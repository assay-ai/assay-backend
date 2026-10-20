import { readFileSync } from 'node:fs';

import { isRegisteredAsset, registeredAssets } from '@modules/chains/ports/asset-registry';
import { ChainId, isChainId } from '@modules/chains/ports/caip.types';

import { normalizeRequestMapping, normalizeResponseMapping } from '../domain/mapping';
import { contractProblems } from '../domain/contract/contract-shape';
import { summaryOf } from '../domain/contract/contract-versions';
import { assertNoReservedToolNames } from '../domain/reserved-tool-names';
import { Tool, ToolBinding, UNCATEGORISED } from '../ports/tool.types';
import { EMPTY_TOOL_CATALOGUE, ToolCatalogueSnapshot } from './in-memory-tool-catalogue';

/**
 * The catalogue, from a file.
 *
 * `InMemoryToolCatalogue` was written to be seeded and has, until now, only
 * ever been seeded empty — which makes a router with nothing to route and an
 * MCP server with an empty `tools/list`. This is the loader the class's own doc
 * comment anticipates: *"the seed is also how the launch catalogue gets in
 * front of a real router before the console exists to author one."*
 *
 * It reads a file rather than an environment variable because the payload is a
 * catalogue — schemas, mappings, prices — and because the binding editor
 * writes the same shape into `tool_bindings`. Keeping it as a document means the
 * migration is "load these rows" rather than "re-type this configuration".
 *
 * ## Mappings are normalised here, not trusted
 *
 * `docs/mapping-format.md` accepts sugar — bare-string selectors, `$from` with
 * sibling item keys — and the canonical `$`-directive form is what every
 * consumer expects. `normalizeRequestMapping` / `normalizeResponseMapping` is
 * the same pass the binding editor runs at Save, so a hand-written seed and a
 * console-authored binding produce identical stored specs, and a malformed
 * mapping fails **at boot** rather than on the first agent that calls the tool.
 */
export function loadToolCatalogue(
  path = process.env.TOOL_CATALOGUE_SEED_FILE,
  inline = process.env.TOOL_CATALOGUE_SEED_JSON,
): ToolCatalogueSnapshot {
  // A deployment config key with no value arrives as an empty string, and at least one
  // role map ships exactly such a placeholder. Blank means "not configured".
  const document_ = (inline ?? '').trim();
  const hasInline = document_.length > 0;

  if (path && hasInline) {
    throw new Error(
      'TOOL_CATALOGUE_SEED_FILE and TOOL_CATALOGUE_SEED_JSON are both set. ' +
        'Two sources for one catalogue disagree silently, and the catalogue is what the ' +
        'router substitutes providers against. Unset one.',
    );
  }

  if (!path && !hasInline) return EMPTY_TOOL_CATALOGUE;

  // Named for the error messages below. A message that says
  // `TOOL_CATALOGUE_SEED_FILE (undefined)` when the document came from an
  // environment variable sends the reader looking for a mount that was never
  // the problem.
  const source = path ? `TOOL_CATALOGUE_SEED_FILE (${path})` : 'TOOL_CATALOGUE_SEED_JSON';

  const parsed: unknown = JSON.parse(path ? readFileSync(path, 'utf8') : document_);
  const document = parsed as { tools?: unknown; bindings?: unknown };

  if (!Array.isArray(document.tools) || !Array.isArray(document.bindings)) {
    throw new Error(`${source} must be a JSON object with "tools" and "bindings" arrays`);
  }

  const tools = (document.tools as Tool[]).map((tool) => withCategory(tool, source));
  const bindings = (document.bindings as RawBinding[]).map((binding) => ({
    ...binding,
    requestMapping: normalizeRequestMapping(binding.requestMapping),
    responseMapping: normalizeResponseMapping(binding.responseMapping),
  })) as ToolBinding[];

  // A binding whose tool is not in the same document is a binding no router
  // will ever reach, and it would be discovered as "this tool has no providers"
  // — a supply problem — rather than as the typo it is.
  const known = new Set(tools.map((tool) => tool.id));
  for (const binding of bindings) {
    if (!known.has(binding.toolId)) {
      throw new Error(`${source}: binding ${binding.id} references unknown tool ${binding.toolId}`);
    }

    // **The failure this check exists for is silent.** A binding priced in an
    // asset the platform does not hold produces a perfectly good quote, a
    // perfectly good intent, and a hold against a balance bucket that is empty
    // by construction — so every call is refused with "insufficient funds" for
    // an agent that has been funded. `SOLANA_DEVNET_USDC_MINT` makes the devnet
    // asset id deployment-specific, so a seed written against one deployment
    // and loaded on another lands exactly there. Boot loudly instead.
    if (!isRegisteredAsset(binding.assetId)) {
      throw new Error(
        `${source}: binding ${binding.id} is priced in ` +
          `${binding.assetId}, which is not a registered asset. On devnet this is ` +
          `usually SOLANA_DEVNET_USDC_MINT disagreeing with the seed.`,
      );
    }

    // The chains the binding is offered on. Checked at boot for
    // the same reason the asset is: the column is `NOT NULL` with a non-empty
    // CHECK, so a seed that omits it or names nonsense is a row the database
    // will refuse — and it would refuse it during whatever import writes the
    // seed, far from the file that is actually wrong.
    const chains = binding.settlementChains;
    if (!Array.isArray(chains) || chains.length === 0) {
      throw new Error(
        `${source}: binding ${binding.id} names no ` +
          `settlementChains. A binding offered on no chain routes nowhere, and ` +
          `chk_tool_bindings_settlement_chains refuses the empty array.`,
      );
    }

    for (const chain of chains) {
      if (!isChainId(chain)) {
        throw new Error(
          `${source}: binding ${binding.id} names ` +
            `"${chain}" in settlementChains, which is not a CAIP-2 chain id.`,
        );
      }

      // Not just "well-formed" — a chain nothing settles in is a chain this
      // deployment cannot quote a price on, so a binding offered there produces
      // a candidate no settlement asset exists for. Boot loudly rather than
      // discover it as a tool with no providers.
      if (!settleableChains().has(chain)) {
        throw new Error(
          `${source}: binding ${binding.id} is offered on ` +
            `${chain}, where no registered asset lives. On offer: ` +
            `[${[...settleableChains()].join(', ')}].`,
        );
      }
    }
  }

  return Object.freeze({ tools: Object.freeze(tools), bindings: Object.freeze(bindings) });
}

/**
 * Every chain a registered asset lives on — the chains this deployment can
 * quote a price in.
 *
 * Computed per call rather than at module load: `ASSET_IDS.USDC_SOLANA_DEVNET`
 * resolves `SOLANA_DEVNET_USDC_MINT` at import time, and a module-level
 * `Set` here would freeze the answer before a test that re-imports the registry
 * under a different mint could change it. The seed is loaded once at boot, so
 * the cost is one pass over a two-entry registry.
 *
 * `asset.chainId` is read off the registry entry rather than parsed back out of
 * `asset.assetId`. The registry already declares it, and the derivation set
 * — the seven `chainIdOf(...assetId)` expressions enumerated in
 * `tool/domain/routing/eligibility.ts`, three of which have since moved to
 * `chooseSettlementChain` — is closed: an eighth here would be one more site
 * answering "which chain does this settle on" out of an asset id, in a file
 * that has no business deciding it.
 */
function settleableChains(): ReadonlySet<ChainId> {
  return new Set(registeredAssets().map((asset) => asset.chainId));
}

const STANDARD_TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,47}$/;
const CATEGORY_RE = /^[a-z][a-z0-9-]{1,63}$/;
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * A seeded tool with its `category` and `tags` checked, and defaulted when the
 * document omits them (hand-written test seeds do).
 *
 * Checked here for the reason assets are: `tools` refuses a malformed name or
 * category with a CHECK, and the refusal would surface in the boot-time upsert,
 * far from the file that is wrong.
 */
function withCategory(tool: Tool, source: string): Tool {
  if (!STANDARD_TOOL_NAME_RE.test(tool.name) || tool.name.includes('__')) {
    throw new Error(
      `${source}: tool ${tool.id} is named "${tool.name}", which is not a standard tool name ` +
        `(snake_case, at most 48 characters, no "__")`,
    );
  }
  assertNoReservedToolNames([tool.name], source);

  const category = tool.category ?? UNCATEGORISED;
  if (!CATEGORY_RE.test(category)) {
    throw new Error(
      `${source}: tool ${tool.name} has category "${category}", expected ${CATEGORY_RE}`,
    );
  }

  const tags = tool.tags ?? [];
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string' || !TAG_RE.test(tag))) {
    throw new Error(`${source}: tool ${tool.name} has tags that are not each ${TAG_RE}`);
  }

  // The seed writes version 1.0.0 of the contract (design spec §11.2), so it
  // is held to what the contract editor holds a version to.
  const seeded = tool as Tool & {
    summary?: string;
    optionalInputFields?: string[];
    optionalOutputFields?: string[];
    examples?: unknown[];
  };
  const problems = contractProblems({
    summary: seeded.summary ?? summaryOf(tool.description ?? ''),
    description: tool.description ?? '',
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    optionalInputFields: seeded.optionalInputFields ?? [],
    optionalOutputFields: seeded.optionalOutputFields ?? [],
    examples: seeded.examples ?? [],
    verificationPolicyId: tool.verificationPolicyId ?? null,
    tier: tool.tier ?? null,
  });
  if (problems.length > 0) {
    throw new Error(`${source}: tool ${tool.name} is not a valid contract: ${problems.join('; ')}`);
  }

  return { ...tool, category, tags: [...new Set(tags)] };
}

/** A binding as written in the seed: mappings still in sugar form. */
type RawBinding = Omit<ToolBinding, 'requestMapping' | 'responseMapping'> & {
  requestMapping: unknown;
  responseMapping: unknown;
};
