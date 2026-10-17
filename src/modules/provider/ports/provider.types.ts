import { AccountId, ChainId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';

/**
 * The provider, as routing sees it.
 *
 * Only the fields a routing decision actually reads are here. The registration
 * record — legal name, contacts, payout proof, the binding editor's drafts —
 * lives in the provider's own aggregate; putting it in the
 * type the router consumes would make every routing test construct a company.
 */

export enum ProviderTier {
  /** Registered and staked. Routable, but nothing is known about it yet. */
  NEW = 'NEW',
  /** 10,000 calls within its declared SLA. Normal weight and sampling. */
  ESTABLISHED = 'ESTABLISHED',
  /** 100,000 calls, 3 months, no upheld slash. May list `GUARANTEED` tools. */
  TRUSTED = 'TRUSTED',
}

export enum ProviderStatus {
  ACTIVE = 'ACTIVE',
  /** Removed from routing by the platform. */
  SUSPENDED = 'SUSPENDED',
  /** Withdrawing stake. Still serving in-flight work, but taking no new traffic. */
  UNBONDING = 'UNBONDING',
}

/**
 * Observed behaviour, never self-declared.
 *
 * Quality is tracked separately for free and paid traffic because a provider
 * running a deliberately degraded free tier is legitimate, and folding the two
 * together would let free-tier throttling drag down the score that paid traffic
 * routes on — or, worse, let a good free tier subsidise a bad paid one.
 *
 * Every field is optional. A provider that has served nothing has no rates, and
 * inventing a `0` for it would mean "measured, and terrible" rather than "not
 * measured" — the first starves a new provider of the traffic it needs to earn
 * a real score. See `NEUTRAL_PRIOR` in `domain/routing/score.ts`.
 */
export interface ProviderStats {
  /**
   * `1 − SYSTEM_ERROR rate` over the provider-caused PAID attempts in the
   * window: at most `BINDING_STATS_MAX_PER_BUYER` per buyer organization, then
   * the last `BINDING_STATS_WINDOW_SIZE`, none older than 7 days. Free calls
   * do not count — they cost the caller nothing to repeat. See
   * `attributeAttempt` for what counts.
   */
  readonly availabilityRate?: number;
  /** `PASS / (PASS + FAIL)` over the window's paid verdicts (same per-buyer cap), shadow policies excluded. */
  readonly paidQualityRate?: number;
  /** `PASS / DATA_RESULT` on free calls. Not measured: free calls are not verified yet. */
  readonly freeQualityRate?: number;
  /** Over the window's paid `DATA_RESULT` attempts and full-budget timeouts. */
  readonly p50LatencyMs?: number;
  readonly p95LatencyMs?: number;
  readonly callsServed?: number;
  readonly upheldSlashes?: number;
}

/**
 * Everything the router needs about a provider, minus the stake.
 *
 * The stake is deliberately *not* here. It comes from
 * {@link ProviderStakePort}, because it can come from chain
 * state while everything in this interface keeps coming from our own database.
 * One snapshot type carrying both would force that migration to touch the
 * registry, the router and every test that builds a provider.
 */
export interface ProviderRoutingState {
  readonly providerId: string;
  readonly status: ProviderStatus;
  readonly tier: ProviderTier;
  /**
   * Pooled over every binding this provider has — the provider's figure, as
   * its profile shows it. The router prefers {@link bindingStats}.
   */
  readonly stats: ProviderStats;

  /**
   * The same stats per binding, keyed by binding id: what the router scores a
   * candidate on, field by field, falling back to {@link stats} where the
   * binding has too little data of its own (`statsOf` in
   * `tool/domain/routing/score.ts`).
   *
   * Per binding because two bindings of one provider can be two different
   * endpoints, one healthy and one broken, and scoring both on the pooled
   * figure would keep sending the broken one its share. Absent or missing a
   * key: nothing measured for that binding.
   */
  readonly bindingStats?: ReadonlyMap<string, ProviderStats>;

  /**
   * Where this provider is paid, per chain — their ACTIVE enrolments.
   *
   * A Map rather than a nullable scalar because the answer is per chain and
   * because an *absent* chain must be distinguishable from a *null* address.
   * Empty when the provider has no enrolments at all, which is the fail-closed
   * value: `evaluatePayoutGate` refuses every paid binding for such a provider,
   * exactly as `payoutAccountId: null` used to.
   *
   * ## Why this is on the routing state and not fetched separately
   *
   * It reads like registration data — the class doc above says only fields *a
   * routing decision actually reads* belong here — and originally that was
   * true, because nothing about routing consulted it. It stopped being true the
   * moment routing began **refusing** a paid binding whose provider cannot be
   * paid (`evaluatePayoutGate`, `domain/routing/payout-gate.ts`). A value the
   * eligibility filter branches on is a routing input by definition, and this
   * is the type that carries routing inputs.
   *
   * The alternative — a `findPayoutAccounts(providerIds)` on
   * {@link ProviderRegistryPort} — would put a second query on the MCP hot
   * path for rows `DbProviderRegistry` is already reading in the same batch.
   *
   * It is deliberately **not** the same kind of thing as
   * {@link minimumStakeOverride}, which is absent here because it is an
   * economic parameter and parameter changes go through
   * `provider-stake.service.ts`. A payout address is an identity fact, proved
   * by a signature, with exactly one writer
   * (`provider-payout-address.service.ts`). Nothing about routing can change
   * it, and nothing here invents one when it is missing.
   *
   * A missing entry is refused, never defaulted, and **never** substituted
   * from another chain's entry. There is no safe substitute for "who gets the
   * money": an address on Solana is unreachable from a contract on
   * `eip155:4663`, so falling back to the first entry of this map would write a
   * payee that cannot be paid onto the row that decides who is paid.
   */
  readonly payoutAccountByChain: ReadonlyMap<ChainId, AccountId>;

  /**
   * Every chain this provider holds an enrolment on, **whatever its status**.
   *
   * A superset of {@link payoutAccountByChain}'s keys, and the difference
   * between the two is exactly the set of chains where an address *is* proved
   * and the enrolment is closed (`SUSPENDED` / `UNBONDING`). Carrying it costs
   * nothing — it comes out of the same single `enrolmentsOf` read — and it buys
   * the one thing the map alone cannot express: **why** a chain is missing.
   *
   * Without it `evaluatePayoutGate` has to answer `PAYOUT_ACCOUNT_UNPROVED` for
   * a provider who has proved, which tells them to go and sign a message they
   * already signed, forever — nothing in this codebase reopens an enrolment.
   * With it the gate says `PAYOUT_ENROLMENT_NOT_ACTIVE` instead. It is only
   * ever read to *choose a reason*: it never admits a candidate, because the
   * pass branch reads {@link payoutAccountByChain} and nothing else.
   */
  readonly payoutEnrolmentChains: ReadonlySet<ChainId>;

  /**
   * A negotiated floor that replaces the computed one for this provider.
   *
   * Every economic parameter must be overridable per provider
   * contract rather than compiled in, so the minimum stake is a value the
   * platform can agree individually. Absent means the computed default applies
   * — see `minimumStakeFor`.
   */
  readonly minimumStakeOverride?: Money;

  /**
   * The chains this provider is on a "slash hold" on (`provider_slash_holds`):
   * its penalties there cannot be collected promptly, so its paid bindings are
   * not routed or quoted on those chains and no payment intent names it
   * there. Absent or empty: no hold. Only ever narrows routing.
   */
  readonly slashHolds?: readonly ProviderSlashHoldView[];
}

/** One standing slash hold, as routing and the provider banner read it. */
export interface ProviderSlashHoldView {
  readonly chainId: ChainId;
  /** `SlashHoldReason` values: `SLASH_WINDOW_FULL`, `STAKE_FULLY_RESERVED`, `BONDED_BELOW_MINIMUM`. */
  readonly reasons: readonly string[];
  readonly heldSince: Date;
}
