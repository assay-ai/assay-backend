import { Inject, Injectable } from '@nestjs/common';
import {
  findAssociatedTokenPda,
  getTokenDecoder,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {
  Address,
  address,
  appendTransactionMessageInstruction,
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
  DEPOSIT_STAKE_DISCRIMINATOR,
  findConfigPda,
  getDepositStakeInstructionDataDecoder,
  findStakePda,
  findStakeVaultPda,
  getConfigDecoder,
  getDepositStakeInstruction,
  getOpenStakeInstruction,
  getRequestUnstakeInstruction,
  getWithdrawStakeInstruction,
} from '@assay/settlement-client';

import {
  GAS_NOT_SPONSORED_REASON,
  StakeAsset,
  StakeIntentBuilderPort,
  StakeIntentKind,
  StakeIntentPreflight,
  StakeIntentRequest,
  ConfirmedDepositExpectation,
} from '@modules/provider/ports/stake-intent-builder.port';
import { UnsignedChainTransaction } from '@modules/chains/ports/unsigned-chain-transaction';
import { MoneyUtil } from '@shared/utils/money.util';

import { ChainErrors } from '../errors/chains.errors';
import { getAssetMetadata } from '../ports/asset-registry';
import {
  AccountId,
  AssetId,
  ChainId,
  chainIdOf,
  parseAccountId,
  toAssetId,
} from '../ports/caip.types';
import { Money } from '../ports/money.types';
import { SOLANA_RPC } from './solana.constants';
import { SETTLEMENT_PROGRAM_ID, SETTLEMENT_PROGRAM_ID_ENV } from './settlement-program.constants';

/**
 * The slice of the Solana JSON-RPC this service needs, declared structurally so
 * a test supplies exactly these three — the same trade
 * `SettlementStakeRpcClient` makes next door.
 *
 * `getBalance` is the one call no other service here has needed: every existing
 * balance read in this module is an **SPL token** balance, and gas is the
 * native asset. Note there is no `sendTransaction`. That is the point of this
 * file — see the class comment.
 */
export interface StakeIntentRpcClient {
  getAccountInfo(
    account: Address,
    config: { encoding: 'base64'; commitment?: 'confirmed' | 'finalized' },
  ): { send(): Promise<{ value: { data: readonly [string, 'base64'] } | null }> };
  getTransaction(
    signature: string,
    config: {
      encoding: 'jsonParsed';
      maxSupportedTransactionVersion: 0;
      commitment?: 'confirmed' | 'finalized';
    },
  ): { send(): Promise<ParsedTransactionForDeposit | null> };
  getBalance(
    account: Address,
    config: { commitment?: 'confirmed' | 'finalized' },
  ): { send(): Promise<{ value: bigint }> };
  getLatestBlockhash(config: { commitment?: 'confirmed' | 'finalized' }): {
    send(): Promise<{ value: { blockhash: string; lastValidBlockHeight: bigint } }>;
  };
}

/**
 * The slice of a `jsonParsed` transaction {@link SolanaStakeIntentBuilder.confirmedDeposit}
 * reads.
 *
 * `jsonParsed` leaves an instruction of an unknown program **unparsed**: the
 * RPC hands back the account addresses it names and its data as base58, which
 * is exactly what is needed here and is why this reads the parsed encoding
 * rather than decoding a whole compiled transaction message by hand.
 */
export interface ParsedTransactionForDeposit {
  readonly meta: { readonly err: unknown } | null;
  /** Unix seconds the slot was produced; `null` when the node does not know. */
  readonly blockTime?: bigint | number | null;
  readonly transaction: {
    readonly message: {
      readonly instructions: readonly {
        readonly programId: string;
        readonly accounts?: readonly string[];
        readonly data?: string;
      }[];
    };
  };
}

/** `deposit_stake`'s fourth account. See `lean-v3-api.md` for the whole order. */
const DEPOSIT_STAKE_ACCOUNT_INDEX = 3;

/** `deposit_stake`'s first account: the funder who signed and paid. */
const DEPOSIT_FUNDER_ACCOUNT_INDEX = 0;

/** Lamports per SOL, as a scale. SPL and the native asset are both `u64`. */
export const LAMPORTS_DECIMALS = 9;

/**
 * CAIP-19 for the native asset of a Solana chain. `slip44:501` is SOL.
 *
 * Deliberately **not** added to `asset-registry.ts`. That registry is the list
 * of assets the platform *holds and reconciles*, and SOL is neither: this
 * platform never takes custody of a lamport, and adding it would enter it into
 * every "which assets do we hold" traversal as a balance nobody keeps. It is
 * quoted here because the stake screen has to print a number with a unit, and a bare
 * lamport count with no asset beside it is exactly the shape
 * `money.types.ts` refuses.
 */
function nativeAssetIdOf(chain: ChainId): AssetId {
  return toAssetId(chain, 'slip44', '501');
}

/**
 * The gas budget quoted to a provider before they sign, in lamports.
 *
 * `0.01 SOL` — deliberately a **ceiling** rather than
 * a quote. The largest of the four acts by far is `OPEN_STAKE`, which pays
 * rent-exemption for the `ProviderStake` PDA out of the provider's pocket; the
 * other three are a signature fee and a priority fee. One number for all four
 * because the screen's job is to stop a provider discovering at signature time
 * that they hold no SOL, and a per-instruction estimate that is occasionally
 * 200 lamports low would fail at exactly that job while looking more precise.
 *
 * Exported so the test that asserts what the preflight quotes reads the same
 * constant the preflight quotes.
 */
export const STAKE_INTENT_GAS_LAMPORTS = 10_000_000n;

/**
 * Builds the four stake transactions a provider's own wallet signs.
 *
 * ## There is no `sendTransaction` in this file, and there must never be one
 *
 * The backend never holds a provider's key and never signs these. A provider's
 * stake authority is theirs, and the settlement program says so —
 * `withdraw_stake`'s own comment is *"Only the provider may take their own
 * stake out. The admin key cannot."* The one transaction here the provider does
 * not sign is a treasury-funded `deposit_stake`
 * ({@link StakeIntentRequest.funder}), and the treasury's multisig signs that
 * one; this class still signs nothing.
 *
 * So this class:
 *
 * - takes the provider's address through {@link createNoopSigner}, which is a
 *   `TransactionSigner` that **cannot** produce a signature — the generated
 *   instruction builders require a signer object for `payer` / `provider` /
 *   `funder`, and a noop signer is how you satisfy that type without acquiring
 *   the capability it usually implies;
 * - compiles with {@link compileTransaction} rather than
 *   `signTransactionMessageWithSigners`, so every signature slot goes out empty;
 * - declares an RPC interface with no send method at all, so there is nothing
 *   for a later call site to reach for.
 *
 * ## The instructions are generated, never hand-built
 *
 * `getOpenStakeInstruction`, `getDepositStakeInstruction`,
 * `getRequestUnstakeInstruction`, `getWithdrawStakeInstruction` from
 * `@assay/settlement-client`, which is Codama output rendered from the program's
 * IDL. Two locks enforce it — an ESLint `no-restricted-syntax` rule and
 * `test/unit/chains/solana/settlement-client-only.spec.ts` — and the reason is
 * the usual one, sharpened by what these instructions do: a `u64` written at
 * the wrong offset is still a number, and here that number is somebody's
 * collateral leaving or not leaving the program.
 *
 * The PDAs are derived explicitly with `findStakePda` / `findConfigPda` /
 * `findStakeVaultPda` and passed to the synchronous builders, rather than
 * letting the `…InstructionAsync` variants default them. The two agree by
 * construction; deriving them here is what lets the deposit's funder token
 * account and the withdrawal's destination be the *same* ATA the preflight just
 * reported a balance for, instead of two independent derivations that could
 * drift.
 *
 * ## `OPEN_STAKE` pays rent from the provider's own pocket
 *
 * `open_stake` takes a `payer` and a `provider`, and they need not be the same
 * account. `scripts/settlement/exercise-all.ts` passes the **admin** as payer,
 * and that is right for a smoke script driving every instruction from one
 * keypair — it is wrong for the product path. A platform that paid rent for
 * provider accounts would be funding an unbounded number of PDAs on the say-so
 * of anyone who can complete registration, which is a griefing vector with an
 * exact price tag. So `payer` is the provider, and the preflight tells them
 * what it will cost before they commit.
 */
@Injectable()
export class SolanaStakeIntentBuilder implements StakeIntentBuilderPort {
  private config: Promise<StakeIntentConfig> | null = null;

  constructor(
    @Inject(SOLANA_RPC) private readonly rpc: StakeIntentRpcClient,
    @Inject(SETTLEMENT_PROGRAM_ID) private readonly programId: string | null,
  ) {}

  async stakeAsset(chain: ChainId): Promise<StakeAsset> {
    const { stakeMint } = await this.settlementConfig();
    const asset = toAssetId(chain, 'token', stakeMint);
    return { asset, decimals: getAssetMetadata(asset).decimals };
  }

  /** Always: the `ProviderStake` PDA has to be created by `open_stake`. */
  needsOpenStake(_chain: ChainId): boolean {
    return true;
  }

  async preflight(request: StakeIntentRequest): Promise<StakeIntentPreflight> {
    const context = await this.resolve(request);
    return context.preflight;
  }

  /**
   * What one confirmed transaction deposited into this provider's stake.
   *
   * Reads the transaction back off the cluster and looks for a `deposit_stake`
   * of this program whose `stake` account is **this** provider's PDA. Three
   * things make that a real check rather than a formality:
   *
   * - the discriminator is the generated `DEPOSIT_STAKE_DISCRIMINATOR`, so a
   *   different instruction of the same program does not pass;
   * - the stake account is re-derived from the provider this caller named, so a
   *   deposit into somebody else's stake does not pass;
   * - the amount is decoded from the instruction's own argument, so a
   *   transaction that deposited less than was owed is visible to the caller
   *   rather than rounded up to "they paid".
   *
   * `null` for an unknown signature, a failed transaction, or a transaction
   * with no matching instruction — see the port for why the three are not told
   * apart.
   *
   * Multiple matching instructions are summed. One transaction may legitimately
   * carry two deposits into the same stake, and taking only the first would
   * under-report what the provider actually received.
   */
  async confirmedDeposit(
    signature: string,
    account: AccountId,
    expected: ConfirmedDepositExpectation,
  ): Promise<Money | null> {
    const programAddress = address(this.requireProgramId());
    const funder = parseAccountId(expected.funder).address;
    const chain = chainIdOf(account);
    const { stakeMint } = await this.settlementConfig();
    const asset = toAssetId(chain, 'token', stakeMint);
    const { decimals } = getAssetMetadata(asset);

    const provider = address(parseAccountId(account).address);
    const [stakePda] = await findStakePda({ provider }, { programAddress });

    const response = await this.rpc
      .getTransaction(signature, {
        encoding: 'jsonParsed',
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      })
      .send();

    // Not found — at this commitment, or ever — and landed-but-failed are the
    // same answer, for the reason `SolanaChainAdapter.observeTransfer` gives
    // next door: the caller decides what absence means, and neither is a
    // deposit.
    if (!response || response.meta?.err) {
      return null;
    }

    // A deposit made at or before the slash executed is not its compensation
    // (review M-3), and one with no known time cannot be shown to be after it.
    const blockTime = response.blockTime;
    if (blockTime === null || blockTime === undefined) return null;
    if (!(Number(blockTime) * 1000 > expected.after.getTime())) return null;

    let total = 0n;
    for (const instruction of response.transaction.message.instructions) {
      if (instruction.programId !== programAddress) continue;
      if (instruction.accounts?.[DEPOSIT_STAKE_ACCOUNT_INDEX] !== stakePda) continue;
      // Only the treasury's deposits count, never the provider's own.
      if (instruction.accounts?.[DEPOSIT_FUNDER_ACCOUNT_INDEX] !== funder) continue;

      const amount = depositAmountOf(instruction.data);
      if (amount !== null) total += amount;
    }

    return total > 0n ? MoneyUtil.of(total, asset, decimals) : null;
  }

  async buildIntent(
    request: StakeIntentRequest,
  ): Promise<{ transaction: UnsignedChainTransaction; preflight: StakeIntentPreflight }> {
    const context = await this.resolve(request);
    const instruction = await this.instructionFor(request, context);

    const { value: latestBlockhash } = await this.rpc
      .getLatestBlockhash({ commitment: 'confirmed' })
      .send();

    const message = pipe(
      createTransactionMessage({ version: 0 }),
      // The provider is the fee payer AND the only signer. There is no
      // fee-payer separation here on purpose: `FeePayerSignerPort` exists to
      // let a relayer pay for somebody else's transaction, and paying for this
      // one is exactly what `GAS_NOT_SPONSORED_REASON` refuses to do.
      (m) => setTransactionMessageFeePayerSigner(context.signer, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          latestBlockhash as Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0],
          m,
        ),
      (m) => appendTransactionMessageInstruction(instruction, m),
    );

    // `compileTransaction`, NOT `signTransactionMessageWithSigners`. The
    // difference is the entire security property of this file: the compiled
    // transaction carries one empty signature slot, addressed to the provider.
    const compiled = compileTransaction(message);

    return {
      transaction: {
        namespace: 'solana',
        // The chain of the account this was built FOR, not a configured
        // default: `resolve()` derives every account on this transaction from
        // it, so a mismatch here would name a chain the bytes do not belong to.
        chainId: chainIdOf(request.account),
        kind: 'transaction',
        transactionBase64: getBase64EncodedWireTransaction(compiled),
        feePayer: context.funder,
        signers: [context.funder],
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight.toString(),
      },
      preflight: context.preflight,
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Everything both entry points need: the derived accounts, and the preflight
   * taken in one pass of RPC calls.
   */
  private async resolve(request: StakeIntentRequest): Promise<StakeIntentContext> {
    const programAddress = address(this.requireProgramId());
    const chain = chainIdOf(request.account);
    const { stakeMint } = await this.settlementConfig();
    const asset = toAssetId(chain, 'token', stakeMint);
    const { decimals } = getAssetMetadata(asset);

    const provider = address(parseAccountId(request.account).address);
    // Normally the provider themselves. A treasury-funded compensation deposit
    // is the one case where they differ — see `StakeIntentRequest.funder`.
    const funder = request.funder ? address(parseAccountId(request.funder).address) : provider;
    const mint = address(stakeMint);

    const [[stakePda], [configPda], [stakeVaultPda], [providerAta], [funderAta]] =
      await Promise.all([
        findStakePda({ provider }, { programAddress }),
        findConfigPda({ programAddress }),
        findStakeVaultPda({ programAddress }),
        findAssociatedTokenPda({ owner: provider, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
        findAssociatedTokenPda({ owner: funder, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
      ]);

    const requiredStakeAsset = this.requiredStakeAsset(request, asset, decimals);

    // The **funder's** balances, not the provider's: the funder is the account
    // that has to hold the money and pay for the transaction.
    const [tokenBalance, lamports] = await Promise.all([
      this.readTokenBalance(funderAta, asset, decimals),
      this.rpc.getBalance(funder, { commitment: 'confirmed' }).send(),
    ]);

    const nativeAsset = nativeAssetIdOf(chain);
    const requiredGas = MoneyUtil.of(STAKE_INTENT_GAS_LAMPORTS, nativeAsset, LAMPORTS_DECIMALS);
    const gasBalance = MoneyUtil.of(lamports.value, nativeAsset, LAMPORTS_DECIMALS);

    return {
      provider,
      funder,
      signer: createNoopSigner(funder),
      programAddress,
      stakePda,
      configPda,
      stakeVaultPda,
      providerAta,
      funderAta,
      mint,
      asset,
      decimals,
      preflight: {
        requiredStakeAsset,
        stakeAssetBalance: tokenBalance,
        requiredGas,
        gasBalance,
        // A `null` balance is unknown, and unknown is never "enough" — the
        // same fail-closed reading `GetProviderStakeResponseDto` applies to an
        // unreadable chain. A funder with no token account genuinely cannot
        // fund a deposit until one exists.
        hasEnoughStakeAsset:
          tokenBalance !== null && MoneyUtil.greaterThanOrEqual(tokenBalance, requiredStakeAsset),
        hasEnoughGas: MoneyUtil.greaterThanOrEqual(gasBalance, requiredGas),
        gasSponsored: false,
        gasNotSponsoredReason: GAS_NOT_SPONSORED_REASON,
      },
    };
  }

  /**
   * What the act itself moves. Only a deposit moves the stake asset — an
   * unstake starts a clock, a withdrawal moves money *out*, and `open_stake`
   * touches no token account at all.
   */
  private requiredStakeAsset(request: StakeIntentRequest, asset: AssetId, decimals: number): Money {
    if (request.kind !== StakeIntentKind.DEPOSIT) {
      return MoneyUtil.zero(asset, decimals);
    }
    return this.requireAmount(request, asset);
  }

  /**
   * The provider's own token account balance, or `null` when there is no such
   * account.
   *
   * `getAccountInfo` + the generated decoder rather than
   * `getTokenAccountBalance`: that method *throws* on a missing account, and the missing account is a
   * first-class answer here. A provider who has never held the stake mint has
   * no ATA, and telling them "0 USDC" instead of "no token account" sends them
   * to a faucet when what they need is an account.
   */
  private async readTokenBalance(
    ata: Address,
    asset: AssetId,
    decimals: number,
  ): Promise<Money | null> {
    const account = await this.rpc
      .getAccountInfo(ata, { encoding: 'base64', commitment: 'confirmed' })
      .send();
    if (!account.value) {
      return null;
    }

    const data = new Uint8Array(getBase64Encoder().encode(account.value.data[0]));
    try {
      return MoneyUtil.of(getTokenDecoder().decode(data).amount, asset, decimals);
    } catch (cause) {
      throw ChainErrors.accountLayoutUnexpected({
        account: ata,
        expected: 'an SPL token account',
        actual: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  private async instructionFor(
    request: StakeIntentRequest,
    context: StakeIntentContext,
  ): Promise<Instruction> {
    const { programAddress } = context;

    switch (request.kind) {
      case StakeIntentKind.OPEN_STAKE:
        // `payer` and `provider` are the same account here — the provider pays
        // rent for their own account. See the class comment for why
        // `exercise-all.ts` using the admin is not a precedent. `funder` is
        // meaningless on this door: it moves no tokens.
        return getOpenStakeInstruction(
          { payer: context.signer, provider: context.provider, stake: context.stakePda },
          { programAddress },
        );

      case StakeIntentKind.DEPOSIT:
        return getDepositStakeInstruction(
          {
            funder: context.signer,
            funderTokenAccount: context.funderAta,
            config: context.configPda,
            stake: context.stakePda,
            stakeVault: context.stakeVaultPda,
            stakeMint: context.mint,
            amount: MoneyUtil.toAtomic(this.requireAmount(request, context.asset)),
          },
          { programAddress },
        );

      case StakeIntentKind.UNSTAKE:
        return getRequestUnstakeInstruction(
          {
            provider: context.signer,
            config: context.configPda,
            stake: context.stakePda,
            amount: MoneyUtil.toAtomic(this.requireAmount(request, context.asset)),
          },
          { programAddress },
        );

      case StakeIntentKind.WITHDRAW:
        return getWithdrawStakeInstruction(
          {
            provider: context.signer,
            config: context.configPda,
            stake: context.stakePda,
            stakeVault: context.stakeVaultPda,
            // The provider's own ATA. `withdraw_stake` is signed by the
            // provider and nobody else, so `funder` never applies here.
            destination: context.providerAta,
            stakeMint: context.mint,
            amount: MoneyUtil.toAtomic(this.requireAmount(request, context.asset)),
          },
          { programAddress },
        );
    }
  }

  /**
   * The amount, refused rather than defaulted when absent or denominated in
   * anything other than the mint `Config` names.
   *
   * A missing amount defaulting to zero would be a transaction the provider
   * signed and paid for that did nothing; a mismatched asset would be a
   * transfer of the wrong token, which the program rejects only after the
   * provider has already paid to submit it.
   */
  private requireAmount(request: StakeIntentRequest, asset: AssetId): Money {
    if (!request.amount) {
      throw ChainErrors.programNotConfigured({
        what: `an amount for a ${request.kind} stake intent`,
        variable: 'amount',
      });
    }
    if (request.amount.asset !== asset) {
      throw ChainErrors.assetUnknown({ asset: request.amount.asset });
    }
    return request.amount;
  }

  private requireProgramId(): string {
    if (!this.programId) {
      // Not a boot failure, by the deliberate design of the token — see
      // `settlement-program.constants.ts`.
      throw ChainErrors.programNotConfigured({
        what: 'the settlement program',
        variable: SETTLEMENT_PROGRAM_ID_ENV,
      });
    }
    return this.programId;
  }

  /**
   * `Config.stake_mint`, read once and remembered — only an admin
   * `update_config` moves it. The memo is dropped on failure so one unreachable
   * RPC at boot does not poison the process for the rest of its life, the same
   * trap `SolanaSettlementStakeReader` disarms around the same account.
   */
  private async settlementConfig(): Promise<StakeIntentConfig> {
    if (!this.config) {
      this.config = this.fetchConfig().catch((error: unknown) => {
        this.config = null;
        throw error;
      });
    }
    return this.config;
  }

  private async fetchConfig(): Promise<StakeIntentConfig> {
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

/**
 * The `u64` a `deposit_stake` instruction carries, or `null` when the data is
 * not a `deposit_stake` at all.
 *
 * Both halves come from the generated client and neither is hand-decoded: the
 * discriminator is `DEPOSIT_STAKE_DISCRIMINATOR`, and the amount comes off
 * `getDepositStakeInstructionDataDecoder()`, so a rebuilt program that changes
 * either changes this too. The discriminator is still compared **before** the
 * decoder runs, because the decoder would happily read eight bytes of some
 * other instruction's argument as an amount.
 */
function depositAmountOf(data: string | undefined): bigint | null {
  if (!data) return null;

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(getBase58Encoder().encode(data));
  } catch {
    // Not base58. An instruction `jsonParsed` DID parse carries an object here
    // rather than a string, which is not this program's and not a deposit.
    return null;
  }

  if (bytes.length < DEPOSIT_STAKE_DISCRIMINATOR.length + 8) return null;
  for (const [index, byte] of DEPOSIT_STAKE_DISCRIMINATOR.entries()) {
    if (bytes[index] !== byte) return null;
  }

  try {
    return getDepositStakeInstructionDataDecoder().decode(bytes).amount;
  } catch {
    return null;
  }
}

/** The `Config` field this builder depends on. */
interface StakeIntentConfig {
  readonly stakeMint: string;
}

/** One request's derived accounts and its preflight, resolved together. */
interface StakeIntentContext {
  readonly provider: Address;
  /** Who signs and pays. The provider, unless a `funder` was named. */
  readonly funder: Address;
  /** A signer that cannot sign — see the class comment on {@link createNoopSigner}. */
  readonly signer: ReturnType<typeof createNoopSigner>;
  readonly programAddress: Address;
  readonly stakePda: Address;
  readonly configPda: Address;
  readonly stakeVaultPda: Address;
  readonly providerAta: Address;
  /** `ATA(funder, mint)` — the same account as {@link providerAta} in the normal case. */
  readonly funderAta: Address;
  readonly mint: Address;
  readonly asset: AssetId;
  readonly decimals: number;
  readonly preflight: StakeIntentPreflight;
}
