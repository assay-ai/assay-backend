import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import { AppError } from '@shared/errors/app-errors';

/**
 * What a chain refusal means for a case.
 *
 * Pure — no NestJS, no TypeORM, no chain SDK. The two imports are a string enum
 * of error codes and the error class itself; both are plain TypeScript, and
 * `@x402/settlement-client` is banned outside `src/modules/chains/` by ESLint
 * anyway.
 *
 * ## Why this keys on names and not on numbers
 *
 * The program's `#[error_code]` enum is not append-only in practice. One
 * change deleted `StatusDoesNotSettle` from the *middle* of it, along with
 * `settle_payment`, and every variant above it shifted down by one:
 * `SlashCapExceeded` was 6026 and is 6025 now, `PenaltyTooSmallToSplit` took
 * over 6026. A hardcoded number here would today be deciding a different
 * question than the one it was written for — and the two neighbours in that
 * particular swap are both in this file, one in `WAIT` and one right beside it.
 *
 * So the number is resolved to a name exactly once, in
 * {@link settlementErrorName}, and every decision is made on the name.
 * {@link SETTLEMENT_ERROR_NAMES} is the only copy of the program's error enum
 * outside the IDL, and `test/unit/slash/chain-slash-outcome.spec.ts` compares
 * it against `packages/settlement-client/idl/x402_payment.json` entry by entry
 * — so the next shift fails a test rather than re-pointing a verdict.
 *
 * Neither the table nor its spec states how many variants there are. One
 * change appended six and every count written down as a literal became a lie that
 * still compiled; the one that was asserted turned red, the ones in prose did
 * not. So the length is read off the IDL wherever it is needed and written
 * nowhere.
 *
 * ## Why it does not key on the message
 *
 * The obvious shortcut — read the name out of the string the chain layer
 * produced — does not work and fails in the dangerous direction. That string
 * comes from `explainStatusError`, which renders
 * `getX402PaymentErrorMessage(code)`: the human *sentence*, not the variant
 * name (6011 is "This verifier key has been revoked and can never be
 * reinstated"), and a fixed placeholder for every code when
 * `NODE_ENV === 'production'`. A parser would extract "reinstated", or nothing,
 * and every `VOID` and `WAIT` would collapse into "retry" — which is how a
 * revoked verifier key ends up hammered once a minute for seven days.
 */

/** The mirror of the on-chain `SlashRecord` lifecycle, as a `slash_proposals` column. */
export enum ChainProposalStatus {
  /** No record exists and none has been attempted. */
  NONE = 'NONE',
  /** A `propose_slash` is claimed or in flight. Recoverable; see the sweep. */
  PROPOSING = 'PROPOSING',
  /** `SlashStatus::Pending` — the stake is reserved and the clock is running. */
  PENDING = 'PENDING',
  /**
   * Still `SlashStatus::Pending` on chain, and this platform has decided it
   * should not be.
   *
   * `cancel_slash` is the **admin's** instruction: its only signer is
   * `Config.admin`, a person's hardware key that no service in this codebase
   * holds. So an overturn, a suspension, a platform-miss sweep or a downward
   * recalculation can no longer release the reservation inside the request that decided it —
   * it can only say so, and wait for a human to sign the transaction
   * `POST /operator/cases/:id/cancel-intent` builds.
   *
   * The distinction from `PENDING` is what keeps a case in this state out of
   * `findChainExecutable` (whose predicate is `chain_status = 'PENDING'`), so a
   * judgement this platform has withdrawn is never executed by this platform
   * while it waits. It does **not** stop a stranger: `execute_slash` is
   * permissionless once `executable_at` passes, which is why the admin cancel
   * matters and why the sweep also expires a record nobody signed for after its
   * seven-day grace.
   */
  CANCEL_REQUESTED = 'CANCEL_REQUESTED',
  /** `SlashStatus::Executed` — the money moved. */
  EXECUTED = 'EXECUTED',
  /** `SlashStatus::Cancelled` — cancelled or expired; the reservation is released. */
  CANCELLED = 'CANCELLED',
  /** The chain refused permanently. No record exists and none will. */
  REFUSED = 'REFUSED',
}

export enum ChainFailureKind {
  /** Try again on a later tick. */
  TRANSIENT = 'TRANSIENT',
  /** The record is still Pending on chain and may become payable later. */
  WAIT = 'WAIT',
  /** The judgement is dead. Close the case; do not retry. */
  VOID = 'VOID',
}

/** The first discriminant Anchor assigns a program's own `#[error_code]` enum. */
export const SETTLEMENT_ERROR_CODE_BASE = 6000;

/**
 * The settlement program's error enum, in declaration order, from
 * `packages/settlement-client/idl/x402_payment.json`.
 *
 * Index `i` is code `SETTLEMENT_ERROR_CODE_BASE + i`. Hand-written on purpose —
 * the generated client is a chain SDK and cannot be imported here — and checked
 * against the IDL, entry by entry and length included, by this module's spec.
 * That check is the whole reason a hand-written copy of a program interface is
 * allowed to exist;
 * `test/unit/chains/solana/record-pda-seeds.spec.ts` does the same for the one
 * hand-written PDA finder.
 *
 * **The enum is not append-only, and the program's simplification proved
 * it.** Removing the exposure authority, `ProviderTerms`, `EconomicsConfig`,
 * the earnings vault, `reverse_slash` and `close_escrow` deleted twenty-eight
 * variants from the middle of the list and renumbered every code after each
 * hole — `ProgramPaused` moved from 6038 to 6007. Nothing in this codebase may
 * hold a settlement error as a number for that reason; the two sets below and
 * every call site work in names, and this table is the single place a number
 * becomes one.
 */
export const SETTLEMENT_ERROR_NAMES: readonly string[] = [
  'ZeroAmount', // 6000
  'MathOverflow', // 6001
  'NotAdmin', // 6002
  'InvalidAdmin', // 6003
  'UnbondingPeriodTooShort', // 6004
  'UnbondingPeriodTooLong', // 6005
  'StakeMintProgramNotSupported', // 6006
  'ProgramPaused', // 6007
  'InvalidSplitBps', // 6008
  'InvalidTakeRateBps', // 6009
  'InvalidSlashCapBps', // 6010
  'InvalidVerifierDailyCap', // 6011
  'InvalidMinimumStake', // 6012
  'MissingBeneficiary', // 6013
  'InsufficientBondedStake', // 6014
  'InsufficientUnbondingStake', // 6015
  'UnbondingPeriodNotElapsed', // 6016
  'DestinationIsVault', // 6017
  'VerifierRevoked', // 6018
  'VerifierAlreadyRevoked', // 6019
  'VerifierKeyExpired', // 6020
  'InvalidVerifierExpiry', // 6021
  'MissingVerifierSignature', // 6022
  'AttestationExpired', // 6023
  'AttestationNotYetValid', // 6024
  'InvalidAttestationWindow', // 6025
  'StatusDoesNotSlash', // 6026
  'NothingToSlash', // 6027
  'SlashCapExceeded', // 6028
  'VerifierDailyCapExceeded', // 6029
  'PenaltyTooSmallToSplit', // 6030
  'PenaltyExceedsMaximum', // 6031
  'SlashNotPending', // 6032
  'SlashNotYetExecutable', // 6033
  'SlashExecutionWindowClosed', // 6034
  'SlashNotExpired', // 6035
  'VoucherSeqZero', // 6036
  'VoucherSeqNotIncreasing', // 6037
  'VoucherExpired', // 6038
  'VoucherNotYetValid', // 6039
  'InvalidVoucherWindow', // 6040
  'MissingBuyerSignature', // 6041
  'EscrowMismatch', // 6042
  'EscrowInsufficient', // 6043
  'VoucherExceedsPerCallLimit', // 6044
  'EscrowWindowLimitExceeded', // 6045
  'ProviderBelowMinimumStake', // 6046
  'NotBuyer', // 6047
  'EscrowLimitsRequireBuyer', // 6048
  'EscrowLimitsUnchanged', // 6049
  'WithdrawNotYetAvailable', // 6050
  'NoWithdrawRequested', // 6051
  'DestinationIsEscrowAta', // 6052
  'NotRedeemer', // 6053
  'MissingRedeemer', // 6054
];

/**
 * Refusals that leave a `Pending` record and may resolve by themselves.
 *
 * All five are functions of a *moving* quantity — the rolling 24-hour windows
 * drain continuously, `at_risk` grows when a provider tops up, and
 * `SlashNotYetExecutable` is simply the clock. Closing a case on any of them
 * would discharge a penalty the provider still owes.
 */
const WAIT_ERRORS: ReadonlySet<string> = new Set([
  'SlashNotYetExecutable',
  'SlashCapExceeded',
  'VerifierDailyCapExceeded',
  'PenaltyTooSmallToSplit',
  'NothingToSlash',
]);

/**
 * Refusals that mean the judgement will never be paid.
 *
 * `VerifierRevoked` and `VerifierKeyExpired` are the important two and are the
 * *designed* consequence of an incident response: `execute_slash` re-asks
 * `assert_can_sign`, so pulling a leaked key voids everything it signed that is
 * still in flight. The backend must record that and stop.
 *
 * `SlashNotPending` is here rather than in `WAIT` because the record has
 * already left `Pending` — somebody executed, cancelled or expired it — and the
 * caller's next move is to read the record, not to try again.
 */
const VOID_ERRORS: ReadonlySet<string> = new Set([
  'VerifierRevoked',
  'VerifierKeyExpired',
  'SlashNotPending',
  'SlashNotExpired',
  // The record outlived its seven-day execution grace. Nothing can pay it now;
  // `expire_slash` is the only door left, and it releases rather than pays.
  'SlashExecutionWindowClosed',
  'PenaltyExceedsMaximum',
  'MissingBeneficiary',
  'StatusDoesNotSlash',
  // NOT `AttestationExpired`, `AttestationNotYetValid` or
  // `InvalidAttestationWindow`. Those are about the SIGNATURE's validity window,
  // not the judgement: a slow send or a clock skew expires a signature that the
  // next attempt simply signs afresh. Voiding on them closed sound cases, and a
  // delayed transaction carrying the old signature could still land behind
  // the closed case. They fall through to TRANSIENT.
  'MissingVerifierSignature',
]);

/**
 * The settlement program's own name for a custom error code, or `null` when the
 * code is not one of its.
 *
 * **The range check is load-bearing, not defensive.** Anchor's `init` collision
 * happens inside a CPI to the *system* program, whose `AccountAlreadyInUse` is
 * discriminant `0`, so it reaches the backend as `custom program error: 0x0`.
 * `extractCustomErrorCode` walks the RPC reply for `{ Custom: n }` and discards
 * the instruction index alongside it, so by the time the number arrives here
 * there is nothing left saying which program produced it. Resolving `0` against
 * the settlement enum would answer `ZeroAmount` — confidently, and about a
 * different program. Anything outside the range {@link SETTLEMENT_ERROR_NAMES}
 * spans — `SETTLEMENT_ERROR_CODE_BASE` up to, but not including,
 * `SETTLEMENT_ERROR_CODE_BASE + SETTLEMENT_ERROR_NAMES.length` — is therefore
 * not ours, and an unnamed refusal is retried rather than diagnosed. The bound
 * is the table's own length and never a number written beside it: the
 * program's simplification removed twenty-eight variants from the middle of
 * the enum and moved the top of the range from 6078 down to 6052, and a literal
 * bound would have gone on naming codes the program no longer has.
 */
export function settlementErrorName(code: number | null | undefined): string | null {
  if (typeof code !== 'number' || !Number.isInteger(code)) {
    return null;
  }
  const index = code - SETTLEMENT_ERROR_CODE_BASE;
  return index >= 0 && index < SETTLEMENT_ERROR_NAMES.length ? SETTLEMENT_ERROR_NAMES[index] : null;
}

/**
 * The program's own name for a failure, taken from the structured error the
 * chain layer throws.
 *
 * `SlashExecutorPort`'s implementation raises
 * {@link ChainErrorCode.CHAIN_TRANSACTION_FAILED} with the Anchor custom error
 * number in `context.customErrorCode` — `null` there means the program never
 * spoke at all (expired blockhash, RPC failure, confirmation timeout), which is
 * transient by construction and has no name to give.
 *
 * Only that one code is read. Another error's context may carry a field of the
 * same name for another reason, and guessing from it would be exactly the
 * confident-wrong-answer failure the range check above exists to prevent.
 */
export function chainErrorName(error: unknown): string | null {
  if (!(error instanceof AppError) || error.errorCode !== ChainErrorCode.CHAIN_TRANSACTION_FAILED) {
    return null;
  }
  const evmName = error.context?.programErrorName;
  if (typeof evmName === 'string' && EVM_PROGRAM_ERROR_NAME.test(evmName)) {
    return evmName;
  }
  return settlementErrorName(error.context?.customErrorCode as number | null | undefined);
}

/**
 * An `Errors.sol` name as `EvmSlashExecutor` reports it in
 * `context.programErrorName`.
 *
 * EVM custom errors are zero-argument and arrive as a 4-byte selector, which
 * `evmErrorName` maps to the declared name — there is no number to resolve,
 * so the name itself travels. The Solidity names mirror the Anchor ones
 * (`VerifierRevoked`, `SlashCapExceeded`, …), so the WAIT and VOID sets below
 * classify both chains with one vocabulary. `UNKNOWN_REVERT:0x…` and
 * `UNKNOWN_REVERT:none` deliberately do NOT match: an unnamed revert is
 * classified exactly like a program that never spoke — transient.
 */
const EVM_PROGRAM_ERROR_NAME = /^[A-Z][A-Za-z0-9]*$/;

/**
 * What to do about a failed chain call: retry it, park it, or close the case.
 *
 * Takes the thrown error rather than a name, because one of the terminal
 * outcomes has no name to take. {@link ChainErrorCode.CHAIN_SLASH_RECORD_NOT_FOUND}
 * is raised *before* any transaction is built, by the phases that must read the
 * record to construct one, so it carries no custom program error code at all —
 * and it is as terminal as anything here: a `SlashRecord` lives at exactly one
 * PDA per request id, and an absent one means the judgement was never proposed
 * or is already finished. A classifier that only looked at
 * `CHAIN_TRANSACTION_FAILED` would drop it into the retryable bucket and spin
 * against a record that can never be executed or expired.
 *
 * **Unrecognised is `TRANSIENT` on purpose.** The two ways to be wrong are not
 * symmetric. A `WAIT` mis-filed as `VOID` closes a case that could still have
 * been paid, and no later pass will find it again. A `VOID` mis-filed as
 * `TRANSIENT` retries a dead judgement until the seven-day grace expires and
 * `expire_slash` reaps it — noisy, alerted, and self-correcting. So the default
 * falls on the recoverable side, and a variant added next quarter is retried
 * rather than silently discharged.
 */
export function classifyChainFailure(error: unknown): ChainFailureKind {
  if (
    error instanceof AppError &&
    error.errorCode === ChainErrorCode.CHAIN_SLASH_RECORD_NOT_FOUND
  ) {
    return ChainFailureKind.VOID;
  }

  const name = chainErrorName(error);
  if (name === null) return ChainFailureKind.TRANSIENT;
  if (VOID_ERRORS.has(name)) return ChainFailureKind.VOID;
  if (WAIT_ERRORS.has(name)) return ChainFailureKind.WAIT;
  return ChainFailureKind.TRANSIENT;
}
