import { deltaOf } from '@modules/ledger/domain/ledger-entry-effect';
import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';

/**
 * Whose money each kind of journal entry moves.
 *
 * Proof of reserves is one inequality —
 * `vault ≥ agents + holds + provider_unpaid + platform_fees` — but the
 * inequality alone is a bad alarm. When it fails, "the vault is $412 short"
 * sends someone hunting through the whole journal; "provider payable jumped
 * $412 while agent liabilities did not move" names the bug. So the total is
 * always decomposed, and the decomposition is a property of the entry *type*.
 *
 * ## Why by type and not by account
 *
 * There is no provider registry yet, so an account id cannot be
 * classified as an agent's or a provider's — both are bare CAIP-10 addresses.
 * The entry type can be, and it is the more stable key anyway: a
 * `PROVIDER_CREDIT` is provider money whatever address it lands on, and an
 * account that somehow received both kinds of entry would be misclassified by
 * an account-level rule and correctly split by this one.
 *
 * `SLASH_DISTRIBUTION` is booked to `AGENT` and that is **exact, not an
 * approximation**. `slash` splits a penalty three ways in one instruction —
 * the agent share to the signed `beneficiary`, the platform share to
 * `economics.treasury`, and a remainder that is **never taken from the stake
 * at all** (`slash.rs` in assay-solana;
 * `taken == agent_amount + platform_amount`, so a provider judged $10 loses
 * $9). Only the first share becomes a ledger
 * entry:
 *
 * - the platform's share lands at `economics.treasury`, which is **not the
 *   vault**, so booking it would add a liability the vault does not cover and
 *   trip proof of reserves on the next reconciliation run;
 * - the provider's remainder never moves, so there is nothing to book.
 *
 * An earlier note here called that third share an "insurance reserve" and
 * asked slash execution to split this entry into new types. Both were wrong. The
 * provider's own terms screen says *"60% to the agent served the bad result,
 * 30% platform, 10% stays yours"* (`provider-terms.ts`), the operator
 * reference parses the parameter as `"agent / platform / provider"`, and the
 * split that the note wanted repeated off-chain already happens on chain.
 * **Do not add entry types for it.**
 *
 * The shares are read off `SlashRecord`, never recomputed: `slash_agent_bps`
 * lives on the **per-provider** `ProviderTerms` account, so "60%" is a default
 * and not an invariant.
 */
export enum LedgerBook {
  /** Money the platform owes an agent — deposits, holds, refunds. */
  AGENT = 'AGENT',
  /** Earnings accrued to a provider and not yet paid out. */
  PROVIDER = 'PROVIDER',
  /** The platform's own take, until it is swept out of the vault. */
  PLATFORM = 'PLATFORM',
}

/**
 * Exhaustive over `LedgerEntryType` at compile time — adding a way for money
 * to move without saying whose money it is fails `yarn build`, rather than
 * silently dropping out of the reserve total.
 */
export const LEDGER_ENTRY_BOOKS: Readonly<Record<LedgerEntryType, LedgerBook>> = {
  [LedgerEntryType.DEPOSIT_PENDING]: LedgerBook.AGENT,
  [LedgerEntryType.DEPOSIT_CONFIRM]: LedgerBook.AGENT,
  [LedgerEntryType.DEPOSIT_REJECT]: LedgerBook.AGENT,
  [LedgerEntryType.DEPOSIT]: LedgerBook.AGENT,

  [LedgerEntryType.HOLD_CREATE]: LedgerBook.AGENT,
  [LedgerEntryType.HOLD_RELEASE]: LedgerBook.AGENT,
  [LedgerEntryType.HOLD_COMMIT]: LedgerBook.AGENT,

  [LedgerEntryType.PROVIDER_CREDIT]: LedgerBook.PROVIDER,
  [LedgerEntryType.PAYOUT]: LedgerBook.PROVIDER,

  [LedgerEntryType.PLATFORM_FEE]: LedgerBook.PLATFORM,

  // Exact, not an approximation — see the header. Only the agent share is ever
  // booked; the platform share leaves the chain to a non-vault account and the
  // provider's remainder never moves.
  [LedgerEntryType.SLASH_DISTRIBUTION]: LedgerBook.AGENT,
  [LedgerEntryType.PROMOTIONAL_CREDIT]: LedgerBook.AGENT,

  [LedgerEntryType.WITHDRAWAL]: LedgerBook.AGENT,

  // Agent money throughout — the cutover changes its custodian, not its owner
  // Its effect is the zero delta, so it contributes nothing to
  // the total either way; the book keeps the decomposition honest about whose
  // money the row describes.
  [LedgerEntryType.MIGRATION_TRANSFER]: LedgerBook.AGENT,
};

/** The three figures the reconciler compares against the chain, plus the total. */
export interface LedgerLiabilities {
  /** Agent-owned value: available + held + pending, summed over every agent. */
  readonly agentLiabilities: bigint;
  /** The reserved slice of `agentLiabilities`. Reported, never added again. */
  readonly openHolds: bigint;
  /** `Σ PROVIDER_CREDIT − Σ PAYOUT`. */
  readonly providerPayable: bigint;
  /** `Σ PLATFORM_FEE`. */
  readonly platformFees: bigint;
  /** `agentLiabilities + providerPayable + platformFees`. What the vault must cover. */
  readonly total: bigint;
}

/**
 * Folds `Σ amount` per entry type into the liability decomposition.
 *
 * The per-type direction is taken from `deltaOf` — the ledger's own effect
 * table — rather than restated here. A second copy of "a `PAYOUT` is a debit"
 * is a second place for it to be wrong, and the copy that is wrong is always
 * the one nobody is reading.
 *
 * Each entry contributes the sum of its three bucket effects, because what the
 * vault has to cover is the account's *total*, not any one bucket:
 * `HOLD_CREATE` moves `available → held` and so contributes nothing, while
 * `HOLD_COMMIT` takes value out of the agent book entirely — and the matching
 * `PROVIDER_CREDIT` and `PLATFORM_FEE` put it back under their own owners.
 * That is the conservation property that makes a settlement invisible to the
 * total and visible in the breakdown.
 *
 * @param totals unsigned `Σ amount` keyed by entry type, as stored.
 * @throws `LEDGER_UNKNOWN_ENTRY_TYPE` via `deltaOf` when the journal holds a
 *   type this build has never heard of — a row written by another deployment.
 *   Loud, because silently skipping it would under-report liabilities.
 */
export function foldLiabilities(totals: ReadonlyMap<string, bigint>): LedgerLiabilities {
  const books: Record<LedgerBook, bigint> = {
    [LedgerBook.AGENT]: 0n,
    [LedgerBook.PROVIDER]: 0n,
    [LedgerBook.PLATFORM]: 0n,
  };
  let openHolds = 0n;

  for (const [rawType, amount] of totals) {
    const entryType = rawType as LedgerEntryType;
    const delta = deltaOf(entryType, amount);
    const net = delta.available + delta.held + delta.pending;

    books[LEDGER_ENTRY_BOOKS[entryType]] += net;
    openHolds += delta.held;
  }

  const agentLiabilities = books[LedgerBook.AGENT];
  const providerPayable = books[LedgerBook.PROVIDER];
  const platformFees = books[LedgerBook.PLATFORM];

  return {
    agentLiabilities,
    openHolds,
    providerPayable,
    platformFees,
    total: agentLiabilities + providerPayable + platformFees,
  };
}

/**
 * The liabilities **the vault itself** must cover: the journal's books less
 * what rail-B redemptions already paid out of the buyer's escrow.
 *
 * A redemption is `HOLD_COMMIT` + `PROVIDER_CREDIT` + `PLATFORM_FEE`, which
 * conserves the journal total — but on chain the escrow sent `amount − fee` to
 * the provider and `fee` to the treasury in the same instruction, so the
 * vault dropped by the full `amount`. Without this every redemption grew the
 * journal's claim on the vault by exactly what had just left it — on EVM,
 * where the escrow IS the vault, an ever-growing false shortfall that only a
 * stray deposit was hiding.
 *
 * Only the reserve comparison uses this. The snapshot check and the
 * negative-book check stay on the journal's own fold — `account_balances`
 * still carries those credits, correctly, as the provider's and the
 * platform's earnings.
 */
export function vaultLiabilities(
  journal: LedgerLiabilities,
  paidAtRedemption: { readonly providerCredits: bigint; readonly platformFees: bigint },
): LedgerLiabilities {
  const providerPayable = journal.providerPayable - paidAtRedemption.providerCredits;
  const platformFees = journal.platformFees - paidAtRedemption.platformFees;
  return {
    ...journal,
    providerPayable,
    platformFees,
    total: journal.agentLiabilities + providerPayable + platformFees,
  };
}
