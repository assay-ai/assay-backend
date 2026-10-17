import { LedgerErrors } from '../errors/ledger.errors';
import { BalanceDelta, LedgerEntryType, ZERO_DELTA } from '../ports/ledger.types';

/**
 * How each entry type moves value between the three buckets, per unit of the
 * entry's amount.
 *
 * **The amount stored in the journal is unsigned.** `Money` is defined as a
 * non-negative count of atomic units (`MoneyUtil` refuses anything below zero),
 * so a signed amount column would need a second, weaker money type that only
 * the ledger uses — and the first bug in that type is a debit written as a
 * credit with nothing to catch it. Instead the *type* carries the direction and
 * the amount carries the magnitude, which makes the direction a closed set of
 * reviewed cases rather than a sign a caller chose.
 *
 * A signed column would be the obvious design; this is a deliberate departure
 * from it, and it is why `LedgerEntryEffect` is exhaustive
 * over the enum at compile time.
 */
export type LedgerEntryEffect = {
  readonly [K in keyof BalanceDelta]: -1 | 0 | 1;
};

export const LEDGER_ENTRY_EFFECTS: Readonly<Record<LedgerEntryType, LedgerEntryEffect>> = {
  // ── Funding ────────────────────────────────────────────────────────────
  [LedgerEntryType.DEPOSIT_PENDING]: { available: 0, held: 0, pending: 1 },
  [LedgerEntryType.DEPOSIT_CONFIRM]: { available: 1, held: 0, pending: -1 },
  [LedgerEntryType.DEPOSIT_REJECT]: { available: 0, held: 0, pending: -1 },
  [LedgerEntryType.DEPOSIT]: { available: 1, held: 0, pending: 0 },

  // ── Holds ──────────────────────────────────────────────────────────────
  [LedgerEntryType.HOLD_CREATE]: { available: -1, held: 1, pending: 0 },
  [LedgerEntryType.HOLD_RELEASE]: { available: 1, held: -1, pending: 0 },
  // The value leaves the account: `held` falls and nothing here replaces it.
  // The matching PROVIDER_CREDIT and PLATFORM_FEE entries put it back on the
  // books under their owners, which is what makes the system-wide conservation
  // invariant hold across a settlement.
  [LedgerEntryType.HOLD_COMMIT]: { available: 0, held: -1, pending: 0 },

  // ── Earnings ───────────────────────────────────────────────────────────
  [LedgerEntryType.PROVIDER_CREDIT]: { available: 1, held: 0, pending: 0 },
  [LedgerEntryType.PLATFORM_FEE]: { available: 1, held: 0, pending: 0 },
  [LedgerEntryType.SLASH_DISTRIBUTION]: { available: 1, held: 0, pending: 0 },
  [LedgerEntryType.PROMOTIONAL_CREDIT]: { available: 1, held: 0, pending: 0 },

  // ── Exits ──────────────────────────────────────────────────────────────
  [LedgerEntryType.PAYOUT]: { available: -1, held: 0, pending: 0 },
  [LedgerEntryType.WITHDRAWAL]: { available: -1, held: 0, pending: 0 },

  // ── Custody ────────────────────────────────────────────────────────────
  // The buyer's balance does not change; only where it is custodied does
  // (the pooled Squads vault to the buyer's own escrow PDA).
  // The zero delta is the whole point: a migration that moved a balance would
  // be a migration that lost or minted one.
  [LedgerEntryType.MIGRATION_TRANSFER]: { available: 0, held: 0, pending: 0 },
};

/**
 * The signed movement `entryType` of `amount` atomic units produces.
 *
 * The lookup is exhaustive at compile time, so the guard below is unreachable
 * from typed code — but not from *stored* data: `fromRow` widens a `varchar`
 * column back into the enum, so a row written by an older or newer deployment
 * arrives here as a string this table has never heard of. That is a
 * `LEDGER_UNKNOWN_ENTRY_TYPE`, with a code and a 500, rather than a bare
 * `Error` that would leave the global filter nothing to report but a stack.
 */
export function deltaOf(entryType: LedgerEntryType, amount: bigint): BalanceDelta {
  const effect = LEDGER_ENTRY_EFFECTS[entryType];
  if (!effect) {
    throw LedgerErrors.unknownEntryType({ entryType });
  }
  return {
    available: BigInt(effect.available) * amount,
    held: BigInt(effect.held) * amount,
    pending: BigInt(effect.pending) * amount,
  };
}

export function addDelta(a: BalanceDelta, b: BalanceDelta): BalanceDelta {
  return {
    available: a.available + b.available,
    held: a.held + b.held,
    pending: a.pending + b.pending,
  };
}

export function isZeroDelta(delta: BalanceDelta): boolean {
  return delta.available === 0n && delta.held === 0n && delta.pending === 0n;
}

export function sumDeltas(deltas: readonly BalanceDelta[]): BalanceDelta {
  return deltas.reduce(addDelta, ZERO_DELTA);
}
