import { toFunctionSelector } from 'viem';

/**
 * Every `error X();` in assay-evm's `src/Errors.sol`, by name.
 *
 * All 71 are **zero-argument** custom errors, so a revert arrives as a bare
 * 4-byte selector with nothing else in it — the only way to say what happened
 * is this table. `check-errors.sh` in `evm/` keeps the Solidity honest;
 * `abi-selectors.spec.ts` keeps this list in step by pinning all 71 names to
 * the selectors `cast sig` produced, which is a different keccak
 * implementation from the one below.
 *
 * Order is the declaration order in `Errors.sol`, so a diff against the
 * Solidity reads straight down.
 *
 * Five of these have no producer on chain and are deliberately kept in
 * `Errors.sol` (assay-evm's `docs/divergences.md` table 2): `EscrowLimitsRequireBuyer`,
 * `DestinationIsVault`, `NotBuyer`, `SignerIsNotVerifier`,
 * `AmountExceedsUint64`. They are listed here too — a table that omits them
 * cannot report one if it ever fires, and "cannot happen" is a claim about
 * today's bytecode.
 */
const NAMES: readonly string[] = [
  'ZeroAmount',
  'ZeroAddress',
  'AmountExceedsUint64',
  'MathOverflow',
  'ProgramPaused',
  'NotAdmin',
  'InvalidAdmin',
  'NotRedeemer',
  'NotBuyer',
  'InvalidTakeRateBps',
  'InvalidSplitBps',
  'InvalidSlashCapBps',
  'InvalidVerifierDailyCap',
  'InvalidMinimumStake',
  'MissingBeneficiary',
  'MissingRedeemer',
  'UnbondingPeriodTooShort',
  'UnbondingPeriodTooLong',
  'VerifierRevoked',
  'VerifierAlreadyRevoked',
  'VerifierKeyExpired',
  'VerifierNotRegistered',
  'VerifierAlreadyRegistered',
  'InvalidVerifierExpiry',
  'InvalidSignature',
  'MalleableSignature',
  'BadSignatureV',
  'SignerIsNotPayer',
  'SignerIsNotVerifier',
  'SignerIsNotBuyer',
  'SignatureExpired',
  'BadNonce',
  'VoucherSeqZero',
  'VoucherSeqNotIncreasing',
  'VoucherExpired',
  'VoucherNotYetValid',
  'InvalidVoucherWindow',
  'VoucherLifetimeTooLong',
  'VoucherExceedsPerCallLimit',
  'EscrowWindowLimitExceeded',
  'EscrowInsufficient',
  'EscrowLimitsUnchanged',
  'EscrowLimitsRequireBuyer',
  'ProviderBelowMinimumStake',
  'BatchTooLarge',
  'BatchLengthMismatch',
  'EmptyBatch',
  'WithdrawNotYetAvailable',
  'NoWithdrawRequested',
  'WithdrawDelayTooShort',
  'TransferAmountMismatch',
  'Permit2NotConfigured',
  'AssetDecimalsNotSix',
  'DestinationIsVault',
  'InsufficientBondedStake',
  'InsufficientUnbondingStake',
  'UnbondingPeriodNotElapsed',
  'AttestationExpired',
  'AttestationNotYetValid',
  'InvalidAttestationWindow',
  'StatusDoesNotSlash',
  'NothingToSlash',
  'SlashCapExceeded',
  'VerifierDailyCapExceeded',
  'PenaltyTooSmallToSplit',
  'PenaltyExceedsMaximum',
  'SlashNotPending',
  'SlashAlreadyExists',
  'SlashNotYetExecutable',
  'SlashExecutionWindowClosed',
  'SlashNotExpired',
  // Agent payment delegation (EVM only).
  'DelegateIsPayer',
  'DelegateCapsInvalid',
  'DelegateCapsExceedEscrowLimits',
  'DelegateValidUntilInvalid',
  'DelegationUnchanged',
  'DelegateNotActive',
  'TooManyDelegates',
  'DelegateIsRevoked',
  'DelegateIsExpired',
  'DelegateVoucherExceedsPerCallLimit',
  'DelegateWindowLimitExceeded',
  'WalletCheckUnderfunded',
];

/** 4-byte selector (lower-case, `0x`-prefixed) → the `Errors.sol` name. */
export const EVM_ERROR_BY_SELECTOR: ReadonlyMap<string, string> = new Map(
  NAMES.map((name) => [toFunctionSelector(`${name}()`), name] as const),
);

/**
 * The `Errors.sol` name behind a revert, or `UNKNOWN_REVERT:…`. **Never null,
 * and never a name it did not recognise.**
 *
 * A selector with no entry here is reported as `UNKNOWN_REVERT:0x…` rather than
 * swallowed: an unnamed refusal is still a refusal, and the one thing it must
 * not do is read as a success. Callers branch on the name, so returning
 * `undefined` for an unknown would put the decision on whoever forgot to check.
 */
export function evmErrorName(revertData: string | null | undefined): string {
  if (typeof revertData !== 'string' || revertData.length < 10) {
    return 'UNKNOWN_REVERT:none';
  }
  const selector = revertData.slice(0, 10).toLowerCase();
  return EVM_ERROR_BY_SELECTOR.get(selector) ?? `UNKNOWN_REVERT:${selector}`;
}

/**
 * The revert data buried in whatever a viem action threw.
 *
 * `EvmRpcError` (`sanctioned-evm-rpc.ts`) carries it as a typed `data`, and
 * viem wraps a transport rejection in one or two of its own error classes, so
 * this walks a bounded `cause` chain rather than reaching for one shape.
 * Anything that is not a `0x` selector is `null` — a message, a string reason, a
 * nested object — because {@link evmErrorName} maps selectors and a
 * non-selector would come back as `UNKNOWN_REVERT:<whatever the node said>`,
 * which is exactly the node's prose the transport refuses to carry.
 *
 * Lives here rather than beside its first caller because it has two:
 * `EvmRelayer` re-runs a reverted send to learn why, and
 * `EvmEscrowIntentBuilder` reads an `eth_estimateGas` refusal to decide whether
 * the chain said "not yet". Two copies would drift on the depth bound, and the
 * one that drifted would silently stop recognising a refusal.
 */
export function revertDataOf(error: unknown): string | null {
  let current = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const data = (current as { data?: unknown }).data;
    if (typeof data === 'string' && /^0x[0-9a-f]{8,}$/i.test(data)) {
      return data.toLowerCase();
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
