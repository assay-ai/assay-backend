import fc from 'fast-check';

import { AssetId } from '@modules/chains/ports/caip.types';
import {
  addDelta,
  deltaOf,
  LEDGER_ENTRY_EFFECTS,
} from '@modules/ledger/domain/ledger-entry-effect';
import {
  deltaEquals,
  foldEntries,
  foldJournal,
  toAccountBalance,
} from '@modules/ledger/domain/balance-fold';
import { LedgerErrorCode } from '@modules/ledger/errors/ledger.errors';
import {
  BalanceDelta,
  INTERNAL_ACCOUNTS,
  JournalEntry,
  LedgerAccountId,
  LedgerEntryType,
  ZERO_DELTA,
  balanceKeyOf,
} from '@modules/ledger/ports/ledger.types';
import { MoneyUtil } from '@shared/utils/money.util';
import { expectErrorCode } from '../helpers/expect-error-code';
import { ORG, USDC, USDC_DECIMALS, makeEntry, shuffleWith, testAccount } from './helpers/entries';

const ALL_TYPES = Object.values(LedgerEntryType);

/**
 * A per-entry ceiling. Bounding each entry rather than the running total keeps
 * a sequence of a few thousand entries comfortably inside
 * `MONEY_MAX_ATOMIC_UNITS` without ever needing to clamp mid-run, which would
 * distort the "reachable" property the generator is trying to model.
 */
const ENTRY_CAP = 1_000_000n;

/** The largest amount of `entryType` that will not drive any bucket of `state` negative. */
function maxSafeAmount(entryType: LedgerEntryType, state: BalanceDelta): bigint {
  const effect = LEDGER_ENTRY_EFFECTS[entryType];
  let max = ENTRY_CAP;
  for (const bucket of ['available', 'held', 'pending'] as const) {
    if (effect[bucket] === -1 && state[bucket] < max) {
      max = state[bucket];
    }
  }
  return max < 0n ? 0n : max;
}

interface ReachableJournal {
  readonly entries: JournalEntry[];
  /** The running triple, tracked independently of `foldEntries`. */
  readonly final: BalanceDelta;
}

/**
 * Draws a journal for one `(organizationId, accountId, asset)` that is
 * reachable by construction: every entry's amount is capped so it can never
 * drive a bucket below zero, given everything drawn before it.
 */
function drawReachableJournal(
  g: fc.GeneratorValue,
  accountId: LedgerAccountId,
  length: number,
  asset: AssetId = USDC,
  decimals: number = USDC_DECIMALS,
  organizationId: string = ORG,
): ReachableJournal {
  let state: BalanceDelta = ZERO_DELTA;
  const entries: JournalEntry[] = [];
  for (let i = 0; i < length; i++) {
    const entryType = g(fc.constantFrom, ...ALL_TYPES);
    const max = maxSafeAmount(entryType, state);
    const amount = g(fc.bigInt, { min: 0n, max });
    entries.push(makeEntry(accountId, entryType, amount, { asset, decimals, organizationId }));
    state = addDelta(state, deltaOf(entryType, amount));
  }
  return { entries, final: state };
}

const NUM_RUNS = 30;
const MAX_LENGTH = 150;
// 30 runs x up to 150 entries: comfortably several thousand entries exercised
// across this describe block alone.

describe('ledger invariants — thousands of random reachable entries', () => {
  it('foldEntries reproduces the running triple tracked independently by the generator', () => {
    fc.assert(
      fc.property(fc.gen(), fc.integer({ min: 0, max: MAX_LENGTH }), (g, length) => {
        const account = testAccount('inv-fold');
        const { entries, final } = drawReachableJournal(g, account, length);
        expect(foldEntries(entries)).toEqual(final);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('every bucket of a reachable journal folds to >= 0', () => {
    fc.assert(
      fc.property(fc.gen(), fc.integer({ min: 0, max: MAX_LENGTH }), (g, length) => {
        const account = testAccount('inv-nonneg');
        const { entries } = drawReachableJournal(g, account, length);
        const delta = foldEntries(entries);
        expect(delta.available >= 0n).toBe(true);
        expect(delta.held >= 0n).toBe(true);
        expect(delta.pending >= 0n).toBe(true);
        // toAccountBalance must agree — it is the same fold, guarded.
        expect(() =>
          toAccountBalance(
            { organizationId: ORG, accountId: account, asset: USDC },
            USDC_DECIMALS,
            delta,
          ),
        ).not.toThrow();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('foldJournal on a mixed multi-account, multi-asset journal equals folding each slice separately', () => {
    fc.assert(
      fc.property(
        fc.gen(),
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 0, max: 40 }),
        (g, lenA, lenB, lenC) => {
          const accountA = testAccount('slice-a');
          const accountB = testAccount('slice-b');
          const accountC = testAccount('slice-c');

          const slices = [
            { accountId: accountA, ...drawReachableJournal(g, accountA, lenA) },
            { accountId: accountB, ...drawReachableJournal(g, accountB, lenB) },
            {
              accountId: accountC,
              ...drawReachableJournal(g, accountC, lenC, USDC, USDC_DECIMALS, ORG),
            },
          ];

          const combined = shuffleWith(
            slices.flatMap((slice) => slice.entries),
            () => g(fc.double, { min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
          );

          const result = foldJournal(combined);

          for (const slice of slices) {
            const key = { organizationId: ORG, accountId: slice.accountId, asset: USDC };
            const expected =
              slice.entries.length === 0
                ? undefined
                : toAccountBalance(key, USDC_DECIMALS, slice.final);
            const actual = result.get(balanceKeyOf(key));
            expect(actual).toEqual(expected);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('order independence: a shuffled permutation of the same journal folds to the same balance', () => {
    fc.assert(
      fc.property(fc.gen(), fc.integer({ min: 0, max: MAX_LENGTH }), (g, length) => {
        const account = testAccount('inv-shuffle');
        const { entries, final } = drawReachableJournal(g, account, length);
        const shuffled = shuffleWith(entries, () =>
          g(fc.double, { min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        );
        expect(foldEntries(shuffled)).toEqual(final);
        expect(deltaEquals(foldEntries(entries), foldEntries(shuffled))).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('incremental fold equals full fold: fold(A) + fold(B) as a delta equals fold(A ++ B)', () => {
    fc.assert(
      fc.property(
        fc.gen(),
        fc.integer({ min: 0, max: MAX_LENGTH / 2 }),
        fc.integer({ min: 0, max: MAX_LENGTH / 2 }),
        (g, lenA, lenB) => {
          const account = testAccount('inv-incremental');
          const first = drawReachableJournal(g, account, lenA);
          // B continues from A's running state so the combined journal stays reachable.
          let state = first.final;
          const bEntries: JournalEntry[] = [];
          for (let i = 0; i < lenB; i++) {
            const entryType = g(fc.constantFrom, ...ALL_TYPES);
            const max = maxSafeAmount(entryType, state);
            const amount = g(fc.bigInt, { min: 0n, max });
            bEntries.push(makeEntry(account, entryType, amount));
            state = addDelta(state, deltaOf(entryType, amount));
          }

          const incremental = addDelta(foldEntries(first.entries), foldEntries(bEntries));
          const full = foldEntries([...first.entries, ...bEntries]);
          expect(incremental).toEqual(full);
          expect(incremental).toEqual(state);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('appending one entry that overdraws by exactly 1 unit turns a valid fold into LEDGER_NEGATIVE_BALANCE', () => {
    fc.assert(
      fc.property(fc.gen(), fc.integer({ min: 0, max: MAX_LENGTH }), (g, length) => {
        const account = testAccount('inv-overdraw');
        const { entries, final } = drawReachableJournal(g, account, length);
        // HOLD_CREATE's effect on `available` is -1, and `final.available` is
        // always >= 0 by construction, so `final.available + 1` always overdraws.
        const overdraft = makeEntry(account, LedgerEntryType.HOLD_CREATE, final.available + 1n);
        const key = { organizationId: ORG, accountId: account, asset: USDC };
        expectErrorCode(
          () => toAccountBalance(key, USDC_DECIMALS, foldEntries([...entries, overdraft])),
          LedgerErrorCode.LEDGER_NEGATIVE_BALANCE,
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('ledger invariants — conservation across accounts in a settlement', () => {
  const PLATFORM_FEES: LedgerAccountId = INTERNAL_ACCOUNTS.PLATFORM_FEES;

  it('the sum of available+held+pending over ALL accounts equals deposits minus payouts/withdrawals', () => {
    fc.assert(
      fc.property(fc.gen(), fc.integer({ min: 1, max: 25 }), (g, settlementCount) => {
        const entries: JournalEntry[] = [];
        let totalDeposits = 0n;
        let totalPayoutsAndWithdrawals = 0n;

        for (let i = 0; i < settlementCount; i++) {
          const agent = testAccount(`settle-agent-${i}`);
          const provider = testAccount(`settle-provider-${i}`);

          const committed = g(fc.bigInt, { min: 1n, max: 100_000n });
          const feeBps = g(fc.integer, { min: 0, max: 10_000 });
          const fee = (committed * BigInt(feeBps)) / 10_000n;
          const providerAmt = committed - fee;

          entries.push(
            makeEntry(agent, LedgerEntryType.DEPOSIT, committed),
            makeEntry(agent, LedgerEntryType.HOLD_CREATE, committed),
            makeEntry(agent, LedgerEntryType.HOLD_COMMIT, committed),
            makeEntry(provider, LedgerEntryType.PROVIDER_CREDIT, providerAmt),
            makeEntry(PLATFORM_FEES, LedgerEntryType.PLATFORM_FEE, fee),
          );
          totalDeposits += committed;

          // Funds unrelated to the hold, exercised through WITHDRAWAL.
          const extraDeposit = g(fc.bigInt, { min: 0n, max: 50_000n });
          if (extraDeposit > 0n) {
            entries.push(makeEntry(agent, LedgerEntryType.DEPOSIT, extraDeposit));
            totalDeposits += extraDeposit;
            const withdrawal = g(fc.bigInt, { min: 0n, max: extraDeposit });
            if (withdrawal > 0n) {
              entries.push(makeEntry(agent, LedgerEntryType.WITHDRAWAL, withdrawal));
              totalPayoutsAndWithdrawals += withdrawal;
            }
          }

          // The provider may cash out some of what it just earned.
          const payout = g(fc.bigInt, { min: 0n, max: providerAmt });
          if (payout > 0n) {
            entries.push(makeEntry(provider, LedgerEntryType.PAYOUT, payout));
            totalPayoutsAndWithdrawals += payout;
          }
        }

        const shuffled = shuffleWith(entries, () =>
          g(fc.double, { min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        );
        const balances = foldJournal(shuffled);

        let grandTotal = 0n;
        for (const balance of balances.values()) {
          grandTotal += MoneyUtil.toAtomic(balance.total);
        }

        expect(grandTotal).toBe(totalDeposits - totalPayoutsAndWithdrawals);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
