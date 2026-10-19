import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
  Address,
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import {
  findConfigPda,
  findEscrowPda,
  getOpenEscrowInstructionAsync,
} from '@assay/settlement-client';

import { EscrowOpenerPort } from '@modules/payment/ports/escrow-opener.port';

import { FEE_PAYER_SIGNER, FeePayerSignerPort } from '../facilitator/signing/fee-payer-signer.port';
import { ChainErrors } from '../errors/chains.errors';
import { AccountId, AssetId, parseAccountId, parseAssetId, toAccountId } from '../ports/caip.types';
import { SETTLEMENT_PROGRAM_ID, SETTLEMENT_PROGRAM_ID_ENV } from './settlement-program.constants';
import { SOLANA_RPC } from './solana.constants';

/**
 * The two RPC calls this service makes, declared structurally like every
 * other service under this directory. No `sendTransaction` — submission
 * happens inside `FeePayerSignerPort.signAndSend`, the only thing here
 * holding a key that can pay for this transaction.
 */
export interface EscrowOpenerRpcClient {
  getAccountInfo(
    account: Address,
    config: { encoding: 'base64'; commitment?: 'confirmed' | 'finalized' },
  ): { send(): Promise<{ value: unknown | null }> };
  getLatestBlockhash(config: { commitment?: 'confirmed' | 'finalized' }): {
    send(): Promise<{ value: { blockhash: string; lastValidBlockHeight: bigint } }>;
  };
}

/**
 * `open_escrow` — the one settlement-program write the
 * platform makes on a buyer's behalf without their signature, because
 * `open_escrow` needs none *for a disarmed escrow*: `buyer` is a plain
 * identity account, not a `TransactionSigner`, and the program only demands
 * its signature when either limit is non-zero (`EscrowLimitsRequireBuyer`,
 * `refactor/trim-optional-doors`).
 *
 * ## Both limits are zero here, always
 *
 * That is not a default — it is the only value this path may write. The
 * platform used to choose a buyer's limits at open time from two env values;
 * the program now refuses that unless the buyer signs, and the buyer never
 * signs anything this service builds. So the escrow opens unable to pay for a
 * single call (`0` refuses, it does not mean unlimited), and stays
 * that way until the buyer arms it with `set_escrow_limits` through
 * `EscrowIntentBuilderPort` — the same wallet signature that already guards
 * every other change to their escrow. A voucher redeemed before that lands is
 * refused on chain with `VoucherExceedsPerCallLimit`, which is the correct
 * answer: the buyer has not yet said what a call may cost them.
 *
 * ## The fee payer is the platform's, and the buyer never signs this
 *
 * `rent_payer` is the fee payer, resolved through `FeePayerSignerPort` exactly
 * as `SolanaVoucherRedeemer` resolves it for `redeem_voucher` — through
 * `ModuleRef` at call time, not the constructor, for the same reason: this
 * class lives behind `ChainsModule`, which the API, worker, scheduler and MCP
 * processes all import, and a fee-payer key must not land in every one of
 * them just because they all import the chain boundary. Only a process that
 * also imports `FeePayerSignerModule` — the API (this is where a deposit
 * opens an escrow) and the scheduler (the cutover runbook) — can actually
 * open one; every other process fails loudly at the first call.
 *
 * ## Idempotent for the addresses, checked before it spends a fee
 *
 * `open_escrow`'s `escrow` account is `init`, not `init_if_needed` — the
 * program's own comment on `open_stake` gives the reason this repository
 * already leans on once: *"an initializer that can run on an existing account
 * is the shape reinitialisation attacks are made of."* A second `open_escrow`
 * for an already-initialised PDA fails on chain, after a network fee. Two API
 * replicas racing to fund the same brand-new buyer within the same few
 * hundred milliseconds is exactly the shape of race this guards: this class
 * reads the escrow account before building anything, and a caller who finds
 * one already there gets its addresses back with `signature: null` — nothing
 * was submitted, because nothing needed to be.
 */
@Injectable()
export class SolanaEscrowOpener implements EscrowOpenerPort {
  private readonly logger = new Logger(SolanaEscrowOpener.name);

  constructor(
    @Inject(SOLANA_RPC) private readonly rpc: EscrowOpenerRpcClient,
    @Inject(SETTLEMENT_PROGRAM_ID) private readonly programId: string | null,
    private readonly moduleRef: ModuleRef,
  ) {}

  async open(
    buyer: AccountId,
    asset: AssetId,
  ): Promise<{ escrowPda: AccountId; escrowTokenAccount: AccountId; signature: string | null }> {
    const programAddress = address(this.requireProgramId());
    const { chainId, address: buyerPubkey } = parseAccountId(buyer);
    const { assetReference } = parseAssetId(asset);

    const [escrowPda] = await findEscrowPda({ buyer: address(buyerPubkey) }, { programAddress });
    const stakeMint = address(assetReference);
    const [escrowTokenAccount] = await findAssociatedTokenPda({
      owner: escrowPda,
      mint: stakeMint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    const existing = await this.rpc
      .getAccountInfo(escrowPda, { encoding: 'base64', commitment: 'confirmed' })
      .send();
    if (existing.value) {
      this.logger.log(`Escrow ${escrowPda} already open for ${buyer} — nothing to submit`);
      return {
        escrowPda: toAccountId(chainId, escrowPda),
        escrowTokenAccount: toAccountId(chainId, escrowTokenAccount),
        signature: null,
      };
    }

    const feePayer = this.resolveFeePayer();
    const feePayerAddress = await feePayer.getFeePayerAddress();

    const [configPda] = await findConfigPda({ programAddress });
    const instruction = await getOpenEscrowInstructionAsync(
      {
        rentPayer: createNoopSigner(feePayerAddress),
        buyer: address(buyerPubkey),
        config: configPda,
        escrow: escrowPda,
        escrowTokenAccount,
        stakeMint,
        // Disarmed — see the class comment. Any other value here would need
        // `buyer` to be a signer, and it is a `createNoopSigner`-free plain
        // address on purpose.
        maxVoucherAmount: 0n,
        maxPerWindow: 0n,
      },
      { programAddress },
    );

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
      (m) => appendTransactionMessageInstruction(instruction, m),
    );

    const wire = getBase64EncodedWireTransaction(compileTransaction(message));
    const { signature } = await feePayer.signAndSend(wire);

    this.logger.log(`open_escrow for ${buyer} — ${escrowPda} — ${signature}`);
    return {
      escrowPda: toAccountId(chainId, escrowPda),
      escrowTokenAccount: toAccountId(chainId, escrowTokenAccount),
      signature,
    };
  }

  private resolveFeePayer(): FeePayerSignerPort {
    try {
      return this.moduleRef.get<FeePayerSignerPort>(FEE_PAYER_SIGNER, { strict: false });
    } catch (cause) {
      throw ChainErrors.programNotConfigured({
        what:
          'a fee payer in this process — FeePayerSignerModule must be imported wherever an ' +
          'escrow can be opened (PaymentApiModule for POST /deposits, the scheduler for the ' +
          'cutover runbook)' +
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
