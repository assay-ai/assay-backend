import {
  ToolContractVersionDto,
  ToolVersionBriefDto,
  ToolVersionListDto,
  ToolVersionProviderDto,
} from '@modules/tool/dto/tool-contract-version.dto';
import {
  contractReplacementOf,
  contractVersionsOf,
  currentContractVersion,
  versionOf,
} from '@modules/tool/domain/contract/contract-versions';
import { bindingRange } from '@modules/tool/domain/contract/version-range';
import { ToolErrors } from '@modules/tool/errors/tool.errors';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { In } from 'typeorm';

import { ProviderEntity } from '@database/postgres/entities/provider.entity';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { BindingVersionRepository } from '@database/postgres/repositories/binding-version.repository';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import {
  ProviderQualityCounters,
  SlaWindowRepository,
} from '@database/postgres/repositories/sla-window.repository';
import { ToolBindingRepository } from '@database/postgres/repositories/tool-binding.repository';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';
import { FREE_QUOTA_CONFIG, FreeQuotaConfig } from '@modules/free-tier/config/free-quota.config';
import { ENABLED_CHAINS } from '@modules/chains/enabled-chains';
import { freeCallsPerDay } from '@modules/free-tier/domain/free-calls-per-day';
import { AssetId, ChainId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { RoutingContext } from '@modules/tool/domain/routing';
import { ProviderErrors } from '@modules/provider/errors/provider.errors';
import { ProviderStatus } from '@modules/provider/ports/provider.types';
import {
  CHAIN_ENROLMENT_SOURCE,
  ChainEnrolmentPort,
} from '@modules/provider/ports/chain-enrolment.port';
import {
  PROVIDER_STAKE_SOURCE,
  ProviderStakePort,
} from '@modules/provider/ports/provider-stake.port';
import { TOOL_CATALOGUE, ToolCataloguePort } from '@modules/tool/ports/tool-catalogue.port';
import {
  BindingStatus,
  PricingMode,
  Tool,
  ToolBinding,
  categoryOf,
  ToolKind,
  ToolVersionStatus,
  isListedTool,
  isNotReviewed,
  isProviderTool,
} from '@modules/tool/ports/tool.types';
import { parseProviderToolName } from '@modules/tool/domain/provider-tool-name';
import { toServedToolBindings } from '@modules/tool/services/database-tool-catalogue';
import { ProviderRouterService, ToolQuote } from '@modules/tool/services/provider-router.service';
import { MoneyUtil } from '@utils/money.util';

import {
  CatalogueChainPriceDto,
  CatalogueChainStakeDto,
  CatalogueMoneyDto,
  CatalogueProviderDetailDto,
  CatalogueProviderDto,
  CatalogueProviderListDto,
  CatalogueProviderToolDto,
  CatalogueQualityDto,
  CatalogueToolDto,
  CatalogueToolListDto,
} from '../dto/get-catalogue.dto';
import { TtlCache } from '../domain/ttl-cache';

/** How long one market read is reused, signed-in and public alike. */
export const CATALOGUE_CACHE_MS = 30_000;

/** The listed market: what {@link CatalogueService.loadMarket} reads once per window. */
export interface ListedMarket {
  /** Every listed binding, at its published revision. */
  readonly bindings: readonly ToolBinding[];
  /** The provider rows behind {@link bindings} — ACTIVE providers only. */
  readonly rows: ReadonlyMap<string, ProviderEntity>;
}

/**
 * Per listed provider, per tool it lists: the chains a call to that listing
 * can settle on now (`null` when the router could not be asked). See
 * {@link CatalogueService.loadServed}.
 */
type ServedChains = ReadonlyMap<string, ReadonlyMap<string, readonly ChainId[] | null>>;

/**
 * One cache window: the market read once, and the two lists derived from that
 * same read. The lists are built lazily — a reader of providers does not pay
 * for the tool quotes — but once built they live and die with the market that
 * produced them, so no answer is older than one window and no two answers in
 * a window disagree about which bindings are listed.
 */
interface CatalogueWindow {
  readonly market: ListedMarket;
  providers?: Promise<CatalogueProviderListDto>;
  tools?: Promise<CatalogueToolListDto>;
  served?: Promise<ServedChains>;
}

/**
 * The buyer's catalogue — see `dto/get-catalogue.dto.ts` for the
 * problem it closes and the rules about absent figures.
 *
 * ## It composes; it does not query
 *
 * Every cross-tenant read this needs already existed and is already on the
 * allowlist in `test/unit/shared/api/surface-consistency.spec.ts`:
 * `ToolBindingRepository.findActiveBindings`,
 * `SlaWindowRepository.qualityByProvider`, `ProviderStakePort.stakeOn` and the
 * scoped-by-foreign-id provider read that `ProviderVerificationService` already
 * relies on. Nothing here writes SQL, so the gate that makes a new cross-tenant
 * read a conversation is not quietly routed around by a service that happens to
 * sit one layer up.
 *
 * ## Bindings are the spine, not providers
 *
 * The list starts from `ACTIVE` bindings and works outward to the providers
 * behind them, rather than starting from `providers` and asking each one what
 * they serve. Two consequences, both wanted: a provider with nothing published
 * cannot appear, and the query count does not grow with the registry.
 *
 * ## Every figure is the published revision's
 *
 * A draft and a live binding are the same `tool_bindings` row: the editor
 * writes an unpublished edit straight onto it, and traffic keeps being served
 * from the published `binding_versions` snapshot until the provider publishes
 * again. So the rows are mapped through `toServedToolBindings` — the router's
 * own mapping — before anything is read off them. Price, pricing mode,
 * `fromPrice` and the free-tier figure are therefore what an agent is actually
 * served, never a saved-but-unpublished draft; and a binding whose published
 * snapshot is missing comes back non-`ACTIVE` and is left out, as the router
 * leaves it out.
 *
 * ## The reads are one wave
 *
 * Stake, quality and the provider rows are fetched concurrently over the id set
 * the bindings produced — three batched calls, not three per provider. The
 * ports were written batched for exactly this (`stakeOn` takes an array;
 * `qualityByProvider` takes an array), and a per-provider loop here would turn
 * a 21-row catalogue into 63 round trips.
 *
 * ## Cached in process, once per market
 *
 * Nothing in the lists depends on the caller — no session, no organization —
 * so every answer is shared by every reader, signed-in and public. The one
 * per-caller field, `servesYou`, is laid over the shared answer afterwards
 * ({@link CatalogueService.listProvidersFor}) and is never cached. The listed market
 * (bindings + provider rows) is ONE cache entry per {@link CATALOGUE_CACHE_MS},
 * and the provider list and the tool list are memoised on that entry rather
 * than cached on their own clocks: a separate 30s cache on top of a market that
 * may itself be 30s old stacked to a minute of staleness, and three independent
 * caches let a detail page pair a fresh card with an older tool set. Concurrent
 * readers share every load in flight. A provider detail for a listed provider is
 * derived from the window, so requesting every listed id costs no query beyond
 * the one market read; only an unlisted id still reads its own row.
 */
@Injectable()
export class CatalogueService {
  private readonly logger = new Logger(CatalogueService.name);
  private readonly windows = new TtlCache<CatalogueWindow>(CATALOGUE_CACHE_MS);

  constructor(
    private readonly bindings: ToolBindingRepository,
    private readonly versions: BindingVersionRepository,
    private readonly providers: ProviderRepository,
    private readonly slaWindows: SlaWindowRepository,
    private readonly router: ProviderRouterService,
    @Inject(PROVIDER_STAKE_SOURCE) private readonly stakes: ProviderStakePort,
    @Inject(CHAIN_ENROLMENT_SOURCE) private readonly enrolments: ChainEnrolmentPort,
    @Inject(TOOL_CATALOGUE) private readonly catalogue: ToolCataloguePort,
    @Inject(ENABLED_CHAINS) private readonly enabledChains: readonly ChainId[],
    private readonly blocklist: AccountBlocklistService,
    @Inject(FREE_QUOTA_CONFIG) private readonly freeQuota: FreeQuotaConfig,
    private readonly agents: AgentRepository,
    private readonly config: ConfigService,
  ) {}

  /**
   * Every `ACTIVE` binding of a provider that is not blocked, at its
   * published revision.
   *
   * The catalogue reads bindings directly rather than through routing, so the
   * blocklist is applied here: a blocked provider's bindings are absent from
   * every list and count, exactly as if it had paused them all. Its own page
   * still answers, with no tools — see {@link getProvider}.
   */
  private async loadMarket(): Promise<ListedMarket> {
    // Only bindings of LISTED tools: an UNLISTED or PRIVATE provider tool is
    // reachable only through its provider's own toolsets (§7.6), so neither
    // its name nor its provider's card may come from here.
    const listed = new Set(
      (await this.catalogue.listTools()).filter(isListedTool).map((tool: Tool) => tool.id),
    );
    const rows = (await this.bindings.findActiveBindings()).filter(
      (row) => listed.has(row.toolId) && !this.blocklist.organizationBlock(row.organizationId),
    );
    // As traffic is served, not as the row reads now: an unpublished draft
    // must not show on a public page. A drifted row with no published snapshot
    // comes back DRAFT and is dropped, exactly as the router drops it.
    const served = (await toServedToolBindings(rows, this.versions)).filter(
      (binding) => binding.status === BindingStatus.ACTIVE,
    );

    // A SUSPENDED or UNBONDING provider takes no new traffic — the router
    // refuses it — so its bindings are left out of every list and count here,
    // exactly like a PAUSED binding: a catalogue row is an invitation to call.
    const providers = await this.providerRows([
      ...new Set(served.map((binding) => binding.providerId)),
    ]);
    const active = new Map(
      [...providers].filter(([, row]) => row.status === ProviderStatus.ACTIVE),
    );
    return {
      bindings: served.filter((binding) => active.has(binding.providerId)),
      rows: active,
    };
  }

  /** The current window — one market read, shared by every reader in it. */
  private window(): Promise<CatalogueWindow> {
    return this.windows.get('all', async () => ({ market: await this.loadMarket() }));
  }

  listProviders(): Promise<CatalogueProviderListDto> {
    return this.window().then((window) => this.providersOf(window));
  }

  /** The window's provider list, built once from the window's own market. */
  private providersOf(window: CatalogueWindow): Promise<CatalogueProviderListDto> {
    if (!window.providers) {
      const load = this.loadProviders(window);
      window.providers = load;
      // A failed derivation is not served for the rest of the window.
      load.catch(() => {
        if (window.providers === load) window.providers = undefined;
      });
    }
    return window.providers;
  }

  /** The window's tool list, built once from the window's own market. */
  private toolsOf(window: CatalogueWindow): Promise<CatalogueToolListDto> {
    if (!window.tools) {
      const load = this.loadTools(window.market);
      window.tools = load;
      load.catch(() => {
        if (window.tools === load) window.tools = undefined;
      });
    }
    return window.tools;
  }

  /** The window's served chains, read once from the window's own market. */
  private servedOf(window: CatalogueWindow): Promise<ServedChains> {
    if (!window.served) {
      const load = this.loadServed(window.market);
      window.served = load;
      load.catch(() => {
        if (window.served === load) window.served = undefined;
      });
    }
    return window.served;
  }

  /**
   * Per listed provider and tool, the chains a call to that listing can settle
   * on now — answered by the router, not re-derived here.
   *
   * Each tool's candidates are read once ({@link ProviderRouterService.snapshotCandidates});
   * then, for each listed provider of the tool and each enabled chain, the
   * router prices that provider's candidates alone for a payer on that one
   * chain, exactly as a call from an agent on it is routed (`payerChains:
   * [chain]`). A chain is in the answer when the router would route there
   * (`routableBindings > 0`), so enrolment, stake, slash holds, ceilings, a
   * paused circuit and the blocklist are all the router's own gates.
   *
   * Only providers in the listed market are asked about, so nothing outside it
   * (blocked, suspended, unlisted tools) is ever named. A tool whose snapshot
   * fails is `null` for each of its providers — not known, never "not serving".
   */
  private async loadServed({ bindings }: ListedMarket): Promise<ServedChains> {
    const tools = new Map((await this.catalogue.listTools()).map((tool: Tool) => [tool.id, tool]));
    const served = new Map<string, Map<string, readonly ChainId[] | null>>();
    const record = (providerId: string, toolId: string, chains: readonly ChainId[] | null) => {
      const own = served.get(providerId) ?? new Map<string, readonly ChainId[] | null>();
      own.set(toolId, chains);
      served.set(providerId, own);
    };

    await Promise.all(
      [...groupBy(bindings, (binding) => binding.toolId)].map(async ([toolId, own]) => {
        const providerIds = [...new Set(own.map((binding) => binding.providerId))];
        const tool = tools.get(toolId);
        try {
          if (!tool) throw new Error('not in the catalogue');
          const candidates = await this.router.snapshotCandidates(toolId);
          for (const providerId of providerIds) {
            const theirs = candidates.filter(
              (candidate) => candidate.binding.providerId === providerId,
            );
            record(
              providerId,
              toolId,
              this.enabledChains.filter(
                (chainId) =>
                  this.router.quoteFromCandidates(tool, theirs, {
                    payerChains: [chainId],
                    defaultChainId: chainId,
                    enabledChains: this.enabledChains,
                    withdrawingChains: [],
                  }).routableBindings > 0,
              ),
            );
          }
        } catch (error: unknown) {
          this.warnChain(tool ?? ({ id: toolId, name: toolId } as Tool), 'served chains', error);
          for (const providerId of providerIds) record(providerId, toolId, null);
        }
      }),
    );
    return served;
  }

  /**
   * The provider list as one buyer sees it: the shared list, plus
   * `servesYou` from the caller's own agents' chains. Nothing about another
   * organization is read: the chains are the router's public answer, and the
   * agents are the caller's own.
   */
  async listProvidersFor(organizationId: string): Promise<CatalogueProviderListDto> {
    const window = await this.window();
    const [{ providers }, served, yours] = await Promise.all([
      this.providersOf(window),
      this.servedOf(window),
      this.yourChains(organizationId),
    ]);
    return {
      providers: providers.map((provider) => ({
        ...provider,
        servesYou: servesYouOf([...(served.get(provider.providerId)?.values() ?? [])], yours),
      })),
    };
  }

  /** {@link getProvider}, with `servesYou` for the caller on the card and each tool. */
  async getProviderFor(
    providerId: string,
    organizationId: string,
  ): Promise<CatalogueProviderDetailDto> {
    const [detail, yours] = await Promise.all([
      this.getProvider(providerId),
      this.yourChains(organizationId),
    ]);
    const tools = detail.tools.map((tool) => ({
      ...tool,
      servesYou: servesYouOf([tool.chains], yours),
    }));
    return {
      ...detail,
      servesYou: servesYouOf(
        tools.map((tool) => tool.chains),
        yours,
      ),
      tools,
    };
  }

  /**
   * The chains the caller's agents pay on: each ACTIVE agent's own chain, or
   * the deployment default for one with no wallet yet (what the agents list
   * and the Connect preview show as its chain). With no agent at all, the
   * default — the chain a first agent would pay on.
   */
  private async yourChains(organizationId: string): Promise<ReadonlySet<string>> {
    const fallback = this.config.get<string>('auth.privy.defaultChainId') || this.enabledChains[0];
    const agents = await this.agents.find({
      where: { organizationId, status: 'ACTIVE' },
      select: { id: true, chainId: true },
    });
    const chains = new Set(agents.map((agent) => agent.chainId ?? fallback));
    if (chains.size === 0) chains.add(fallback);
    return chains;
  }

  private async loadProviders(window: CatalogueWindow): Promise<CatalogueProviderListDto> {
    const { bindings, rows } = window.market;
    const byProvider = groupBy(bindings, (binding) => binding.providerId);
    const providerIds = [...byProvider.keys()];

    if (providerIds.length === 0) return { providers: [] };

    const [stakes, quality, served] = await Promise.all([
      this.cardStakes(providerIds),
      this.slaWindows.qualityByProvider(providerIds),
      this.servedOf(window),
    ]);

    const providers = providerIds
      // A binding whose `providers` row is missing is dropped rather than
      // rendered nameless. `providers.organization_id` is UNIQUE and
      // registration writes it before any binding can be saved, so this is an
      // impossible state — and a card reading "unknown provider, $0.25 a call"
      // is worse than one fewer card.
      .filter((providerId) => rows.has(providerId))
      .map((providerId) =>
        this.toProviderDto(
          rows.get(providerId) as ProviderEntity,
          byProvider.get(providerId) ?? [],
          stakes.get(providerId) ?? [],
          quality.get(providerId) ?? null,
          unionOf([...(served.get(providerId)?.values() ?? [])]),
        ),
      )
      .sort(byQualityThenName);

    return { providers };
  }

  /**
   * One provider, whether or not they are listed.
   *
   * A provider with no `ACTIVE` binding is absent from {@link listProviders}
   * but answers here with an empty `tools`, because a buyer reaches this page
   * from a call record as often as from the list — a provider who paused every
   * binding after serving you is a page that must still render, not a 404.
   *
   * 404 when there is no `providers` row at all, never 403: a 403 would confirm
   * the id exists, which is the leak `surface-consistency.spec.ts` bans.
   */
  async getProvider(providerId: string): Promise<CatalogueProviderDetailDto> {
    // A listed provider's card and its bindings come from ONE window, so the
    // card's counts and `toolIds` always match its `tools`; no query of its own.
    const window = await this.window();
    const [{ providers }, tools, served] = await Promise.all([
      this.providersOf(window),
      this.catalogue.listTools(),
      this.servedOf(window),
    ]);
    const { bindings } = window.market;
    const card = providers.find((provider) => provider.providerId === providerId);
    const names = new Map(tools.map((tool: Tool) => [tool.id, tool.name]));

    if (card) {
      const own = bindings.filter((binding) => binding.providerId === providerId);
      return { ...card, tools: this.toolRows(own, names, served.get(providerId)) };
    }

    // Not listed — paused everything, suspended, blocked, or not registered.
    // Its listed bindings are none by definition, so `tools` is empty.
    const row = await this.providers.findOne({
      where: { organizationId: providerId },
    });

    if (!row) throw ProviderErrors.providerNotFound({ providerId });

    const [stakes, quality] = await Promise.all([
      this.cardStakes([providerId]),
      this.slaWindows.qualityByProvider([providerId]),
    ]);

    // Nothing listed, so no chain takes a call to it now.
    return {
      ...this.toProviderDto(
        row,
        [],
        stakes.get(providerId) ?? [],
        quality.get(providerId) ?? null,
        [],
      ),
      tools: [],
    };
  }

  private toolRows(
    own: readonly ToolBinding[],
    names: ReadonlyMap<string, string>,
    served: ReadonlyMap<string, readonly ChainId[] | null> | undefined,
  ): CatalogueProviderToolDto[] {
    return own
      .map(
        (binding): CatalogueProviderToolDto => ({
          toolId: binding.toolId,
          name: names.get(binding.toolId) ?? binding.toolId,
          pricingMode: binding.pricingMode,
          price: money(binding),
          // The failure rate this listing promises (`tool_bindings.sla_failure_rate`),
          // the line its penalties are measured against — so a buyer can read
          // the observed rate against it.
          promisedFailureRate: binding.slaFailureRate,
          // What the free tier would grant one agent here: its per-agent
          // quota, never more than the binding's daily free-call budget (a
          // call COUNT across all agents, BUG-R17g-01), each falling back to
          // the platform default `FreeQuotaService` uses, and capped by the
          // platform's per-agent ceiling. Null for a PAID binding, which has
          // no free tier at all.
          freeCallsPerAgentPerDay:
            binding.pricingMode === PricingMode.PAID
              ? null
              : freeCallsPerDay(
                  [
                    {
                      freeQuotaPerAgent: binding.freeQuotaPerAgent,
                      freeDailyBudget: binding.freeDailyBudget ?? null,
                    },
                  ],
                  this.freeQuota,
                ),
          // Per tool, not per binding: the router answers for the provider's
          // listing of the tool as a whole.
          chains: chainsOf(served?.get(binding.toolId)),
          servesYou: null,
        }),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * The tools, each with the market behind it.
   *
   * Only tools with at least one `ACTIVE` binding appear: the seed catalogue
   * carries contracts nobody has implemented yet, and a row nobody can serve is
   * an invitation to a 404.
   *
   * `router.quote` is called once per listed tool, concurrently. It is safe
   * from a listing endpoint because `quote()` deliberately does **not** consume
   * a ceiling token — see its own comment — so browsing cannot exhaust a
   * provider's rate limit.
   */
  listTools(): Promise<CatalogueToolListDto> {
    return this.window().then((window) => this.toolsOf(window));
  }

  private async loadTools({ bindings }: ListedMarket): Promise<CatalogueToolListDto> {
    const contracts = await this.catalogue.listTools();

    const byTool = groupBy(bindings, (binding) => binding.toolId);
    const listed = contracts.filter((tool: Tool) => byTool.has(tool.id));
    // A replacement tool is named only when it is itself a LISTED tool.
    const publicTools = new Set(contracts.filter(isListedTool).map((tool: Tool) => tool.id));

    // Every chain this deployment offers, on both sides of the intersection —
    // the catalogue is anonymous and has no buyer to narrow to, and a tool
    // must be SHOWN rather than hidden when the reader
    // cannot pay for it. `defaultChainId` is `null` for the same reason: there
    // is nobody whose default it would be.
    const quoteContext: RoutingContext = {
      payerChains: this.enabledChains,
      defaultChainId: null,
      enabledChains: this.enabledChains,
      // A catalogue is not an offer to be paid, and this one is anonymous:
      // there is no buyer whose withdrawal it could be. Hiding a tool for a
      // pending withdrawal would make the listing flicker with somebody's cash
      // management. The refusal comes from the CALL path.
      withdrawingChains: [],
    };
    // Each quote is isolated: one tool's failure (a catalogue defect in its
    // bindings, a stake read that failed) shows that tool as unroutable, with
    // the reason, and never takes the rest of the shop down with it.
    const quotes = await Promise.all(
      listed.map((tool: Tool) =>
        this.router.quote(tool.id, quoteContext).catch((error: unknown): ToolQuote => {
          const reason = error instanceof Error ? error.message : String(error);
          this.logger.warn(`${tool.name} (${tool.id}): quote failed — ${reason}`);
          return {
            tool,
            price: null,
            pricingMode: null,
            routableBindings: 0,
            settlementChains: [],
            p95LatencyMs: null,
            qualityRate: null,
            unroutableReason: reason,
          };
        }),
      ),
    );

    // One quote per chain a tool settles on (D6): a buyer pays on ONE chain, so
    // the headline is that chain's price, never the dearest across chains.
    const chainPrices = await Promise.all(
      listed.map((tool: Tool, index) =>
        this.pricesPerChain(
          tool,
          quotes[index],
          quoteContext,
          new Set((byTool.get(tool.id) ?? []).map((binding) => binding.providerId)),
        ),
      ),
    );

    const tools = listed.map((tool: Tool, index): CatalogueToolDto => {
      const own = byTool.get(tool.id) ?? [];
      const quote = quotes[index];

      return {
        id: tool.id,
        name: tool.name,
        description: tool.description,
        ...versionFieldsOf(tool, (toolId) => publicTools.has(toolId)),
        tier: tool.tier,
        kind: isProviderTool(tool) ? ToolKind.PROVIDER : ToolKind.STANDARD,
        handle: isProviderTool(tool) ? (parseProviderToolName(tool.name)?.handle ?? null) : null,
        notReviewed: isNotReviewed(tool),
        category: categoryOf(tool),
        tags: [...(tool.tags ?? [])],
        providerCount: new Set(own.map((binding) => binding.providerId)).size,
        fromPrice: cheapest(own),
        price: quote.price ? toMoneyDto(quote.price) : null,
        pricingMode: quote.pricingMode,
        freeCallsPerDay:
          quote.pricingMode === PricingMode.FREE || quote.pricingMode === PricingMode.FREEMIUM
            ? // The router's routable free-capable bindings at their published
              // revision, capped by the platform ceiling — never raw draft rows,
              // so this and `tools/list` print the same N (review L2).
              freeCallsPerDay(quote.freeBindings ?? [], this.freeQuota)
            : null,
        routable: quote.price !== null,
        routableBindings: quote.routableBindings,
        paidBindings: quote.paidBindings ?? 0,
        unroutableReason: quote.unroutableReason,
        // The settles-elsewhere caveat, off the router's own union — the same value and the
        // same spelling `tools/list` publishes as `x402/settlementChains`. NOT
        // re-derived from `tool_bindings.settlement_chains`: a binding's
        // declared list is narrowed by the provider's ACTIVE enrolments and by
        // `ENABLED_CHAINS` before it is a chain a call can settle on, and a
        // second derivation of one fact drifts invisibly.
        //
        // Empty becomes `null`, never `[]`. The empty case is exactly the
        // unroutable one — `filterEligible` rejects a candidate whose settleable
        // set is empty, so a routable tool always names at least one chain —
        // and `[]` on the wire reads as "settles nowhere you can pay", which
        // would present a tool nobody can route right now as one the buyer
        // should give up on. Keyed off the list itself rather than off `price`
        // so the two can never disagree.
        settlementChains: quote.settlementChains.length > 0 ? [...quote.settlementChains] : null,
        prices: chainPrices[index],
      };
    });

    return { tools: tools.sort((a, b) => a.name.localeCompare(b.name)) };
  }

  /**
   * The price a call pays on each chain the tool settles on, with the provider
   * whose listing sets it.
   *
   * Each chain is priced by the router itself with the payer narrowed to that
   * one chain, so every figure is `quote()`'s own answer for a buyer funded
   * there — the dearest eligible binding on that chain. The candidates are
   * read once ({@link ProviderRouterService.snapshotCandidates}) and every
   * chain is priced from that one snapshot, so the chain lines agree with
   * each other. A tool on one chain reuses the tool's own quote, which is
   * that same question. A chain that cannot be priced right now is left out.
   *
   * `providerId` and `listings` come from the router's own priced set, so a
   * binding the router would not route to (understaked, at its ceiling, in a
   * slash hold) never names a price: `providerId` is the one provider at the
   * quoted price, or `null` when several are; `listings` is how many eligible
   * bindings the price was taken over.
   *
   * `listed` is the tool's providers in the listed market (ACTIVE, not
   * blocked). The router does not apply the account blocklist, so a provider
   * outside it is never named: the public detail route keeps a blocked
   * provider unconfirmable (wave-1 audit I3).
   */
  private async pricesPerChain(
    tool: Tool,
    quote: ToolQuote,
    context: RoutingContext,
    listed: ReadonlySet<string>,
  ): Promise<CatalogueChainPriceDto[]> {
    const chains = quote.settlementChains;
    if (quote.price === null || chains.length === 0) return [];
    if (chains.length === 1) return [chainPrice(chains[0], quote, listed)].filter(isPriced);

    try {
      const candidates = await this.router.snapshotCandidates(tool.id);
      return chains
        .map((chainId) => {
          try {
            return chainPrice(
              chainId,
              this.router.quoteFromCandidates(tool, candidates, {
                ...context,
                payerChains: [chainId],
                defaultChainId: chainId,
              }),
              listed,
            );
          } catch (error: unknown) {
            this.warnChain(tool, chainId, error);
            return null;
          }
        })
        .filter(isPriced);
    } catch (error: unknown) {
      this.warnChain(tool, 'every chain', error);
      return [];
    }
  }

  private warnChain(tool: Tool, chain: string, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    this.logger.warn(`${tool.name} (${tool.id}) on ${chain}: quote failed — ${reason}`);
  }

  /**
   * A served tool's published versions and their changelog (design spec §7.5:
   * the deprecation shows in the catalogue). Any tool in the catalogue, served
   * or not right now; a DRAFT tool is in none and is a 404.
   */
  async toolVersions(toolId: string): Promise<ToolVersionListDto> {
    const tool = await this.catalogue.findTool(toolId);
    // Only the LISTED catalogue: an UNLISTED tool's contract is its link's to share.
    if (!tool || !isListedTool(tool)) throw ToolErrors.toolNotFound({ toolId });
    const current = currentContractVersion(tool);
    const { market } = await this.window();
    return {
      toolId: tool.id,
      name: tool.name,
      currentVersion: current?.semver ?? null,
      versions: contractVersionsOf(tool).map((version) =>
        ToolContractVersionDto.of(version, tool.currentVersion ?? current?.version),
      ),
      providers: providerDeclarationsOf(market, tool.id),
    };
  }

  /**
   * The provider rows behind a set of ids.
   *
   * A perfectly ordinary **scoped** read that happens to name organizations
   * other than the caller's — legal because `providerId === organizationId`,
   * and the same idiom `ProviderVerificationService.getVerifications` uses to
   * answer "is this provider verified?" about a provider who is, by definition,
   * never the caller. No `IS NOT NULL` escape hatch is involved. One `IN`
   * query for the whole set, never one per provider.
   */
  private async providerRows(
    providerIds: readonly string[],
  ): Promise<ReadonlyMap<string, ProviderEntity>> {
    if (providerIds.length === 0) return new Map();

    const rows = await this.providers.find({
      where: { organizationId: In([...providerIds]) },
    });

    return new Map(rows.map((row) => [row.organizationId, row]));
  }

  /**
   * Bonded stake **per chain** — a list, never a sum — degrading to
   * an empty list rather than failing the page.
   *
   * ## Why a list
   *
   * The card used to carry one number and a buyer read it as *"how much is
   * behind a call I make here"*. A call settles on one chain and is backed only
   * by that chain's collateral, so a **sum** advertises protection no single
   * call has: $40 on Solana plus $40 on `eip155:4663` renders as $80 and clears
   * a floor neither chain clears. Reporting the **lowest** cannot be
   * implemented either — a `Money.asset` is CAIP-19 and names its own chain, so
   * two readings on two chains are two different assets, always, and
   * `MoneyUtil` refuses to compare across them for the right reason: USDC on
   * Solana and USDC on 4663 share a symbol and a scale and are not the same
   * claim on anybody. And picking one chain's figure presents it wearing the
   * provider's name.
   *
   * The previous answer — `null` for two chains — collided with the meaning
   * `null` already carried in this DTO (*"the source cannot say"*), so a
   * provider that **complies** with the per-chain floor by staking on every chain
   * it serves rendered identically to one whose RPC was down, and the card
   * rewarded the narrower commitment. This screen must not hide what it knows.
   * `catalogue.service.spec.ts` pinned the INVARIANT (never a sum, never one
   * chain's figure as the provider's) rather than the value, so this change
   * deletes no passing assertion.
   *
   * ## Absent is still not zero
   *
   * A chain with a reading of zero appears as a zero-amount entry; a chain
   * nobody could read does not appear at all. An empty list is therefore "we do
   * not know", exactly as `null` was, and the distinction survives to the
   * screen.
   *
   * ## Why the chain set comes from the enrolments
   *
   * A stake reading resolves through the enrolment's stake authority, so a
   * chain with no enrolment is absent by construction and asking about it would
   * be a question with a known answer. It also keeps a provider who has paused
   * every binding — {@link getProvider} still renders for them — from losing
   * their stake figures, which taking the chains off the bindings would do.
   *
   * ## Why it never throws
   *
   * `stakeOn` reaches an RPC in `chain` mode, and a catalogue that 500s because
   * a Solana endpoint hiccuped is worse than one whose stake column reads "—".
   * `PlatformHealthService.stakeLocked` takes the same escape for the same
   * reason.
   */
  private async cardStakes(
    providerIds: readonly string[],
  ): Promise<ReadonlyMap<string, CatalogueChainStakeDto[]>> {
    const byProvider = new Map<string, CatalogueChainStakeDto[]>();
    if (providerIds.length === 0) return byProvider;

    try {
      const enrolments = await this.enrolments.enrolmentsOf(providerIds);
      const keys = [...enrolments.values()].map((enrolment) => ({
        providerId: enrolment.providerId,
        chainId: enrolment.chainId,
      }));
      if (keys.length === 0) return byProvider;

      for (const reading of (await this.stakes.stakeOn(keys)).values()) {
        byProvider.set(reading.providerId, [
          ...(byProvider.get(reading.providerId) ?? []),
          {
            // Off the READING's own `chainId`, not off the key it was filed
            // under: the two are the same for every production source today,
            // and the reading is the one that came back with the money.
            chainId: reading.chainId,
            amount: reading.staked.amount,
            asset: reading.staked.asset,
            decimals: reading.staked.decimals,
          },
        ]);
      }

      // A stable order, so two loads of the same page do not reorder the rows.
      // `stakeOn` makes no promise about the order of its map.
      for (const entries of byProvider.values()) {
        entries.sort((a, b) => a.chainId.localeCompare(b.chainId));
      }
    } catch {
      return new Map();
    }

    return byProvider;
  }

  private toProviderDto(
    row: ProviderEntity,
    own: readonly ToolBinding[],
    stake: readonly CatalogueChainStakeDto[],
    counters: ProviderQualityCounters | null,
    chains: readonly string[],
  ): CatalogueProviderDto {
    return {
      providerId: row.organizationId,
      legalName: row.legalName,
      verified: row.verified,
      verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
      tier: row.tier,
      toolIds: [...new Set(own.map((binding) => binding.toolId))].sort(),
      activeBindings: own.length,
      fromPrice: cheapest(own),
      stake: [...stake],
      quality: toQualityDto(counters),
      chains: [...chains],
      servesYou: null,
    };
  }
}

/** A tool's served chains as the wire carries them; absent (not asked) reads as unknown. */
function chainsOf(chains: readonly ChainId[] | null | undefined): string[] | null {
  return chains ? [...chains] : null;
}

/** Every chain any of the lists names, in the enabled order they came in. */
function unionOf(lists: readonly (readonly ChainId[] | null)[]): string[] {
  return [...new Set(lists.flatMap((chains) => chains ?? []))];
}

/**
 * Whether any listing takes a call on one of `yours`: true as soon as one
 * does; `null` when none does and at least one could not be read; else false.
 */
export function servesYouOf(
  lists: readonly (readonly string[] | null)[],
  yours: ReadonlySet<string>,
): boolean | null {
  if (lists.some((chains) => chains?.some((chainId) => yours.has(chainId)))) return true;
  return lists.some((chains) => chains === null) ? null : false;
}

/**
 * `verifiedCalls === 0` is **not** 100%.
 *
 * A provider whose windows all closed empty has been measured on nothing, and
 * dividing by zero into a `1` would put the least-proven provider at the top of
 * a list sorted by quality. Null, and the screen says "not measured".
 */
function toQualityDto(counters: ProviderQualityCounters | null): CatalogueQualityDto | null {
  if (!counters || counters.verifiedCalls === 0) return null;

  return {
    rate: (counters.verifiedCalls - counters.failedCalls) / counters.verifiedCalls,
    measuredCalls: counters.verifiedCalls,
    failedCalls: counters.failedCalls,
  };
}

/**
 * Cheapest `ACTIVE` binding at its published price, compared as integers.
 *
 * `price_amount` is `numeric(78,0)` and arrives as a string, so the comparison
 * is `BigInt` rather than `Number` — a price beyond 2^53 minor units compares
 * wrong under float arithmetic, silently, and the wrongness lands on money.
 * Every binding on a deployment prices in the one settlement asset, so a
 * min across them is meaningful; the asset is carried on the answer rather
 * than assumed by the reader.
 */
function cheapest(bindings: readonly ToolBinding[]): CatalogueMoneyDto | null {
  let best: ToolBinding | null = null;

  for (const binding of bindings) {
    if (!best || BigInt(binding.priceAmount) < BigInt(best.priceAmount)) best = binding;
  }

  return best ? money(best) : null;
}

/**
 * One chain's entry from the router's quote for a payer on that chain; `null`
 * when it has no price. The provider is named only when it is in `listed`.
 */
function chainPrice(
  chainId: ChainId,
  quote: ToolQuote,
  listed: ReadonlySet<string>,
): CatalogueChainPriceDto | null {
  if (quote.price === null) return null;
  const pricedBy = quote.pricedBy ?? [];
  return {
    chainId,
    price: toMoneyDto(quote.price),
    providerId: pricedBy.length === 1 && listed.has(pricedBy[0]) ? pricedBy[0] : null,
    listings: quote.listings ?? 0,
  };
}

function isPriced(entry: CatalogueChainPriceDto | null): entry is CatalogueChainPriceDto {
  return entry !== null;
}

function money(binding: ToolBinding): CatalogueMoneyDto {
  return toMoneyDto(
    MoneyUtil.of(binding.priceAmount, binding.assetId as AssetId, decimalsOf(binding.assetId)),
  );
}

/**
 * The scale a binding's price is quoted in.
 *
 * `tool_bindings` stores the asset but not its scale, and the asset registry is
 * behind the `chains/` boundary. Six is the scale of every asset this
 * deployment settles in (USDC, USDT and PYUSD all use it) and is what
 * `MoneyUtil` is handed everywhere else in this codebase for the same reason.
 * Named as a constant with this comment rather than inlined, so that the day an
 * asset with a different scale is registered, the thing to change is findable.
 */
function decimalsOf(_assetId: string): number {
  return 6;
}

function toMoneyDto(value: Money): CatalogueMoneyDto {
  return {
    amount: MoneyUtil.toAtomic(value).toString(),
    asset: value.asset,
    decimals: value.decimals,
  };
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();

  for (const item of items) {
    const group = map.get(key(item));
    if (group) group.push(item);
    else map.set(key(item), [item]);
  }

  return map;
}

/**
 * Measured quality first, then name.
 *
 * A provider with no measurement sorts **below** every measured one rather than
 * at the top or in name order among them: "not measured" is a weaker claim than
 * any rate, including a bad one, and a default sort that led with the unproven
 * would undo the point of measuring. Name breaks the tie, so two providers with
 * identical quality — which is the normal case on seeded data — do not swap
 * places between requests.
 */
function byQualityThenName(a: CatalogueProviderDto, b: CatalogueProviderDto): number {
  const left = a.quality?.rate ?? -1;
  const right = b.quality?.rate ?? -1;

  if (left !== right) return right - left;
  return a.legalName.localeCompare(b.legalName);
}

/** The contract-version half of a catalogue tool card (T3). */
export function versionFieldsOf(
  tool: Tool,
  isPublicTool: (toolId: string) => boolean = () => true,
): {
  summary: string;
  version: string | null;
  versions: ToolVersionBriefDto[];
  deprecatedMajors: number[];
  replacementToolId: string | null;
  replacementName: string | null;
  replacementMajor: number | null;
  replacementVersion: string | null;
} {
  const current = currentContractVersion(tool);
  const versions = contractVersionsOf(tool);
  const deprecatedMajors = [
    ...new Set(
      versions
        .filter((version) => version.status === ToolVersionStatus.DEPRECATED)
        .map((version) => version.major),
    ),
  ].sort((a, b) => a - b);
  // What replaces the newest deprecated major; never a tool the catalogue does not list.
  const found =
    deprecatedMajors.length > 0
      ? contractReplacementOf(tool, { major: deprecatedMajors[deprecatedMajors.length - 1] })
      : null;
  const replacement =
    found && (found.toolId === tool.id || isPublicTool(found.toolId)) ? found : null;
  return {
    summary: versionOf(tool).summary,
    version: current?.semver ?? null,
    versions: versions.map((version) =>
      ToolVersionBriefDto.of(version, tool.currentVersion ?? current?.version),
    ),
    deprecatedMajors,
    replacementToolId: replacement?.toolId ?? null,
    replacementName: replacement?.name ?? null,
    replacementMajor: replacement?.major ?? null,
    replacementVersion: replacement?.semver ?? null,
  };
}

/**
 * What each listed provider declares for `toolId`, from the window's market
 * (listed providers' ACTIVE bindings at their published revision only).
 */
export function providerDeclarationsOf(
  market: ListedMarket,
  toolId: string,
): ToolVersionProviderDto[] {
  const byProvider = groupBy(
    market.bindings.filter((binding) => binding.toolId === toolId),
    (binding) => binding.providerId,
  );
  const rows: ToolVersionProviderDto[] = [];
  for (const [providerId, own] of byProvider) {
    const row = market.rows.get(providerId);
    if (!row) continue;
    rows.push({
      providerId,
      legalName: row.legalName,
      servedMajors: sortedUnion(own.flatMap((binding) => bindingRange(binding.toolVersionRange))),
      providesOutputFields: sortedUnion(
        own.flatMap((binding) => binding.providesOutputFields ?? []),
      ),
      supportsInputFields: sortedUnion(own.flatMap((binding) => binding.supportsInputFields ?? [])),
    });
  }
  return rows.sort((a, b) => a.legalName.localeCompare(b.legalName));
}

function sortedUnion<T extends number | string>(items: readonly T[]): T[] {
  return [...new Set(items)].sort((a, b) =>
    typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)),
  );
}
