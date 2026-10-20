import { Inject, Injectable } from '@nestjs/common';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
  Address,
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  Instruction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import {
  BUYER_ESCROW_DISCRIMINATOR,
  findConfigPda,
  findEscrowPda,
  getBuyerEscrowDecoder,
  getConfigDecoder,
  getRequestWithdrawInstructionAsync,
  getSetEscrowLimitsInstructionAsync,
  getWithdrawInstructionAsync,
  WITHDRAW_DELAY_SECONDS,
} from '@assay/settlement-client';

import { PaymentErrors } from '@modules/payment/errors/payment.errors';
import {
  EscrowIntentBuilderPort,
  EscrowIntentKind,
  EscrowIntentRequest,
} from '@modules/settlement/ports/escrow-intent-builder.port';
import { SettlementErrors } from '@modules/settlement/errors/settlement.errors';
import { MoneyUtil } from '@shared/utils/money.util';

import { ChainErrors } from '../errors/chains.errors';
import { getAssetMetadata } from '../ports/asset-registry';
import {
  AccountId,
  AssetId,
  ChainId,
  ChainNamespace,
  chainIdOf,
  namespaceOf,
  parseAccountId,
  toAssetId,
} from '../ports/caip.types';
import { UnsignedChainTransaction } from '../ports/unsigned-chain-transaction';
import { EscrowLimits } from '../ports/escrow.types';
import { SETTLEMENT_PROGRAM_ID, SETTLEMENT_PROGRAM_ID_ENV } from './settlement-program.constants';
import { SOLANA_RPC } from './solana.constants';

/**
 * The slice of the Solana JSON-RPC this builder uses — exactly two read
 * calls, and **no `sendTransaction`**. That absence is not an oversight; see
 * the class comment.
 */
export interface EscrowIntentBuilderRpcClient {
  getAccountInfo(
    account: Address,
    config: { encoding: 'base64'; commitment?: 'confirmed' | 'finalized' },
  ): { send(): Promise<{ value: { data: readonly [string, 'base64'] } | null }> };
  getLatestBlockhash(config: { commitment?: 'confirmed' | 'finalized' }): {
    send(): Promise<{ value: { blockhash: string; lastValidBlockHeight: bigint } }>;
  };
}

export const ESCROW_INTENT_BUILDER_CONFIG = 'ESCROW_INTENT_BUILDER_CONFIG';

export interface EscrowIntentBuilderConfig {
  /**
   * Milliseconds since epoch (`Date.now()`'s own unit — the escrow's chain
   * timestamps are seconds, and every comparison against them divides by
   * 1000 explicitly). Injected so a test can fix "now" without waiting for a
   * clock.
   */
  readonly now: () => number;
}

/**
 * The three transactions a **buyer's own wallet** signs against their escrow:
 * `set_escrow_limits`, `request_withdraw`, `withdraw`.
 *
 * There is no `close_escrow` in the program. Escrow accounts are permanent: the
 * program has no door that closes one, so there is no rent to reclaim and no
 * quarantine window to police.
 *
 * ## There is no `sendTransaction` in this file, and there must never be one
 *
 * `SolanaStakeIntentBuilder` next door makes this argument for a provider's
 * stake and every word of it applies here, one degree more sharply. Two of
 * these three doors are the buyer's defence against *this platform*:
 * `withdraw` takes their money out of reach, and `set_escrow_limits` is the
 * ceiling that exists precisely because the platform writes the 402 and
 * therefore picks the number the buyer's agent is asked to sign. A backend
 * that could sign either could raise the ceiling and then spend to it. So
 * this class:
 *
 * - takes the buyer's address through `createNoopSigner`, which cannot
 *   produce a signature — the generated instruction builders require a
 *   signer object for `buyer`, and a noop signer is how you satisfy that type
 *   without acquiring the capability it usually implies;
 * - compiles with `compileTransaction`, never `signTransactionMessageWithSigners`,
 *   so every signature slot goes out empty;
 * - declares an RPC interface with two read methods and no send method at all.
 *
 * ## The buyer is also the fee payer, and gas is not sponsored
 *
 * Same reason `GAS_NOT_SPONSORED_REASON` gives for staking: sponsoring an
 * intentional financial act invites griefing. A withdrawal and a limit change
 * are both intentional financial acts.
 *
 * ## Preconditions are checked here so the chain does not have to charge for them
 *
 * `withdraw` before `withdraw_available_at` and a destination equal to the
 * escrow's own token account are both refusals the program makes — after a
 * network fee. Refusing them here is the same trade
 * `ProviderStakeIntentService.withdrawIntent` already makes when it returns
 * `transaction: null` with a `blockedBy`.
 *
 * ## The instructions are generated, never hand-built
 *
 * `getSetEscrowLimitsInstructionAsync`, `getRequestWithdrawInstructionAsync`
 * and `getWithdrawInstructionAsync` from `@assay/settlement-client` — Codama
 * output rendered from the program's IDL.
 */
@Injectable()
export class SolanaEscrowIntentBuilder implements EscrowIntentBuilderPort {
  private config: Promise<SolanaEscrowConfig> | null = null;

  constructor(
    @Inject(SOLANA_RPC) private readonly rpc: EscrowIntentBuilderRpcClient,
    @Inject(SETTLEMENT_PROGRAM_ID) private readonly programId: string | null,
    @Inject(ESCROW_INTENT_BUILDER_CONFIG) private readonly builderConfig: EscrowIntentBuilderConfig,
  ) {}

  async escrowAsset(account: AccountId): Promise<{ asset: AssetId; decimals: number }> {
    const { chainId } = parseAccountId(account);
    const { stakeMint } = await this.settlementConfig();
    const asset = toAssetId(chainId, 'token', stakeMint);
    return { asset, decimals: getAssetMetadata(asset).decimals };
  }

  /**
   * `WITHDRAW_DELAY_SECONDS` — a program **constant**, not a
   * `Config` field, so there is nothing to read and nothing that one
   * `update_config` could move under a cached copy. Kept `async` because the
   * port's shape is the same for every chain and an EVM implementation may
   * still have to ask.
   */

  async withdrawDelaySeconds(chainId: ChainId): Promise<number> {
    // Asserted rather than ignored: the multiplexer above only ever hands this
    // a `solana:` chain, and an implementation that silently answered for any
    // chain would make that dispatch untestable — a wrong wiring would return a
    // plausible number instead of failing.
    if (namespaceOf(chainId) !== ChainNamespace.SOLANA) {
      throw ChainErrors.namespaceMismatch({ expected: ChainNamespace.SOLANA, actual: chainId });
    }
    return WITHDRAW_DELAY_SECONDS;
  }

  async buildIntent(request: EscrowIntentRequest): Promise<UnsignedChainTransaction> {
    const programAddress = address(this.requireProgramId());
    const { address: buyerAddress } = parseAccountId(request.account);
    const buyer = address(buyerAddress);
    const signer = createNoopSigner(buyer);

    const { stakeMint } = await this.settlementConfig();
    const mint = address(stakeMint);

    const [[escrowPda], [configPda]] = await Promise.all([
      findEscrowPda({ buyer }, { programAddress }),
      findConfigPda({ programAddress }),
    ]);
    const escrow = await this.readEscrow(escrowPda);
    if (!escrow) {
      throw PaymentErrors.escrowNotOpen({ account: request.account });
    }

    const instruction = await this.instructionFor(request, {
      programAddress,
      signer,
      buyer,
      mint,
      escrowPda,
      configPda,
      escrow,
    });

    const { value: latestBlockhash } = await this.rpc
      .getLatestBlockhash({ commitment: 'confirmed' })
      .send();

    const message = pipe(
      createTransactionMessage({ version: 0 }),
      // The buyer is the fee payer AND the only signer — no fee-payer
      // separation, for the same reason `SolanaStakeIntentBuilder` gives.
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          latestBlockhash as Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0],
          m,
        ),
      (m) => appendTransactionMessageInstruction(instruction, m),
    );

    // `compileTransaction`, NOT `signTransactionMessageWithSigners` — see the
    // class comment. The compiled transaction carries one empty signature
    // slot, addressed to the buyer.
    const compiled = compileTransaction(message);

    return {
      namespace: 'solana',
      // The chain of the buyer account this was built FOR. Every account on
      // this transaction is derived from it, so a mismatch would name a chain
      // the bytes do not belong to.
      chainId: chainIdOf(request.account),
      kind: 'transaction',
      transactionBase64: getBase64EncodedWireTransaction(compiled),
      feePayer: buyerAddress,
      signers: [buyerAddress],
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight.toString(),
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async instructionFor(
    request: EscrowIntentRequest,
    context: EscrowContext,
  ): Promise<Instruction> {
    const { programAddress, signer, escrowPda } = context;

    switch (request.kind) {
      case EscrowIntentKind.SET_LIMITS: {
        const limits = this.requireLimits(request);
        return getSetEscrowLimitsInstructionAsync(
          {
            buyer: signer,
            escrow: escrowPda,
            maxVoucherAmount: limits.maxVoucherAmount,
            maxPerWindow: limits.maxPerWindow,
          },
          { programAddress },
        );
      }

      case EscrowIntentKind.REQUEST_WITHDRAW:
        return getRequestWithdrawInstructionAsync(
          {
            buyer: signer,
            escrow: escrowPda,
            // `0` cancels a standing request — passed through, not
            // special-cased, so the chain's own semantics are the only ones.
            amount: MoneyUtil.toAtomic(this.requireAmount(request)),
          },
          { programAddress },
        );

      case EscrowIntentKind.WITHDRAW:
        return this.buildWithdraw(request, context);
    }
  }

  private async buildWithdraw(
    request: EscrowIntentRequest,
    context: EscrowContext,
  ): Promise<Instruction> {
    const { programAddress, signer, buyer, mint, escrowPda, configPda, escrow } = context;

    const [escrowTokenAccount] = await findAssociatedTokenPda({
      owner: escrowPda,
      mint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    const destination = request.destination
      ? address(parseAccountId(request.destination).address)
      : (
          await findAssociatedTokenPda({ owner: buyer, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS })
        )[0];

    if (destination === escrowTokenAccount) {
      throw SettlementErrors.withdrawalDestinationInvalid({ destination });
    }

    // `builderConfig.now()` is milliseconds (`Date.now()`'s own unit, the
    // same convention `EscrowBalanceReaderConfig.now` uses); the chain's
    // timestamps are unix seconds.
    const nowSeconds = Math.floor(this.builderConfig.now() / 1000);
    if (escrow.withdrawRequested === 0n || nowSeconds < Number(escrow.withdrawAvailableAt)) {
      throw SettlementErrors.withdrawalNotYetAvailable({
        availableAt: new Date(Number(escrow.withdrawAvailableAt) * 1000).toISOString(),
      });
    }

    // `config` is the escrow-mint pin: the program reads `config.stake_mint`
    // and refuses a `stake_mint` that is not it, so a withdrawal cannot be
    // aimed at a token account of some other mint. It is a seventh account on
    // an instruction that had six.
    return getWithdrawInstructionAsync(
      {
        buyer: signer,
        config: configPda,
        escrow: escrowPda,
        escrowTokenAccount,
        destination,
        stakeMint: mint,
      },
      { programAddress },
    );
  }

  private requireLimits(request: EscrowIntentRequest): EscrowLimits {
    if (!request.limits) {
      throw ChainErrors.programNotConfigured({
        what: `escrow limits for a ${request.kind} intent`,
        variable: 'limits',
      });
    }
    return request.limits;
  }

  private requireAmount(request: EscrowIntentRequest) {
    if (!request.amount) {
      throw ChainErrors.programNotConfigured({
        what: `an amount for a ${request.kind} escrow intent`,
        variable: 'amount',
      });
    }
    return request.amount;
  }

  private async readEscrow(escrowPda: Address): Promise<DecodedBuyerEscrow | null> {
    const account = await this.rpc
      .getAccountInfo(escrowPda, { encoding: 'base64', commitment: 'confirmed' })
      .send();
    if (!account.value) {
      return null;
    }

    const bytes = new Uint8Array(getBase64Encoder().encode(account.value.data[0]));
    if (!discriminatorMatches(bytes)) {
      throw ChainErrors.accountLayoutUnexpected({
        account: escrowPda,
        expected: 'a BuyerEscrow account',
        actual: Buffer.from(bytes.subarray(0, 8)).toString('hex'),
      });
    }
    try {
      return getBuyerEscrowDecoder().decode(bytes);
    } catch (cause) {
      throw ChainErrors.accountLayoutUnexpected({
        account: escrowPda,
        expected: 'a BuyerEscrow account',
        actual: cause instanceof Error ? cause.message : String(cause),
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

  /**
   * `Config.stake_mint`, read once and remembered — same trap-disarm as
   * `SolanaStakeIntentBuilder`.
   */
  private async settlementConfig(): Promise<SolanaEscrowConfig> {
    if (!this.config) {
      this.config = this.fetchConfig().catch((error: unknown) => {
        this.config = null;
        throw error;
      });
    }
    return this.config;
  }

  private async fetchConfig(): Promise<SolanaEscrowConfig> {
    const programAddress = address(this.requireProgramId());
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

    const data = new Uint8Array(getBase64Encoder().encode(account.value.data[0]));
    try {
      return { stakeMint: getConfigDecoder().decode(data).stakeMint };
    } catch (cause) {
      throw ChainErrors.accountLayoutUnexpected({
        account: configPda,
        expected: 'a settlement program Config account',
        actual: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
}

interface SolanaEscrowConfig {
  readonly stakeMint: string;
}

type DecodedBuyerEscrow = ReturnType<ReturnType<typeof getBuyerEscrowDecoder>['decode']>;

interface EscrowContext {
  readonly programAddress: Address;
  readonly signer: ReturnType<typeof createNoopSigner>;
  readonly buyer: Address;
  readonly mint: Address;
  readonly escrowPda: Address;
  /**
   * `["config"]` under the **deployed** program id, derived here and passed
   * to every builder that takes it.
   *
   * The `…InstructionAsync` builders will fill this account in themselves
   * when it is omitted — by calling Codama's `findConfigPda()` with no
   * argument, which derives it under the **compiled-in** `declare_id!()`.
   * That is the same silent divergence `voucher-message.ts` refuses a default
   * for: it compiles, it type-checks, and only the chain notices.
   */
  readonly configPda: Address;
  readonly escrow: DecodedBuyerEscrow;
}

function discriminatorMatches(data: Uint8Array): boolean {
  const expected = BUYER_ESCROW_DISCRIMINATOR;
  if (data.length < expected.length) {
    return false;
  }
  return Array.from(expected).every((byte, index) => data[index] === byte);
}
