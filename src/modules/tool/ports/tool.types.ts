import { AssetId, ChainId } from '@modules/chains/ports/caip.types';
import { JsonSchema } from '../domain/mapping/schema-validator';
import { RequestMappingSpec, ResponseMappingSpec } from '../domain/mapping/mapping.types';

/**
 * The tool catalogue and its bindings.
 *
 * ```text
 * Tool                    what the agent calls          "search_web"
 *  └── ToolBinding        one provider's implementation of it
 *       └── Provider      the operator: endpoint, wallet, stake
 * ```
 *
 * A tool has many bindings; a provider has many bindings; routing picks one.
 */

export enum ToolTier {
  UNVERIFIED = 'UNVERIFIED',
  VERIFIED = 'VERIFIED',
  GUARANTEED = 'GUARANTEED',
}

export enum BindingStatus {
  /** Written but never published — not routable, editable freely. */
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  /** Circuit open, or the provider paused it. Takes no strikes. */
  PAUSED = 'PAUSED',
  SUSPENDED = 'SUSPENDED',
}

/**
 * Who stopped the traffic — the other half of {@link BindingStatus.PAUSED}.
 *
 * `PAUSED` has two causes with opposite consequences, which is why the status
 * alone cannot answer "why did my traffic stop". A provider pausing their own
 * binding is a **choice**: no penalty, no effect on accrued earnings, nothing
 * in the quality profile, because declining to serve is not failing to serve.
 * The SLA health circuit opening is a **fault**, and it has to be recorded as
 * one. Both write the same status.
 *
 * The cause is not recoverable after the fact — a `PAUSED` row six weeks old
 * carries no trace of how it got there — so it is written at the moment of
 * pausing or never. `chk_tool_bindings_pause_attributed` makes the pairing a
 * property of the row rather than of whichever service happened to write it.
 *
 * Lives here, next to `BindingStatus`, because the two are read together and
 * the second producer will be the SLA health breaker rather than the provider
 * console. The column is `varchar(24)` with no value CHECK: enumerating members
 * in Postgres before both producers exist would be a guess.
 */
export enum BindingPauseReason {
  /** The provider pressed pause. Takes no strike, leaves no mark. */
  PROVIDER_REQUESTED = 'PROVIDER_REQUESTED',
  /** The SLA health circuit opened. A fault, and recorded as one. */
  HEALTH = 'HEALTH',
  /** Ours — an incident, a migration, an investigation short of `SUSPENDED`. */
  PLATFORM = 'PLATFORM',
}

export enum PricingMode {
  FREE = 'FREE',
  FREEMIUM = 'FREEMIUM',
  PAID = 'PAID',
}

/**
 * What the agent calls, and the only contract it ever sees.
 *
 * `outputSchema` is the load-bearing field. Every binding maps its provider's
 * native shape into it, which is what lets the router substitute one provider
 * for another mid-flight without the agent noticing. A tool whose
 * `outputSchema` is loose is a tool whose bindings cannot be compared, and
 * therefore a tool that cannot be routed on quality.
 */
export interface Tool {
  readonly id: string;
  readonly name: string;
  /** Shown to the agent's model. It drives tool selection, so it is product copy, not a comment. */
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly verificationPolicyId: string;
  readonly tier: ToolTier;
  /**
   * The topic a view filter (`?category=`) and a toolset's inferred category
   * read: `^[a-z][a-z0-9-]{1,63}$`. Optional on the type so hand-built
   * fixtures stay valid; the seed loader always sets it, and a tool without
   * one reads as {@link UNCATEGORISED}.
   */
  readonly category?: string;
  /** Search keywords. Never sent to a model on their own. */
  readonly tags?: readonly string[];
}

/** The category of a tool that declares none. */
export const UNCATEGORISED = 'uncategorised';

/** `tool.category`, never undefined. */
export function categoryOf(tool: Pick<Tool, 'category'>): string {
  return tool.category ?? UNCATEGORISED;
}

/** `tools.kind`. Only STANDARD exists until provider tools (T4). */
export enum ToolKind {
  STANDARD = 'STANDARD',
  PROVIDER = 'PROVIDER',
}

/** `tools.status`. */
export enum ToolStatus {
  ACTIVE = 'ACTIVE',
  DEPRECATED = 'DEPRECATED',
  RETIRED = 'RETIRED',
  REMOVED = 'REMOVED',
}

/**
 * One provider's implementation of a tool.
 *
 * The two mappings are the entire adaptation layer. Everything else here —
 * price, timeout, status — is routing metadata. Note what the binding does
 * *not* carry: nothing the provider must implement, and no credential. The
 * provider never has to change their API, and that holds because a binding
 * describes an endpoint that already exists.
 */
export interface ToolBinding {
  readonly id: string;
  readonly toolId: string;
  readonly providerId: string;

  /** The provider's own URL, unchanged. `requestMapping.path` is appended to it. */
  readonly endpoint: string;
  readonly requestMapping: RequestMappingSpec;
  readonly responseMapping: ResponseMappingSpec;

  readonly pricingMode: PricingMode;
  readonly priceAmount: string;
  readonly assetId: AssetId;

  /**
   * The chains this binding is offered on. Never empty.
   *
   * Read by `filterEligible` as one of three sets it intersects — the others
   * being the buyer's fundable chains and `ENABLED_CHAINS`. It is a *ceiling*
   * on where this binding may settle, never a claim that it can: a chain is
   * removed from the candidate's `settlementChains` when the provider's
   * enrolment there is not ACTIVE, and removed again by the stake gate when the
   * collateral is not there.
   */
  readonly settlementChains: readonly ChainId[];

  readonly freeQuotaPerAgent: number | null;
  /** Free calls per day across all agents (a count, not money); `null` = platform default. */
  readonly freeDailyBudget: number | null;

  /**
   * The provider's self-declared ceilings, or `null` for "none declared".
   *
   * They ride on the binding — and therefore on `RoutingCandidate.binding` —
   * rather than being fetched when a shed decision is taken, because
   * `gatherCandidates` is the hot path and its own doc comment rules out a
   * per-candidate read. A ceiling the router has to go and look up is a
   * ceiling checked once per call against the database.
   *
   * `null` is not `0`. `null` means the provider declared no limit; `0` would
   * mean they declared themselves unroutable, which is what {@link status}
   * `PAUSED` is for.
   *
   * `maxDailyCalls` and never "daily quota": *quota* in this codebase is the
   * AGENT's free-tier allowance — {@link freeQuotaPerAgent} and
   * {@link freeDailyBudget}, on this same object, and `McpErrors.quotaExceeded`
   * — and this is the PROVIDER's upstream limit, the opposite party.
   */
  readonly maxRps: number | null;
  readonly maxDailyCalls: number | null;

  readonly slaFailureRate: number;
  readonly timeoutMs: number;
  readonly status: BindingStatus;

  /**
   * Which stored revision of the mappings this is.
   *
   * A verdict has to be re-evaluable against the mapping that was in force
   * when the call happened (`binding_versions`). Without it, a provider who edits a
   * mapping mid-window and a platform disputing a result have no way to agree
   * on which version produced the response, and the dispute is unwinnable in
   * both directions.
   */
  readonly version: number;
}
