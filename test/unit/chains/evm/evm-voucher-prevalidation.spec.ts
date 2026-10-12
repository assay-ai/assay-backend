import { EvmVoucher } from '@modules/chains/evm/eip712/voucher';
import { EVM_CONSTANTS } from '@modules/chains/evm/evm.constants';
import {
  decayWindow,
  PrevalidationState,
  prevalidateVoucher,
} from '@modules/chains/evm/evm-voucher-prevalidation';

/**
 * The off-chain replay of `_redeem`'s check list.
 *
 * Getting the ORDER wrong here does not break correctness — the chain still
 * refuses what it refuses. It breaks the **diagnosis**: a job that reports the
 * wrong refusal sends an operator to the wrong screen, and a batch that was
 * assembled on a wrong answer reverts for a reason the backend did not predict.
 *
 * ## Every fixture violates exactly one thing
 *
 * A fixture wrong in two ways passes its case for the wrong reason and would go
 * on passing after the guard it names is deleted. Each patch below is one
 * field, spread onto `GOOD` / `STATE`, and the ordering cases are the only ones
 * that deliberately violate two — which is what they are for.
 */
const NOW = 1_800_000_000;
const PAYER = '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4' as const;
const PROVIDER = '0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2' as const;

const GOOD: EvmVoucher = {
  payer: PAYER,
  provider: PROVIDER,
  amount: 1_000_000n,
  resourceHash: `0x${'ab'.repeat(32)}`,
  requestHash: `0x${'cd'.repeat(32)}`,
  seq: 10n,
  issuedAt: BigInt(NOW - 10),
  expiresAt: BigInt(NOW + 60),
};

const STATE: PrevalidationState = {
  nowSeconds: NOW,
  paused: false,
  redeemerIsUs: true,
  seqHigh: 9n,
  maxVoucherAmount: 2_000_000n,
  maxPerWindow: 10_000_000n,
  spentInWindow: 0n,
  windowStartedAt: NOW - 3_600,
  balance: 5_000_000n,
  providerBonded: 50_000_000n,
  minimumStake: 50_000_000n,
};

describe('prevalidateVoucher', () => {
  it('accepts a voucher that would settle', () => {
    // The control every refusal below is measured against. Without it,
    // "names ZeroAmount" is satisfied by a function that refuses everything.
    expect(prevalidateVoucher(GOOD, STATE)).toBeNull();
  });

  it.each([
    ['ZeroAmount', { amount: 0n }],
    ['InvalidVoucherWindow', { expiresAt: GOOD.issuedAt }],
    ['VoucherLifetimeTooLong', { expiresAt: GOOD.issuedAt + 301n }],
    ['VoucherNotYetValid', { issuedAt: BigInt(NOW) + 121n, expiresAt: BigInt(NOW) + 200n }],
    ['VoucherExpired', { issuedAt: BigInt(NOW - 2_000), expiresAt: BigInt(NOW - 1_900) }],
    ['VoucherSeqZero', { seq: 0n }],
    ['VoucherSeqNotIncreasing', { seq: 9n }],
    ['VoucherExceedsPerCallLimit', { amount: 2_000_001n }],
  ])('names %s', (expected, patch) => {
    expect(prevalidateVoucher({ ...GOOD, ...patch }, STATE)).toBe(expected);
  });

  it.each([
    ['NotRedeemer', { redeemerIsUs: false }],
    ['ProgramPaused', { paused: true }],
    ['EscrowWindowLimitExceeded', { spentInWindow: 9_500_000n }],
    ['ProviderBelowMinimumStake', { providerBonded: 49_999_999n }],
    ['EscrowInsufficient', { balance: 999_999n }],
  ])('names %s from the state', (expected, patch) => {
    expect(prevalidateVoucher(GOOD, { ...STATE, ...patch })).toBe(expected);
  });

  it('accepts the exact boundary of every bound it enforces', () => {
    // Off-by-one in the safe direction is still a defect: it refuses a voucher
    // the chain would have settled, and the buyer's call was already served.
    expect(prevalidateVoucher({ ...GOOD, expiresAt: GOOD.issuedAt + 300n }, STATE)).toBeNull();
    expect(
      prevalidateVoucher(
        { ...GOOD, issuedAt: BigInt(NOW) + 120n, expiresAt: BigInt(NOW) + 200n },
        STATE,
      ),
    ).toBeNull();
    expect(
      prevalidateVoucher(
        { ...GOOD, issuedAt: BigInt(NOW - 1_900), expiresAt: BigInt(NOW - 1_800) },
        STATE,
      ),
    ).toBeNull();
    expect(prevalidateVoucher({ ...GOOD, seq: 10n }, STATE)).toBeNull();
    expect(
      prevalidateVoucher({ ...GOOD, amount: 2_000_000n }, { ...STATE, balance: 2_000_000n }),
    ).toBeNull();
    expect(
      prevalidateVoucher(GOOD, { ...STATE, spentInWindow: 9_000_000n, windowStartedAt: NOW }),
    ).toBeNull();
    expect(prevalidateVoucher(GOOD, { ...STATE, providerBonded: 50_000_000n })).toBeNull();
    expect(prevalidateVoucher(GOOD, { ...STATE, balance: 1_000_000n })).toBeNull();
  });

  it('reports the FIRST refusal when several apply, in the contract order', () => {
    // A voucher that is both stale and over the per-call limit must report
    // VoucherSeqNotIncreasing, because that is what the chain would say — and a
    // job that reports the other one sends the operator to the wrong screen.
    const both = { ...GOOD, seq: 1n, amount: STATE.maxVoucherAmount + 1n };
    expect(prevalidateVoucher(both, STATE)).toBe('VoucherSeqNotIncreasing');
  });

  describe('the seq jump cap (D-17: seq <= seqHigh + MAX_SEQ_GAP)', () => {
    const gap = BigInt(EVM_CONSTANTS.MAX_SEQ_GAP);

    it('accepts a seq exactly MAX_SEQ_GAP above seqHigh, the chain boundary', () => {
      expect(prevalidateVoucher({ ...GOOD, seq: STATE.seqHigh + gap }, STATE)).toBeNull();
    });

    it('names VoucherSeqGapTooLarge one above it', () => {
      expect(prevalidateVoucher({ ...GOOD, seq: STATE.seqHigh + gap + 1n }, STATE)).toBe(
        'VoucherSeqGapTooLarge',
      );
    });

    it('comes right after VoucherSeqNotIncreasing and before the spending checks', () => {
      // Too far ahead AND over the per-call limit: the chain reports the gap.
      const both = { ...GOOD, seq: STATE.seqHigh + gap + 1n, amount: STATE.maxVoucherAmount + 1n };
      expect(prevalidateVoucher(both, STATE)).toBe('VoucherSeqGapTooLarge');
      // And a stale seq is still VoucherSeqNotIncreasing, never a gap.
      expect(prevalidateVoucher({ ...GOOD, seq: STATE.seqHigh }, STATE)).toBe(
        'VoucherSeqNotIncreasing',
      );
    });
  });

  it('checks the stake floor BEFORE the balance', () => {
    // Divergence 4 puts ProviderBelowMinimumStake at the Anchor position, after
    // the spending limits and before the balance. A voucher that fails both
    // must report the stake.
    const state = { ...STATE, providerBonded: 0n, balance: 0n };
    expect(prevalidateVoucher(GOOD, state)).toBe('ProviderBelowMinimumStake');
  });

  it('checks the per-call ceiling BEFORE the window', () => {
    const state = { ...STATE, maxVoucherAmount: 1n, maxPerWindow: 1n };
    expect(prevalidateVoucher(GOOD, state)).toBe('VoucherExceedsPerCallLimit');
  });

  it('puts the redeemer pin and the pause ahead of every voucher rule', () => {
    // `redeemVoucher` checks both before it calls `_redeem` at all, so a paused
    // program refuses a zero-amount voucher with ProgramPaused — and a job that
    // reported ZeroAmount would absorb a hold the chain never rejected.
    expect(
      prevalidateVoucher({ ...GOOD, amount: 0n }, { ...STATE, redeemerIsUs: false, paused: true }),
    ).toBe('NotRedeemer');
    expect(prevalidateVoucher({ ...GOOD, amount: 0n }, { ...STATE, paused: true })).toBe(
      'ProgramPaused',
    );
  });

  it('reads bonded stake alone, and a strict less-than against the floor', () => {
    // `_redeem` is `bondedOf(provider) < p.minimumStake`. Equal passes.
    expect(prevalidateVoucher(GOOD, { ...STATE, providerBonded: 50_000_000n })).toBeNull();
    expect(prevalidateVoucher(GOOD, { ...STATE, providerBonded: 49_999_999n })).toBe(
      'ProviderBelowMinimumStake',
    );
  });
});

describe('decayWindow', () => {
  /**
   * `Window.decay` in `assay-evm/src/libraries/Window.sol`, ported verbatim from
   * `state.rs::decay_window`. It DRAINS rather than resetting: capacity comes
   * back linearly across the 24-hour window, rounding **up** so capacity is
   * returned late and never early.
   *
   * Every expectation below is hand-computed from that description, not from
   * the implementation.
   */
  const base = { spentInWindow: 0n, windowStartedAt: 0, nowSeconds: 0 };

  it('is zero when nothing has been spent', () => {
    expect(
      decayWindow({ ...base, spentInWindow: 0n, windowStartedAt: 0, nowSeconds: 86_400 }),
    ).toBe(0n);
  });

  it('returns capacity to nobody when the clock did not advance, or went back', () => {
    expect(decayWindow({ spentInWindow: 100n, windowStartedAt: 500, nowSeconds: 500 })).toBe(100n);
    expect(decayWindow({ spentInWindow: 100n, windowStartedAt: 500, nowSeconds: 499 })).toBe(100n);
  });

  it('is fully drained once a whole window has elapsed', () => {
    expect(decayWindow({ spentInWindow: 100n, windowStartedAt: 0, nowSeconds: 86_400 })).toBe(0n);
    expect(decayWindow({ spentInWindow: 100n, windowStartedAt: 0, nowSeconds: 86_401 })).toBe(0n);
  });

  it('drains linearly across the window', () => {
    // Half a window elapsed: 100 * 43 200 / 86 400 = 50, exactly.
    expect(decayWindow({ spentInWindow: 100n, windowStartedAt: 0, nowSeconds: 43_200 })).toBe(50n);
  });

  it('rounds UP, so capacity is returned late and never early', () => {
    // 1 * 86 399 / 86 400 is 0.999…; `div_ceil` makes it 1. Rounding down here
    // would hand a buyer one unit of capacity the chain has not given back.
    expect(decayWindow({ spentInWindow: 1n, windowStartedAt: 0, nowSeconds: 1 })).toBe(1n);
    // 3 * 43 200 / 86 400 = 1.5 → 2.
    expect(decayWindow({ spentInWindow: 3n, windowStartedAt: 0, nowSeconds: 43_200 })).toBe(2n);
  });

  it('reproduces the live delegate counter after three 0.10 vouchers (299988, not 300000)', () => {
    // DelegateVoucherRedeemed on eip155:46630 for seq 5, 6, 7 (block times
    // 1791767941, …944, …948): spentInWindow 100000, 199997, 299988. The window
    // drains between redemptions, so three 100000 vouchers never sum to 300000.
    const afterSeq6 =
      decayWindow({
        spentInWindow: 100_000n,
        windowStartedAt: 1_791_767_941,
        nowSeconds: 1_791_767_944,
      }) + 100_000n;
    expect(afterSeq6).toBe(199_997n);
    const afterSeq7 =
      decayWindow({
        spentInWindow: afterSeq6,
        windowStartedAt: 1_791_767_944,
        nowSeconds: 1_791_767_948,
      }) + 100_000n;
    expect(afterSeq7).toBe(299_988n);
  });

  it('does not overflow on a uint64 counter across a full window', () => {
    const max = 2n ** 64n - 1n;
    expect(
      decayWindow({ spentInWindow: max, windowStartedAt: 0, nowSeconds: 1 }),
    ).toBeLessThanOrEqual(max);
  });
});
