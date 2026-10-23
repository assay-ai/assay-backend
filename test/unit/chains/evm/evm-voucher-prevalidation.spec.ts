import { EvmVoucher } from '@modules/chains/evm/eip712/voucher';
import { EVM_CONSTANTS } from '@modules/chains/evm/evm.constants';
import {
  decayWindow,
  PrevalidationState,
  prevalidateBatch,
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
  seqUsed: false,
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
    // Past expiresAt + 7,200 (D-24; Solana keeps 1,800).
    ['VoucherExpired', { issuedAt: BigInt(NOW - 7_400), expiresAt: BigInt(NOW - 7_201) }],
    ['VoucherSeqZero', { seq: 0n }],
    ['VoucherExceedsPerCallLimit', { amount: 2_000_001n }],
  ])('names %s', (expected, patch) => {
    expect(prevalidateVoucher({ ...GOOD, ...patch }, STATE)).toBe(expected);
  });

  it.each([
    ['NotRedeemer', { redeemerIsUs: false }],
    ['ProgramPaused', { paused: true }],
    ['VoucherSeqUsed', { seqUsed: true }],
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
        { ...GOOD, issuedAt: BigInt(NOW - 7_300), expiresAt: BigInt(NOW - 7_200) },
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
    // A voucher whose seq is used and that is over the per-call limit must
    // report VoucherSeqUsed, because that is what the chain would say — and a
    // job that reports the other one sends the operator to the wrong screen.
    const both = { ...GOOD, seq: 1n, amount: STATE.maxVoucherAmount + 1n };
    expect(prevalidateVoucher(both, { ...STATE, seqUsed: true })).toBe('VoucherSeqUsed');
    // Zero comes before used.
    expect(prevalidateVoucher({ ...GOOD, seq: 0n }, { ...STATE, seqUsed: true })).toBe(
      'VoucherSeqZero',
    );
  });

  /**
   * D-23: the replay rule is per `(payer, seq)`, in any order. `seqHigh` is
   * only the anchor of the gap cap.
   */
  describe('the per-seq replay rule (D-23)', () => {
    it('accepts an unused seq at or below seqHigh: a lower seq after a higher one', () => {
      expect(prevalidateVoucher({ ...GOOD, seq: 9n }, STATE)).toBeNull();
      expect(prevalidateVoucher({ ...GOOD, seq: 1n }, { ...STATE, seqHigh: 500n })).toBeNull();
    });

    it('refuses a used seq — held, collected or refunded — wherever it sits', () => {
      // A refunded seq stays used: records are never deleted.
      expect(prevalidateVoucher({ ...GOOD, seq: 9n }, { ...STATE, seqUsed: true })).toBe(
        'VoucherSeqUsed',
      );
      expect(prevalidateVoucher({ ...GOOD, seq: 20n }, { ...STATE, seqUsed: true })).toBe(
        'VoucherSeqUsed',
      );
    });

    it('never names VoucherSeqNotIncreasing, which eip155 no longer has', () => {
      for (const seq of [1n, 9n, 10n]) {
        expect(prevalidateVoucher({ ...GOOD, seq }, STATE)).not.toBe('VoucherSeqNotIncreasing');
      }
    });
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

    it('comes right after VoucherSeqUsed and before the spending checks', () => {
      // Too far ahead AND over the per-call limit: the chain reports the gap.
      const both = { ...GOOD, seq: STATE.seqHigh + gap + 1n, amount: STATE.maxVoucherAmount + 1n };
      expect(prevalidateVoucher(both, STATE)).toBe('VoucherSeqGapTooLarge');
      // Too far ahead AND used: the chain reports the use.
      expect(
        prevalidateVoucher({ ...GOOD, seq: STATE.seqHigh + gap + 1n }, { ...STATE, seqUsed: true }),
      ).toBe('VoucherSeqUsed');
    });

    it('applies only above seqHigh, so a seq below it is never a gap', () => {
      expect(prevalidateVoucher({ ...GOOD, seq: 1n }, { ...STATE, seqHigh: gap * 3n })).toBeNull();
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

describe('prevalidateVoucher — a delegate-signed voucher', () => {
  const GRANT = {
    maxVoucherAmount: 1_000_000n,
    maxPerWindow: 5_000_000n,
    spentInWindow: 0n,
    windowStartedAt: NOW - 3_600,
    validUntil: BigInt(NOW + 86_400),
    revoked: false,
  };
  const withGrant = (patch: Partial<typeof GRANT> & { canSign?: boolean }) => ({
    ...STATE,
    delegation: { ...GRANT, ...patch },
  });

  it('accepts a live grant, before and after the tighten delay', () => {
    expect(prevalidateVoucher(GOOD, withGrant({}))).toBeNull();
    expect(prevalidateVoucher(GOOD, withGrant({ canSign: true }))).toBeNull();
  });

  it('without the tighten delay, a revocation is final at once', () => {
    expect(prevalidateVoucher(GOOD, withGrant({ revoked: true }))).toBe('DelegateIsRevoked');
  });

  it('with it (D-21), a revoked grant the chain says can still sign is redeemable', () => {
    // The voucher was signed before the revocation; `effectiveCapsOf` gives
    // the held caps until revocation + TIGHTEN_DELAY_SECONDS.
    expect(prevalidateVoucher(GOOD, withGrant({ revoked: true, canSign: true }))).toBeNull();
  });

  it('names a grant that cannot sign by why: revoked, else expired', () => {
    expect(prevalidateVoucher(GOOD, withGrant({ revoked: true, canSign: false }))).toBe(
      'DelegateIsRevoked',
    );
    expect(prevalidateVoucher(GOOD, withGrant({ canSign: false }))).toBe('DelegateIsExpired');
  });

  it('keeps nowSeconds > validUntil as DelegateIsExpired whatever the chain answered', () => {
    const lapsed = { validUntil: BigInt(NOW - 1) };
    expect(prevalidateVoucher(GOOD, withGrant({ ...lapsed, canSign: true }))).toBe(
      'DelegateIsExpired',
    );
    expect(prevalidateVoucher(GOOD, withGrant(lapsed))).toBe('DelegateIsExpired');
  });

  it('a grant never written is not a delegate at all', () => {
    expect(prevalidateVoucher(GOOD, withGrant({ validUntil: 0n }))).toBe('SignerIsNotPayer');
  });

  it('applies the caps it is given — the effective ones once the chain has D-21', () => {
    expect(prevalidateVoucher(GOOD, withGrant({ maxVoucherAmount: 999_999n }))).toBe(
      'DelegateVoucherExceedsPerCallLimit',
    );
  });
});

/**
 * `redeemVoucherBatch` runs `_redeem` item by item, so each item sees the
 * effects of the earlier ones of its payer. Since D-23 one payer's items may
 * share a batch in any order.
 */
describe('prevalidateBatch', () => {
  const item = (voucher: Partial<EvmVoucher>, state: Partial<PrevalidationState> = {}) => ({
    voucher: { ...GOOD, ...voucher },
    state: { ...STATE, ...state },
  });

  it('accepts one payer’s seqs out of order, a lower one after a higher one', () => {
    expect(prevalidateBatch([item({ seq: 12n }), item({ seq: 10n }), item({ seq: 11n })])).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('refuses the second copy of the same voucher as VoucherSeqUsed', () => {
    expect(prevalidateBatch([item({ seq: 10n }), item({ seq: 10n })])).toEqual([
      null,
      'VoucherSeqUsed',
    ]);
  });

  it('a refused item has no effect: its seq is not used by it', () => {
    // The first copy is over the balance and left out of the batch, so the
    // second copy (a smaller amount on the same seq) is the one the chain sees.
    expect(
      prevalidateBatch([
        item({ seq: 10n, amount: 2_000_000n }, { balance: 1_000_000n }),
        item({ seq: 10n }, { balance: 1_000_000n }),
      ]),
    ).toEqual(['EscrowInsufficient', null]);
  });

  it('raises seqHigh for the gap check of later items', () => {
    const gap = BigInt(EVM_CONSTANTS.MAX_SEQ_GAP);
    // Alone, seqHigh + gap + 5 is too far. After an item at seqHigh + gap it is not.
    expect(prevalidateBatch([item({ seq: STATE.seqHigh + gap + 5n })])).toEqual([
      'VoucherSeqGapTooLarge',
    ]);
    expect(
      prevalidateBatch([
        item({ seq: STATE.seqHigh + gap }),
        item({ seq: STATE.seqHigh + gap + 5n }),
      ]),
    ).toEqual([null, null]);
  });

  it('spends the payer’s balance and window item by item', () => {
    expect(
      prevalidateBatch([
        item({ seq: 10n }, { balance: 1_500_000n }),
        item({ seq: 11n }, { balance: 1_500_000n }),
      ]),
    ).toEqual([null, 'EscrowInsufficient']);
    expect(
      prevalidateBatch([
        item({ seq: 10n }, { maxPerWindow: 1_500_000n }),
        item({ seq: 11n }, { maxPerWindow: 1_500_000n }),
      ]),
    ).toEqual([null, 'EscrowWindowLimitExceeded']);
  });

  it('spends a delegate’s own window too', () => {
    const grant = {
      maxVoucherAmount: 1_000_000n,
      maxPerWindow: 1_500_000n,
      spentInWindow: 0n,
      windowStartedAt: NOW - 3_600,
      validUntil: BigInt(NOW + 86_400),
      revoked: false,
    };
    const signed = (seq: bigint) => ({
      ...item({ seq }, { delegation: grant }),
      delegate: '0x00000000000000000000000000000000000000De',
    });
    expect(prevalidateBatch([signed(10n), signed(11n)])).toEqual([
      null,
      'DelegateWindowLimitExceeded',
    ]);
  });

  it('keeps two payers apart', () => {
    const other = '0x0000000000000000000000000000000000000002' as const;
    expect(prevalidateBatch([item({ seq: 10n }), item({ seq: 10n, payer: other })])).toEqual([
      null,
      null,
    ]);
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
