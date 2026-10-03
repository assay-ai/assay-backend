import {
  deltaEquals,
  deltaOfBalance,
  foldEntries,
  foldJournal,
  toAccountBalance,
  zeroBalance,
} from '@modules/ledger/domain/balance-fold';
import { LedgerEntryType, ZERO_DELTA, balanceKeyOf } from '@modules/ledger/ports/ledger.types';
import { LedgerErrorCode } from '@modules/ledger/errors/ledger.errors';
import { MONEY_MAX_ATOMIC_UNITS, MoneyUtil } from '@shared/utils/money.util';
import { expectErrorCode } from '../helpers/expect-error-code';
import {
  ORG,
  OTHER_ORG,
  PLATFORM_FEES,
  USDC,
  USDC_DECIMALS,
  WETH,
  WETH_DECIMALS,
  makeEntry,
  testAccount,
} from './helpers/entries';

const agent = testAccount('agent-1');
const provider = testAccount('provider-1');

describe('foldEntries — the definition of a balance', () => {
  it('folds an empty journal to the zero delta', () => {
    expect(foldEntries([])).toEqual(ZERO_DELTA);
  });

  it('folds a simple deposit/hold/commit sequence to the expected running delta', () => {
    const entries = [
      makeEntry(agent, LedgerEntryType.DEPOSIT, 1_000n),
      makeEntry(agent, LedgerEntryType.HOLD_CREATE, 400n),
      makeEntry(agent, LedgerEntryType.HOLD_COMMIT, 400n),
    ];
    expect(foldEntries(entries)).toEqual({ available: 600n, held: 0n, pending: 0n });
  });

  it('does not itself enforce non-negativity — it is a raw sum, `toAccountBalance` is the guard', () => {
    // This is a documentation-by-test of the module's own split of
    // responsibility: `foldEntries` returns whatever the arithmetic gives,
    // impossible or not. If this test starts failing because `foldEntries`
    // grew a throw, `toAccountBalance`'s negative-balance tests below become
    // redundant and should be revisited together with this one.
    const entries = [makeEntry(agent, LedgerEntryType.HOLD_RELEASE, 50n)];
    expect(foldEntries(entries)).toEqual({ available: 50n, held: -50n, pending: 0n });
  });
});

describe('toAccountBalance / foldJournal — fold refuses the impossible', () => {
  const key = { organizationId: ORG, accountId: agent, asset: USDC };

  it('throws LEDGER_NEGATIVE_BALANCE when `available` folds negative', () => {
    const entries = [makeEntry(agent, LedgerEntryType.HOLD_CREATE, 1n)];
    expectErrorCode(
      () => toAccountBalance(key, USDC_DECIMALS, foldEntries(entries)),
      LedgerErrorCode.LEDGER_NEGATIVE_BALANCE,
    );
  });

  it('throws LEDGER_NEGATIVE_BALANCE when `held` folds negative', () => {
    const entries = [makeEntry(agent, LedgerEntryType.HOLD_RELEASE, 1n)];
    expectErrorCode(
      () => toAccountBalance(key, USDC_DECIMALS, foldEntries(entries)),
      LedgerErrorCode.LEDGER_NEGATIVE_BALANCE,
    );
  });

  it('throws LEDGER_NEGATIVE_BALANCE when `pending` folds negative', () => {
    const entries = [makeEntry(agent, LedgerEntryType.DEPOSIT_REJECT, 1n)];
    expectErrorCode(
      () => toAccountBalance(key, USDC_DECIMALS, foldEntries(entries)),
      LedgerErrorCode.LEDGER_NEGATIVE_BALANCE,
    );
  });

  it('does not clamp a negative bucket to zero — it throws instead of returning any Money at all', () => {
    // A clamped implementation would return `AccountBalance` with `available`
    // silently pinned at 0. This asserts the call never completes normally,
    // which a clamp-to-zero bug would make pass a naive "balance >= 0" check.
    expect(() =>
      toAccountBalance(key, USDC_DECIMALS, { available: -5n, held: 3n, pending: 0n }),
    ).toThrow();
  });

  it('a journal that never overdraws never throws, and reports the exact fold', () => {
    const entries = [
      makeEntry(agent, LedgerEntryType.DEPOSIT, 1_000n),
      makeEntry(agent, LedgerEntryType.HOLD_CREATE, 1_000n),
      makeEntry(agent, LedgerEntryType.HOLD_RELEASE, 1_000n),
    ];
    const balance = foldJournal(entries).get(balanceKeyOf(key));
    expect(balance).toBeDefined();
    expect(MoneyUtil.toAtomic(balance!.available)).toBe(1_000n);
    expect(MoneyUtil.toAtomic(balance!.held)).toBe(0n);
    expect(MoneyUtil.toAtomic(balance!.total)).toBe(1_000n);
  });
});

describe('boundary arithmetic', () => {
  const key = { organizationId: ORG, accountId: agent, asset: USDC };

  it('a hold for exactly the full available balance succeeds and leaves available at 0', () => {
    const entries = [
      makeEntry(agent, LedgerEntryType.DEPOSIT, 500n),
      makeEntry(agent, LedgerEntryType.HOLD_CREATE, 500n),
    ];
    const balance = toAccountBalance(key, USDC_DECIMALS, foldEntries(entries));
    expect(MoneyUtil.toAtomic(balance.available)).toBe(0n);
    expect(MoneyUtil.toAtomic(balance.held)).toBe(500n);
  });

  it('a hold for available + 1 is the failing case', () => {
    const entries = [
      makeEntry(agent, LedgerEntryType.DEPOSIT, 500n),
      makeEntry(agent, LedgerEntryType.HOLD_CREATE, 501n),
    ];
    expectErrorCode(
      () => toAccountBalance(key, USDC_DECIMALS, foldEntries(entries)),
      LedgerErrorCode.LEDGER_NEGATIVE_BALANCE,
    );
  });

  it('handles an amount at MONEY_MAX_ATOMIC_UNITS without overflow or precision loss', () => {
    const entries = [
      makeEntry(agent, LedgerEntryType.DEPOSIT, MONEY_MAX_ATOMIC_UNITS),
      makeEntry(agent, LedgerEntryType.HOLD_CREATE, MONEY_MAX_ATOMIC_UNITS),
    ];
    const balance = toAccountBalance(key, USDC_DECIMALS, foldEntries(entries));
    expect(MoneyUtil.toAtomic(balance.available)).toBe(0n);
    expect(MoneyUtil.toAtomic(balance.held)).toBe(MONEY_MAX_ATOMIC_UNITS);
  });

  it('a zero-amount entry changes nothing about an otherwise-funded balance', () => {
    const funded = foldEntries([makeEntry(agent, LedgerEntryType.DEPOSIT, 777n)]);
    const withNoop = foldEntries([
      makeEntry(agent, LedgerEntryType.DEPOSIT, 777n),
      makeEntry(agent, LedgerEntryType.HOLD_CREATE, 0n),
    ]);
    expect(deltaEquals(funded, withNoop)).toBe(true);
  });
});

describe('asset/scale safety', () => {
  it('foldJournal throws LEDGER_ASSET_MISMATCH when the same asset appears at two different decimals', () => {
    const entries = [
      makeEntry(agent, LedgerEntryType.DEPOSIT, 100n, { asset: USDC, decimals: 6 }),
      makeEntry(agent, LedgerEntryType.DEPOSIT, 100n, { asset: USDC, decimals: 8 }),
    ];
    expectErrorCode(() => foldJournal(entries), LedgerErrorCode.LEDGER_ASSET_MISMATCH);
  });

  it('the same account holding two different assets folds to two separate balances, never summed', () => {
    const entries = [
      makeEntry(agent, LedgerEntryType.DEPOSIT, 100n, { asset: USDC, decimals: USDC_DECIMALS }),
      makeEntry(agent, LedgerEntryType.DEPOSIT, 5n, { asset: WETH, decimals: WETH_DECIMALS }),
    ];
    const balances = foldJournal(entries);
    expect(balances.size).toBe(2);

    const usdcBalance = balances.get(
      balanceKeyOf({ organizationId: ORG, accountId: agent, asset: USDC }),
    );
    const wethBalance = balances.get(
      balanceKeyOf({ organizationId: ORG, accountId: agent, asset: WETH }),
    );
    expect(MoneyUtil.toAtomic(usdcBalance!.available)).toBe(100n);
    expect(MoneyUtil.toAtomic(wethBalance!.available)).toBe(5n);
  });

  it('the same account in two different organizations folds to two separate balances', () => {
    const entries = [
      makeEntry(agent, LedgerEntryType.DEPOSIT, 100n, { organizationId: ORG }),
      makeEntry(agent, LedgerEntryType.DEPOSIT, 40n, { organizationId: OTHER_ORG }),
    ];
    const balances = foldJournal(entries);
    expect(balances.size).toBe(2);
    expect(
      MoneyUtil.toAtomic(
        balances.get(balanceKeyOf({ organizationId: ORG, accountId: agent, asset: USDC }))!
          .available,
      ),
    ).toBe(100n);
    expect(
      MoneyUtil.toAtomic(
        balances.get(balanceKeyOf({ organizationId: OTHER_ORG, accountId: agent, asset: USDC }))!
          .available,
      ),
    ).toBe(40n);
  });

  it('two different accounts never bleed into the same balance', () => {
    const entries = [
      makeEntry(agent, LedgerEntryType.DEPOSIT, 100n),
      makeEntry(provider, LedgerEntryType.DEPOSIT, 5n),
    ];
    const balances = foldJournal(entries);
    expect(balances.size).toBe(2);
  });
});

describe('zeroBalance / deltaOfBalance / deltaEquals', () => {
  it('zeroBalance renders all-zero buckets for a fresh key', () => {
    const balance = zeroBalance(ORG, agent, USDC, USDC_DECIMALS);
    expect(MoneyUtil.isZero(balance.available)).toBe(true);
    expect(MoneyUtil.isZero(balance.held)).toBe(true);
    expect(MoneyUtil.isZero(balance.pending)).toBe(true);
    expect(MoneyUtil.isZero(balance.total)).toBe(true);
  });

  it('deltaOfBalance is the exact inverse of toAccountBalance for a reachable delta', () => {
    const delta = { available: 10n, held: 20n, pending: 30n };
    const balance = toAccountBalance(
      { organizationId: ORG, accountId: agent, asset: USDC },
      6,
      delta,
    );
    expect(deltaOfBalance(balance)).toEqual(delta);
  });

  it('deltaEquals is strict per-bucket equality, not just equal totals', () => {
    const a = { available: 10n, held: 5n, pending: 0n };
    const b = { available: 5n, held: 10n, pending: 0n };
    // Same total (15n), different distribution across buckets — must not be equal.
    expect(deltaEquals(a, b)).toBe(false);
  });

  it('an account internal to the platform (no CAIP address) folds like any other account', () => {
    const entries = [makeEntry(PLATFORM_FEES, LedgerEntryType.PLATFORM_FEE, 25n)];
    const balances = foldJournal(entries);
    const balance = balances.get(
      balanceKeyOf({ organizationId: ORG, accountId: PLATFORM_FEES, asset: USDC }),
    );
    expect(MoneyUtil.toAtomic(balance!.available)).toBe(25n);
  });
});
