import {
  EVM_CONSTANTS,
  EVM_DELEGATE_MIN_VALID_UNTIL_AHEAD_SECONDS,
} from '@modules/chains/evm/evm.constants';
import { VOUCHER_MAX_SEQ_GAP } from '@modules/payment/constants/escrow-seq.constants';

/**
 * The constants copied out of `assay-evm/src/Constants.sol`.
 *
 * They are `internal` there, so they are **not readable over the ABI** — there
 * is no getter to call and no way for the backend to derive them at runtime.
 * And `evm/` lives in the WORKSPACE, one level above this submodule, so this
 * file cannot read the Solidity either: there is no stable relative path from a
 * backend checkout to it, and this repo is cloned on its own.
 *
 * So the pin is the literal plus the Solidity name and line it came from,
 * verified by hand on 2026-09-09 against `assay-evm/src/Constants.sol`:
 *
 * ```
 * 38:  uint64 internal constant WITHDRAW_DELAY_SECONDS = 3600;
 * 41:  uint64 internal constant REDEEM_GRACE_SECONDS = 30 * 60;
 * 47:  uint64 internal constant VOUCHER_MAX_LIFETIME_SECONDS = 5 * 60;
 * 51:  uint64 internal constant CLOCK_SKEW_TOLERANCE_SECONDS = 120;
 * 87:  uint64 internal constant SLASH_WINDOW_SECONDS = 86_400;
 * 147: uint256 internal constant MAX_REDEEM_BATCH = 64;
 * ```
 *
 * and, on 2026-10-13 after D-17/D-18:
 *
 * ```
 * 152: uint64 internal constant MAX_SEQ_GAP = 1_000_000;
 * 172: uint64 internal constant MAX_SIGNATURE_LIFETIME_SECONDS = 3600;
 * ```
 *
 * and, on 2026-10-14 at assay-evm 99f98ed (the dispute upgrade, D-19):
 *
 * ```
 *  56: uint64 internal constant DISPUTE_TIMEOUT_SECONDS = 30 * 86_400;
 *  40: uint64 internal constant SLASH_DELAY_SECONDS = 72 * 3600;  // the default, and the old delay
 * 182: uint256 internal constant MAX_SLASH_BATCH = 64;
 * ```
 *
 * and, on 2026-10-16 at assay-evm f814629 (signed means collectable, D-21):
 *
 * ```
 *  66: uint64 internal constant TIGHTEN_DELAY_SECONDS = WITHDRAW_DELAY_SECONDS;
 * ```
 *
 * and, on 2026-10-23 at assay-evm fix/seq-used-set-and-slash-floor (D-24 — the
 * file grew, so every line moved; the current lines are):
 *
 * ```
 *  67: uint64 internal constant DISPUTE_TIMEOUT_SECONDS = 30 * 86_400;
 *  72: uint64 internal constant WITHDRAW_DELAY_SECONDS = 3 * 3600;
 *  79: uint64 internal constant TIGHTEN_DELAY_SECONDS = WITHDRAW_DELAY_SECONDS;
 * 106: uint64 internal constant REDEEM_GRACE_SECONDS = 2 * 3600;
 * 112: uint64 internal constant VOUCHER_MAX_LIFETIME_SECONDS = 5 * 60;
 * 116: uint64 internal constant CLOCK_SKEW_TOLERANCE_SECONDS = 120;
 * 120: uint64 internal constant MAX_VOUCHER_REDEEMABLE_LIFE_SECONDS = 120 + 300 + grace;  // 7,620
 * 151: uint64 internal constant SLASH_WINDOW_SECONDS = 86_400;
 * 221: uint64 internal constant MAX_SEQ_GAP = 1_000_000;
 * 225: uint256 internal constant MAX_REDEEM_BATCH = 64;
 * 229: uint256 internal constant MAX_SLASH_BATCH = 64;
 * 234: uint64 internal constant MAX_DELEGATION_LIFETIME_SECONDS = 365 * 86_400;
 * 239: uint256 internal constant MAX_DELEGATES_PER_PAYER = 16;
 * 248: uint64 internal constant MAX_SIGNATURE_LIFETIME_SECONDS = 3600;
 * ```
 *
 * **State the limit rather than overstate the check.** This suite cannot catch
 * the Solidity moving; the deployment-record comparison is what does that.
 * What it does catch is the other direction, which is the one that happens:
 * somebody raising 64 to 128 here to make batches faster now has to edit a line
 * that names the contract constant it is mirroring, and the change surfaces in
 * review instead of at a revert.
 */
describe('the constants copied from assay-evm/src/Constants.sol', () => {
  it.each([
    ['MAX_REDEEM_BATCH', 64],
    ['WITHDRAW_DELAY_SECONDS', 3 * 3_600],
    ['REDEEM_GRACE_SECONDS', 2 * 3_600],
    ['VOUCHER_MAX_LIFETIME_SECONDS', 300],
    ['CLOCK_SKEW_TOLERANCE_SECONDS', 120],
    ['SLASH_WINDOW_SECONDS', 86_400],
    ['MAX_DELEGATION_LIFETIME_SECONDS', 365 * 86_400],
    ['MAX_DELEGATES_PER_PAYER', 16],
    ['MAX_SEQ_GAP', 1_000_000],
    ['MAX_SIGNATURE_LIFETIME_SECONDS', 3_600],
    ['MAX_SLASH_BATCH', 64],
    ['DISPUTE_TIMEOUT_SECONDS', 30 * 86_400],
    ['TIGHTEN_DELAY_SECONDS', 3 * 3_600],
  ])('%s is %i', (name, value) => {
    expect(EVM_CONSTANTS[name as keyof typeof EVM_CONSTANTS]).toBe(value);
  });

  it('pins every member, so a new constant cannot arrive unpinned', () => {
    // Without this the table above is satisfied by a superset: a sixth constant
    // could be added with no pin and no review, which is exactly how a number
    // nobody checked reaches a redeem call.
    expect(Object.keys(EVM_CONSTANTS).sort()).toEqual([
      'CLOCK_SKEW_TOLERANCE_SECONDS',
      'DISPUTE_TIMEOUT_SECONDS',
      'MAX_DELEGATES_PER_PAYER',
      'MAX_DELEGATION_LIFETIME_SECONDS',
      'MAX_REDEEM_BATCH',
      'MAX_SEQ_GAP',
      'MAX_SIGNATURE_LIFETIME_SECONDS',
      'MAX_SLASH_BATCH',
      'MAX_VOUCHER_REDEEMABLE_LIFE_SECONDS',
      'REDEEM_GRACE_SECONDS',
      'SLASH_WINDOW_SECONDS',
      'TIGHTEN_DELAY_SECONDS',
      'VOUCHER_MAX_LIFETIME_SECONDS',
      'WITHDRAW_DELAY_SECONDS',
    ]);
  });

  it('the payment domain issues and admits against the SAME seq gap the contract enforces', () => {
    // Issue (`EscrowSeqService.allocate`) and admission (`VoucherService`)
    // read `VOUCHER_MAX_SEQ_GAP`; the redemption pre-validator reads
    // `EVM_CONSTANTS.MAX_SEQ_GAP`. Two copies would drift.
    expect(VOUCHER_MAX_SEQ_GAP).toBe(EVM_CONSTANTS.MAX_SEQ_GAP);
    expect(VOUCHER_MAX_SEQ_GAP).toBe(1_000_000);
  });

  it('the backend signs relayed deadlines well inside the signature lifetime cap', () => {
    // `*BySig` deadlines are chain time + VOUCHER_MAX_LIFETIME_SECONDS; the
    // contract refuses more than MAX_SIGNATURE_LIFETIME_SECONDS ahead.
    expect(EVM_CONSTANTS.VOUCHER_MAX_LIFETIME_SECONDS).toBeLessThan(
      EVM_CONSTANTS.MAX_SIGNATURE_LIFETIME_SECONDS,
    );
  });

  it('the derived redeemable life is the sum of its three parts', () => {
    // Derived, not copied — matching `Constants.sol:120`, which computes it the
    // same way. A change to any part that forgets this one is a failure rather
    // than a silently stale number.
    expect(EVM_CONSTANTS.MAX_VOUCHER_REDEEMABLE_LIFE_SECONDS).toBe(
      EVM_CONSTANTS.CLOCK_SKEW_TOLERANCE_SECONDS +
        EVM_CONSTANTS.VOUCHER_MAX_LIFETIME_SECONDS +
        EVM_CONSTANTS.REDEEM_GRACE_SECONDS,
    );
    // and the literal it must come to, so a change to two parts that cancel out
    // is caught as well
    expect(EVM_CONSTANTS.MAX_VOUCHER_REDEEMABLE_LIFE_SECONDS).toBe(7_620);
  });

  it('the withdraw delay outlives every voucher signed before a request', () => {
    // `Constants.sol:126` notes the same invariant on the contract side. It is
    // restated here because the backend's withdraw gate covers the OTHER half
    // — the backend's refusal to quote against a standing request — and a
    // reader needs both to see why 10,800 is not an arbitrary three hours.
    expect(EVM_CONSTANTS.WITHDRAW_DELAY_SECONDS).toBeGreaterThan(
      EVM_CONSTANTS.MAX_VOUCHER_REDEEMABLE_LIFE_SECONDS,
    );
  });

  it('a delegate grant is issued at least the tighten delay plus the relay window ahead (F8)', () => {
    // `validUntil >= now + TIGHTEN_DELAY_SECONDS` at the landing block, and the
    // relayer may land the signed request until its deadline (chain time + 300).
    expect(EVM_DELEGATE_MIN_VALID_UNTIL_AHEAD_SECONDS).toBe(
      EVM_CONSTANTS.TIGHTEN_DELAY_SECONDS + EVM_CONSTANTS.VOUCHER_MAX_LIFETIME_SECONDS,
    );
    expect(EVM_DELEGATE_MIN_VALID_UNTIL_AHEAD_SECONDS).toBe(11_100);
  });

  it('a tightening outlives every voucher valid when it lands', () => {
    // D-21: the hold on lowered caps and a revoked grant's grace both last
    // TIGHTEN_DELAY_SECONDS, so it must exceed the longest a voucher stays
    // redeemable — the reason the strand guard is not needed once it is live.
    expect(EVM_CONSTANTS.TIGHTEN_DELAY_SECONDS).toBeGreaterThan(
      EVM_CONSTANTS.MAX_VOUCHER_REDEEMABLE_LIFE_SECONDS,
    );
  });
});
