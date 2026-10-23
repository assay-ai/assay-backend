import { EvmVoucher } from './eip712/voucher';
import { EVM_CONSTANTS } from './evm.constants';

/**
 * Everything `_redeem` reads that is not in the voucher itself.
 *
 * All of it comes off the chain in one `multicall` — the escrow struct, the
 * provider's bonded stake, and the two `AssayConfig` reads — so nothing here is
 * derived from anything else and nothing is a local copy of a program constant.
 */
export interface PrevalidationState {
  readonly nowSeconds: number;
  readonly paused: boolean;
  /** `msg.sender == p.redeemer`: whether the relayer is the key the contract accepts. */
  readonly redeemerIsUs: boolean;
  /**
   * The escrow's high-water mark: the highest seq ever redeemed. Since D-23 it
   * is only the anchor of the gap cap (`MAX_SEQ_GAP` applies only above it);
   * a seq at or below it is fine unless {@link seqUsed}.
   */
  readonly seqHigh: bigint;
  /**
   * `held(payer, seq).status != None`: this `(payer, seq)` was already
   * redeemed — held, collected or refunded. Records are never deleted, so a
   * refunded seq stays used. The chain's replay rule since D-23.
   */
  readonly seqUsed: boolean;
  /**
   * The escrow's caps as `_redeem` applies them: on an escrow with the tighten
   * delay (D-21) the EFFECTIVE caps from `effectiveCapsOf` — a cap lowered less
   * than `TIGHTEN_DELAY_SECONDS` ago still counts — else the stored ones.
   */
  readonly maxVoucherAmount: bigint;
  readonly maxPerWindow: bigint;
  readonly spentInWindow: bigint;
  readonly windowStartedAt: number;
  readonly balance: bigint;
  /** `bondedOf(provider)` — **`bonded` alone**, never `bonded + unbonding`. */
  readonly providerBonded: bigint;
  readonly minimumStake: bigint;
  /**
   * The signing delegate's on-chain grant (`delegationOf(payer, delegate)`,
   * caps from `effectiveCapsOf` once the escrow has the tighten delay), when
   * the voucher was signed by a delegate; absent for the payer's own key.
   */
  readonly delegation?: PrevalidationDelegation | null;
}

export interface PrevalidationDelegation {
  /** Stored caps, or the effective ones (D-21) when {@link canSign} is set. */
  readonly maxVoucherAmount: bigint;
  readonly maxPerWindow: bigint;
  readonly spentInWindow: bigint;
  readonly windowStartedAt: number;
  readonly validUntil: bigint;
  readonly revoked: boolean;
  /**
   * The chain's own answer to "can this grant sign now" — `effectiveCapsOf`
   * gives delegate caps `0` when it cannot (D-21: a revoked grant still signs
   * for `TIGHTEN_DELAY_SECONDS` after the revocation). Absent on an escrow
   * without the tighten delay, where a revoked grant is dead at once.
   */
  readonly canSign?: boolean;
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
 * The order is copied from assay-evm's `src/AssayEscrow.sol::_redeem` rather than
 * invented, and two entries are **not** where the Anchor program puts them:
 *
 *  - **`seq` is checked BEFORE the signature** (divergence 3). Cheaper on chain
 *    — a used seq is refused without paying for `ecrecover` — and it leaks
 *    nothing, because `held(payer, seq)` and `escrowOf` are public views.
 *    D-23's order: zero, then used (`held(payer, seq)`), then the gap cap,
 *    which applies only to a seq above `seqHigh`.
 *  - **`ProviderBelowMinimumStake` sits at the ANCHOR position** (divergence 4):
 *    after the spending limits and before the balance. Being paid is the
 *    counterpart of being slashable, and it reads `bonded` only, because stake
 *    already asked back is not backing anybody's traffic.
 *
 * The redeemer pin and the pause come first because `redeemVoucher` and
 * `redeemVoucherBatch` both check them **before** calling `_redeem` at all — so
 * a paused program refuses a zero-amount voucher with `ProgramPaused`, and a job
 * that reported `ZeroAmount` would close a hold the chain never rejected.
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

  // D-23: each `(payer, seq)` once, in any order. A seq at or below `seqHigh`
  // is fine as long as it was never used; D-17's jump cap applies only above
  // the mark — the contract's order, and its guard against the subtraction.
  if (voucher.seq === 0n) return 'VoucherSeqZero';
  if (state.seqUsed) return 'VoucherSeqUsed';
  if (
    voucher.seq > state.seqHigh &&
    voucher.seq - state.seqHigh > BigInt(EVM_CONSTANTS.MAX_SEQ_GAP)
  ) {
    return 'VoucherSeqGapTooLarge';
  }

  // The authority, where `_voucherAuthority` decides it (agent payment
  // delegation): a delegate-signed voucher needs a grant that can sign at THIS
  // block. `_canSign`: not past `validUntil` and, if revoked, still inside the
  // grace the chain reports (D-21); without the tighten delay a revocation is
  // final at once. A grant that cannot sign is named `DelegateIsRevoked` if it
  // was revoked and `DelegateIsExpired` if not — the contract's naming.
  const delegation = state.delegation ?? null;
  if (delegation !== null) {
    if (delegation.validUntil === 0n) return 'SignerIsNotPayer';
    const canSign =
      BigInt(state.nowSeconds) <= delegation.validUntil &&
      (delegation.canSign ?? !delegation.revoked);
    if (!canSign) return delegation.revoked ? 'DelegateIsRevoked' : 'DelegateIsExpired';
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

/** One item of a `redeemVoucherBatch`, as {@link prevalidateBatch} takes it. */
export interface PrevalidationItem {
  readonly voucher: EvmVoucher;
  /** Read for THIS item before the batch; the payer's earlier items are applied on top. */
  readonly state: PrevalidationState;
  /** The delegate that signed (any spelling), or `null` for the payer's own key. */
  readonly delegate?: string | null;
}

/**
 * {@link prevalidateVoucher} over a batch, item by item, exactly as
 * `redeemVoucherBatch` runs `_redeem`: each item sees the effects of the items
 * before it that would settle.
 *
 * Every state was read before the batch, so on its own it knows nothing about
 * an earlier item of the same payer. Since D-23 one payer's items may share a
 * batch in any order, so the earlier ones are applied here the way the chain
 * applies them: the seq becomes used (a second copy of the same voucher is
 * `VoucherSeqUsed`), `seqHigh = max(seqHigh, seq)` (the gap cap of later items
 * anchors on it), the balance drops by the amount, and the escrow's — and the
 * signing delegate's — window counter is decayed to now and grows by it.
 *
 * Only an item that would settle has effects: a refused one is left out of the
 * batch, so the chain never sees it.
 */
export function prevalidateBatch(items: readonly PrevalidationItem[]): (string | null)[] {
  interface EscrowEffects {
    seqHigh: bigint;
    readonly used: Set<bigint>;
    balance: bigint;
    spentInWindow: bigint;
    windowStartedAt: number;
  }
  interface WindowEffects {
    spentInWindow: bigint;
    windowStartedAt: number;
  }
  const escrows = new Map<string, EscrowEffects>();
  const delegates = new Map<string, WindowEffects>();

  return items.map(({ voucher, state, delegate }) => {
    const payer = voucher.payer.toLowerCase();
    const delegateKey = delegate ? `${payer}:${delegate.toLowerCase()}` : null;
    const escrow = escrows.get(payer);
    const grant = delegateKey === null ? undefined : delegates.get(delegateKey);

    const effective: PrevalidationState =
      escrow === undefined && grant === undefined
        ? state
        : {
            ...state,
            ...(escrow === undefined
              ? {}
              : {
                  seqHigh: escrow.seqHigh,
                  seqUsed: state.seqUsed || escrow.used.has(voucher.seq),
                  balance: escrow.balance,
                  spentInWindow: escrow.spentInWindow,
                  windowStartedAt: escrow.windowStartedAt,
                }),
            delegation:
              grant === undefined || !state.delegation
                ? state.delegation
                : {
                    ...state.delegation,
                    spentInWindow: grant.spentInWindow,
                    windowStartedAt: grant.windowStartedAt,
                  },
          };

    const refusal = prevalidateVoucher(voucher, effective);
    if (refusal !== null) return refusal;

    // The effects of `_redeem`, in its terms.
    const used = escrow?.used ?? new Set<bigint>();
    used.add(voucher.seq);
    escrows.set(payer, {
      seqHigh: voucher.seq > effective.seqHigh ? voucher.seq : effective.seqHigh,
      used,
      balance: effective.balance - voucher.amount,
      spentInWindow: decayWindow(effective) + voucher.amount,
      windowStartedAt: Math.max(effective.nowSeconds, effective.windowStartedAt),
    });
    const delegation = effective.delegation ?? null;
    if (delegateKey !== null && delegation !== null) {
      delegates.set(delegateKey, {
        spentInWindow:
          decayWindow({
            spentInWindow: delegation.spentInWindow,
            windowStartedAt: delegation.windowStartedAt,
            nowSeconds: effective.nowSeconds,
          }) + voucher.amount,
        windowStartedAt: Math.max(effective.nowSeconds, delegation.windowStartedAt),
      });
    }
    return null;
  });
}
