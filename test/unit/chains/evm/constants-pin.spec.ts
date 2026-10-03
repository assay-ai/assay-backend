import { EVM_CONSTANTS } from '@modules/chains/evm/evm.constants';

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
    ['WITHDRAW_DELAY_SECONDS', 3_600],
    ['REDEEM_GRACE_SECONDS', 1_800],
    ['VOUCHER_MAX_LIFETIME_SECONDS', 300],
    ['CLOCK_SKEW_TOLERANCE_SECONDS', 120],
    ['SLASH_WINDOW_SECONDS', 86_400],
  ])('%s is %i', (name, value) => {
    expect(EVM_CONSTANTS[name as keyof typeof EVM_CONSTANTS]).toBe(value);
  });

  it('pins every member, so a new constant cannot arrive unpinned', () => {
    // Without this the table above is satisfied by a superset: a sixth constant
    // could be added with no pin and no review, which is exactly how a number
    // nobody checked reaches a redeem call.
    expect(Object.keys(EVM_CONSTANTS).sort()).toEqual([
      'CLOCK_SKEW_TOLERANCE_SECONDS',
      'MAX_REDEEM_BATCH',
      'MAX_VOUCHER_REDEEMABLE_LIFE_SECONDS',
      'REDEEM_GRACE_SECONDS',
      'SLASH_WINDOW_SECONDS',
      'VOUCHER_MAX_LIFETIME_SECONDS',
      'WITHDRAW_DELAY_SECONDS',
    ]);
  });

  it('the derived redeemable life is the sum of its three parts', () => {
    // Derived, not copied — matching `Constants.sol:56`, which computes it the
    // same way. A change to any part that forgets this one is a failure rather
    // than a silently stale number.
    expect(EVM_CONSTANTS.MAX_VOUCHER_REDEEMABLE_LIFE_SECONDS).toBe(
      EVM_CONSTANTS.CLOCK_SKEW_TOLERANCE_SECONDS +
        EVM_CONSTANTS.VOUCHER_MAX_LIFETIME_SECONDS +
        EVM_CONSTANTS.REDEEM_GRACE_SECONDS,
    );
    // and the literal it must come to, so a change to two parts that cancel out
    // is caught as well
    expect(EVM_CONSTANTS.MAX_VOUCHER_REDEEMABLE_LIFE_SECONDS).toBe(2_220);
  });

  it('the withdraw delay outlives every voucher signed before a request', () => {
    // `Constants.sol:61` asserts the same invariant on the contract side. It is
    // restated here because the backend's withdraw gate covers the OTHER half
    // — the backend's refusal to quote against a standing request — and a
    // reader needs both to see why 3,600 is not an arbitrary hour.
    expect(EVM_CONSTANTS.WITHDRAW_DELAY_SECONDS).toBeGreaterThan(
      EVM_CONSTANTS.MAX_VOUCHER_REDEEMABLE_LIFE_SECONDS,
    );
  });
});
