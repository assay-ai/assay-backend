import { EvmVoucher } from './eip712/voucher';
import { EVM_CONSTANTS } from './evm.constants';

/**
 * Everything `_redeem` reads that is not in the voucher itself.
 *
 * All of it comes off the chain in one `multicall` — the escrow struct, the
 * provider's bonded stake, and the two `X402Config` reads — so nothing here is
 * derived from anything else and nothing is a local copy of a program constant.
 */
export interface PrevalidationState {
  readonly nowSeconds: number;
  readonly paused: boolean;
  /** `msg.sender == p.redeemer`: whether the relayer is the key the contract accepts. */
  readonly redeemerIsUs: boolean;
  readonly seqHigh: bigint;
  readonly maxVoucherAmount: bigint;
  readonly maxPerWindow: bigint;
  readonly spentInWindow: bigint;
  readonly windowStartedAt: number;
  readonly balance: bigint;
  /** `bondedOf(provider)` — **`bonded` alone**, never `bonded + unbonding`. */
  readonly providerBonded: bigint;
  readonly minimumStake: bigint;
  /**
   * The signing delegate's on-chain grant (`delegationOf(payer, delegate)`),
   * when the voucher was signed by a delegate; absent for the payer's own key.
   */
  readonly delegation?: PrevalidationDelegation | null;
}

export interface PrevalidationDelegation {
  readonly maxVoucherAmount: bigint;
  readonly maxPerWindow: bigint;
  readonly spentInWindow: bigint;
  readonly windowStartedAt: number;
  readonly validUntil: bigint;
  readonly revoked: boolean;
}

/**
 * `Window.decay`, off chain.
 *
 * A verbatim port of assay-evm's `src/libraries/Window.sol`, itself a verbatim port of
 * `state.rs::decay_window`. It **drains** rather than resetting: a counter
 * anchored at `windowStartedAt` gives capacity back linearly across
 * `SLASH_WINDOW_SECONDS`, rounding **up** so capacity is returned late and never
 * early. Rounding the other way would hand a buyer window capacity the chain has
 * not given back, and the batch that used it would revert.
 *
 * The three early returns are the contract's, in its order:
 * a zero counter is zero; a clock that did not advance — or went backwards —
 * returns capacity to nobody; a whole window elapsed is fully drained.
 */
export function decayWindow(state: {
  readonly spentInWindow: bigint;
  readonly windowStartedAt: number;
  readonly nowSeconds: number;
}): bigint {
  const counter = state.spentInWindow;
  if (counter === 0n) {
    return 0n;
  }
  if (state.nowSeconds <= state.windowStartedAt) {
    return counter;
  }

  const window = BigInt(EVM_CONSTANTS.SLASH_WINDOW_SECONDS);
  const elapsed = BigInt(state.nowSeconds - state.windowStartedAt);
  if (elapsed >= window) {
    return 0n;
  }

  const remaining = window - elapsed;
  // `div_ceil`, in bigint so `counter * remaining` cannot wrap — the Solidity
  // does the same in `uint256` for the same reason.
  return (counter * remaining + window - 1n) / window;
}

/**
 * The same list `_redeem` applies, in the same order, evaluated off chain.
 *
 * `redeemVoucherBatch` is **atomic by decision**: one bad voucher reverts all
 * 64. Skip-and-continue would need a per-item external self-call, would leave an
 * event stream that no longer says which vouchers settled, and would let one
 * malformed item quietly drop 63 good ones into a state nobody reconciles. So
 * the cost of that decision lands here, and assay-evm's `docs/gas.md` states
 * it in the imperative.
 *
 * The order is copied from assay-evm's `src/X402Escrow.sol::_redeem` rather than
 * invented, and two entries are **not** where the Anchor program puts them:
 *
 *  - **`seq` is checked BEFORE the signature** (divergence 3). Cheaper on chain
 *    — a stale voucher is refused without paying for `ecrecover` — and it leaks
 *    nothing, because `escrowOf` already returns `seqHigh` to anybody who asks.
 *  - **`ProviderBelowMinimumStake` sits at the ANCHOR position** (divergence 4):
 *    after the spending limits and before the balance. Being paid is the
 *    counterpart of being slashable, and it reads `bonded` only, because stake
 *    already asked back is not backing anybody's traffic.
 *
 * The redeemer pin and the pause come first because `redeemVoucher` and
 * `redeemVoucherBatch` both check them **before** calling `_redeem` at all — so
 * a paused program refuses a zero-amount voucher with `ProgramPaused`, and a job
 * that reported `ZeroAmount` would absorb a hold the chain never rejected.
 *
 * Returns the `Errors.sol` NAME the chain would raise, or `null` for a voucher
 * that would settle. Getting the order wrong does not break correctness — it
 * breaks the diagnosis, and a job that reports the wrong refusal sends somebody
 * to the wrong screen.
 *
 * **The signature is not checked here.** It is checked by the caller, which has
 * one; this function is about state, and a signature check would need the digest
 * and the recovery. `SignerIsNotPayer` therefore has no producer in this file
 * and one in the redeemer.
 */
export function prevalidateVoucher(voucher: EvmVoucher, state: PrevalidationState): string | null {
  if (!state.redeemerIsUs) return 'NotRedeemer';
  if (state.paused) return 'ProgramPaused';

  if (voucher.amount === 0n) return 'ZeroAmount';
  if (voucher.expiresAt <= voucher.issuedAt) return 'InvalidVoucherWindow';
  if (voucher.expiresAt - voucher.issuedAt > BigInt(EVM_CONSTANTS.VOUCHER_MAX_LIFETIME_SECONDS)) {
    return 'VoucherLifetimeTooLong';
  }
  if (voucher.issuedAt > BigInt(state.nowSeconds + EVM_CONSTANTS.CLOCK_SKEW_TOLERANCE_SECONDS)) {
    return 'VoucherNotYetValid';
  }
  if (BigInt(state.nowSeconds) > voucher.expiresAt + BigInt(EVM_CONSTANTS.REDEEM_GRACE_SECONDS)) {
    return 'VoucherExpired';
  }

  if (voucher.seq === 0n) return 'VoucherSeqZero';
  if (voucher.seq <= state.seqHigh) return 'VoucherSeqNotIncreasing';

  // The authority, where `_voucherAuthority` decides it (agent payment
  // delegation): a delegate-signed voucher needs a live grant at THIS block.
  const delegation = state.delegation ?? null;
  if (delegation !== null) {
    if (delegation.validUntil === 0n) return 'SignerIsNotPayer';
    if (delegation.revoked) return 'DelegateIsRevoked';
    if (BigInt(state.nowSeconds) > delegation.validUntil) return 'DelegateIsExpired';
  }

  if (voucher.amount > state.maxVoucherAmount) return 'VoucherExceedsPerCallLimit';
  const carried = decayWindow(state);
  if (carried + voucher.amount > state.maxPerWindow) return 'EscrowWindowLimitExceeded';

  if (delegation !== null) {
    if (voucher.amount > delegation.maxVoucherAmount) return 'DelegateVoucherExceedsPerCallLimit';
    const delegateCarried = decayWindow({
      spentInWindow: delegation.spentInWindow,
      windowStartedAt: delegation.windowStartedAt,
      nowSeconds: state.nowSeconds,
    });
    if (delegateCarried + voucher.amount > delegation.maxPerWindow) {
      return 'DelegateWindowLimitExceeded';
    }
  }

  if (state.providerBonded < state.minimumStake) return 'ProviderBelowMinimumStake';
  if (state.balance < voucher.amount) return 'EscrowInsufficient';

  return null;
}
