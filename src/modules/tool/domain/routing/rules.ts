import { Money } from '@modules/chains/ports/money.types';
import { ProviderTier } from '@modules/provider/ports/provider.types';
import { MoneyUtil } from '@utils/money.util';

import { getAssetMetadata } from '@modules/chains/ports/asset-registry';

import { RoutingCandidate } from './routing.types';

/**
 * Buyer-chosen provider rules: the agent's rules and a toolset entry's rules,
 * merged so the stricter one wins (design spec §7.3, FR-4, FR-5).
 *
 * ```text
 * allowProviderIds   = entry ONLY set (or all)                        TOOLSET
 * excludeByToolset   = entry EXCLUDE set                              TOOLSET
 * excludeByAgent     = agent excluded providers                       AGENT
 * minTier            = the higher of the two                          stricter side
 * maxPrice           = the lower of the two, per asset                stricter side
 * minQuality         = the higher of the two                          stricter side
 * ```
 *
 * These are **not** the failover exclusion. `RoutingContext.excludeProviderIds`
 * keeps its meaning (already tried in this request) and reports
 * `PROVIDER_EXCLUDED`; folding a buyer's exclusions into it would lose which
 * party asked for the exclusion, and the refusal has to name it (FR-6).
 *
 * Every rejection here is the buyer's choice, never a provider-quality event:
 * it does not count toward a circuit breaker, does not enter `ProviderStats`,
 * is not a strike, and is not a routing rejection on the provider's console.
 * The router records none of them anywhere but the refusal it returns.
 */

/**
 * Which party a rule came from. `REQUEST` and `MIGRATION` are the contract's
 * hard constraints (T3): an optional input the call's arguments use, and a
 * binding whose version range does not cover the contract version chosen.
 */
export enum RuleSource {
  AGENT = 'AGENT',
  TOOLSET = 'TOOLSET',
  REQUEST = 'REQUEST',
  MIGRATION = 'MIGRATION',
}

/** Why the rules dropped a candidate. Never a provider-quality reason. */
export enum RuleRejectionReason {
  /** The entry is ONLY and this provider is not in its list. */
  NOT_IN_ALLOWED_PROVIDERS = 'NOT_IN_ALLOWED_PROVIDERS',
  /** The entry is EXCLUDE and lists this provider. */
  EXCLUDED_BY_TOOLSET = 'EXCLUDED_BY_TOOLSET',
  /** The agent's rules exclude this provider. */
  EXCLUDED_BY_AGENT = 'EXCLUDED_BY_AGENT',
  /** `ProviderTier` below the minimum. */
  BELOW_MIN_TIER = 'BELOW_MIN_TIER',
  /** The price is above the maximum, or in another asset and so not comparable. */
  ABOVE_MAX_PRICE = 'ABOVE_MAX_PRICE',
  /** Quality below the minimum. Inert until backlog G1.1 (see {@link MIN_QUALITY_ENFORCED}). */
  BELOW_MIN_QUALITY = 'BELOW_MIN_QUALITY',
  /** Rail B: the payee the voucher pins fails the rules at retry time. */
  PAYEE_NO_LONGER_ELIGIBLE = 'PAYEE_NO_LONGER_ELIGIBLE',
  /** T3: the binding does not declare an output the toolset entry requires. */
  MISSING_OUTPUT_FIELD = 'MISSING_OUTPUT_FIELD',
  /** T3: the binding does not support an optional input the arguments use. */
  UNSUPPORTED_INPUT_FIELD = 'UNSUPPORTED_INPUT_FIELD',
  /** T3: the binding's version range does not cover the chosen contract version. */
  CONTRACT_VERSION_MISMATCH = 'CONTRACT_VERSION_MISMATCH',
}

/** `BEST` (Assay picks), `ONLY` these providers, or all `EXCEPT` these. */
export enum ProviderMode {
  BEST = 'BEST',
  ONLY = 'ONLY',
  EXCLUDE = 'EXCLUDE',
}

/** What a toolset entry does when its rules leave no provider. */
export enum OnEmpty {
  FAIL = 'FAIL',
  FALLBACK_BEST = 'FALLBACK_BEST',
}

/**
 * `min_quality` is stored and validated but has no effect until backlog G1.1
 * ships the measured quality it compares against (spec §7.3, "Quality").
 */
export const MIN_QUALITY_ENFORCED = false;

/** The agent's rules: applied on every URL, never relaxed by FALLBACK_BEST. */
export interface AgentRoutingRules {
  readonly excludeProviderIds: readonly string[];
  /** In the spend policy's asset. */
  readonly maxPrice: Money | null;
  readonly minTier: ProviderTier | null;
  readonly minQuality: number | null;
}

/** A toolset entry's rules. Applied only on that toolset's URL. */
export interface EntryRoutingRules {
  readonly mode: ProviderMode;
  readonly providerIds: readonly string[];
  readonly minTier: ProviderTier | null;
  readonly maxPrice: Money | null;
  readonly minQuality: number | null;
  readonly onEmpty: OnEmpty;
}

/** Both halves, as `RoutingContext.rules` carries them. */
export interface RoutingRules {
  readonly agent: AgentRoutingRules | null;
  readonly entry: EntryRoutingRules | null;
}

export interface SourcedLimit<T> {
  readonly value: T;
  readonly source: RuleSource;
}

/** The two halves combined — see the file header for the table. */
export interface MergedRules {
  readonly allowProviderIds: ReadonlySet<string> | null;
  readonly excludeByToolset: ReadonlySet<string>;
  readonly excludeByAgent: ReadonlySet<string>;
  readonly minTier: SourcedLimit<ProviderTier> | null;
  /** One per asset: two maxima in different assets cannot be compared, so both apply. */
  readonly maxPrices: readonly SourcedLimit<Money>[];
  readonly minQuality: SourcedLimit<number> | null;
}

/** One candidate the rules dropped, with the party whose rule did it. */
export interface RuleRejection {
  readonly candidate: RoutingCandidate;
  readonly reason: RuleRejectionReason;
  readonly source: RuleSource;
  readonly detail: string;
  /** The contract fields behind an `UNSUPPORTED_INPUT_FIELD` or `MISSING_OUTPUT_FIELD`. */
  readonly fields?: readonly string[];
  /** `CONTRACT_VERSION_MISMATCH`: the majors the binding's range covers. */
  readonly servedMajors?: readonly number[];
  /** `CONTRACT_VERSION_MISMATCH`: the major of the version the call is routed at. */
  readonly requestedMajor?: number;
  /** `CONTRACT_VERSION_MISMATCH`: the majors the call may use; `null` when unconstrained. */
  readonly requestedRange?: readonly number[] | null;
}

export const NO_RULES: RoutingRules = Object.freeze({ agent: null, entry: null });

const TIER_RANK: Readonly<Record<ProviderTier, number>> = Object.freeze({
  [ProviderTier.NEW]: 0,
  [ProviderTier.ESTABLISHED]: 1,
  [ProviderTier.TRUSTED]: 2,
});

/** Whether `rules` constrains anything at all. */
export function hasRules(rules: RoutingRules | null | undefined): boolean {
  return Boolean(rules && (rules.agent || rules.entry));
}

/**
 * The two halves, merged. The stricter side wins every limit, and a tie goes
 * to the agent: agent rules are the ones guaranteed on every URL, so naming
 * them keeps the refusal's fix pointing at the setting that always applies.
 */
export function mergeRules(rules: RoutingRules): MergedRules {
  const { agent, entry } = rules;

  const minTier = stricter<ProviderTier>(
    agent?.minTier ? { value: agent.minTier, source: RuleSource.AGENT } : null,
    entry?.minTier ? { value: entry.minTier, source: RuleSource.TOOLSET } : null,
    (a, b) => TIER_RANK[a] - TIER_RANK[b],
  );

  const minQuality = stricter<number>(
    agent?.minQuality != null ? { value: agent.minQuality, source: RuleSource.AGENT } : null,
    entry?.minQuality != null ? { value: entry.minQuality, source: RuleSource.TOOLSET } : null,
    (a, b) => a - b,
  );

  const maxPrices: SourcedLimit<Money>[] = [];
  const agentMax = agent?.maxPrice ? { value: agent.maxPrice, source: RuleSource.AGENT } : null;
  const entryMax = entry?.maxPrice ? { value: entry.maxPrice, source: RuleSource.TOOLSET } : null;
  if (agentMax && entryMax && agentMax.value.asset === entryMax.value.asset) {
    // Lower wins; the higher limit would never be the one that refused.
    maxPrices.push(MoneyUtil.greaterThan(agentMax.value, entryMax.value) ? entryMax : agentMax);
  } else {
    if (agentMax) maxPrices.push(agentMax);
    if (entryMax) maxPrices.push(entryMax);
  }

  return {
    allowProviderIds: entry?.mode === ProviderMode.ONLY ? new Set(entry.providerIds) : null,
    excludeByToolset: entry?.mode === ProviderMode.EXCLUDE ? new Set(entry.providerIds) : new Set(),
    excludeByAgent: new Set(agent?.excludeProviderIds ?? []),
    minTier,
    maxPrices,
    minQuality,
  };
}

/** The rules with the entry's preferences dropped: what FALLBACK_BEST routes under. */
export function withoutEntryPreferences(rules: RoutingRules): RoutingRules {
  return { agent: rules.agent, entry: null };
}

/**
 * Why `merged` drops `candidate`, or `null` when it passes.
 *
 * The order decides which reason is reported when several apply: the
 * provider lists first (they name this provider specifically), then the
 * limits. A price in another asset fails `ABOVE_MAX_PRICE` — there is no
 * conversion (spec §7.3, "Price").
 */
export function evaluateRules(
  candidate: RoutingCandidate,
  merged: MergedRules,
  options: { readonly enforceMinQuality?: boolean } = {},
): Omit<RuleRejection, 'candidate'> | null {
  const { binding, provider } = candidate;
  const providerId = binding.providerId;

  if (merged.allowProviderIds && !merged.allowProviderIds.has(providerId)) {
    return {
      reason: RuleRejectionReason.NOT_IN_ALLOWED_PROVIDERS,
      source: RuleSource.TOOLSET,
      detail: `provider ${providerId} is not in the toolset entry's provider list`,
    };
  }
  if (merged.excludeByAgent.has(providerId)) {
    return {
      reason: RuleRejectionReason.EXCLUDED_BY_AGENT,
      source: RuleSource.AGENT,
      detail: `provider ${providerId} is excluded by this agent's provider limits`,
    };
  }
  if (merged.excludeByToolset.has(providerId)) {
    return {
      reason: RuleRejectionReason.EXCLUDED_BY_TOOLSET,
      source: RuleSource.TOOLSET,
      detail: `provider ${providerId} is excluded by the toolset entry`,
    };
  }

  if (merged.minTier && TIER_RANK[provider.tier] < TIER_RANK[merged.minTier.value]) {
    return {
      reason: RuleRejectionReason.BELOW_MIN_TIER,
      source: merged.minTier.source,
      detail: `provider tier ${provider.tier} is below ${merged.minTier.value}`,
    };
  }

  for (const max of merged.maxPrices) {
    if (binding.assetId !== max.value.asset) {
      return {
        reason: RuleRejectionReason.ABOVE_MAX_PRICE,
        source: max.source,
        detail: `priced in a different asset (${binding.assetId}) than the limit (${max.value.asset})`,
      };
    }
    const price = MoneyUtil.of(
      binding.priceAmount,
      binding.assetId,
      getAssetMetadata(binding.assetId).decimals,
    );
    if (MoneyUtil.greaterThan(price, max.value)) {
      return {
        reason: RuleRejectionReason.ABOVE_MAX_PRICE,
        source: max.source,
        detail: `price ${price.amount} is above the limit ${max.value.amount}`,
      };
    }
  }

  const enforceQuality = options.enforceMinQuality ?? MIN_QUALITY_ENFORCED;
  if (enforceQuality && merged.minQuality) {
    // The neutral prior scoring uses for a provider with no measurement yet.
    const quality = provider.stats.paidQualityRate ?? 0.5;
    if (quality < merged.minQuality.value) {
      return {
        reason: RuleRejectionReason.BELOW_MIN_QUALITY,
        source: merged.minQuality.source,
        detail: `quality ${quality} is below ${merged.minQuality.value}`,
      };
    }
  }

  return null;
}

/** Split `candidates` into what the rules keep and what they drop, in order. */
export function applyRules(
  candidates: readonly RoutingCandidate[],
  rules: RoutingRules | null | undefined,
  options: { readonly enforceMinQuality?: boolean } = {},
): { readonly kept: readonly RoutingCandidate[]; readonly rejected: readonly RuleRejection[] } {
  if (!hasRules(rules)) return { kept: candidates, rejected: [] };

  const merged = mergeRules(rules as RoutingRules);
  const kept: RoutingCandidate[] = [];
  const rejected: RuleRejection[] = [];
  for (const candidate of candidates) {
    const verdict = evaluateRules(candidate, merged, options);
    if (verdict) rejected.push({ candidate, ...verdict });
    else kept.push(candidate);
  }
  return { kept, rejected };
}

/**
 * The refusal layer a set of rule rejections belongs to: the agent's limits
 * whenever one of them is the agent's (they apply on every URL, so they are
 * the setting to look at first), then the toolset's rules, and otherwise the
 * request or the contract migration — which the caller files under the
 * server, since no limit of the buyer's caused them.
 */
export function rejectionLayer(rejections: readonly Pick<RuleRejection, 'source'>[]): RuleSource {
  if (rejections.some((rejection) => rejection.source === RuleSource.AGENT))
    return RuleSource.AGENT;
  if (rejections.some((rejection) => rejection.source === RuleSource.TOOLSET)) {
    return RuleSource.TOOLSET;
  }
  if (rejections.some((rejection) => rejection.source === RuleSource.REQUEST)) {
    return RuleSource.REQUEST;
  }
  return rejections.length > 0 ? RuleSource.MIGRATION : RuleSource.TOOLSET;
}

function stricter<T>(
  a: SourcedLimit<T> | null,
  b: SourcedLimit<T> | null,
  compare: (left: T, right: T) => number,
): SourcedLimit<T> | null {
  if (!a) return b;
  if (!b) return a;
  return compare(b.value, a.value) > 0 ? b : a;
}
