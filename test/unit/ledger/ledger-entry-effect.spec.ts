import {
  LEDGER_ENTRY_EFFECTS,
  addDelta,
  deltaOf,
  isZeroDelta,
  sumDeltas,
} from '@modules/ledger/domain/ledger-entry-effect';
import { LedgerEntryType, ZERO_DELTA } from '@modules/ledger/ports/ledger.types';

const ALL_TYPES = Object.values(LedgerEntryType);

describe('LEDGER_ENTRY_EFFECTS — the exhaustive effect table', () => {
  it('declares an effect for every member of LedgerEntryType', () => {
    // If a member is ever added to the enum without a matching effect, this
    // is the test that must fail — not a runtime crash three modules away.
    for (const type of ALL_TYPES) {
      expect(LEDGER_ENTRY_EFFECTS[type]).toBeDefined();
    }
    expect(Object.keys(LEDGER_ENTRY_EFFECTS).sort()).toEqual([...ALL_TYPES].sort());
  });

  it('every effect bucket is exactly -1, 0 or 1, never any other integer', () => {
    for (const type of ALL_TYPES) {
      const effect = LEDGER_ENTRY_EFFECTS[type];
      for (const bucket of ['available', 'held', 'pending'] as const) {
        expect([-1, 0, 1]).toContain(effect[bucket]);
      }
    }
  });

  it('deltaOf throws rather than silently defaulting for a type absent from the table', () => {
    // Casts around the enum to simulate the "added a member, forgot the effect"
    // failure mode the table's own comment warns about.
    const bogus = 'NOT_A_REAL_ENTRY_TYPE' as LedgerEntryType;
    expect(() => deltaOf(bogus, 1n)).toThrow();
  });
});
describe('deltaOf — boundary: a zero-amount entry is a no-op delta', () => {
  it('every entry type at amount 0 folds to the zero delta, regardless of direction', () => {
    for (const type of ALL_TYPES) {
      expect(isZeroDelta(deltaOf(type, 0n))).toBe(true);
      expect(deltaOf(type, 0n)).toEqual(ZERO_DELTA);
    }
  });
});

describe('addDelta / sumDeltas', () => {
  it('addDelta is componentwise addition', () => {
    const a = { available: 5n, held: -2n, pending: 1n };
    const b = { available: -3n, held: 4n, pending: 0n };
    expect(addDelta(a, b)).toEqual({ available: 2n, held: 2n, pending: 1n });
  });

  it('sumDeltas of an empty list is the zero delta, not undefined or a throw', () => {
    expect(sumDeltas([])).toEqual(ZERO_DELTA);
  });

  it('sumDeltas matches folding deltaOf across a HOLD_CREATE then HOLD_COMMIT of the same amount', () => {
    const amount = 12_345n;
    const total = sumDeltas([
      deltaOf(LedgerEntryType.DEPOSIT, amount),
      deltaOf(LedgerEntryType.HOLD_CREATE, amount),
      deltaOf(LedgerEntryType.HOLD_COMMIT, amount),
    ]);
    // Deposited, reserved, spent: nothing left in this account at all.
    expect(total).toEqual({ available: 0n, held: 0n, pending: 0n });
  });
});
