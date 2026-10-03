import { MoneyUtil } from '@shared/utils/money.util';
import { AssetId } from '@modules/chains/ports/caip.types';
import { LedgerErrors } from '../errors/ledger.errors';
import {
  AccountBalance,
  BalanceDelta,
  BalanceKey,
  JournalEntry,
  LedgerAccountId,
  ZERO_DELTA,
  balanceKeyOf,
} from '../ports/ledger.types';
import { addDelta, deltaOf } from './ledger-entry-effect';

/**
 * The definition of a balance.
 *
 * Everything else in this module — the snapshot table, the Redis cache, the
 * reconciler — is an optimisation of this function. If any of them disagrees
 * with it, they are wrong and this is right, which is what "the journal is the
 * source of truth" has to mean concretely to be worth saying.
 *
 * It returns a raw signed `BalanceDelta` and deliberately does **not** check
 * non-negativity: a delta is an arithmetic result and may legitimately be
 * negative — the delta of a suffix of the journal usually is. Non-negativity is
 * a property of a *balance*, and is asserted in `toAccountBalance`, which is the
 * only place a delta becomes one. Callers wanting the checked form want
 * `foldJournal`.
 */
export function foldEntries(entries: readonly JournalEntry[]): BalanceDelta {
  return entries.reduce(
    (total, entry) => addDelta(total, deltaOf(entry.entryType, MoneyUtil.toAtomic(entry.money))),
    ZERO_DELTA,
  );
}

/**
 * Folds a mixed journal into one balance per `(organizationId, accountId, asset)`.
 *
 * Entries on the same account in two different assets are two balances, never
 * one: `MoneyUtil` refuses to add across assets, and so does this.
 */
export function foldJournal(entries: readonly JournalEntry[]): Map<string, AccountBalance> {
  const accumulator = new Map<string, { key: BalanceKey; decimals: number; delta: BalanceDelta }>();

  for (const entry of entries) {
    const key: BalanceKey = {
      organizationId: entry.organizationId,
      accountId: entry.accountId,
      asset: entry.money.asset,
    };
    const mapKey = balanceKeyOf(key);
    const existing = accumulator.get(mapKey);
    const delta = deltaOf(entry.entryType, MoneyUtil.toAtomic(entry.money));

    if (!existing) {
      accumulator.set(mapKey, { key, decimals: entry.money.decimals, delta });
      continue;
    }

    // Two scales for one asset is data corruption, not a display preference —
    // the same guard `MoneyUtil.add` applies, applied one level up.
    if (existing.decimals !== entry.money.decimals) {
      throw LedgerErrors.assetMismatch({
        expected: `${entry.money.asset}@${existing.decimals}`,
        actual: `${entry.money.asset}@${entry.money.decimals}`,
      });
    }

    existing.delta = addDelta(existing.delta, delta);
  }

  const balances = new Map<string, AccountBalance>();
  for (const [mapKey, { key, decimals, delta }] of accumulator) {
    balances.set(mapKey, toAccountBalance(key, decimals, delta));
  }
  return balances;
}

/**
 * Renders a folded delta as a balance.
 *
 * A negative bucket here is not a value to be clamped or reported — it means
 * the journal itself describes an impossible state, so it throws. Clamping
 * would turn a correctness failure into a plausible-looking number, which is
 * exactly how a money bug survives to production.
 */
export function toAccountBalance(
  key: BalanceKey,
  decimals: number,
  delta: BalanceDelta,
): AccountBalance {
  assertNonNegative(key, delta);

  const money = (amount: bigint) => MoneyUtil.of(amount, key.asset, decimals);

  return {
    organizationId: key.organizationId,
    accountId: key.accountId,
    asset: key.asset,
    decimals,
    available: money(delta.available),
    held: money(delta.held),
    pending: money(delta.pending),
    total: money(delta.available + delta.held + delta.pending),
  };
}

export function zeroBalance(
  organizationId: string,
  accountId: LedgerAccountId,
  asset: AssetId,
  decimals: number,
): AccountBalance {
  return toAccountBalance({ organizationId, accountId, asset }, decimals, ZERO_DELTA);
}

export function deltaOfBalance(balance: AccountBalance): BalanceDelta {
  return {
    available: MoneyUtil.toAtomic(balance.available),
    held: MoneyUtil.toAtomic(balance.held),
    pending: MoneyUtil.toAtomic(balance.pending),
  };
}

export function deltaEquals(a: BalanceDelta, b: BalanceDelta): boolean {
  return a.available === b.available && a.held === b.held && a.pending === b.pending;
}

function assertNonNegative(key: BalanceKey, delta: BalanceDelta): void {
  const negative = (['available', 'held', 'pending'] as const).filter(
    (bucket) => delta[bucket] < 0n,
  );
  if (negative.length > 0) {
    throw LedgerErrors.negativeBalance({
      accountId: key.accountId,
      asset: key.asset,
      buckets: negative.join(', '),
      available: delta.available.toString(),
      held: delta.held.toString(),
      pending: delta.pending.toString(),
    });
  }
}
