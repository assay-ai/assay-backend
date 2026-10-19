/**
 * The table that decides whether a judgement is retried, parked or closed.
 *
 * Every entry is keyed on the program's **name** for the error, never on its
 * number. Removing `settle_payment` also removed `StatusDoesNotSettle`,
 * which shifted every variant above it down by one — `SlashCapExceeded` moved
 * from 6026 to 6025. Any code that had matched a number would now be pointing
 * at its neighbour, and the two neighbours here are on opposite sides of "close
 * this case permanently".
 *
 * The number still has to be turned into a name somewhere, because that is all
 * the chain hands back (`{"InstructionError":[i,{"Custom":6011}]}`). This suite
 * is what keeps that one lookup honest: it reads `errors` out of the same
 * `idl/assay_payment.json` the client is generated from and compares it with the
 * table `chain-slash-outcome.ts` declares, entry by entry and however many
 * there are. A variant inserted, deleted or renamed in the program turns this
 * suite red rather than silently re-pointing a verdict at its neighbour.
 *
 * **The count is read, never written.** This file used to say `toHaveLength(50)`
 * and the range test used to say `settlementErrorName(6050)` is null. A later
 * program change appended six variants, and both lines then asserted that the program's own
 * codes were foreign — the second one would have kept passing if the table had
 * been extended and the guard had not, which is the shape of the drift that
 * produced this suite in the first place. Every bound below is now derived from
 * `idl.errors`, so appending is invisible here and a *shift* is still loud.
 *
 * Modelled on `test/unit/chains/solana/record-pda-seeds.spec.ts`, which does
 * the same job for the hand-written PDA seeds.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ChainErrors } from '@modules/chains/errors/chains.errors';
import {
  ChainFailureKind,
  chainErrorName,
  ChainProposalStatus,
  classifyChainFailure,
  settlementErrorName,
  SETTLEMENT_ERROR_CODE_BASE,
  SETTLEMENT_ERROR_NAMES,
} from '@modules/slash/domain/chain-slash-outcome';
import { SlashRecordStatus } from '@modules/slash/ports/slash-executor.port';
import { AppError } from '@shared/errors/app-errors';

const IDL_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'packages',
  'settlement-client',
  'idl',
  'assay_payment.json',
);

interface Idl {
  readonly errors: ReadonlyArray<{ code: number; name: string; msg: string }>;
}

const idl: Idl = JSON.parse(readFileSync(IDL_PATH, 'utf8'));

/**
 * The error the executor actually throws, built by its actual factory.
 *
 * Deliberately not a hand-shaped object: `ChainErrors.transactionFailed` is
 * what `chainRefusal` calls, and the field this module reads
 * (`context.customErrorCode`) only exists because `AppError` retains the
 * factory's context bag. Faking the error would test the fake.
 */
function refusal(customErrorCode: number | null, reason = 'the chain said no'): AppError<any> {
  return ChainErrors.transactionFailed({
    instruction: 'execute_slash',
    signature: null,
    customErrorCode,
    reason,
  });
}

/** The same refusal, addressed by the program's name for it. */
function refusalNamed(name: string): AppError<any> {
  const entry = idl.errors.find((candidate) => candidate.name === name);
  if (!entry) {
    throw new Error(`${name} is not an error the settlement program declares`);
  }
  return refusal(entry.code, entry.msg);
}

describe('the settlement error table agrees with the IDL', () => {
  it('declares exactly the contiguous variants the IDL does, however many there are', () => {
    // Guards against the rest of this suite passing vacuously if the IDL moves
    // or the enum is truncated. A floor rather than a pin: a truncated or
    // unparsed IDL is caught, and appending a variant is not an event this file
    // has an opinion about.
    expect(idl.errors.length).toBeGreaterThan(40);
    expect(SETTLEMENT_ERROR_NAMES).toHaveLength(idl.errors.length);
    expect(SETTLEMENT_ERROR_CODE_BASE).toBe(6000);
    expect(idl.errors.map((entry) => entry.code)).toEqual(
      idl.errors.map((_entry, index) => SETTLEMENT_ERROR_CODE_BASE + index),
    );
  });

  it('resolves every one of the IDL’s codes to the name the IDL gives it', () => {
    // The whole point of the file. An earlier revision deleted a variant from the middle
    // of the enum and shifted 24 codes down by one; if that happens again this
    // is the line that says so.
    expect(idl.errors.map((entry) => settlementErrorName(entry.code))).toEqual(
      idl.errors.map((entry) => entry.name),
    );
  });

  it('classifies every name it decides on as a name the program still declares', () => {
    // A typo or a stale name in VOID_ERRORS/WAIT_ERRORS does not fail loudly:
    // it silently degrades that verdict to TRANSIENT, and a revoked verifier
    // key gets retried until the grace period reaps the record. So assert the
    // other direction too — every name the table decides on must exist.
    const declared = new Set(idl.errors.map((entry) => entry.name));
    const byKind = (kind: ChainFailureKind) =>
      idl.errors
        .map((entry) => entry.name)
        .filter((name) => classifyChainFailure(refusalNamed(name)) === kind);

    // 12 VOID and 5 WAIT — the sizes are asserted because a name that stops
    // matching is invisible otherwise: the verdict just quietly becomes
    // TRANSIENT and nothing anywhere says a rule was lost. These two ARE
    // literals, and deliberately so: they are the size of a decision this repo
    // makes, not of the program's enum, so adding a variant must not move them
    // and changing a rule must be typed here as well as there. Lean v3 took
    // five names out of VOID (`SlashNotExecuted`, `SlashAlreadyReversed`,
    // `MissingProvider`, `ProviderMismatch` and `PenaltyExceedsContract`, the
    // last renamed to `PenaltyExceedsMaximum`) and added
    // `SlashExecutionWindowClosed`. The G7 review took three more out
    // (`AttestationExpired`, `AttestationNotYetValid`, `InvalidAttestationWindow`):
    // they are about a signature's lifetime and are re-signed on retry.
    expect(byKind(ChainFailureKind.VOID)).toHaveLength(9);
    expect(byKind(ChainFailureKind.WAIT)).toHaveLength(5);
    for (const name of [...byKind(ChainFailureKind.VOID), ...byKind(ChainFailureKind.WAIT)]) {
      expect(declared.has(name)).toBe(true);
    }
    // The rest are refusals about staking, config, administration and the
    // escrow: things `propose`/`execute`/`expire` do not raise, and which the
    // default correctly retries rather than guessing at. Counted as the
    // remainder, so appending a variant lands here without a hand edit and
    // moving one out of VOID or WAIT still fails the two lines above.
    expect(byKind(ChainFailureKind.TRANSIENT)).toHaveLength(idl.errors.length - 9 - 5);
  });
});

describe('ChainProposalStatus', () => {
  it('spells the three on-chain lifecycle states exactly as the port does', () => {
    // `SlashRecordSnapshot.status` is a `SlashRecordStatus` string union, and
    // the recovery paths store what the chain reported straight into the
    // `slash_proposals` column this enum types. A different spelling on either
    // side would compile and then write a row nothing matches.
    const fromChain: SlashRecordStatus[] = ['PENDING', 'EXECUTED', 'CANCELLED'];

    expect(fromChain.map((status) => ChainProposalStatus[status])).toEqual(fromChain);
    // The three states with no on-chain counterpart: nothing has been
    // attempted, the chain refused permanently so no record exists or ever
    // will, and — since cancels became admin-signed — the record is still `Pending` while this
    // platform waits for the settlement admin to sign `cancel_slash`.
    expect(ChainProposalStatus.NONE).toBe('NONE');
    expect(ChainProposalStatus.PROPOSING).toBe('PROPOSING');
    expect(ChainProposalStatus.REFUSED).toBe('REFUSED');
    expect(ChainProposalStatus.CANCEL_REQUESTED).toBe('CANCEL_REQUESTED');
  });
});

describe('settlementErrorName', () => {
  it('answers only for codes inside the settlement program’s own range', () => {
    // Both ends taken from the IDL. The top used to be the literal 6049, which
    // a later program change turned into an assertion that `VerifierNotYetActive` belongs to
    // somebody else's program.
    const last = idl.errors[idl.errors.length - 1];

    expect(settlementErrorName(6000)).toBe('ZeroAmount');
    expect(settlementErrorName(last.code)).toBe(last.name);
    expect(settlementErrorName(5999)).toBeNull();
    expect(settlementErrorName(last.code + 1)).toBeNull();
    expect(settlementErrorName(null)).toBeNull();
  });

  it('names the variants later program changes appended or renumbered, by name not number', () => {
    // The regeneration that caught the first drift: the vendored IDL was pinned
    // at 50 variants while the program had 56, and `client:check` compared the
    // generated client against that same stale pin — so nothing anywhere was
    // comparing the copy with the program. Lean v3 then REMOVED twenty-eight
    // variants from the middle of the enum, renumbering every code after each
    // hole — `ProgramPaused` moved from 6038 to 6007 — which is why nothing in
    // this module matches by number. Named explicitly rather than left to the
    // length check, because the failure this guards is precisely a name that
    // stops resolving.
    for (const name of [
      'InvalidAdmin',
      'InvalidMinimumStake',
      'EscrowLimitsRequireBuyer',
      'DestinationIsEscrowAta',
    ]) {
      const entry = idl.errors.find((candidate) => candidate.name === name);
      expect(entry).toBeDefined();
      expect(settlementErrorName(entry!.code)).toBe(name);
      // None of them is a door the slash caller knocks on, so all four retry.
      expect(classifyChainFailure(refusalNamed(name))).toBe(ChainFailureKind.TRANSIENT);
    }
  });

  it('no longer names the variants the program simplifications removed', () => {
    for (const name of [
      // `refactor/trim-optional-doors`
      'NotUpgradeAuthority',
      'ProgramDataMismatch',
      'NotPendingAdmin',
      'RestorePoolInsufficient',
      'NoPendingEconomicsChange',
      'EconomicsChangeNotYetEffective',
      'NoPendingTermsChange',
      'TermsChangeNotYetEffective',
      // The simplified program — the exposure authority, the earnings vault, `reverse_slash`,
      // `close_escrow`, the seq bitmap and the four `Config` delays
      'NotExposureAuthority',
      'InvalidExposureMaxAge',
      'StakeExposed',
      'ExposureAuthorityNotSeparate',
      'SlashAlreadyReversed',
      'SlashNotExecuted',
      'SlashDelayTooShort',
      'SlashDelayTooLong',
      'VerifierActivationDelayTooShort',
      'VerifierActivationDelayTooLong',
      'VerifierExpiresBeforeActive',
      'VerifierNotYetActive',
      'InvalidWithdrawDelay',
      'VoucherSeqJump',
      'VoucherTooOld',
      'VoucherAlreadyRedeemed',
      'EscrowNotEmpty',
      'EscrowNotSettled',
      'WithdrawRequestPending',
      'DestinationIsEarningsVault',
      'NotProvider',
      'InsufficientEarnings',
      'EarningsWithdrawNotYetAvailable',
      'NoEarningsWithdrawRequested',
      'NoFeesToSweep',
      'EarningsVaultInsufficient',
      'InvalidEarningsWithdrawDelay',
      'ProviderMismatch',
      'MissingProvider',
      'PenaltyExceedsContract',
    ]) {
      expect(idl.errors.find((candidate) => candidate.name === name)).toBeUndefined();
      expect(SETTLEMENT_ERROR_NAMES).not.toContain(name);
    }
  });

  it('refuses to name code 0, which belongs to the system program', () => {
    // Anchor's `init` collision happens inside a CPI to the SYSTEM program,
    // whose `AccountAlreadyInUse` is discriminant 0, so it surfaces as
    // "custom program error: 0x0". `extractCustomErrorCode` throws away the
    // instruction index and so cannot tell whose code it is — without the range
    // check, 0 resolves against the settlement IDL to the confident and wrong
    // `ZeroAmount`, which is a WAIT-shaped diagnosis for a foreign program's
    // failure.
    expect(settlementErrorName(0)).toBeNull();
    expect(chainErrorName(refusal(0))).toBeNull();
    expect(classifyChainFailure(refusal(0))).toBe(ChainFailureKind.TRANSIENT);
  });
});

describe('chainErrorName', () => {
  it('reads the name off the structured error, not out of the message', () => {
    // `explainStatusError` renders `getAssayPaymentErrorMessage(code)` — the
    // human sentence, not the variant name — and in production it renders a
    // fixed placeholder for every code. A classifier that parsed the message
    // would see "reinstated" for that code, or nothing at all, and every VOID
    // would degrade into "retry forever".
    //
    // The code is read out of the IDL rather than typed: a program change moved
    // `VerifierRevoked` from 6011 to 6018, and a literal here would have gone
    // on asserting a different variant's name with a straight face.
    const revokedCode = idl.errors.find((entry) => entry.name === 'VerifierRevoked')!.code;
    expect(
      chainErrorName(
        refusal(revokedCode, 'This verifier key has been revoked and can never be reinstated'),
      ),
    ).toBe('VerifierRevoked');
    expect(chainErrorName(refusal(revokedCode, 'the transaction failed'))).toBe('VerifierRevoked');
  });

  it('has no name for a refusal the settlement program never spoke on', () => {
    // `customErrorCode: null` is an expired blockhash, a fallen-over RPC, a
    // confirmation that timed out.
    expect(chainErrorName(refusal(null))).toBeNull();
    expect(chainErrorName(new Error('fetch failed'))).toBeNull();
    expect(chainErrorName(undefined)).toBeNull();
    expect(chainErrorName('VerifierRevoked (custom program error 6011)')).toBeNull();
  });
});

describe('classifyChainFailure', () => {
  it('treats a revoked or expired verifier key as terminal, not as an error to retry', () => {
    // The two-phase slash's whole point: execute_slash re-asks assert_can_sign, so revoking a
    // leaked key voids every judgement it signed that is still in flight. That
    // is the designed outcome of an incident. Retrying it every minute for
    // seven days would bury the one signal that a key was pulled.
    expect(classifyChainFailure(refusalNamed('VerifierRevoked'))).toBe(ChainFailureKind.VOID);
    expect(classifyChainFailure(refusalNamed('VerifierKeyExpired'))).toBe(ChainFailureKind.VOID);
  });

  it('parks a judgement the rolling caps have temporarily priced out', () => {
    // The record stays Pending on chain and the window drains continuously, so
    // the same call can succeed on a later tick. Closing the case here would
    // discharge a penalty the provider still owes.
    for (const name of [
      'SlashNotYetExecutable',
      'SlashCapExceeded',
      'VerifierDailyCapExceeded',
      'PenaltyTooSmallToSplit',
      'NothingToSlash',
    ]) {
      expect(classifyChainFailure(refusalNamed(name))).toBe(ChainFailureKind.WAIT);
    }
  });

  it('closes a case the chain says is already settled or was never valid', () => {
    for (const name of [
      'SlashNotPending',
      'SlashNotExpired',
      // Lean v3's own: the record outlived its seven-day execution grace, so
      // nothing can pay it and only `expire_slash` is left.
      'SlashExecutionWindowClosed',
      'PenaltyExceedsMaximum',
      'MissingBeneficiary',
      'StatusDoesNotSlash',
      // The attestation-window refusals are no longer here: see the block at
      // the end of this file — they are TRANSIENT, re-signed on retry.
      'MissingVerifierSignature',
    ]) {
      expect(classifyChainFailure(refusalNamed(name))).toBe(ChainFailureKind.VOID);
    }
  });

  it('closes a case whose slash record does not exist', () => {
    // Thrown before any transaction is built, so it carries no custom program
    // error code at all. A classifier that only looked at
    // CHAIN_TRANSACTION_FAILED would drop this into the retryable bucket and
    // spin against a record that can never be executed or expired.
    expect(
      classifyChainFailure(
        ChainErrors.slashRecordNotFound({ account: 'SomePda11111', requestId: 'req-1' }),
      ),
    ).toBe(ChainFailureKind.VOID);
  });

  it('retries a paused program and anything it does not recognise', () => {
    // Unrecognised is TRANSIENT on purpose: a WAIT mis-filed as VOID closes a
    // case no later pass will find again, while a VOID mis-filed as TRANSIENT
    // retries until `expire_slash` reaps the record — noisy and self-correcting.
    expect(classifyChainFailure(refusalNamed('ProgramPaused'))).toBe(ChainFailureKind.TRANSIENT);
    expect(classifyChainFailure(refusal(null))).toBe(ChainFailureKind.TRANSIENT);
    expect(classifyChainFailure(new Error('fetch failed'))).toBe(ChainFailureKind.TRANSIENT);
    expect(classifyChainFailure(undefined)).toBe(ChainFailureKind.TRANSIENT);
  });

  it('ignores an unrelated AppError’s context rather than reading a code out of it', () => {
    // Only CHAIN_TRANSACTION_FAILED carries a settlement custom error code. Any
    // other error that happens to have a `customErrorCode` in its context is
    // not one of ours.
    const unrelated = ChainErrors.rpcReplyMalformed({
      method: 'getSignatureStatuses',
      customErrorCode: 6011,
    });

    expect(chainErrorName(unrelated)).toBeNull();
    expect(classifyChainFailure(unrelated)).toBe(ChainFailureKind.TRANSIENT);
  });
});

describe('chainErrorName — EVM program errors', () => {
  // Imported lazily so this block reads on its own.
  const { ChainErrors } = jest.requireActual('@modules/chains/errors/chains.errors');
  const outcome = jest.requireActual('@modules/slash/domain/chain-slash-outcome');

  const evmRevert = (programErrorName: string) =>
    ChainErrors.transactionFailed({
      instruction: 'executeSlash',
      reason: programErrorName,
      customErrorCode: null,
      programErrorName,
    });

  it('names an Errors.sol revert and classifies it with the shared vocabulary', () => {
    expect(outcome.chainErrorName(evmRevert('VerifierRevoked'))).toBe('VerifierRevoked');
    expect(outcome.classifyChainFailure(evmRevert('VerifierRevoked'))).toBe(
      outcome.ChainFailureKind.VOID,
    );
    expect(outcome.classifyChainFailure(evmRevert('SlashCapExceeded'))).toBe(
      outcome.ChainFailureKind.WAIT,
    );
  });

  it('C2: reads the "window full, retry later" revert as WAIT, never VOID', () => {
    expect(outcome.classifyChainFailure(evmRevert('SlashWindowNotDrained'))).toBe(
      outcome.ChainFailureKind.WAIT,
    );
  });

  it('treats an unrecognised revert as a program that never spoke', () => {
    expect(outcome.chainErrorName(evmRevert('UNKNOWN_REVERT:0xdeadbeef'))).toBeNull();
    expect(outcome.classifyChainFailure(evmRevert('UNKNOWN_REVERT:none'))).toBe(
      outcome.ChainFailureKind.TRANSIENT,
    );
  });
});

describe('attestation-window refusals are retried with a fresh signature, never voided', () => {
  const { ChainErrors } = jest.requireActual('@modules/chains/errors/chains.errors');
  const outcome = jest.requireActual('@modules/slash/domain/chain-slash-outcome');

  it.each(['AttestationExpired', 'AttestationNotYetValid', 'InvalidAttestationWindow'])(
    '%s is TRANSIENT: it is about the signature, not the judgement',
    (name) => {
      const error = ChainErrors.transactionFailed({
        reason: name,
        customErrorCode: null,
        programErrorName: name,
      });
      expect(outcome.classifyChainFailure(error)).toBe(outcome.ChainFailureKind.TRANSIENT);
    },
  );
});
