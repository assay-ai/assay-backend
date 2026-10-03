import { AccountId, ChainId } from '@modules/chains/ports/caip.types';

/**
 * A provider's money on one chain.
 *
 * ```text
 * provider (one identity)   reputation, verification history, slash record — SHARED
 *   └─ chain enrolment      stake, payout address                          — PER CHAIN
 *       └─ tool binding     which chains this tool is offered on           — PER BINDING
 * ```
 *
 * **The row exists before the stake, and staking never creates one.** An
 * enrolment is a declaration — "I intend to be paid on this chain, at this
 * address, and here is a signature proving I control it". Stake is a fact about
 * a chain, read against `stakeAuthorityAccountId`, which is a field *on this
 * row*: you cannot read a provider's stake on a chain until you know which
 * account to read. `stakeAuthorityAccountId` is therefore nullable, and null
 * means "enrolled, not yet funded".
 *
 * **So an enrolment proves nothing about collateral.** `status === ACTIVE`
 * means the provider declared this chain and proved an address on it — not that
 * there is money behind it. That is why the router re-reads the stake on every
 * decision rather than trusting this row or the binding's chain list, which is
 * downstream of it.
 */

/**
 * The enrolment's own lifecycle, which is not the provider's.
 *
 * The three names match `ProviderStatus` deliberately — the backfill copies a
 * provider's status onto its first enrolment, so on day one the two agree — but
 * they diverge from the first suspension onwards. That divergence is the point
 * of per-chain enrolment: a provider suspended on one chain is not suspended on the
 * other, while the reputation that got them suspended is shared.
 */
export enum ChainEnrolmentStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  UNBONDING = 'UNBONDING',
}

export interface ChainEnrolment {
  /** `providerId === organizationId` platform-wide; this is that same id. */
  readonly providerId: string;
  readonly chainId: ChainId;
  /** CAIP-10, proved. Always on {@link chainId} — the database refuses otherwise. */
  readonly payoutAccountId: AccountId;
  /** CAIP-10, proved, or `null` for "enrolled, not yet funded". See the header. */
  readonly stakeAuthorityAccountId: AccountId | null;
  readonly status: ChainEnrolmentStatus;
  readonly enrolledAt: Date;
}

export interface ChainEnrolmentPort {
  /** Every enrolment for these providers, keyed `${providerId}|${chainId}`. */
  enrolmentsOf(providerIds: readonly string[]): Promise<ReadonlyMap<string, ChainEnrolment>>;
}

/** DI token for the bound {@link ChainEnrolmentPort}. */
export const CHAIN_ENROLMENT_SOURCE = 'CHAIN_ENROLMENT_SOURCE';

/**
 * The map key, and the only place its shape is written.
 *
 * Both halves are load-bearing. Keyed on the provider alone, a provider's
 * mainnet enrolment would overwrite their devnet one; keyed on the chain alone,
 * one provider's enrolment would overwrite every other provider's on that same
 * chain — and the router asks about many providers at once, so that second
 * collision is the likelier one. `|` is not a character CAIP-2 or a UUID can
 * contain, so the two halves cannot run together into an ambiguous key.
 */
export function enrolmentKey(providerId: string, chainId: ChainId): string {
  return `${providerId}|${chainId}`;
}
