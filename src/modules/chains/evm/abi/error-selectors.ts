import { toFunctionSelector } from 'viem';

/**
 * Every `error X();` in assay-evm's `src/Errors.sol`, by name.
 *
 * All 88 are **zero-argument** custom errors, so a revert arrives as a bare
 * 4-byte selector with nothing else in it — the only way to say what happened
 * is this table. `check-errors.sh` in `evm/` keeps the Solidity honest;
 * `abi-selectors.spec.ts` keeps this list in step by pinning every name to the
 * selector `cast sig` produced, which is a different keccak implementation from
 * the one below.
 *
 * Order is the declaration order in `Errors.sol`, so a diff against the
 * Solidity reads straight down. D-18 removed seven errors with no producer
 * left (`AmountExceedsUint64`, `NotBuyer`, `SignerIsNotVerifier`,
 * `EscrowLimitsRequireBuyer`, `DestinationIsVault`, `WalletCheckUnderfunded`,
 * `Permit2NotConfigured`); D-17/D-18 added `NotOwner`,
 * `OwnershipCannotBeRenounced`, `AdminChangeRequiresOwner`,
 * `VoucherSeqGapTooLarge` and `SignatureDeadlineTooFar`. The dispute upgrade
 * (D-19) appended seven: `NotSlashedProvider`, `DisputeWindowClosed`,
 * `SlashNotDisputed`, `NotArbiter`, `ArbiterIsVerifier`, `AddressBlocked` and
 * `InvalidSlashDelay`.
 */
const NAMES: readonly string[] = [
  'ZeroAmount',
  'ZeroAddress',
  'MathOverflow',
  'ProgramPaused',
  'NotAdmin',
  'InvalidAdmin',
  'NotRedeemer',
  'NotOwner',
  'OwnershipCannotBeRenounced',
  'AdminChangeRequiresOwner',
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
  'SignerIsNotBuyer',
  'SignatureExpired',
  'SignatureDeadlineTooFar',
  'BadNonce',
  'VoucherSeqZero',
  'VoucherSeqNotIncreasing',
  'VoucherSeqGapTooLarge',
  'VoucherExpired',
  'VoucherNotYetValid',
  'InvalidVoucherWindow',
  'VoucherLifetimeTooLong',
  'VoucherExceedsPerCallLimit',
  'EscrowWindowLimitExceeded',
  'EscrowInsufficient',
  'EscrowLimitsUnchanged',
  'ProviderBelowMinimumStake',
  'BatchTooLarge',
  'BatchLengthMismatch',
  'EmptyBatch',
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
  'WithdrawNotYetAvailable',
  'NoWithdrawRequested',
  'WithdrawDelayTooShort',
  'TransferAmountMismatch',
  'AssetDecimalsNotSix',
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
  // The dispute upgrade (D-19), appended in Errors.sol's order.
  'NotSlashedProvider',
  'DisputeWindowClosed',
  'SlashNotDisputed',
  'NotArbiter',
  'ArbiterIsVerifier',
  'AddressBlocked',
  'InvalidSlashDelay',
];

/**
 * OpenZeppelin's own errors that `X402Config`'s owner doors raise
 * (`Ownable2StepUpgradeable`, D-17). Unlike `Errors.sol` these carry an
 * argument, so the selector is over the full signature; the decoded name drops
 * the argument, which a revert reason does not need. The backend calls none of
 * those doors — they are here so a revert that carries one is named, not
 * `UNKNOWN_REVERT`.
 */
const PARAMETERISED_SIGNATURES: readonly string[] = [
  'OwnableUnauthorizedAccount(address)',
  'OwnableInvalidOwner(address)',
];

/** 4-byte selector (lower-case, `0x`-prefixed) → the error's name. */
export const EVM_ERROR_BY_SELECTOR: ReadonlyMap<string, string> = new Map([
  ...NAMES.map((name) => [toFunctionSelector(`${name}()`), name] as const),
  ...PARAMETERISED_SIGNATURES.map(
    (signature) =>
      [toFunctionSelector(signature), signature.slice(0, signature.indexOf('('))] as const,
  ),
]);

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
