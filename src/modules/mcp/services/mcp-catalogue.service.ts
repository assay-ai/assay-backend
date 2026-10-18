import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { offersRail } from '@modules/chains/chain-metadata';
import { ENABLED_CHAINS } from '@modules/chains/enabled-chains';
import { getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { ChainId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import {
  FreeQuotaRemaining,
  FreeQuotaService,
} from '@modules/free-tier/services/free-quota.service';
import { TOOL_CATALOGUE, ToolCataloguePort } from '@modules/tool/ports/tool-catalogue.port';
import {
  PricingMode,
  Tool,
  ToolKind,
  ToolTier,
  ToolVisibility,
  isListedTool,
  isNotReviewed,
  isProviderTool,
} from '@modules/tool/ports/tool.types';
import { ProviderRouterService, ToolQuote } from '@modules/tool/services/provider-router.service';
import { QuoteIndexService } from '@modules/tool/services/quote-index.service';
import { ToolAccessErrors } from '@modules/tool/errors/tool-access.errors';
import { RoutingContext } from '@modules/tool/domain/routing';
import {
  deprecationOf,
  replacementOf,
  versionOf,
} from '@modules/tool/domain/contract/contract-versions';
import { selectViewTools, servesPricingMode } from '@modules/toolset/domain/view';
import { MoneyUtil } from '@utils/money.util';

import {
  X402_FREE_QUOTA,
  X402_P95_LATENCY_MS,
  X402_PAID_ALTERNATIVE,
  X402_PAID_ON_THIS_CHAIN,
  X402_PRICE,
  X402_PRICING_MODE,
  X402_QUALITY_RATE,
  X402_REFUND_ON_FAILURE,
  X402_SETTLEMENT_CHAINS,
  X402_TIER,
  X402_TOOL_ID,
} from '../constants/mcp.constants';
import { McpErrors } from '../errors/mcp.errors';
import { McpScope, contractFor, rulesFor, scopeAllows } from '../ports/mcp-scope';

/**
 * `tools/list` — the catalogue an agent decides from.
 *
 * **The price is the feature.** An agent that discovers cost by being charged
 * cannot budget, cannot plan a 200-call task, and cannot prefer a free tool
 * when a free tool would do. The price is an annotation on the tool itself
 * for exactly that reason, and
 * it is the one thing in this file that must never regress: a tool listed
 * without a price is worse than a tool not listed at all, because the agent
 * calls it anyway and finds out afterwards.
 *
 * Which is why a tool with no routable supply is **omitted** rather than listed
 * without a price. There is no honest price for it — every binding behind it is
 * draft, paused, suspended or under-staked — and an unpriced entry in a
 * price-annotated catalogue reads as "free" to a model skimming the list.
 */
@Injectable()
export class McpCatalogueService {
  private readonly logger = new Logger(McpCatalogueService.name);
  private readonly quotes: QuoteIndexService;

  constructor(
    @Inject(TOOL_CATALOGUE) private readonly catalogue: ToolCataloguePort,
    router: ProviderRouterService,
    private readonly freeQuota: FreeQuotaService,
    @Inject(ENABLED_CHAINS) private readonly enabledChains: readonly ChainId[],
    // The quote index every listing prices from. Optional only so a harness
    // that builds this class by hand gets a private one over the same router.
    @Optional() quotes?: QuoteIndexService,
  ) {
    this.quotes = quotes ?? new QuoteIndexService(router, catalogue);
  }

  /**
   * View ∩ access, unpriced: every tool this URL serves that this caller may
   * call. The one set `tools/list`, `search_tools` and `get_tool` all draw
   * from, so none of them can ever show a tool the others would hide.
   */
  async scopedTools(scope: McpScope): Promise<readonly Tool[]> {
    const { tools } = selectViewTools(scope.view, await this.catalogue.listTools());
    return tools.filter((tool) => scopeAllows(scope, tool.id));
  }

  /** This agent's free calls left today on a FREE or FREEMIUM tool, or `null`. */
  async freeCallsLeft(viewer: McpCatalogueViewer, toolId: string): Promise<number | null> {
    const remaining = await this.freeQuota.remainingForTool(
      viewer.organizationId,
      viewer.agentId,
      toolId,
    );
    return remaining ? remaining.remaining : null;
  }

  /**
   * The `?tools=` names this URL does not serve to this caller, for
   * `_meta["assay/ignoredTools"]`: measured against view ∩ access, so a tool
   * the caller may not use reads exactly like one that does not exist.
   */
  async ignoredTools(scope: McpScope): Promise<readonly string[]> {
    const { tools, ignoredTools } = selectViewTools(scope.view, await this.catalogue.listTools());
    const refused = tools.filter((tool) => !scopeAllows(scope, tool.id)).map((tool) => tool.name);
    return [...ignoredTools, ...refused].sort();
  }

  /**
   * The tool `name` names at this URL, for a call — or `TOOL_NOT_IN_TOOLSET`
   * (not served here, including a name that exists nowhere) and then
   * `TOOL_NOT_ALLOWED` (served here, refused by the agent's access).
   */
  async admit(name: string, scope: McpScope): Promise<Tool> {
    const { tools } = selectViewTools(scope.view, await this.catalogue.listTools());
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) {
      await this.refuseIfRemoved(name, scope);
      throw ToolAccessErrors.notInToolset({ details: { name } });
    }
    if (!scopeAllows(scope, tool.id)) {
      throw ToolAccessErrors.notAllowed({ details: { name, toolId: tool.id } });
    }
    return tool;
  }

  /**
   * `TOOL_REMOVED` for a removed tool this URL served (§7.6 "Removal"): one
   * its toolset held, or a LISTED one on a catalogue-wide URL. Anything else
   * stays `TOOL_NOT_IN_TOOLSET`, so a removed PRIVATE or UNLISTED tool's
   * name is no oracle.
   */
  private async refuseIfRemoved(name: string, scope: McpScope): Promise<void> {
    const removed = await this.catalogue.findRemovedByName?.(name);
    if (!removed) return;
    const view = scope.view;
    const served = view.baseToolIds
      ? view.baseToolIds.includes(removed.id) &&
        (removed.visibility === ToolVisibility.LISTED ||
          (!!view.toolset?.ownerOrgId && view.toolset.ownerOrgId === removed.ownerOrgId))
      : removed.visibility === ToolVisibility.LISTED &&
        (!view.baseOwnerOrgId || view.baseOwnerOrgId === removed.ownerOrgId);
    if (!served) return;
    throw ToolAccessErrors.removed({
      details: { name, replacement: removed.replacementToolName },
    });
  }

  /**
   * Every tool that can actually be called, priced.
   *
   * Quotes are gathered concurrently: each one joins the catalogue to the
   * provider registry and the stake source, and the stake read is an RPC to
   * chain state. Sequentially that would make `tools/list` —
   * the first thing every agent does — take one round-trip per tool.
   *
   * `viewer` is who is asking, so `x402/freeQuota` can be
   * this **agent's own** remaining count rather than nobody's. It is optional
   * because `tools/list`, unlike `tools/call`, has no session threaded to it
   * on every path. Without a `viewer`, every `FREE`/`FREEMIUM` tool is still listed and still
   * carries `x402/pricingMode`; it simply omits `x402/freeQuota` rather than
   * publish a number that is nobody's.
   */
  async listTools(
    viewer?: McpCatalogueViewer,
    scope?: McpScope,
    options: McpListOptions = {},
  ): Promise<McpToolDescriptor[]> {
    return (await this.listQuoted(viewer, scope, options)).map((entry) => entry.descriptor);
  }

  /**
   * {@link listTools}, each descriptor beside the tool it describes **at the
   * contract version a call through this URL would use** — what `get_tool`
   * and `search_tools` read their schemas, summary, examples and version
   * from, so the list, the search and the call agree (§7.3).
   */
  async listQuoted(
    viewer?: McpCatalogueViewer,
    scope?: McpScope,
    options: McpListOptions = {},
  ): Promise<McpQuotedTool[]> {
    // The URL's view, then the agent's access: `tools/list` returns view ∩
    // access, and prices each tool under the rules a call through this URL
    // would be routed under. Without a scope (the REST surfaces), the whole
    // catalogue with no rules.
    const all = scope
      ? await this.scopedTools(scope)
      : (await this.catalogue.listTools()).filter(isListedTool);
    const tools = options.onlyToolIds
      ? all.filter((tool) => options.onlyToolIds.has(tool.id))
      : all;
    // **Not narrowed to the viewer's chain, deliberately.** A tool that
    // settles somewhere the buyer holds nothing must be LISTED and marked, not
    // hidden — hiding it makes the platform look like it lacks the tool —
    // so every quote asks about every chain this deployment offers and reports
    // `settlementChains` for the descriptor to carry. The refusal, when the
    // agent actually calls, is `PAYMENT_NO_SETTLEABLE_CHAIN`, which names the
    // chain to fund; a missing row names nothing.
    //
    // `defaultChainId` is still the viewer's own, so rule 1 of
    // `chooseSettlementChain` answers the
    // same chain a real call from this agent would settle on.
    //
    // **One tool's failure is that tool's alone.** A quote can throw — a
    // catalogue defect in one tool's bindings, an unregistered asset, a stake
    // read that failed — and a single `Promise.all` turned any of those into
    // `-32603` for the whole list, for every agent on the platform. A tool
    // whose quote throws has no honest price, so it is omitted exactly like a
    // tool with no routable supply, and the failure is logged for whoever owns
    // it. Its own `tools/call` still reports the real error.
    //
    // Priced from the quote index, never `router.quote()`: no registry or
    // chain read per tool per listing (NFR-2).
    const context: RoutingContext = {
      payerChains: this.enabledChains,
      defaultChainId: viewer?.chainId ?? null,
      enabledChains: this.enabledChains,
      // A catalogue is not an offer to be paid. A tool
      // must be SHOWN rather than hidden when the reader cannot pay for it,
      // and a standing withdrawal is the buyer's cash management — hiding a
      // tool for it would make the listing flicker as they move money in and
      // out. The refusal, when it comes, comes from the CALL path.
      withdrawingChains: [],
    };
    // Each tool is priced under the rules and at the contract version a call
    // through this URL would use, so the listed schema and price are the
    // ones the call gets (§7.3, "Contract version").
    const byId = new Map(tools.map((tool) => [tool.id, tool]));
    const quoted = await this.quotes.quoteMany(
      tools.map((tool) => tool.id),
      (toolId) =>
        scope
          ? {
              ...context,
              rules: rulesFor(scope, toolId),
              contract: contractFor(scope, byId.get(toolId) as Tool),
            }
          : context,
    );
    const quotes = tools.map((tool) => quoted.get(tool.id) ?? null);

    const freeQuotas = await Promise.all(
      quotes.map((quote) =>
        viewer && quote && options.freeQuota !== false && isFreeOrFreemium(quote.pricingMode)
          ? this.freeQuota.remainingForTool(viewer.organizationId, viewer.agentId, quote.tool.id)
          : Promise.resolve(null),
      ),
    );

    // The "N" of a FREEMIUM tool's "N free per day, then $X". The same figure
    // for every agent, so it is published with or without a viewer.
    const freeAllowances = quotes.map((quote) =>
      quote && quote.pricingMode === PricingMode.FREEMIUM
        ? this.freeQuota.dailyAllowance(quote.freeBindings ?? [])
        : null,
    );

    // A chain with no paid rail (Solana: `rails: []`) cannot buy a priced
    // tool. Still listed — see above — but not priced as buyable (L6).
    const paidOnViewerChain = viewer?.chainId ? paidRailOffered(viewer.chainId) : true;

    const listed: McpQuotedTool[] = [];
    quotes.forEach((quote, index) => {
      if (!quote) return;

      // `?free=1` serves only tools that can be free, and that is decided
      // first: a tool the rules left unpriced has no free supply to show.
      if (scope && !servesPricingMode(scope.view.filter, quote.pricingMode)) return;

      if (!quote.price) {
        // The agent's or the toolset's rules left no provider: listed, and
        // saying so, because the tool exists and the fix is the agent's.
        if (quote.ruleRejections && quote.ruleRejections.length > 0) {
          listed.push({ tool: quote.tool, descriptor: describeNoProviderFits(quote) });
          return;
        }
        this.logger.debug(
          `${quote.tool.name}: omitted from tools/list — ${quote.unroutableReason ?? 'no price'}`,
        );
        return;
      }

      listed.push({
        tool: quote.tool,
        descriptor: describe(
          quote,
          quote.price,
          freeQuotas[index],
          freeAllowances[index],
          paidOnViewerChain,
        ),
      });
    });

    return listed;
  }

  /**
   * The tool an agent named, or `MCP_TOOL_NOT_FOUND`.
   *
   * MCP addresses a tool by `name`; everything inside the platform addresses it
   * by uuid. This is the only place the two meet, and it resolves in that
   * direction only — nothing downstream accepts a name.
   *
   * A duplicate name is refused rather than resolved to the first match. Two
   * tools sharing a name is a catalogue error that makes every call to that
   * name a coin flip between two prices, and answering it arbitrarily would
   * charge some agents for the wrong one.
   */
  async findByName(name: string): Promise<Tool> {
    // Off the MCP host there is no URL to reach an unlisted tool through, so
    // only the LISTED catalogue answers (§7.6).
    const matches = (await this.catalogue.listTools()).filter(
      (tool) => tool.name === name && isListedTool(tool),
    );

    if (matches.length === 0) {
      throw McpErrors.toolNotFound({ name });
    }
    if (matches.length > 1) {
      this.logger.error(
        `Catalogue defect: ${matches.length} tools are named "${name}" ` +
          `(${matches.map((tool) => tool.id).join(', ')})`,
      );
      throw McpErrors.toolNotFound({
        name: `${name} — the catalogue holds ${matches.length} tools under this name`,
      });
    }

    return matches[0];
  }
}

// ---------------------------------------------------------------------------
// The descriptor
// ---------------------------------------------------------------------------

/** How {@link McpCatalogueService.listTools} prices. */
export interface McpListOptions {
  /**
   * `false` skips the per-agent `x402/freeQuota` read: `search_tools` ranks the
   * whole view and reads the quota only for the page it returns.
   */
  readonly freeQuota?: boolean;
  /** Price only these tools (still within view ∩ access): a SEARCH list's pinned ones. */
  readonly onlyToolIds?: ReadonlySet<string>;
}

/** One listed tool: its descriptor, and the tool at the contract version it describes. */
export interface McpQuotedTool {
  readonly tool: Tool;
  readonly descriptor: McpToolDescriptor;
}

/** Who is asking `tools/list` — see {@link McpCatalogueService.listTools}. */
export interface McpCatalogueViewer {
  readonly organizationId: string;
  readonly agentId: string;
  /**
   * The chain this viewer's linked account is on, when the caller has a session
   * (rule 1 of `chooseSettlementChain`).
   *
   * Optional because the viewer itself is: `tools/list` can be answered with no
   * session at all. It does NOT narrow what is listed — see `listTools` — it
   * only decides which chain a multi-chain tool is quoted as settling on, which
   * is the chain that agent's own call would take.
   */
  readonly chainId?: ChainId;
}

/**
 * One entry of `tools/list`.
 *
 * Structurally an MCP `Tool`, declared here rather than imported from the SDK
 * because the SDK types `annotations` as a closed set of behavioural hints and
 * every field this platform publishes is outside it. See `DUPLICATED_INTO_META`
 * for why the same values also appear in `_meta`.
 */
export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly annotations: Record<string, unknown>;
  readonly _meta: Record<string, unknown>;
}

/** The `x402/price` value: atomic units, the asset that scales them, and a display form. */
export interface McpPriceAnnotation {
  readonly amount: string;
  readonly asset: string;
  readonly display: string;
}

/**
 * `FREE` or `FREEMIUM` — the two pricing modes a tool can still be free
 * under. `PAID` is the only value this excludes; `null` never reaches here
 * because {@link ProviderRouterService.quote} only returns it alongside
 * `price: null`, which `listTools` has already filtered out by the time this
 * runs.
 */
function isFreeOrFreemium(mode: PricingMode | null): boolean {
  return mode === PricingMode.FREE || mode === PricingMode.FREEMIUM;
}

function describe(
  quote: ToolQuote,
  price: Money,
  freeQuota: FreeQuotaRemaining | null,
  freePerDay: number | null,
  paidOnThisChain = true,
): McpToolDescriptor {
  const { tool } = quote;

  const annotations: Record<string, unknown> = {
    [X402_PRICE]: priceAnnotation(
      price,
      quote.pricingMode,
      quote.paidBindings ?? quote.routableBindings,
      freePerDay,
      paidOnThisChain,
    ),
    [X402_TIER]: tierLabel(tool.tier),
    // Every response class other than `DATA_RESULT` releases the hold rather
    // than committing it (`RESPONSE_CLASS_CONSEQUENCE`), so this is a property
    // of the platform today rather than of the tool. It is published per tool
    // anyway because the free-tier and relay work will make it one.
    [X402_REFUND_ON_FAILURE]: true,
    [X402_TOOL_ID]: tool.id,
    // Where this tool settles, so a buyer holding funds on another chain
    // can be told rather than discovering it at PAYMENT_NO_SETTLEABLE_CHAIN.
    // Unconditional, including when empty: a missing LIST reads as
    // "unconstrained", which is the one reading that is never true here — see
    // `X402_SETTLEMENT_CHAINS`. That is why it sits in the base object beside
    // the price rather than behind a guard, unlike `x402/p95LatencyMs`.
    //
    // Copied, not passed through: `annotations` is handed to an SDK that owns
    // it afterwards, and the quote's array is the router's.
    [X402_SETTLEMENT_CHAINS]: [...quote.settlementChains],
  };

  // Omitted rather than sent as null. An agent scoring endpoints has to be able
  // to tell "measured, and this is the figure" from "never measured", and a
  // null in a numeric field is read as zero by more clients than not.
  if (quote.p95LatencyMs !== null)
    annotations[X402_P95_LATENCY_MS] = Math.round(quote.p95LatencyMs);
  if (quote.qualityRate !== null) annotations[X402_QUALITY_RATE] = quote.qualityRate;

  // Free-tier annotations. Every listed tool has a
  // non-null `pricingMode` by the time `describe` runs (see `quotedPricingMode`
  // on `ProviderRouterService.quote`: it is set whenever `eligible.length > 0`,
  // which is the same condition that produced a non-null `price`).
  if (isFreeOrFreemium(quote.pricingMode)) {
    annotations[X402_PRICING_MODE] = quote.pricingMode;

    // Present only when the caller supplied a viewer AND the quota is known —
    // never a zeroed placeholder. See `McpCatalogueService.listTools`.
    if (freeQuota) {
      annotations[X402_FREE_QUOTA] = {
        remaining: freeQuota.remaining,
        limit: freeQuota.limit,
        resetsAt: freeQuota.resetsAt.toISOString(),
      };
    }

    // FREEMIUM's paid path is provably honest: the same tool, at the price
    // already quoted above. FREE has no paid path through this catalogue at
    // all — see `X402_PAID_ALTERNATIVE`'s own doc comment — so it publishes
    // no key rather than a fabricated one.
    if (quote.pricingMode === PricingMode.FREEMIUM && paidOnThisChain) {
      annotations[X402_PAID_ALTERNATIVE] = tool.name;
    }
  }
  if (!paidOnThisChain && quote.pricingMode !== PricingMode.FREE) {
    annotations[X402_PAID_ON_THIS_CHAIN] = false;
  }

  return {
    name: tool.name,
    // The version's stored summary (at most 200 characters), never the full
    // description: that is `get_tool`'s (§7.4).
    description: `${versionOf(tool).summary}\n\n${priceLine(quote, price, freePerDay)}${reviewNote(tool)}`,
    inputSchema: tool.inputSchema as unknown as Record<string, unknown>,
    outputSchema: tool.outputSchema as unknown as Record<string, unknown>,
    annotations,
    // The copy an SDK client keeps. Same values, same keys — a client reading
    // one and a client reading the other must never see different prices.
    _meta: { ...annotations, ...contractMetaOf(tool) },
  };
}

/** `_meta["assay/deprecated"]`: the contract version this URL serves is deprecated. */
export const ASSAY_DEPRECATED = 'assay/deprecated';

/**
 * The contract `_meta` of a listed or described tool: `assay/deprecated`
 * (`{ sunsetAt, replacement }`) when the version served is deprecated.
 */
export function contractMetaOf(tool: Tool): Record<string, unknown> {
  const version = versionOf(tool);
  const deprecated = deprecationOf(version, replacementOf(tool, version));
  return {
    ...(deprecated ? { [ASSAY_DEPRECATED]: deprecated } : {}),
    ...providerMetaOf(tool),
  };
}

/**
 * The stable note a "Not reviewed" provider tool's description line ends
 * with, so a model reading `tools/list` sees it before it pays (§7.6).
 */
export function reviewNote(tool: Tool): string {
  return isNotReviewed(tool) ? ' · Not reviewed' : '';
}

/** `_meta["assay/kind"]`: `PROVIDER` on one maker's own tool (absent on a standard one). */
export const ASSAY_KIND = 'assay/kind';
/** `_meta["assay/notReviewed"]`: a provider tool no operator has reviewed (§7.6). */
export const ASSAY_NOT_REVIEWED = 'assay/notReviewed';

/**
 * A provider tool says so beside its price: one maker's API, with no backup
 * provider, and — until an operator approved it — not reviewed. Calls are
 * never priced or routed on this; it is what the agent and its owner see.
 */
export function providerMetaOf(tool: Tool): Record<string, unknown> {
  if (!isProviderTool(tool)) return {};
  return {
    [ASSAY_KIND]: ToolKind.PROVIDER,
    ...(isNotReviewed(tool) ? { [ASSAY_NOT_REVIEWED]: true } : {}),
  };
}

/**
 * The one stable line a description ends with (design spec §7.4): the lowest
 * price the rules leave and the free allowance. Never the free calls left
 * today, which change on every call and would make the list unstable.
 */
function priceLine(quote: ToolQuote, price: Money, freePerDay: number | null): string {
  if (quote.pricingMode === PricingMode.FREE) return 'Free';
  const from = `From ${displayPrice(quote.cheapestPrice ?? price)} per call`;
  if (quote.pricingMode !== PricingMode.FREEMIUM) return from;
  return freePerDay === null
    ? `${from} · free calls each day`
    : `${from} · ${freePerDay} free calls a day`;
}

/** `assay/noProviderFits`: the rules left no provider for this tool. */
export const ASSAY_NO_PROVIDER_FITS = 'assay/noProviderFits';

/** A tool the agent's or the toolset's rules leave no provider for. Listed, unpriced. */
function describeNoProviderFits(quote: ToolQuote): McpToolDescriptor {
  const { tool } = quote;
  const annotations: Record<string, unknown> = {
    [X402_TIER]: tierLabel(tool.tier),
    [X402_TOOL_ID]: tool.id,
    [X402_SETTLEMENT_CHAINS]: [],
    [ASSAY_NO_PROVIDER_FITS]: true,
  };
  return {
    name: tool.name,
    description: `${versionOf(tool).summary}\n\nNo provider fits your limits.${reviewNote(tool)}`,
    inputSchema: tool.inputSchema as unknown as Record<string, unknown>,
    outputSchema: tool.outputSchema as unknown as Record<string, unknown>,
    annotations,
    _meta: { ...annotations, ...contractMetaOf(tool) },
  };
}

/**
 * `free` is a display value, not a price of zero dressed up.
 *
 * A `FREE` tool displays `"free"`, so a model can prefer one without parsing an
 * amount against an asset's scale.
 */
/**
 * `amount` is the quote: the dearest eligible binding, which is what a call is
 * held for and the most it can be charged. The charge is the price of the
 * binding that serves, so when more than one binding could serve, `display`
 * says `"up to $0.10"` rather than claiming a price the call may undercut.
 *
 * A `FREEMIUM` tool is free first, then paid, so its `display` leads with the
 * free allowance: `"100 free per day, then up to $0.10"`. `amount` stays the
 * paid quote — what a call past the quota is held for.
 */
function priceAnnotation(
  price: Money,
  mode: PricingMode | null,
  /** Bindings that can be charged: a FREE one beside them makes no range (L2). */
  paidBindings: number,
  freePerDay: number | null,
  paidOnThisChain = true,
): McpPriceAnnotation {
  if (mode === PricingMode.FREE) {
    return { amount: price.amount, asset: price.asset, display: 'free' };
  }

  const shown = displayPrice(price);
  const paid = paidBindings > 1 ? `up to ${shown}` : shown;
  const free = freePerDay === null ? 'free tier' : `${freePerDay} free per day`;
  if (!paidOnThisChain) {
    // Paid calls are off on the viewer's chain: never advertise a price it
    // cannot pay (review #2, L6). `amount` is still the quote, for reference.
    return {
      amount: price.amount,
      asset: price.asset,
      display:
        mode === PricingMode.FREEMIUM
          ? `${free} (paid calls are off on this chain)`
          : `${paid} (paid calls are off on this chain)`,
    };
  }
  return {
    amount: price.amount,
    asset: price.asset,
    display: mode === PricingMode.FREEMIUM ? `${free}, then ${paid}` : paid,
  };
}

/** Whether `chainId` offers any paid rail (`chain-metadata.ts`'s `rails`). */
function paidRailOffered(chainId: ChainId): boolean {
  return offersRail(chainId, 'A') || offersRail(chainId, 'B');
}

/**
 * `"$0.01"` for a USD-pegged asset, `"0.01 SOL"` for anything else.
 *
 * `MoneyUtil.format` renders every decimal place — `"0.010000 USDC"` — which is
 * correct for an accounting record and wrong for a line a model reads while
 * choosing between tools. Trailing zeros are trimmed here and **only** here:
 * the trimmed string never leaves this annotation, and `amount` beside it
 * carries the exact atomic figure that is actually charged.
 *
 * The `$` is applied by symbol, not by chain, so a second USD stablecoin
 * renders the same way and a non-USD asset never silently gains a dollar sign.
 */
export function displayPrice(price: Money): string {
  const { symbol } = getAssetMetadata(price.asset);
  const rendered = trimTrailingZeros(MoneyUtil.format(price));

  return USD_PEGGED_SYMBOLS.has(symbol) ? `$${rendered}` : `${rendered} ${symbol}`;
}

/** Dollar stablecoins: shown as `$`. USDG is the Robinhood Chain one (review 2026-10-18: "0.1 USDG"). */
const USD_PEGGED_SYMBOLS: ReadonlySet<string> = new Set(['USDC', 'USDG', 'USDT', 'PYUSD']);

function trimTrailingZeros(decimal: string): string {
  if (!decimal.includes('.')) return decimal;
  return decimal.replace(/0+$/, '').replace(/\.$/, '');
}

/** Lower case on the wire (`"verified"`). The enum is upper case internally. */
function tierLabel(tier: ToolTier): string {
  return tier.toLowerCase();
}
