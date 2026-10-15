import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
  Address,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase58Encoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  Instruction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import {
  findConfigPda,
  findEscrowPda,
  findStakePda,
  getConfigDecoder,
  getRedeemVoucherInstructionAsync,
  voucherMessage,
} from '@x402/settlement-client';

import {
  RedeemOutcome,
  RedeemOutcomeKind,
  RedeemVoucherRequest,
  VoucherRedeemerPort,
} from '@modules/payment/ports/voucher-redeemer.port';
import { settlementErrorName } from '@modules/slash/domain/chain-slash-outcome';
import { MoneyUtil } from '@shared/utils/money.util';

import { FEE_PAYER_SIGNER, FeePayerSignerPort } from '../facilitator/signing/fee-payer-signer.port';
import { ChainErrors } from '../errors/chains.errors';
import { parseAccountId, parseAssetId } from '../ports/caip.types';
import { ed25519VerifyInstruction } from './ed25519-precompile';
import { describeError, extractCustomErrorCode } from './program-error';
import { SETTLEMENT_PROGRAM_ID, SETTLEMENT_PROGRAM_ID_ENV } from './settlement-program.constants';
import { SOLANA_RPC } from './solana.constants';

/** How long a submitted redemption is given to confirm before it becomes a RETRY. */
const CONFIRM_TIMEOUT_MS = 30_000;
const CONFIRM_POLL_MS = 500;

/**
 * The three RPC calls this service makes, declared structurally so a test
 * supplies exactly those three — the same trade every other service under this
 * directory makes.
 *
 * `getAccountInfo` is here for one reason: the program pays the platform's fee to
 * `ATA(Config.treasury, Config.stake_mint)`, an account the program requires by
 * address and never derives for the submitter. So the treasury has to be read
 * off `Config` once and remembered.
 *
 * **There is deliberately no `sendTransaction`.** Submission happens inside
 * `FeePayerSignerPort.signAndSend`, which is the one thing holding a key that
 * can pay for this transaction. A `sendTransaction` here would be a second
 * submit path that bypasses it.
 */
export interface VoucherRedeemerRpcClient {
  getAccountInfo(
    account: Address,
    config: { encoding: 'base64'; commitment?: 'confirmed' | 'finalized' },
  ): { send(): Promise<{ value: { data: readonly [string, 'base64'] } | null }> };
  getLatestBlockhash(config: { commitment?: 'confirmed' | 'finalized' }): {
    send(): Promise<{ value: { blockhash: string; lastValidBlockHeight: bigint } }>;
  };
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
 * Terminal refusals. The voucher will never be accepted, whatever changes.
 *
 * `VoucherSeqNotIncreasing` is the one the backend is supposed to prevent and
 * must still handle: the program admits a voucher iff `seq > escrow.seq_high`, so a
 * lower seq that lands after a higher one is dead and no retry revives it. The
 * rest are the buyer's own limits, none of which a retry moves. When one of
 * these comes back the buyer keeps their money and the platform pays the
 * provider — see `VoucherRedemptionService`. The provider's stake is not here:
 * it is retried, and a voucher that expires on it is forfeited by the provider.
 */
/** The two `Config` addresses this class needs, from one read. */
interface SettlementConfigFacts {
  /** `Config.treasury` — whose ATA takes the platform fee. */
  readonly treasury: Address;
  /** `Config.redeemer` — the only key `redeem_voucher` accepts as `rent_payer`. */
  readonly redeemer: Address;
}

/**
 * Refusals that are about the **deployment**, not about the voucher.
 *
 * `NotRedeemer` (6053) and `MissingRedeemer` (6054) both come off
 * `Config.redeemer`: the first says this process is not the key the program
 * accepts redemptions from, the second that the program was initialised
 * without one at all. Neither is a property of the voucher in hand — every
 * voucher on the platform is refused identically until an admin acts — so
 * neither may be retried (a fee per hold per pass, for ever) and neither may
 * close the voucher (it would become buyer debt for a fault that
 * `update_config` fixes in one transaction).
 *
 * {@link SolanaVoucherRedeemer.assertRedeemer} is supposed to catch the first
 * of these before a transaction is ever built. This set is what happens when it
 * cannot — an admin moved the redeemer while this process was running, and its
 * cached `Config` predates the move.
 */
const MISCONFIGURATION_ERRORS: ReadonlySet<string> = new Set(['NotRedeemer', 'MissingRedeemer']);

const UNREDEEMABLE_ERRORS: ReadonlySet<string> = new Set([
  'VoucherSeqNotIncreasing',
  'VoucherSeqZero',
  'VoucherExpired',
  'VoucherNotYetValid',
  'InvalidVoucherWindow',
  'MissingBuyerSignature',
  'EscrowMismatch',
  'VoucherExceedsPerCallLimit',
  'EscrowWindowLimitExceeded',
  // Not 'ProviderBelowMinimumStake': the provider may top its stake back up
  // inside the window, so it is a RETRY, as on EVM. If the voucher then
  // expires, `VoucherRedemptionService` reads it as the last refusal and the
  // provider forfeits the voucher — the platform never pays for it.
]);

/**
 * Submits one `redeem_voucher` per transaction.
 *
 * ## The program pays two wallets and holds nothing
 *
 * There is no earnings pool any more. One `redeem_voucher` credits the
 * provider's own associated token account with `amount − fee` and the
 * treasury's with the fee, both in the same instruction. The provider's ATA is
 * `init_if_needed` and its rent comes out of `rent_payer`, which is the
 * platform's fee payer; the treasury's is **not** created by the program, so a
 * deployment whose treasury ATA does not exist refuses every redemption with
 * `AccountNotInitialized` until a human creates it.
 *
 * ## The fee payer is the platform's, and the signature it proves is not
 *
 * `rent_payer` on this instruction is a fee payer and nothing else — the
 * program consults it about nothing, and it is deliberately **not** called
 * `payer`, because `voucher.payer` is the key whose ed25519 signature the
 * precompile proves and confusing the two is a drain. The fee payer goes
 * through `FeePayerSignerPort` like every other transaction this platform pays
 * for; this class never holds a buyer key of any kind, and the buyer's
 * signature arrives on the request having been produced by a wallet the
 * backend has no access to.
 *
 * The port is resolved through `ModuleRef` at call time rather than through the
 * constructor, for the reason `SolanaSlashExecutor` resolves
 * `VerifierSigningService` that way: `ChainsModule` is imported by the API, the
 * worker and the MCP processes, and `src/bootstrap/mcp/app.module.ts` states
 * outright that *"the fee-payer signer stays out of this address space"*.
 * Making it a constructor dependency would force every importer of
 * `ChainsModule` to provide one. The failure mode in a process that has none is
 * loud and at the first call.
 *
 * ## One voucher per transaction. Measured.
 *
 * 1,154 of 1,232 bytes for N=1; well past the limit for N=2 even when both vouchers share a
 * buyer and a provider. A v0 transaction with an address lookup table
 * compresses account keys but not instruction data, and two 351-byte
 * precompile bodies plus two 200-byte arguments are 1,146 bytes before any
 * header. There is no batching, and `voucher-redeemer.spec.ts` serialises both
 * shapes and asserts the two halves so nobody reintroduces one on the strength
 * of an estimate.
 *
 * The cost of that is one base fee per paid call — 5,000 lamports ≈ $0.00068 at
 * $135/SOL — which is roughly 7x the original estimate.
 *
 * ## Every failure is an outcome, not a throw
 *
 * The one exception is a missing program id, which is a deployment fault rather
 * than a redemption failure: returning `RETRY` for it would hammer the same
 * misconfiguration once a minute for ever.
 */
@Injectable()
export class SolanaVoucherRedeemer implements VoucherRedeemerPort {
  private readonly logger = new Logger(SolanaVoucherRedeemer.name);

  /**
   * `Config.treasury` and `Config.redeemer`, read once and remembered.
   *
   * Both move only under an admin `update_config`, and a process that has
   * cached a stale one builds an instruction the program refuses outright —
   * the treasury ATA is checked by address and `rent_payer` carries
   * `address = config.redeemer` — rather than paying the wrong account. So the
   * failure of this cache is loud, not silent, in both directions.
   *
   * One read serves both. The redeemer check below is therefore free after the
   * first redemption in a process, which is why it lives here rather than in a
   * boot hook: a process that never redeems never pays for it at all.
   */
  private config: Promise<SettlementConfigFacts> | null = null;

  constructor(
    @Inject(SOLANA_RPC) private readonly rpc: VoucherRedeemerRpcClient,
    @Inject(SETTLEMENT_PROGRAM_ID) private readonly programId: string | null,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * One. Measured, not a policy: see the class comment's *"One voucher per
   * transaction"* section and `voucher-redeemer.spec.ts`, which serialises both
   * shapes rather than trusting the estimate.
   */
  readonly maxBatchSize = 1;

  /**
   * A loop, and it does not pretend to be a batch.
   *
   * There is no `redeem_voucher_batch` instruction and no room for a second
   * voucher in a transaction, so the only honest implementation of the port's
   * batch method here is one transaction each. It stops at the first outcome
   * that ends a pass — `PAUSED` and `MISCONFIGURED` refuse every remaining hold
   * identically, and each attempt costs a fee — and the outcomes it returns are
   * still **positional**, so a caller can match them to its rows by index. The
   * caller sees a short array and knows the rest were not attempted.
   */
  async redeemBatch(requests: readonly RedeemVoucherRequest[]): Promise<readonly RedeemOutcome[]> {
    const outcomes: RedeemOutcome[] = [];
    for (const request of requests) {
      const outcome = await this.redeem(request);
      outcomes.push(outcome);
      if (
        outcome.kind === RedeemOutcomeKind.PAUSED ||
        outcome.kind === RedeemOutcomeKind.MISCONFIGURED
      ) {
        break;
      }
    }
    return outcomes;
  }

  async redeem(request: RedeemVoucherRequest): Promise<RedeemOutcome> {
    const programAddress = address(this.requireProgramId());
    const feePayer = this.resolveFeePayer();
    const feePayerAddress = await feePayer.getFeePayerAddress();

    // Before anything is built, and before a fee is spent finding out.
    const mismatch = await this.assertRedeemer(programAddress, feePayerAddress);
    if (mismatch) {
      return mismatch;
    }

    let signature: string;
    try {
      // `build` inside the try, not before it. It reads `Config` and derives
      // PDAs, so an RPC failure there is exactly as retryable as one at
      // submission — and outside the try it escaped `redeem()` as a throw,
      // against this class's promise that every failure is an outcome.
      const instructions = await this.build(request, programAddress, feePayerAddress);
      const wire = await this.compile(instructions, feePayerAddress);
      ({ signature } = await feePayer.signAndSend(wire));
    } catch (cause) {
      // Most named refusals land here rather than at confirmation: the RPC
      // simulates before it accepts, so `EscrowInsufficient` and
      // `VoucherSeqNotIncreasing` are refused in preflight and never get a signature.
      return this.classify(request, cause);
    }

    const statusError = await this.confirm(signature);
    if (statusError !== null) {
      return this.classify(request, statusError);
    }

    this.logger.log(
      `redeem_voucher seq ${request.seq} for ${request.payer} — ` +
        `${MoneyUtil.format(request.amount)} to ${request.provider} — ${signature}`,
    );
    return { kind: RedeemOutcomeKind.REDEEMED, signature, programError: null };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Every PDA is derived against the **deployed** program id and handed in
   * explicitly.
   *
   * The generated builder resolves `config` and the three associated token
   * accounts by itself when they are omitted — but it resolves the PDA against
   * the *compiled-in* `X402_PAYMENT_PROGRAM_ADDRESS`, not against the
   * `programAddress` passed in the config. A redeploy under a new id makes
   * those two differ, and an omitted account would then name a PDA of the
   * wrong program.
   */
  private async build(
    request: RedeemVoucherRequest,
    programAddress: Address,
    feePayerAddress: Address,
  ): Promise<readonly Instruction[]> {
    const { address: buyer } = parseAccountId(request.payer);
    const { address: providerPubkey } = parseAccountId(request.provider);
    const { assetReference } = parseAssetId(request.asset);

    const payer = address(buyer);
    const provider = address(providerPubkey);
    const stakeMint = address(assetReference);

    const [[escrow], [providerStake], [configPda], treasury] = await Promise.all([
      findEscrowPda({ buyer: payer }, { programAddress }),
      findStakePda({ provider }, { programAddress }),
      findConfigPda({ programAddress }),
      this.settlementConfig(programAddress).then(({ treasury }) => treasury),
    ]);
    const [[escrowTokenAccount], [providerTokenAccount], [treasuryTokenAccount]] =
      await Promise.all([
        findAssociatedTokenPda({
          owner: escrow,
          mint: stakeMint,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
        }),
        findAssociatedTokenPda({
          owner: provider,
          mint: stakeMint,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
        }),
        findAssociatedTokenPda({
          owner: treasury,
          mint: stakeMint,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
        }),
      ]);

    const resourceHash = hashBytes(request.resourceHash);
    const requestHash = hashBytes(request.requestHash);
    const amount = MoneyUtil.toAtomic(request.amount);
    const seq = BigInt(request.seq);
    const issuedAt = BigInt(request.issuedAt);
    const expiresAt = BigInt(request.expiresAt);

    const instruction = await getRedeemVoucherInstructionAsync(
      {
        rentPayer: createNoopSigner(feePayerAddress),
        // Derived under the DEPLOYED id. Omitting it lets the builder fill it
        // in from `findConfigPda()` under the compiled-in `declare_id!()`.
        config: configPda,
        stakeMint,
        escrow,
        escrowTokenAccount,
        providerStake,
        provider,
        // The provider's own wallet. `init_if_needed`, rent paid by rentPayer.
        providerTokenAccount,
        // ATA(Config.treasury, stake_mint) — a plain associated token account,
        // NOT a PDA of this program, and the program never creates it.
        treasuryTokenAccount,
        // Codama FLATTENS the lone `Voucher` argument: these nine are the
        // instruction's own arguments, not a nested object.
        payer,
        // The escrow PDA, and the program re-derives it from the signed
        // `payer` rather than trusting this — see the account's own doc.
        payTo: escrow,
        // Codama renames the *argument* `provider` to `providerArg` because the
        // instruction also has an account of that name. Same value, and the
        // program compares the two.
        providerArg: provider,
        amount,
        resourceHash,
        requestHash,
        seq,
        issuedAt,
        expiresAt,
      },
      { programAddress },
    );

    // The exact 239 bytes the buyer signed, rebuilt from the same nine fields
    // the instruction carries. If these two ever disagree the program refuses
    // with `MissingBuyerSignature` after the call has been served, which is why
    // both are built from one set of locals here rather than from two reads.
    const message = voucherMessage({
      payer,
      payTo: escrow,
      provider,
      amount,
      resourceHash,
      requestHash,
      seq,
      issuedAt,
      expiresAt,
      programAddress,
    });

    const precompile = ed25519VerifyInstruction(
      new Uint8Array(getBase58Encoder().encode(buyer)),
      message,
      new Uint8Array(getBase58Encoder().encode(request.signature)),
    );

    // Precompile first: the program reads it back with
    // `load_instruction_at_checked`, and its index is what the program's own
    // check is written against.
    return [precompile, instruction];
  }

  /**
   * Compiled over a **noop** signer, never signed here.
   *
   * `FeePayerSignerPort` is the only thing that may put a signature on this
   * transaction, and `signAndSend` submits it in the same call — so there is no
   * `sendTransaction` on this class's RPC interface either.
   */
  private async compile(
    instructions: readonly Instruction[],
    feePayerAddress: Address,
  ): Promise<string> {
    const { value: latestBlockhash } = await this.rpc
      .getLatestBlockhash({ commitment: 'confirmed' })
      .send();

    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(createNoopSigner(feePayerAddress), m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          latestBlockhash as Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0],
          m,
        ),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );

    return getBase64EncodedWireTransaction(compileTransaction(message));
  }

  /**
   * Refuses the pass when this process is not the program's redeemer.
   *
   * Returns the outcome to report rather than throwing, because `redeem()`
   * promises that every failure is an outcome — and because the caller needs to
   * stop the *pass*, not lose the exception into one hold's retry counter.
   *
   * `null` means the check passed. It is the cached `Config` read that also
   * supplies the treasury, so on every redemption after the first this costs a
   * string comparison and no I/O. A read that fails outright is **not** treated
   * as a mismatch: an unreachable RPC says nothing about who the redeemer is,
   * and answering `MISCONFIGURED` to it would stop the pass and page a human
   * for a network blip. It is left to the ordinary retry path, which is what
   * every other RPC failure in this class gets.
   */
  private async assertRedeemer(
    programAddress: Address,
    feePayerAddress: Address,
  ): Promise<RedeemOutcome | null> {
    let redeemer: Address;
    try {
      ({ redeemer } = await this.settlementConfig(programAddress));
    } catch (cause) {
      this.logger.warn(
        `could not read Config to check the redeemer; continuing — the program will refuse ` +
          `NotRedeemer if this process is the wrong one. ${describeError(cause)}`,
      );
      return null;
    }

    if (redeemer === feePayerAddress) {
      return null;
    }

    // Loud, by name, once per redemption attempt rather than once per process:
    // a scheduler that has been running for a week must still say why it is
    // refusing, not only in the log line it wrote at boot.
    const error = ChainErrors.redeemerMismatch({
      configured: redeemer,
      feePayer: feePayerAddress,
    });
    this.logger.error(`${error.errorCode}: ${error.message}`);
    return { kind: RedeemOutcomeKind.MISCONFIGURED, signature: null, programError: null };
  }

  /** `Config`'s two addresses, fetched at most once per process. */
  private async settlementConfig(programAddress: Address): Promise<SettlementConfigFacts> {
    if (!this.config) {
      this.config = this.fetchConfig(programAddress).catch((error: unknown) => {
        // A rejected promise left in the field would turn one transient RPC
        // failure into a permanent one for the life of the process.
        this.config = null;
        throw error;
      });
    }
    return this.config;
  }

  private async fetchConfig(programAddress: Address): Promise<SettlementConfigFacts> {
    const [configPda] = await findConfigPda({ programAddress });
    const account = await this.rpc
      .getAccountInfo(configPda, { encoding: 'base64', commitment: 'confirmed' })
      .send();
    if (!account.value) {
      throw ChainErrors.programNotConfigured({
        what: `the settlement program's Config account (${configPda})`,
        variable: SETTLEMENT_PROGRAM_ID_ENV,
      });
    }
    try {
      const decoded = getConfigDecoder().decode(
        new Uint8Array(getBase64Encoder().encode(account.value.data[0])),
      );
      return { treasury: decoded.treasury, redeemer: decoded.redeemer };
    } catch (cause) {
      throw ChainErrors.accountLayoutUnexpected({
        account: configPda,
        expected: 'a settlement program Config account',
        actual: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  /** `null` once the transaction has landed; the status error otherwise. */
  private async confirm(signature: string): Promise<unknown> {
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    for (;;) {
      const { value } = await this.rpc
        .getSignatureStatuses([signature], { searchTransactionHistory: false })
        .send();
      const status = value[0];
      if (status?.err) {
        return status.err;
      }
      if (
        status?.confirmationStatus === 'confirmed' ||
        status?.confirmationStatus === 'finalized'
      ) {
        return null;
      }
      if (Date.now() > deadline) {
        // No program error to name — a transaction that never confirmed says
        // nothing about whether it would have been accepted, and the next pass
        // finds out. `VoucherSeqNotIncreasing` is what it gets if it did land.
        return new Error(`did not confirm within ${CONFIRM_TIMEOUT_MS}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, CONFIRM_POLL_MS));
    }
  }

  /**
   * By **name**, never by number.
   *
   * Lean v3 shifted every code again, which is exactly why nothing here is
   * written as a number: `settlementErrorName` resolves one against the single
   * table that `chain-slash-outcome.spec.ts` checks against the IDL entry by
   * entry.
   *
   * There is no `VoucherAlreadyRedeemed` any more. A resubmission of a voucher
   * that already landed comes back as `VoucherSeqNotIncreasing`, which is
   * terminal — and Solana has no `findLanding`, so a confirmation this process
   * did not see becomes buyer debt the buyer may then pay twice. Rail B is off
   * on Solana (`rails: []`) until it has the EVM landing lookup; the redemption
   * job's per-buyer ordering is what keeps the case rare.
   *
   * Unrecognised is `RETRY`, and the asymmetry is deliberate. Mis-filing a
   * retryable refusal as `UNREDEEMABLE` turns a call the buyer would have paid
   * for into buyer debt it must re-sign; mis-filing a terminal one as
   * `RETRY` costs a fee per pass until the hold's own deadline ends it. The
   * second is bounded and visible in a log; the first is silent.
   */
  private classify(request: RedeemVoucherRequest, cause: unknown): RedeemOutcome {
    const programError = settlementErrorName(extractCustomErrorCode(cause));

    if (programError === 'ProgramPaused') {
      return { kind: RedeemOutcomeKind.PAUSED, signature: null, programError };
    }

    if (programError !== null && MISCONFIGURATION_ERRORS.has(programError)) {
      // `assertRedeemer` did not catch it, so the redeemer moved under a
      // running process. Same treatment: stop, and say so by name.
      this.logger.error(
        `redeem_voucher seq ${request.seq} for ${request.payer} was refused ${programError} — ` +
          `this process is not the program's configured redeemer. No voucher can be redeemed ` +
          `until an admin fixes it; nothing is being retried.`,
      );
      return { kind: RedeemOutcomeKind.MISCONFIGURED, signature: null, programError };
    }

    if (programError !== null && UNREDEEMABLE_ERRORS.has(programError)) {
      this.logger.error(
        `redeem_voucher seq ${request.seq} for ${request.payer} refused permanently: ` +
          `${programError}. The call becomes buyer debt (or the provider forfeits it).`,
      );
      return { kind: RedeemOutcomeKind.UNREDEEMABLE, signature: null, programError };
    }

    this.logger.warn(
      `redeem_voucher seq ${request.seq} for ${request.payer} did not land ` +
        `(${programError ?? describeError(cause)}) — retrying on the next pass`,
    );
    return { kind: RedeemOutcomeKind.RETRY, signature: null, programError };
  }

  private resolveFeePayer(): FeePayerSignerPort {
    try {
      return this.moduleRef.get<FeePayerSignerPort>(FEE_PAYER_SIGNER, { strict: false });
    } catch (cause) {
      throw ChainErrors.programNotConfigured({
        what:
          'a fee payer in this process — FeePayerSignerModule is not imported here (only the ' +
          'facilitator and the scheduler import it; see bootstrap/scheduler/app.module.ts)' +
          (cause instanceof Error ? ` (${cause.message})` : ''),
      });
    }
  }

  private requireProgramId(): string {
    if (!this.programId) {
      throw ChainErrors.programNotConfigured({
        what: 'the settlement program',
        variable: SETTLEMENT_PROGRAM_ID_ENV,
      });
    }
    return this.programId;
  }
}

/** `'sha256:' + 64 hex`, or a bare 64 hex — both are 32 bytes. */
function hashBytes(value: string): Uint8Array {
  const hex = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
  return new Uint8Array(Buffer.from(hex, 'hex'));
}
