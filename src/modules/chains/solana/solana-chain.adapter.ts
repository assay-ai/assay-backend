import { createPublicKey, verify as verifyEd25519 } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
  Address,
  address,
  CompiledTransactionMessage,
  getBase58Encoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  isAddress,
  ReadonlyUint8Array,
} from '@solana/kit';

import { voucherMessage } from '@assay/settlement-client';

import { computeResourceHash, hashHexToBytes } from '@modules/payment/domain/resource-hash';

import { ChainErrors } from '../errors/chains.errors';
import { getAssetMetadata } from '../ports/asset-registry';
import {
  AccountId,
  AssetId,
  ChainId,
  ChainNamespace,
  namespaceOf,
  parseAccountId,
  parseAssetId,
  toAccountId,
} from '../ports/caip.types';
import { ChainAdapter } from '../ports/chain-adapter.port';
import { Money } from '../ports/money.types';
import { PayoutProofChallenge } from '../ports/payout-proof.types';
import { StakeAuthorityChallenge } from '../ports/stake-authority.types';
import {
  BuildRequirementsInput,
  ObservedTransfer,
  PaymentIntent,
  PaymentPayload,
  PaymentRequirements,
  SettlementReceipt,
  TxRef,
  Voucher,
} from '../ports/x402.types';
import { MoneyUtil } from '@shared/utils/money.util';
import { ENABLED_CHAINS } from '../enabled-chains';
import { SETTLEMENT_PROGRAM_ID, SETTLEMENT_PROGRAM_ID_ENV } from './settlement-program.constants';
import {
  MEMO_PROGRAM_ADDRESS,
  PAYOUT_PROOF_MESSAGE_VERSION,
  SOLANA_MAX_TIMEOUT_SECONDS,
  SOLANA_PAYMENT_SCHEME,
  SOLANA_RPC,
  STAKE_AUTHORITY_MESSAGE_VERSION,
} from './solana.constants';

/**
 * The slice of the Solana JSON-RPC this adapter uses.
 *
 * Declared structurally rather than imported as the full `Rpc<SolanaRpcApi>` so
 * a test can supply the three calls we make instead of a whole RPC surface.
 */
export interface SolanaRpcClient {
  getTokenAccountBalance(account: Address): {
    send(): Promise<{ value: { amount: string; decimals: number } }>;
  };
  getTransaction(
    signature: string,
    config: {
      encoding: 'jsonParsed';
      maxSupportedTransactionVersion: 0;
      commitment?: 'confirmed' | 'finalized';
    },
  ): {
    send(): Promise<SolanaParsedTransactionResponse | null>;
  };
  getLatestBlockhash(config: { commitment?: 'confirmed' | 'finalized' }): {
    send(): Promise<{ value: { blockhash: string; lastValidBlockHeight: bigint } }>;
  };
}

/** The slice of `getTransaction`'s `jsonParsed` response this adapter reads. */
export interface SolanaParsedTransactionResponse {
  readonly meta: {
    readonly err: unknown;
    readonly preTokenBalances?: readonly SolanaParsedTokenBalance[];
    readonly postTokenBalances?: readonly SolanaParsedTokenBalance[];
  } | null;
}

export interface SolanaParsedTokenBalance {
  /** The SPL token account's authority — absent for accounts the RPC could not resolve an owner for. */
  readonly owner?: string;
  readonly mint: string;
  readonly uiTokenAmount: { readonly amount: string; readonly decimals: number };
}

/** The 12-byte SPKI prefix that turns a raw 32-byte ed25519 key into a DER key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

@Injectable()
export class SolanaChainAdapter implements ChainAdapter {
  readonly namespace = ChainNamespace.SOLANA;

  /**
   * A Solana transaction names its fee payer, and the buyer must leave that
   * signature slot empty for the facilitator to occupy — which is what makes a
   * deposit gasless for a wallet holding no SOL. So a `402` on this chain has
   * to advertise the address. See {@link ChainAdapter.requiresFeePayer}.
   */
  readonly requiresFeePayer = true;
  /**
   * The networks *this deployment* serves, not the networks this class can
   * talk to — see `../enabled-chains.ts` for why the two are different and what
   * conflating them cost. Injected rather than declared, so a devnet-only
   * deployment does not advertise, reconcile or pay out on mainnet.
   *
   * There is no fallback. The list used to default to both Solana networks when
   * nothing was injected, which is a fail-*open*: an adapter with no opinion
   * quietly served mainnet. `ENABLED_CHAINS` is mandatory at boot, so
   * the absence this default covered can no longer happen.
   */
  readonly supportedChains: readonly ChainId[];

  constructor(
    @Inject(SOLANA_RPC) private readonly rpc: SolanaRpcClient,
    @Inject(ENABLED_CHAINS) enabledChains: readonly ChainId[],
    /**
     * The **deployed** settlement program id, which a voucher signs at offset
     * 15. `null` when this deployment has no settlement program — the failure
     * belongs at the first call that needs the address, not at boot, exactly as
     * `settlement-program.constants.ts` argues.
     */
    @Optional() @Inject(SETTLEMENT_PROGRAM_ID) private readonly programId: string | null = null,
  ) {
    // Only the chains in THIS adapter's namespace. `ENABLED_CHAINS` is the
    // deployment-wide list and may name `eip155:*` once an EVM adapter exists;
    // handing those to the Solana adapter would make `resolve()` return it for
    // a chain it cannot talk to.
    this.supportedChains = enabledChains.filter(
      (chainId) => namespaceOf(chainId) === ChainNamespace.SOLANA,
    );
  }

  // ── Identity ─────────────────────────────────────────────────────────────

  isValidAddress(chainId: ChainId, addressToCheck: string): boolean {
    this.assertServes(chainId);
    return isAddress(addressToCheck);
  }

  toAccountId(chainId: ChainId, addressToWrap: string): AccountId {
    this.assertServes(chainId);
    if (!isAddress(addressToWrap)) {
      throw ChainErrors.invalidAddress({ address: addressToWrap, chainId });
    }
    return toAccountId(chainId, addressToWrap);
  }

  parseAccountId(accountId: AccountId): { chainId: ChainId; address: string } {
    const parsed = parseAccountId(accountId);
    this.assertServes(parsed.chainId);
    return { chainId: parsed.chainId, address: parsed.address };
  }

  // ── x402 ─────────────────────────────────────────────────────────────────

  async buildPaymentRequirements(input: BuildRequirementsInput): Promise<PaymentRequirements> {
    this.assertServes(input.chainId);

    const asset = parseAssetId(input.amount.asset);
    if (asset.chainId !== input.chainId) {
      throw ChainErrors.assetNotOnChain({ asset: input.amount.asset, chainId: input.chainId });
    }

    // `payToIsTokenAccount` — escrow deposits hand over the ATA
    // directly, not its owner; deriving an ATA of that ATA would compute an
    // address nothing owns. Every other caller still names an owner and gets
    // the same derivation this always did.
    const vaultAddress = input.payToIsTokenAccount
      ? this.parseAccountId(input.payTo).address
      : this.parseAccountId(await this.getVaultAccount(input.payTo, input.amount.asset)).address;
    // Refused rather than cast. `feePayer` is nullable on the input because EVM
    // has no such account, and a `null` reaching here would otherwise become
    // the string `"undefined"` in `extra.feePayer` — the buyer signs against
    // it, and the failure surfaces at the facilitator as an invalid payload
    // they cannot interpret. Unreachable on the deposit path, which asks
    // `requiresFeePayer` before it fetches one; this is the guard that keeps it
    // unreachable for the next caller too.
    if (input.feePayer === null) {
      throw ChainErrors.facilitatorUnavailable({
        chainId: input.chainId,
        reason: 'this chain separates the fee payer and none was supplied',
      });
    }
    const feePayer = this.parseAccountId(input.feePayer);

    return {
      scheme: SOLANA_PAYMENT_SCHEME,
      network: input.chainId,
      amount: input.amount.amount,
      // Chain-native from here on: x402 `accepts[]` carries the bare mint and
      // token account, not the CAIP forms the domain uses.
      asset: asset.assetReference,
      payTo: vaultAddress,
      resource: input.resource,
      maxTimeoutSeconds: SOLANA_MAX_TIMEOUT_SECONDS,
      ...(input.description ? { description: input.description } : {}),
      extra: {
        paymentFlow: 'upfront',
        feePayer: feePayer.address,
        // The binding. Everything else in the transaction can be rebuilt by an
        // attacker; the memo is what ties these lamports to this intent.
        memo: input.intentId,
      },
    };
  }

  /**
   * Reads the memo out of the *signed transaction*, not out of a field the
   * client also controls. An echoed memo would prove nothing — the whole point
   * is that the payer signed over the binding.
   */
  assertPayloadBoundToIntent(payload: PaymentPayload, intent: PaymentIntent): void {
    this.assertServes(payload.network);
    if (payload.network !== intent.chainId) {
      throw ChainErrors.payloadNotBoundToIntent({
        intentId: intent.id,
        reason: `payload is for ${payload.network}, intent is on ${intent.chainId}`,
      });
    }

    const memos = this.extractMemos(payload);

    if (memos.length === 0) {
      throw ChainErrors.payloadNotBoundToIntent({
        intentId: intent.id,
        reason: 'transaction carries no memo',
      });
    }
    // More than one memo is not ambiguity to resolve — it is an attempt to make
    // two intents accept the same transaction.
    if (memos.length > 1) {
      throw ChainErrors.payloadNotBoundToIntent({
        intentId: intent.id,
        reason: `transaction carries ${memos.length} memos`,
      });
    }
    if (memos[0] !== intent.id) {
      throw ChainErrors.payloadNotBoundToIntent({
        intentId: intent.id,
        reason: `memo is "${memos[0]}"`,
      });
    }
  }

  /**
   * The observed amount, refusing a foreign chain, a foreign receipt, a
   * different asset, or an underpayment — in that order.
   *
   * The chain-membership check covers 12 of 15 port methods; this one was the
   * real gap.
   * It takes an intent that CARRIES a chain id and never looked at it, so an
   * intent on a chain this adapter does not serve settled as if it did —
   * unreachable while one chain is enabled, live from the second one. The guard
   * lands **before** that second chain rather than with it, so the window in
   * which the defect is live is not a window somebody has to notice.
   */
  extractSettledAmount(intent: PaymentIntent, receipt: SettlementReceipt): Money {
    this.assertServes(intent.chainId);

    // And the sharper half: the receipt names its own network, and nothing
    // compared the two. Alignment today is a property of one call site
    // (`deposit.service.ts` passes `network: intent.chainId` literally), not of
    // the port — so it holds for exactly as long as nobody writes a second
    // caller.
    if (receipt.network !== intent.chainId) {
      throw ChainErrors.settledNetworkMismatch({
        intentId: intent.id,
        expected: intent.chainId,
        actual: receipt.network,
      });
    }

    if (receipt.observed.asset !== intent.amount.asset) {
      throw ChainErrors.settledAssetMismatch({
        intentId: intent.id,
        expected: intent.amount.asset,
        actual: receipt.observed.asset,
      });
    }

    const settled = MoneyUtil.of(
      receipt.observed.amount,
      receipt.observed.asset,
      receipt.observed.decimals,
    );

    // The SVM `exact` scheme permits a transfer of *at least* `amount`, to
    // accommodate smart-wallet rounding. Overpayment is credited; underpayment
    // is not a payment.
    if (MoneyUtil.compare(settled, intent.amount) < 0) {
      throw ChainErrors.settledAmountBelowIntent({
        intentId: intent.id,
        expected: intent.amount.amount,
        actual: settled.amount,
      });
    }

    return settled;
  }

  /**
   * Reads the transaction's `preTokenBalances` / `postTokenBalances` — the
   * balance delta the cluster itself computed — rather than decoding the raw
   * `TransferChecked` instruction. Two reasons: it is what the RPC already
   * verified against the ledger (a hand-decoded instruction says what was
   * *requested*, not what actually posted), and it is indexed by owner and
   * mint directly, so no account-index bookkeeping is needed to find the
   * vault's entry among however many accounts the transaction touched.
   */
  async observeTransfer(
    intent: PaymentIntent,
    transaction: TxRef,
    options?: { readonly commitment?: 'confirmed' | 'finalized' },
  ): Promise<ObservedTransfer | null> {
    this.assertServes(intent.chainId);
    const parsedAsset = parseAssetId(intent.amount.asset);
    const vaultOwnerAddress = this.parseAccountId(intent.payTo).address;

    const response = await this.rpc
      .getTransaction(transaction, {
        encoding: 'jsonParsed',
        maxSupportedTransactionVersion: 0,
        ...(options?.commitment ? { commitment: options.commitment } : {}),
      })
      .send();

    // Not found (yet, at this commitment, or ever — a reorg looks identical
    // to "not landed yet" from here) and a transaction that landed but
    // failed are both "nothing was observed", never a throw: the caller
    // decides what "not found" means for its own state machine.
    if (!response || response.meta?.err) {
      return null;
    }

    const matches = (balance: SolanaParsedTokenBalance) =>
      balance.owner === vaultOwnerAddress && balance.mint === parsedAsset.assetReference;

    const pre = response.meta?.preTokenBalances?.find(matches);
    const post = response.meta?.postTokenBalances?.find(matches);
    if (!post) {
      return null;
    }

    const before = pre ? BigInt(pre.uiTokenAmount.amount) : 0n;
    const after = BigInt(post.uiTokenAmount.amount);
    const delta = after - before;
    if (delta <= 0n) {
      return null;
    }

    return {
      amount: delta.toString(),
      asset: intent.amount.asset,
      decimals: post.uiTokenAmount.decimals,
    };
  }

  // ── Vouchers ─────────────────────────────────────────────────────────────

  /**
   * The 240 bytes of voucher v2, produced by the one encoder in this repository
   * (`@assay/settlement-client`'s `voucherMessage`) so that the bytes a buyer
   * signs and the bytes `redeem_voucher` recomputes cannot drift apart.
   *
   * v1 was a newline-joined UTF-8 text message under the tag `x402-voucher/v1`.
   * It is gone rather than kept alongside: the escrow program verifies this
   * layout and no other, and a second accepted encoding would be a second thing
   * that has to be right. Because the domain tag leads the message, no v1
   * signature can verify as v2 — an old voucher is refused, never misread.
   *
   * `programAddress` is the **deployed** id from `SOLANA_SETTLEMENT_PROGRAM_ID`,
   * never the client's compiled-in `ASSAY_PAYMENT_PROGRAM_ADDRESS`. See
   * `voucher-message.ts` for the failure that default would produce: every
   * buyer signs bytes naming a program that is not the one about to check them,
   * the call is served, the money is held, and every redemption dies with
   * `MissingBuyerSignature`.
   */
  buildVoucherMessage(voucher: Voucher): Uint8Array {
    if (!this.programId) {
      throw ChainErrors.programNotConfigured({
        what: 'the settlement program id a voucher signs at offset 16',
        variable: SETTLEMENT_PROGRAM_ID_ENV,
      });
    }

    return voucherMessage({
      payer: address(this.parseAccountId(voucher.payer).address),
      payTo: address(this.parseAccountId(voucher.payTo).address),
      provider: address(this.parseAccountId(voucher.provider).address),
      amount: MoneyUtil.toAtomic(voucher.amount),
      resourceHash: hashHexToBytes(computeResourceHash(voucher.resource)),
      requestHash: hashHexToBytes(voucher.requestHash),
      seq: BigInt(voucher.seq),
      issuedAt: BigInt(voucher.issuedAt),
      expiresAt: BigInt(voucher.expiresAt),
      programAddress: address(this.programId),
    });
  }

  voucherResourceHash(resource: string): string {
    // The same value `buildVoucherMessage` decodes into the 240 bytes.
    return computeResourceHash(resource);
  }

  verifyVoucherSignature(voucher: Voucher, signature: string, signer: AccountId): boolean {
    return this.verifySignature(this.buildVoucherMessage(voucher), signature, signer);
  }

  // ── Payout proof ─────────────────────────────────────────────────────────

  /**
   * The same construction `buildVoucherMessage` uses, over the payout
   * challenge's own fields and under its own version tag.
   *
   * `PAYOUT_PROOF_MESSAGE_VERSION` leads the message and differs from the
   * other version tags in this file, so a signature obtained here can never
   * be replayed as a voucher, and a voucher signature can never be replayed
   * as a payout proof — see the constant's comment. `account` and
   * `organizationId` are both inside the signed bytes: without `account`, a
   * signature proving control of *some* wallet could be attributed to any
   * address the caller names when submitting it; without `organizationId`, a
   * proof obtained by one organization's console session could be replayed
   * onto another organization's provider row.
   *
   * Every field is newline-free: a CAIP-10 account id, a UUID, 64 hex
   * characters and a unix timestamp all have grammars that exclude one, and
   * — unlike a voucher — there is no free-text field here at all.
   */
  buildPayoutProofMessage(challenge: PayoutProofChallenge): Uint8Array {
    const fields = [
      PAYOUT_PROOF_MESSAGE_VERSION,
      challenge.account,
      challenge.organizationId,
      challenge.nonce,
      String(challenge.expiresAt),
    ];
    return new TextEncoder().encode(fields.join('\n'));
  }

  verifyPayoutProofSignature(
    challenge: PayoutProofChallenge,
    signature: string,
    signer: AccountId,
  ): boolean {
    return this.verifySignature(this.buildPayoutProofMessage(challenge), signature, signer);
  }

  // ── Stake authority proof ────────────────────────────────────────────────

  /**
   * The same construction again, over the stake-authority challenge's own
   * fields and under its own version tag.
   *
   * `STAKE_AUTHORITY_MESSAGE_VERSION` leads the message and differs from all
   * three other tags. The one that matters most is
   * `PAYOUT_PROOF_MESSAGE_VERSION`: the two challenges carry the same four
   * fields, so with a shared tag the *identical bytes* would be produced and
   * a proof collected for "this is my payout wallet" would satisfy "this is
   * the wallet holding my stake". Both cross directions are asserted in
   * `test/unit/chains/solana/stake-authority-message.spec.ts` — the readable,
   * direct statement that neither signature satisfies the other's check, and
   * what fails loudly if the two tags are ever made equal.
   *
   * The pair does *not* catch a tag that is a prefix of another one, and it
   * cannot: the tag leads the message and is newline-delimited, so the bytes
   * built here are equal exactly when the tags are, which makes the two
   * directions logically equivalent. Mutating the stake tag to
   * `'assay-payout-proof/v1X'` leaves both of them passing. The single
   * assertion that fails is `not.toContain(PAYOUT_PROOF_MESSAGE_VERSION)` in
   * that spec's `leads the message with the version tag` — the only prefix
   * cover in the suite.
   *
   * `account` and `organizationId` are both inside the signed bytes for the
   * reasons the payout builder gives, sharpened by what is being claimed
   * here: without `account`, a signature proving control of *some* wallet
   * could be attributed to any stake pubkey the caller names — which is the
   * whole attack this proof exists to deny, since the named pubkey's owner is
   * the one whose collateral gets gated and slashed.
   *
   * Every field is newline-free: a CAIP-10 account id, a UUID, 64 hex
   * characters and a unix timestamp all have grammars that exclude one, and
   * there is no free-text field here at all.
   */
  buildStakeAuthorityMessage(challenge: StakeAuthorityChallenge): Uint8Array {
    const fields = [
      STAKE_AUTHORITY_MESSAGE_VERSION,
      challenge.account,
      challenge.organizationId,
      challenge.nonce,
      String(challenge.expiresAt),
    ];
    return new TextEncoder().encode(fields.join('\n'));
  }

  /** `null`: a Solana proof is a plain message — the bytes above ARE what is signed. */
  payoutProofTypedData(): null {
    return null;
  }

  /** `null`, for the same reason as {@link payoutProofTypedData}. */
  stakeAuthorityTypedData(): null {
    return null;
  }

  verifyStakeAuthoritySignature(
    challenge: StakeAuthorityChallenge,
    signature: string,
    signer: AccountId,
  ): boolean {
    return this.verifySignature(this.buildStakeAuthorityMessage(challenge), signature, signer);
  }

  /**
   * Raw ed25519 verification against a base58 Solana address.
   *
   * One implementation shared by all four signed structures. Separate copies
   * of the SPKI-prefix trick would be separate chances to get the key
   * encoding subtly wrong, and a subtly wrong verifier that returns `false`
   * too often looks like a client bug while one that returns `true` too often
   * is a theft.
   */
  private verifySignature(message: Uint8Array, signature: string, signer: AccountId): boolean {
    const { address: signerAddress } = this.parseAccountId(signer);

    try {
      const raw = Buffer.from(getBase58Encoder().encode(signerAddress));
      // One line on purpose. `settlement-client-only.spec.ts` bans
      // `Buffer.concat(` in every file that touches the settlement program —
      // which this one now does — and exempts the line by what it is building
      // rather than by which file it is in. Splitting the argument list across
      // lines hides the `_PREFIX` from that exemption and fails the scan.
      const der = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
      const publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });

      return verifyEd25519(
        null,
        Buffer.from(message),
        publicKey,
        Buffer.from(getBase58Encoder().encode(signature)),
      );
    } catch {
      // A malformed key or signature is a failed verification, not a 500. The
      // caller asked "is this signed?", and the answer is no.
      return false;
    }
  }

  // ── Vault ────────────────────────────────────────────────────────────────

  async getVaultAccount(owner: AccountId, asset: AssetId): Promise<AccountId> {
    const { chainId, address: ownerAddress } = this.parseAccountId(owner);
    const parsedAsset = parseAssetId(asset);
    if (parsedAsset.chainId !== chainId) {
      throw ChainErrors.assetNotOnChain({ asset, chainId });
    }

    // On Solana the recipient is never the wallet — it is the associated token
    // account for that mint. Paying the wallet address is a lost transfer.
    const [ata] = await findAssociatedTokenPda({
      owner: address(ownerAddress),
      mint: address(parsedAsset.assetReference),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    return toAccountId(chainId, ata);
  }

  async getVaultBalance(owner: AccountId, asset: AssetId): Promise<Money> {
    const metadata = getAssetMetadata(asset);
    const vault = await this.getVaultAccount(owner, asset);
    const { value } = await this.rpc
      .getTokenAccountBalance(address(this.parseAccountId(vault).address))
      .send();

    if (value.decimals !== metadata.decimals) {
      throw ChainErrors.assetDecimalsMismatch({
        asset,
        expected: metadata.decimals,
        actual: value.decimals,
      });
    }

    return MoneyUtil.of(value.amount, asset, metadata.decimals);
  }

  // ── Blockhash ────────────────────────────────────────────────────────────

  /**
   * The deposit's transaction is built in the **browser** (`W2b`), so the
   * blockhash has to travel to it. It deliberately does NOT ride on
   * `PaymentRequirements`: `settleDeposit` rebuilds those a second time
   * (`deposit.service.ts:134`) and would hand the facilitator a blockhash
   * different from the one the buyer signed against.
   */
  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: bigint }> {
    const { value } = await this.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    return { blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private assertServes(chainId: ChainId): void {
    if (!this.supportedChains.includes(chainId)) {
      throw ChainErrors.namespaceMismatch({ expected: this.namespace, actual: chainId });
    }
  }

  private extractMemos(payload: PaymentPayload): string[] {
    const encoded = payload.payload?.transaction;
    if (typeof encoded !== 'string' || !BASE64_RE.test(encoded)) {
      throw ChainErrors.payloadMalformed({ reason: 'payload.transaction is not base64' });
    }

    try {
      const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(encoded));
      const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
      const decoder = new TextDecoder();

      return compiledInstructionsOf(message)
        .filter(
          (instruction) =>
            message.staticAccounts[instruction.programAddressIndex] === MEMO_PROGRAM_ADDRESS,
        )
        .map((instruction) => decoder.decode(instruction.data ?? new Uint8Array()));
    } catch (error) {
      throw ChainErrors.payloadMalformed({ reason: (error as Error).message });
    }
  }
}

/**
 * One shape for the instruction list across every transaction version.
 *
 * Legacy and v0 carry `instructions`; v1 splits the same information across
 * `instructionHeaders` and `instructionPayloads`. Reading only the first shape
 * would make a v1 transaction look like one with no memo — an accounting bug
 * dressed up as a validation failure.
 */
function compiledInstructionsOf(
  message: CompiledTransactionMessage,
): readonly { programAddressIndex: number; data?: ReadonlyUint8Array }[] {
  if (message.version === 1) {
    return message.instructionHeaders.map((header, index) => ({
      programAddressIndex: header.programAccountIndex,
      data: message.instructionPayloads[index]?.instructionData,
    }));
  }
  return message.instructions;
}
