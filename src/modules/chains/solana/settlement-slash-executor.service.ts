import { webcrypto } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  Address,
  address,
  appendTransactionMessageInstruction,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getAddressDecoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  Instruction,
  pipe,
  ReadonlyUint8Array,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  SignatureBytes,
  SignatureDictionary,
  Transaction,
  TransactionPartialSigner,
} from '@solana/kit';

import {
  findConfigPda,
  findSlashRecordPda,
  findStakePda,
  findVerifierKeyPda,
  getCancelSlashInstructionAsync,
  getConfigDecoder,
  getExecuteSlashInstructionAsync,
  getExpireSlashInstruction,
  getProposeSlashInstructionAsync,
  getSlashRecordDecoder,
  getX402PaymentErrorMessage,
  ResponseClass,
  SIGNED_RESPONSE_CLASS,
  SLASH_RECORD_DISCRIMINATOR,
  slashAttestationMessage,
  SlashStatus,
  X402PaymentError,
} from '@x402/settlement-client';

import {
  AccountId,
  AssetId,
  ChainId,
  parseAssetId,
  toAccountId,
} from '@modules/chains/ports/caip.types';

import {
  SlashCancelIntent,
  SlashCancelRequest,
  SlashCancelResult,
  SlashExecutionRequest,
  SlashExecutionResult,
  SlashExecutorPort,
  SlashProposalRequest,
  SlashProposalResult,
  SlashRecordSnapshot,
} from '@modules/slash/ports/slash-executor.port';
import { SigningRequesterType } from '@modules/verification/signing/domain/signing-journal';
import {
  SignatureResult,
  VerifierSigningService,
} from '@modules/verification/signing/services/verifier-signing.service';

import { ChainErrors } from '../errors/chains.errors';
import { ed25519VerifyInstruction } from './ed25519-precompile';
import { describeError, extractCustomErrorCode } from './program-error';
import { ENABLED_CHAINS_ENV } from '../enabled-chains';
import { SOLANA_CHAIN_ID, SOLANA_RPC } from './solana.constants';
import { SETTLEMENT_PROGRAM_ID, SETTLEMENT_PROGRAM_ID_ENV } from './settlement-program.constants';

/**
 * The slice of the Solana JSON-RPC this service needs, declared structurally so
 * a test supplies exactly these four — the same trade every other service under
 * this directory makes. One method more than `ExposureRecorderRpcClient`:
 * `getSignatureStatuses`, because `record_exposure` is fire-and-forget (see its
 * class comment) and a slash is not — `appliedMinor` can only be read back once
 * the transaction has actually landed.
 */
export interface SlashExecutorRpcClient {
  getAccountInfo(
    account: Address,
    config: { encoding: 'base64'; commitment?: 'confirmed' | 'finalized' },
  ): { send(): Promise<{ value: { data: readonly [string, 'base64'] } | null }> };
  getLatestBlockhash(config: { commitment?: 'confirmed' | 'finalized' }): {
    send(): Promise<{ value: { blockhash: string; lastValidBlockHeight: bigint } }>;
  };
  sendTransaction(
    base64Transaction: string,
    config: { encoding: 'base64'; preflightCommitment?: 'confirmed' | 'finalized' },
  ): { send(): Promise<string> };
  getSignatureStatuses(
    signatures: readonly string[],
    config: { searchTransactionHistory?: boolean },
  ): {
    send(): Promise<{
      value: readonly ({ err: unknown; confirmationStatus: string | null } | null)[];
    }>;
  };
}

/**
 * The two methods this class needs from `VerifierSigningService`, narrowed so a
 * unit test can hand it a bare fake instead of constructing the real service's
 * six dependencies (signer port, alerting, config, key directory, rate limiter,
 * journal repository). Resolved through `ModuleRef` rather than a constructor
 * parameter — see the class comment for why.
 *
 * `publicKey()` exists because two of the three doors this class submits —
 * `execute_slash` and `expire_slash` — sign no attestation at all, and still need the verifier's
 * address to name a fee payer. Recovering it by signing an empty payload would
 * put a second, meaningless row in the signing journal for every submission,
 * and that journal is the audit record for every use of the key: a row that
 * attests to nothing makes the rest of them harder to read, not easier.
 *
 * A **public** key is not key material, so this does not breach the port rule
 * in `docs/architecture.md` §"Signing Keys" ("no port returns private key material"). A
 * remote signer — KMS, Turnkey, Vault — can implement it, which is the test
 * that rule actually encodes.
 */
export interface AttestationSigner {
  sign(request: {
    /**
     * The chain whose verifier key signs. Present here because TypeScript's method parameters are
     * **bivariant**: this interface kept compiling against a
     * `VerifierSigningService.sign` that had grown a required `chainId`, and
     * every call below would have passed `undefined` into
     * `findActive(chainId)` at runtime. A structural copy of a service's
     * signature is only as good as its last edit; this one is now checked by
     * the compiler again because the field exists on both sides.
     */
    chainId: ChainId;
    purpose: string;
    requestId: string | null;
    requestedBy: { type: SigningRequesterType; id: string };
    payload: Uint8Array;
  }): Promise<SignatureResult>;
  publicKey(chainId: ChainId): Promise<Uint8Array>;
}

const SUBMITTER_IDENTITY = 'solana-slash-executor';
const PROPOSE_ATTESTATION_PURPOSE = 'settlement.propose_slash.attestation';
const PROPOSE_TRANSACTION_PURPOSE = 'settlement.propose_slash.transaction';
const EXECUTE_TRANSACTION_PURPOSE = 'settlement.execute_slash.transaction';
const EXPIRE_TRANSACTION_PURPOSE = 'settlement.expire_slash.transaction';
// There is no cancel purpose of either kind. Lean v3's `cancel_slash` is
// authorised by `Config.admin`'s own signature — a person's hardware key — so
// this process builds that transaction and signs nothing on it.

/** How long a signed attestation stays valid on-chain — see `attestationWindow`. */
const ATTESTATION_VALIDITY_SECONDS = 600n;

/** How long to wait for a signature to reach `confirmed`, and how often to poll. */
const CONFIRM_TIMEOUT_MS = 60_000;
const CONFIRM_POLL_MS = 500;

/**
 * `SlashRecord` as the decoder actually returns it. Declared from the generated
 * decoder rather than retyped, so a field the program adds or moves is a
 * compile error at the call sites rather than a silently missing property.
 */
type DecodedSlashRecord = ReturnType<ReturnType<typeof getSlashRecordDecoder>['decode']>;

/**
 * `SlashStatus` as the port's own vocabulary.
 *
 * Indexed by the generated enum's members rather than by name, so a reordering
 * of the Rust enum is a compile error here rather than a silent remapping — the
 * difference between "cancelled" and "executed" is whether the money moved.
 */
const SLASH_STATUS_NAMES = {
  [SlashStatus.Pending]: 'PENDING',
  [SlashStatus.Executed]: 'EXECUTED',
  [SlashStatus.Cancelled]: 'CANCELLED',
} as const satisfies Record<SlashStatus, SlashRecordSnapshot['status']>;

/**
 * Submits the slash lifecycle to the settlement program: `propose_slash`,
 * `execute_slash` and `expire_slash`.
 *
 * It also **builds, and does not sign,** `cancel_slash`. Lean v3 moved the
 * cancellation from a verifier attestation to `Config.admin`'s own signature,
 * and that key is a person's hardware key that this codebase does not hold — so
 * {@link buildCancel} returns an unsigned transaction for a human to sign, in
 * the same shape `StakeIntentBuilderPort` and `EscrowIntentBuilderPort` already
 * return theirs. There is no `reverse_slash` any more at all: compensating an
 * overturned judgement is a treasury-funded `deposit_stake`, built by
 * `StakeIntentBuilderPort` and signed by the treasury's multisig.
 *
 * ## Why `VerifierSigningService` is resolved through `ModuleRef`, not injected
 *
 * `VerifierSigningModule` imports `ChainsModule` — it needs `VERIFIER_REGISTRY`
 * to check a key against the on-chain allowlist before it will sign with it.
 * If `ChainsModule` in turn imported `VerifierSigningModule` to reach
 * `VerifierSigningService`, the two modules would import each other, and
 * neither file has been written with `forwardRef()` around that reference —
 * `verifier-signing.module.ts` is out of scope for this change, and there is no
 * precedent for a circular module import anywhere in this codebase (`grep -r
 * forwardRef src/` is empty), which is a strong signal that the architecture
 * does not want one added here either.
 *
 * `ModuleRef.get(VerifierSigningService, { strict: false })` sidesteps the
 * static import cycle entirely: it is a NestJS core provider available in every
 * module without an `imports:` entry, and `strict: false` searches the whole
 * running application's container rather than only this module's own. Today
 * only the worker process imports `VerifierSigningModule` (see
 * `bootstrap/worker/app.module.ts`), so in every other process this lookup
 * throws — correctly: `ChainsModule` is imported by the api, worker, websocket,
 * scheduler and facilitator bootstraps alike, and a process with no verifier
 * signing key in its address space has no business being able to slash anyone.
 * The failure is loud (see {@link resolveSigner}) rather than a silent no-op.
 *
 * ## Why the verifier's own key is also the transaction fee payer
 *
 * `propose_slash` and `execute_slash` both treat their `payer` as "deliberately
 * any signer … it is load-bearing that nothing in this instruction consults
 * it", and `expire_slash` does not even have one, because it is permissionless.
 * This class has exactly one signing capability available to it — the verifier
 * key reached through `VerifierSigningService` — and reuses it for the fee-payer
 * role rather than inventing a second production signing key nobody asked for.
 * That key needs **SOL and nothing else**.
 *
 * `cancel_slash` has no fee payer this class can supply: its only signer is the
 * admin, and the admin is also the fee payer of the transaction
 * {@link buildCancel} hands back unsigned.
 *
 * Every signature the verifier key makes — attestation and transaction alike —
 * goes through `VerifierSigningService.sign()`, so it lands in the signing
 * journal. Reading the verifier key's public address does not go through the
 * journal, and deliberately: see {@link AttestationSigner}.
 *
 * ## Every amount and every clock is read from the chain, never assumed
 *
 * `SlashRecord` is the only place these exist — the generated client has no
 * event decoder at all (`packages/settlement-client/src/generated` has no
 * `events/` directory), so there is no second, cheaper source to prefer. Each
 * door fetches and decodes the record after confirming, with the same
 * discriminator guard `SolanaVerifierRegistryService` uses next door, for the
 * same reason: reporting the requested penalty back as `appliedMinor` would make
 * a capped judgement look fully applied, which is exactly the number a dispute
 * later argues about. `executableAt` matters for the same reason in the other
 * direction — it is frozen on the record precisely so that no later
 * `update_config` can pull a pending judgement forward, and recomputing it here
 * from a locally-read delay would give that guarantee away.
 */
@Injectable()
export class SolanaSlashExecutor implements SlashExecutorPort {
  private readonly logger = new Logger(SolanaSlashExecutor.name);

  /** `Config.stakeMint`, `Config.treasury` and `Config.admin`, fetched once and remembered. */
  private chainAddresses: Promise<SettlementAddresses> | null = null;

  constructor(
    @Inject(SOLANA_RPC) private readonly rpc: SlashExecutorRpcClient,
    @Inject(SETTLEMENT_PROGRAM_ID) private readonly programId: string | null,
    // The one Solana chain this deployment serves. This class submits nowhere
    // else, and it is what names the verifier key it may sign with.
    @Inject(SOLANA_CHAIN_ID) private readonly solanaChainId: ChainId | null,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * `Config.treasury`, as CAIP-10.
   *
   * Reads the same cached value {@link executeProposal} puts into the
   * instruction, so the caller that refuses `beneficiary == treasury` and the
   * instruction that would fail on it can never disagree about which account
   * the treasury is. `asset` supplies the chain id and nothing else.
   */
  async settlementTreasury(asset: AssetId): Promise<AccountId> {
    const programAddress = address(this.requireProgramId());
    const { treasury } = await this.settlementAddresses(programAddress);
    const { chainId } = parseAssetId(asset);
    return toAccountId(chainId, treasury);
  }

  /**
   * Phase one: prove the signature, reserve the stake, start the on-chain clock.
   *
   * There is no token account in the accounts struct, and that absence is the
   * control — this call cannot move a lamport however it is driven. What it can
   * do is reserve stake, which is bounded by the contract's `penalty_amount`
   * ceiling and costs the submitter a record's rent; `expire_slash` reaps the
   * reservation of a revoked key immediately.
   */
  async propose(request: SlashProposalRequest): Promise<SlashProposalResult> {
    const programAddress = address(this.requireProgramId());
    const signer = this.resolveSigner();

    const requestId = parseRequestId(request.requestId);
    const provider = address(request.provider);
    const beneficiary = address(request.beneficiary);
    const penalty = parseMinorUnits(request.penaltyMinor, 'penaltyMinor');
    const policy = await hashPolicy(request.policy);
    const { issuedAt, expiresAt } = attestationWindow();

    const message = slashAttestationMessage({
      requestId,
      provider,
      beneficiary,
      // The only class the port and the program agree may slash.
      status: SIGNED_RESPONSE_CLASS.dataFail,
      penalty,
      policy,
      issuedAt,
      expiresAt,
      programAddress,
    });

    const attested = await signer.sign({
      chainId: this.requireChainId(),
      purpose: PROPOSE_ATTESTATION_PURPOSE,
      requestId: request.requestId,
      requestedBy: { type: SigningRequesterType.SERVICE, id: SUBMITTER_IDENTITY },
      payload: message,
    });
    const verifier = getAddressDecoder().decode(attested.publicKey);
    const precompile = ed25519VerifyInstruction(attested.publicKey, message, attested.signature);
    const payer = this.transactionSigner(
      signer,
      verifier,
      request.requestId,
      PROPOSE_TRANSACTION_PURPOSE,
    );

    const [[stakePda], [verifierPda], [slashRecordPda]] = await Promise.all([
      findStakePda({ provider }, { programAddress }),
      findVerifierKeyPda({ verifier }, { programAddress }),
      findSlashRecordPda({ requestId }, { programAddress }),
    ]);

    const instruction = await getProposeSlashInstructionAsync(
      {
        payer,
        stake: stakePda,
        verifierKey: verifierPda,
        slashRecord: slashRecordPda,
        requestId,
        provider,
        beneficiary,
        status: ResponseClass.DataFail,
        penalty,
        policy,
        issuedAt,
        expiresAt,
      },
      { programAddress },
    );

    let signature: string;
    try {
      signature = await this.sendAndConfirm([precompile, instruction], payer, 'propose_slash');
    } catch (cause) {
      // `init` on ["slash", request_id] is the replay lock: a second proposal
      // for the same finding cannot land, and the honest response is to adopt
      // what is already there rather than report a failure the caller retries
      // forever.
      //
      // **Whether that happened is decided by looking, not by reading the
      // error.** The refusal is the system program's `AccountAlreadyInUse`,
      // which is not an Anchor error and has no entry in the catalogue: it
      // renders as `Allocate: account Address { … } already in use` in the
      // simulation *logs* and reaches the RPC's `message` only as
      // `custom program error: 0x0`. A text match against the message would
      // therefore have failed on the exact path it exists for — leaving a
      // request id that can never be proposed again and a caller retrying it
      // until the record's grace period reaps it.
      //
      // Asking the chain is also what `D4` prescribes for the numbers ("always
      // adopted from the account, never from the local clock"), so the read has
      // to happen regardless; this only moves it in front of the decision. It
      // costs one `getAccountInfo` on a path that is already failing.
      const adopted = await this.fetchSlashRecord(slashRecordPda, provider);
      if (!adopted) throw cause;

      // Deliberately adopted in ANY status, and reported. Neither `cancel_slash`
      // nor `expire_slash` closes the account, so what is sitting here may be a
      // finished judgement rather than a live one — see
      // `SlashProposalResult.status`, which is how the caller tells the
      // difference and why it must.
      //
      // The original failure is logged rather than swallowed. Adoption is the
      // right answer whatever the submission tripped over — a record on chain is
      // a judgement on chain — but "the key that tried to propose has since been
      // revoked" is worth seeing even on a run that returned a result.
      this.logger.warn(
        `propose_slash ${request.requestId}: a ${SLASH_STATUS_NAMES[adopted.status]} record ` +
          `already exists — adopting it (submission said: ${describeError(cause)})`,
      );
      return {
        signature: '',
        status: SLASH_STATUS_NAMES[adopted.status],
        proposedAt: secondsToDate(adopted.proposedAt),
        executableAt: secondsToDate(adopted.executableAt),
        reservedMinor: adopted.reserved.toString(),
        adopted: true,
      };
    }

    const record = await this.readSlashRecord(slashRecordPda, provider, request.requestId);

    this.logger.log(
      `propose_slash ${request.requestId} on ${request.provider} — reserved ${record.reserved}, ` +
        `executable ${secondsToDate(record.executableAt).toISOString()} — ${signature}`,
    );

    return {
      signature,
      // Read off the record rather than hardcoded to `PENDING`. It cannot be
      // anything else on this path, and asserting that from local knowledge is
      // how the two paths would drift.
      status: SLASH_STATUS_NAMES[record.status],
      proposedAt: secondsToDate(record.proposedAt),
      executableAt: secondsToDate(record.executableAt),
      reservedMinor: record.reserved.toString(),
      adopted: false,
    };
  }

  /**
   * Phase two: submit `execute_slash` and report what the chain actually took.
   *
   * Signs no attestation — the judgement was proved at proposal time and the
   * record is the evidence. The record is read *before* building, because two
   * of the instruction's accounts (`stake`, `verifier_key`) are seeded
   * from fields on it, which Codama cannot resolve; `verifier_key` in particular
   * follows `slash_record.verifier` and not whichever key happens to be signing
   * this transaction, because it is that key's rolling daily cap the judgement
   * is metered against.
   *
   * The record's `status` is deliberately not pre-checked here. The program
   * checks it first, by name, and a second check off local state would only add
   * a way for this process to refuse something the chain would have allowed.
   */
  async executeProposal(request: SlashExecutionRequest): Promise<SlashExecutionResult> {
    const programAddress = address(this.requireProgramId());
    const signer = this.resolveSigner();

    const requestId = parseRequestId(request.requestId);
    const provider = address(request.provider);
    const beneficiary = address(request.beneficiary);

    const [[slashRecordPda], chain] = await Promise.all([
      findSlashRecordPda({ requestId }, { programAddress }),
      this.settlementAddresses(programAddress),
    ]);
    const proposed = await this.readSlashRecord(slashRecordPda, provider, request.requestId);

    // The fee payer is still the verifier key: it is the one signing capability
    // this process has, it needs SOL only, and with the two-phase slash it holds
    // no USDC at all. `execute_slash` consults `payer` about nothing.
    const payer = this.transactionSigner(
      signer,
      await this.verifierAddress(signer),
      request.requestId,
      EXECUTE_TRANSACTION_PURPOSE,
    );

    const [[stakePda], [verifierPda]] = await Promise.all([
      findStakePda({ provider: proposed.provider }, { programAddress }),
      findVerifierKeyPda({ verifier: proposed.verifier }, { programAddress }),
    ]);

    const instruction = await getExecuteSlashInstructionAsync(
      {
        payer,
        slashRecord: slashRecordPda,
        stake: stakePda,
        verifierKey: verifierPda,
        beneficiary,
        treasury: chain.treasury,
        stakeMint: chain.stakeMint,
      },
      { programAddress },
    );

    const signature = await this.sendAndConfirm([instruction], payer, 'execute_slash');
    const record = await this.readSlashRecord(slashRecordPda, provider, request.requestId);

    this.logger.log(
      `execute_slash ${request.requestId} on ${request.provider} — applied ${record.applied} ` +
        `of ${record.penalty} — ${signature}`,
    );

    return {
      signature,
      appliedMinor: record.applied.toString(),
      // Read off the record rather than recomputed. The program freezes
      // the split on the record at execution precisely so a later
      // `update_config` cannot change what a finished judgement paid. A second
      // copy of the arithmetic off-chain is a second thing that can disagree
      // with the chain about how much an agent is owed.
      agentAmountMinor: record.agentAmount.toString(),
      platformAmountMinor: record.platformAmount.toString(),
      // The cluster's own record of when it executed, not this process's clock
      // — the two can disagree by however long confirmation took.
      executedAt: secondsToDate(record.executedAt),
    };
  }

  /**
   * Build — and deliberately do **not** sign — the `cancel_slash` that
   * withdraws a pending judgement.
   *
   * Lean v3's `cancel_slash` takes `Config.admin` as its only signer. That key
   * is a person's, held off this machine, so the whole of what this process can
   * do is compile the transaction and hand back the wire bytes for the admin's
   * wallet to sign. Compiled with {@link compileTransaction}, never
   * `signTransactionMessageWithSigners`, so the one signature slot goes out
   * empty — the same property `SolanaStakeIntentBuilder` relies on next door.
   *
   * `stake` is seeded on chain from `slash_record.provider` and Anchor checks
   * the two agree, so passing the provider from the request is safe: a mismatch
   * is refused by the program rather than papered over here.
   */
  async buildCancel(request: SlashCancelRequest): Promise<SlashCancelIntent> {
    const programAddress = address(this.requireProgramId());

    const requestId = parseRequestId(request.requestId);
    const provider = address(request.provider);

    const [[stakePda], [slashRecordPda], [configPda], chain] = await Promise.all([
      findStakePda({ provider }, { programAddress }),
      findSlashRecordPda({ requestId }, { programAddress }),
      findConfigPda({ programAddress }),
      this.settlementAddresses(programAddress),
    ]);

    // A signer that cannot sign. The generated builder needs a
    // `TransactionSigner` for `admin`; this is how the type is satisfied
    // without acquiring the capability it usually implies.
    const admin = createNoopSigner(chain.admin);

    const instruction = await getCancelSlashInstructionAsync(
      {
        admin,
        config: configPda,
        slashRecord: slashRecordPda,
        stake: stakePda,
      },
      { programAddress },
    );

    const { value: latestBlockhash } = await this.rpc
      .getLatestBlockhash({ commitment: 'confirmed' })
      .send();

    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(admin, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          latestBlockhash as Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0],
          m,
        ),
      (m) => appendTransactionMessageInstruction(instruction, m),
    );

    return {
      transaction: getBase64EncodedWireTransaction(compileTransaction(message)),
      admin: chain.admin,
      requestId: request.requestId,
      provider: request.provider,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight.toString(),
    };
  }

  /**
   * Reap a pending judgement that can no longer execute.
   *
   * **Permissionless.** No attestation and no privilege — the program checks the
   * record's own clock and the verifier key's own status, and the instruction
   * has no `payer` account at all (`generated/instructions/expireSlash.ts`).
   * This is how a revoked key's reservations are released, and anybody may call
   * it, so the backend calling it is a courtesy to the provider whose stake is
   * held rather than a control.
   *
   * The record still has to be read first: `stake` and `verifier_key` are both
   * seeded from fields on it, and `verifier_key` must be the *proposing* key's
   * entry — half the expiry condition is read from it, so a substituted entry
   * would let a caller reap a live proposal by presenting some other key's
   * revoked registration.
   */
  async expire(request: SlashCancelRequest): Promise<SlashCancelResult> {
    const programAddress = address(this.requireProgramId());
    const signer = this.resolveSigner();

    const requestId = parseRequestId(request.requestId);
    const provider = address(request.provider);

    const [slashRecordPda] = await findSlashRecordPda({ requestId }, { programAddress });
    const pending = await this.readSlashRecord(slashRecordPda, provider, request.requestId);

    const payer = this.transactionSigner(
      signer,
      await this.verifierAddress(signer),
      request.requestId,
      EXPIRE_TRANSACTION_PURPOSE,
    );

    const [[stakePda], [verifierPda]] = await Promise.all([
      findStakePda({ provider: pending.provider }, { programAddress }),
      findVerifierKeyPda({ verifier: pending.verifier }, { programAddress }),
    ]);

    const instruction = getExpireSlashInstruction(
      { slashRecord: slashRecordPda, stake: stakePda, verifierKey: verifierPda },
      { programAddress },
    );

    const signature = await this.sendAndConfirm([instruction], payer, 'expire_slash');
    const record = await this.readSlashRecord(slashRecordPda, provider, request.requestId);

    this.logger.log(`expire_slash ${request.requestId} on ${request.provider} — ${signature}`);

    return { signature, cancelledAt: secondsToDate(record.cancelledAt) };
  }

  /**
   * What the chain says about one judgement, or `null` when there is no record.
   *
   * One account read, not two: the "does it exist" question and the "what does
   * it say" question are answered by the same `getAccountInfo`. Asking twice
   * would double the RPC cost of every sweep tick and — worse — open a window in
   * which the two answers describe different states of the account.
   */
  async readRecord(requestId: string, provider: string): Promise<SlashRecordSnapshot | null> {
    const programAddress = address(this.requireProgramId());
    const [slashRecordPda] = await findSlashRecordPda(
      { requestId: parseRequestId(requestId) },
      { programAddress },
    );

    const record = await this.fetchSlashRecord(slashRecordPda, address(provider));
    if (!record) return null;

    return {
      status: SLASH_STATUS_NAMES[record.status],
      penaltyMinor: record.penalty.toString(),
      appliedMinor: record.applied.toString(),
      agentAmountMinor: record.agentAmount.toString(),
      platformAmountMinor: record.platformAmount.toString(),
      reservedMinor: record.reserved.toString(),
      proposedAt: secondsToDate(record.proposedAt),
      executableAt: secondsToDate(record.executableAt),
      // `0` is the program's "not yet" sentinel, and a `Date(0)` here would read
      // as 1 January 1970 to every caller that only checks for null.
      executedAt: record.executedAt === 0n ? null : secondsToDate(record.executedAt),
      cancelledAt: record.cancelledAt === 0n ? null : secondsToDate(record.cancelledAt),
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private requireProgramId(): string {
    if (!this.programId) {
      // Not a boot failure — see `settlement-program.constants.ts`. A
      // deployment with no settlement program is legitimate, so the failure
      // belongs here, at the first call that actually needs an address.
      throw ChainErrors.programNotConfigured({
        what: 'the settlement program',
        variable: SETTLEMENT_PROGRAM_ID_ENV,
      });
    }
    return this.programId;
  }

  /**
   * `VerifierSigningService`, or a loud failure. See the class comment for why
   * this is a `ModuleRef` lookup rather than a constructor dependency, and why
   * failing here — rather than resolving to `undefined` and failing at the
   * first `.sign()` call — is the point: a slash that silently never happened
   * must never be mistaken for one that did.
   */
  /**
   * Which chain's verifier key this executor signs with.
   *
   * `SOLANA_CHAIN_ID` is `null` when `ENABLED_CHAINS` names zero or two Solana
   * clusters, and this is where that becomes visible — at the call, naming the
   * variable, rather than at the boot of six processes that never slash
   * anything. Guessing one would pick a verifier key row at random out of two,
   * which is the mainnet/devnet mislabel `ENABLED_CHAINS` exists to prevent.
   */
  private requireChainId(): ChainId {
    if (!this.solanaChainId) {
      throw ChainErrors.programNotConfigured({
        what: 'exactly one solana chain in ENABLED_CHAINS, to name the verifier key to sign with',
        variable: ENABLED_CHAINS_ENV,
      });
    }
    return this.solanaChainId;
  }

  private resolveSigner(): AttestationSigner {
    try {
      return this.moduleRef.get(VerifierSigningService, { strict: false });
    } catch (cause) {
      throw ChainErrors.programNotConfigured({
        what:
          'a verifier signing capability in this process — VerifierSigningModule is not ' +
          'imported here (only the worker bootstrap imports it; see bootstrap/worker/app.module.ts)' +
          (cause instanceof Error ? ` (${cause.message})` : ''),
      });
    }
  }

  /**
   * The verifier key's own address, for the two doors that sign no attestation
   * and still need a fee payer. A read, not a signature — see
   * {@link AttestationSigner}.
   */
  private async verifierAddress(signer: AttestationSigner): Promise<Address> {
    return getAddressDecoder().decode(await signer.publicKey(this.requireChainId()));
  }

  /**
   * Adapts `VerifierSigningService.sign()` into `@solana/kit`'s
   * `TransactionPartialSigner`. Modelled on
   * `SolanaExposureRecorder.transactionSigner()`, with one difference: that
   * adapter calls `SignerPort.sign()` directly, and this one goes through the
   * journal — see the class comment for why a fee-payer signature from the
   * verifier key belongs there too.
   */
  private transactionSigner(
    signer: AttestationSigner,
    verifierAddress: Address,
    requestId: string,
    purpose: string,
  ): TransactionPartialSigner {
    const chainId = this.requireChainId();
    return {
      address: verifierAddress,
      async signTransactions(
        transactions: readonly Transaction[],
      ): Promise<readonly SignatureDictionary[]> {
        return Promise.all(
          transactions.map(async (transaction) => {
            const signed = await signer.sign({
              chainId,
              purpose,
              requestId,
              requestedBy: { type: SigningRequesterType.SERVICE, id: SUBMITTER_IDENTITY },
              payload: new Uint8Array(transaction.messageBytes),
            });
            return { [verifierAddress]: signed.signature as SignatureBytes };
          }),
        );
      },
    };
  }

  private async sendAndConfirm(
    instructions: readonly Instruction[],
    feePayer: TransactionPartialSigner,
    instructionName: string,
  ): Promise<string> {
    const { value: latestBlockhash } = await this.rpc
      .getLatestBlockhash({ commitment: 'confirmed' })
      .send();

    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          latestBlockhash as Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0],
          m,
        ),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );

    const signed = await signTransactionMessageWithSigners(message);
    const wire = getBase64EncodedWireTransaction(signed);

    // `preflightCommitment` is set and `skipPreflight` is left at its default
    // (`false`), so the RPC node simulates before accepting — a malformed
    // instruction or a bad signature surfaces here, before this method
    // considers anything "sent". That is also why this rejection is wrapped:
    // most named refusals (a revoked key, an unelapsed timelock) never reach
    // `confirmLanded` at all, they are refused in simulation, and the classifier
    // that decides whether a judgement is void needs the code either way.
    try {
      await this.rpc
        .sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed' })
        .send();
    } catch (cause) {
      throw chainRefusal(instructionName, null, cause, describeError(cause));
    }

    const signature = getSignatureFromTransaction(signed);
    await this.confirmLanded(signature, instructionName);
    return signature;
  }

  /**
   * Polls `getSignatureStatuses` rather than subscribing, for the same reason
   * `scripts/settlement/lib/sender.ts`'s `confirm()` does: a websocket
   * subscription needs `rpcSubscriptions`, which the structural RPC interface
   * this class declares does not carry, and this call is rare enough that an
   * extra poll or two costs nothing next to the certainty of reading the
   * applied amount only after the transaction has actually landed.
   */
  private async confirmLanded(signature: string, instructionName: string): Promise<void> {
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    for (;;) {
      const { value } = await this.rpc
        .getSignatureStatuses([signature], { searchTransactionHistory: false })
        .send();
      const status = value[0];
      if (status?.err) {
        throw chainRefusal(instructionName, signature, status.err, explainStatusError(status.err));
      }
      if (
        status?.confirmationStatus === 'confirmed' ||
        status?.confirmationStatus === 'finalized'
      ) {
        return;
      }
      if (Date.now() > deadline) {
        throw chainRefusal(
          instructionName,
          signature,
          null,
          `did not confirm within ${CONFIRM_TIMEOUT_MS}ms`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, CONFIRM_POLL_MS));
    }
  }

  /**
   * The record, or a loud failure. Every path but {@link readRecord} wants this
   * one.
   *
   * Absence raises `CHAIN_SLASH_RECORD_NOT_FOUND` rather than the layout error
   * it used to, and the distinction is the whole point: a layout error says the
   * deploy is skewed and a human should look, while this says the judgement is
   * over. `SlashRecord` is a PDA on the request id and both `cancel_slash` and
   * `expire_slash` close the account, so "no record" is terminal — retrying can
   * never produce one. Reported under its own code so the failure classifier can
   * say so; folded into `CHAIN_TRANSACTION_FAILED` it would have arrived with a
   * null `customErrorCode`, which reads as "the chain never answered" and is
   * retried forever.
   */
  private async readSlashRecord(
    pda: Address,
    expectedProvider: Address,
    requestId: string,
  ): Promise<DecodedSlashRecord> {
    const record = await this.fetchSlashRecord(pda, expectedProvider);
    if (!record) {
      throw ChainErrors.slashRecordNotFound({ account: pda, requestId });
    }
    return record;
  }

  /**
   * One `getAccountInfo`, decoded, or `null` when the account does not exist.
   *
   * Absence is returned rather than thrown because one caller — {@link readRecord}
   * — treats it as an ordinary answer. Every other caller wraps this in
   * {@link readSlashRecord}, which turns it back into a failure.
   */
  private async fetchSlashRecord(
    pda: Address,
    expectedProvider: Address,
  ): Promise<DecodedSlashRecord | null> {
    const account = await this.rpc
      .getAccountInfo(pda, { encoding: 'base64', commitment: 'confirmed' })
      .send();
    if (!account.value) {
      return null;
    }

    const data = new Uint8Array(getBase64Encoder().encode(account.value.data[0]));
    if (!discriminatorMatches(data, SLASH_RECORD_DISCRIMINATOR)) {
      throw ChainErrors.accountLayoutUnexpected({
        account: pda,
        expected: 'a SlashRecord account',
        actual: Buffer.from(data.subarray(0, SLASH_RECORD_DISCRIMINATOR.length)).toString('hex'),
      });
    }

    let decoded: DecodedSlashRecord;
    try {
      decoded = getSlashRecordDecoder().decode(data);
    } catch (cause) {
      throw ChainErrors.accountLayoutUnexpected({
        account: pda,
        expected: 'a well-formed SlashRecord account',
        actual: cause instanceof Error ? cause.message : String(cause),
      });
    }

    if (decoded.provider !== expectedProvider) {
      // Cannot differ without the program or the PDA seeds having changed
      // underneath us — see `SolanaVerifierRegistryService`'s identical guard
      // for the reasoning. The consequence of being wrong here is reporting an
      // amount taken from, or restored to, the wrong provider's stake.
      throw ChainErrors.accountLayoutUnexpected({
        account: pda,
        expected: expectedProvider,
        actual: decoded.provider,
      });
    }

    return decoded;
  }

  /**
   * `Config.stakeMint`, `Config.treasury` and `Config.admin`, read once and
   * remembered — the same trade `SolanaSettlementStakeReader.settlementConfig()`
   * makes, for the same reason: all three come from an account only an admin
   * `update_config` ever moves, and a copy of any of them elsewhere is a value
   * that can silently disagree with the one the program actually enforces.
   */
  private async settlementAddresses(programAddress: Address): Promise<SettlementAddresses> {
    if (!this.chainAddresses) {
      this.chainAddresses = this.fetchSettlementAddresses(programAddress).catch(
        (error: unknown) => {
          // A rejected promise left in the field would make one transient RPC
          // failure permanent for the life of the process.
          this.chainAddresses = null;
          throw error;
        },
      );
    }
    return this.chainAddresses;
  }

  private async fetchSettlementAddresses(programAddress: Address): Promise<SettlementAddresses> {
    const [configPda] = await findConfigPda({ programAddress });
    const configAccount = await this.rpc
      .getAccountInfo(configPda, { encoding: 'base64', commitment: 'confirmed' })
      .send();
    if (!configAccount.value) {
      throw ChainErrors.programNotConfigured({
        what: `the settlement program's Config account (${configPda})`,
        variable: SETTLEMENT_PROGRAM_ID_ENV,
      });
    }

    try {
      const config = getConfigDecoder().decode(
        new Uint8Array(getBase64Encoder().encode(configAccount.value.data[0])),
      );
      return { stakeMint: config.stakeMint, treasury: config.treasury, admin: config.admin };
    } catch (cause) {
      throw ChainErrors.accountLayoutUnexpected({
        account: configPda,
        expected: 'a settlement program Config account',
        actual: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
}

/** The three `Config` addresses this class builds instructions from. */
interface SettlementAddresses {
  readonly stakeMint: Address;
  readonly treasury: Address;
  readonly admin: Address;
}

// ── free functions ──────────────────────────────────────────────────────────

function discriminatorMatches(data: Uint8Array, expected: ReadonlyUint8Array): boolean {
  if (data.length < expected.length) {
    return false;
  }
  return Array.from(expected).every((byte, index) => data[index] === byte);
}

/** `issuedAt` is now; `expiresAt` is far enough out to survive send-and-confirm retries. */
function attestationWindow(): { issuedAt: bigint; expiresAt: bigint } {
  const issuedAt = BigInt(Math.floor(Date.now() / 1000));
  return { issuedAt, expiresAt: issuedAt + ATTESTATION_VALIDITY_SECONDS };
}

function secondsToDate(seconds: bigint): Date {
  return new Date(Number(seconds) * 1000);
}

function parseRequestId(requestId: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(requestId)) {
    throw new Error(`requestId must be 32 bytes as 64 hex characters, got "${requestId}"`);
  }
  return new Uint8Array(Buffer.from(requestId, 'hex'));
}

function parseMinorUnits(value: string, field: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${field} must be a non-negative integer string, got "${value}"`);
  }
  return BigInt(value);
}

/**
 * The attestation's `policy` field is a fixed 32 bytes and `policy: string` on
 * the port is not — a hash is the only mapping between the two that does not
 * silently truncate a longer identifier, and it is what a dispute needs: it
 * proves which policy string a signature was over without requiring the exact
 * bytes to have been stored on-chain to begin with.
 *
 * `webcrypto.subtle.digest`, not `node:crypto`'s `createHash` — this file
 * imports `@x402/settlement-client`, so `test/unit/chains/solana/settlement-client-only.spec.ts`
 * treats it as a file that touches the settlement program and bans
 * `createHash(` outright, on the (correct, for every other case) assumption
 * that the only reason to hash something here is a hand-recomputed Anchor
 * discriminator. This hash is over a policy string, not an instruction name,
 * but the scan is a blunt lock on purpose — see its own header — so it is
 * routed around rather than carved an exception into.
 */
async function hashPolicy(policy: string): Promise<Uint8Array> {
  const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(policy));
  return new Uint8Array(digest);
}

/**
 * The one error every failed submission on this path throws.
 *
 * **`customErrorCode` is the load-bearing field, not the message.** The
 * classifier that decides whether a judgement is void, still waiting, or worth
 * retrying keys on the error's *name*, resolved from this number against the
 * vendored IDL — and it cannot key on the message, for two reasons.
 * `getX402PaymentErrorMessage` renders the human sentence rather than the
 * variant name (`6011` is "This verifier key has been revoked and can never be
 * reinstated"), and in production it returns a fixed placeholder for every code.
 * A classifier reading the string would therefore see nothing to classify, and
 * every void outcome would degrade into "retry forever" — with a revoked
 * verifier key retried until the grace period reaps the record.
 *
 * `null` means the refusal carried no settlement-program error: a blockhash that
 * expired, an RPC that fell over, a confirmation that timed out. Those are
 * transient by construction, and the distinction between "the program said no"
 * and "we never got an answer" is exactly the one a retry policy needs.
 *
 * The message keeps the human-readable rendering because that is what a log is
 * read for.
 */
function chainRefusal(
  instructionName: string,
  signature: string | null,
  cause: unknown,
  reason: string,
) {
  // The original is chained rather than summarised. `describeError` keeps only
  // `cause.message`, and for a preflight rejection the half that says *why* —
  // the simulation `logs`, where the system program's "already in use" and every
  // `Program log:` line live — hangs off the error object, not off its message.
  // Dropping it left an operator with "custom program error: 0x0" and nothing
  // to read. `cause` is not serialised by `toJSON()`, so this stays a
  // diagnostic and never reaches the wire.
  return Object.assign(
    ChainErrors.transactionFailed({
      instruction: instructionName,
      signature,
      customErrorCode: extractCustomErrorCode(cause),
      reason,
    }),
    { cause },
  );
}

/** `{"InstructionError":[i,{"Custom":n}]}` → the program's own message for `n`, if any. */
function explainStatusError(err: unknown): string {
  const custom = extractCustomErrorCode(err);
  if (custom === null) {
    return describeError(err);
  }
  const explanation = getX402PaymentErrorMessage(custom as X402PaymentError);
  return explanation
    ? `${explanation} (custom program error ${custom})`
    : `custom program error ${custom}`;
}
