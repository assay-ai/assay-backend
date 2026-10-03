import { Injectable } from '@nestjs/common';
import {
  decodeEventLog,
  decodeFunctionData,
  getAddress,
  hexToBytes,
  isAddress,
  keccak256,
  parseTransaction,
  stringToBytes,
  type TypedDataDomain,
} from 'viem';

import { MoneyUtil } from '@shared/utils/money.util';

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
  parseChainId,
  toAccountId,
} from '../ports/caip.types';
import { ChainAdapter } from '../ports/chain-adapter.port';
import { Money } from '../ports/money.types';
import { PayoutProofChallenge, ProofTypedData } from '../ports/payout-proof.types';
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
import { X402_ESCROW_ABI } from './abi/x402.abi';
import { evmDomain } from './eip712/domain';
import { EvmVoucher, hashVoucher } from './eip712/voucher';
import { EVM_DEPOSIT_METHOD, EvmDeployment } from './evm.constants';
import {
  hashPayoutProof,
  hashStakeAuthority,
  payoutProofTypedData,
  ProofMessage,
  stakeAuthorityTypedData,
  toProofMessage,
} from './evm-proofs';
import { recoverEvmSigner } from './secp256k1-recover';

/** x402 scheme name on eip155. Same word as SVM; the RAIL is what differs. */
export const EVM_PAYMENT_SCHEME = 'exact';
/** Robinhood Chain blocks in ~100 ms; 60 s is the same order as SVM's window. */
export const EVM_MAX_TIMEOUT_SECONDS = 60;

/** A 32-byte transaction hash, as the only reference an EVM chain answers to. */
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** Every amount and counter the `Voucher` struct carries is a `uint64`. */
const MAX_UINT64 = 2n ** 64n - 1n;

/**
 * The `Escrow` struct's field names, in the order assay-evm's `src/Types.sol` declares
 * them.
 *
 * **The names are the pin, not the types.** Nine of the twelve fields are
 * `uint64`, so swapping `seqHigh` and `authNonce` changes no selector, no
 * encoding length and no canonical form — a return-shape check written over
 * types alone accepts the swap, and a swap on this struct is a wrong number
 * under a right name on a money path. viem decodes a named tuple into a named
 * object, so requiring exactly these keys is what makes the decode readable
 * against the deployed layout rather than against a shape.
 */
export const ESCROW_FIELDS = [
  'balance',
  'seqHigh',
  'authNonce',
  'maxVoucherAmount',
  'maxPerWindow',
  'spentInWindow',
  'windowStartedAt',
  'withdrawRequested',
  'withdrawAvailableAt',
  'totalRedeemed',
  'totalWithdrawn',
  'totalFunded',
] as const;

export type EvmEscrowView = Readonly<Record<(typeof ESCROW_FIELDS)[number], bigint>>;

/**
 * The slice of a viem `PublicClient` the EVM adapter uses.
 *
 * Declared structurally rather than as viem's `PublicClient`, for the reason
 * `sanctioned-evm-rpc.ts` gives about its own return type: annotating that
 * alias makes the compiler walk viem's whole action union (`TS2589`). It also
 * lets a test supply the three calls this class makes instead of a whole RPC
 * surface, exactly as `SolanaRpcClient` does on the other side.
 */
export interface EvmReadClient {
  getTransactionReceipt(args: { hash: `0x${string}` }): Promise<EvmTransactionReceipt | null>;
  getBlock(args: { blockTag: 'finalized' }): Promise<{ readonly number: bigint | null }>;
  readContract(args: {
    address: `0x${string}`;
    abi: unknown;
    functionName: string;
    args: readonly unknown[];
  }): Promise<unknown>;
}

export interface EvmLog {
  readonly address: string;
  readonly data: `0x${string}`;
  readonly topics: readonly `0x${string}`[];
}

export interface EvmTransactionReceipt {
  readonly status: 'success' | 'reverted';
  readonly blockNumber: bigint;
  readonly logs: readonly EvmLog[];
}

/**
 * The `eip155` `ChainAdapter`.
 *
 * ## What is deliberately NOT here
 *
 * There is no per-buyer escrow account to derive and no associated token
 * account: one `X402Escrow` contract holds every buyer's USDG and splits it in
 * an `escrows[buyer]` mapping. Two consequences run through this whole file:
 *
 *  - `getVaultAccount` is the identity function. That is the *correct*
 *    implementation here, not a degenerate one — see the method for why
 *    returning the contract address instead would be the dangerous answer
 *    rather than the safe-looking one.
 *  - A plain ERC-20 `transfer` to the escrow contract **credits nobody**
 *    (`test_donationsDoNotBecomeAnybodysBalance` in assay-evm). So the
 *    contract address never appears as `payTo`; it travels in `extra.contract`, beside
 *    the name of the call that has to be made.
 */
@Injectable()
export class EvmChainAdapter implements ChainAdapter {
  readonly namespace = ChainNamespace.EIP155;

  /**
   * Gas comes from whoever sends the transaction, so there is no second party
   * to name in a `402` and nothing for this adapter to read out of
   * `BuildRequirementsInput.feePayer` — which it does not. A buyer holding no
   * native token is served by `EvmGasGrantService`, a separate path that funds
   * the buyer rather than co-signing for them. See
   * {@link ChainAdapter.requiresFeePayer}.
   */
  readonly requiresFeePayer = false;

  constructor(
    private readonly clients: ReadonlyMap<ChainId, EvmReadClient>,
    private readonly deployments: ReadonlyMap<ChainId, EvmDeployment>,
    readonly supportedChains: readonly ChainId[],
  ) {}

  // ── Identity ─────────────────────────────────────────────────────────────

  /**
   * EIP-55, strictly.
   *
   * An all-lowercase address makes no checksum claim and is accepted; a
   * MIXED-case address whose checksum does not verify is refused, because that
   * is a typo in an address and the money goes to a key nobody holds. This is
   * the property the shared conformance suite cannot demand of any chain, and
   * `evm-chain.adapter.identity.spec.ts` is where it is pinned.
   */
  isValidAddress(chainId: ChainId, address: string): boolean {
    this.assertServes(chainId);
    return typeof address === 'string' && isAddress(address, { strict: true });
  }

  toAccountId(chainId: ChainId, address: string): AccountId {
    this.assertServes(chainId);
    if (!this.isValidAddress(chainId, address)) {
      throw ChainErrors.invalidAddress({ chainId, address });
    }
    // Normalised, so one identity is one string everywhere it is a key.
    return toAccountId(chainId, getAddress(address));
  }

  /**
   * The reading door, and it applies the same EIP-55 rule the minting door
   * does.
   *
   * CAIP-10's grammar is chain-agnostic — `parseAccountId` splits on `:` and
   * checks a character class, and a mixed-case address with a broken checksum
   * satisfies it. Without the check below, `getAddress()` downstream **repairs**
   * that address into its correctly checksummed form and every method carries
   * on: measured, `getVaultAccount(<bad checksum>)` resolved to a normalised
   * vault instead of refusing. That is EIP-55 defeated at exactly the doors it
   * exists to protect — a typo'd hex digit is what the checksum catches, and
   * silently re-checksumming a value nobody verified means the money is derived
   * for an address no key controls.
   *
   * `assertServes` stays FIRST: assertion 22 asks for a chain refusal on a
   * chain this adapter does not serve, and a foreign chain's address is not
   * this adapter's business to judge.
   */
  parseAccountId(accountId: AccountId): { chainId: ChainId; address: string } {
    const parsed = parseAccountId(accountId);
    this.assertServes(parsed.chainId);
    if (!isAddress(parsed.address, { strict: true })) {
      throw ChainErrors.invalidAddress({ chainId: parsed.chainId, address: parsed.address });
    }
    return parsed;
  }

  // ── x402 ─────────────────────────────────────────────────────────────────

  /**
   * One `accepts[]` entry.
   *
   * `payTo` is the **buyer's own address**, because that is what
   * `getVaultAccount` resolves to and because the escrow contract must never be
   * rendered as a send-to target. What actually has to happen — an
   * `approve` followed by `depositFor` on a named contract — is stated in
   * `extra`, so the fact travels with the requirements instead of living in a
   * comment on the frontend.
   *
   * `payToIsTokenAccount` is meaningless here and is neither read nor
   * rejected: on EVM the owner and the balance holder are the same string, so
   * both branches of the SVM flag would compute the same address.
   */
  async buildPaymentRequirements(input: BuildRequirementsInput): Promise<PaymentRequirements> {
    this.assertServes(input.chainId);

    const asset = parseAssetId(input.amount.asset);
    if (asset.chainId !== input.chainId) {
      throw ChainErrors.assetNotOnChain({ asset: input.amount.asset, chainId: input.chainId });
    }

    const deployment = this.deploymentFor(input.chainId);
    // `payer`, never `payTo`. On this chain the tokens land in the pooled
    // escrow contract and only `depositFor` moves a buyer's balance, so the
    // account that must be named is the one being credited — see
    // `BuildRequirementsInput.payer`. Reading `payTo` here is what produced
    // `depositFor(<the escrow contract>, amount)` on the deposit path, because
    // that is exactly what `DepositService` passes as the destination.
    const buyer = getAddress(this.parseAccountId(input.payer).address);

    // A buyer cannot be the escrow itself. Unreachable through the deposit
    // path now that `payer` is a separate field, and kept because the cost of
    // being wrong here is a `depositFor` crediting an address no key controls —
    // a lost deposit, arrived at through the front door instead of a stray
    // `transfer`.
    if (buyer === getAddress(deployment.escrow)) {
      throw ChainErrors.invalidAddress({ chainId: input.chainId, address: buyer });
    }

    return {
      scheme: EVM_PAYMENT_SCHEME,
      network: input.chainId,
      amount: input.amount.amount,
      asset: asset.assetReference,
      payTo: buyer,
      resource: input.resource,
      maxTimeoutSeconds: EVM_MAX_TIMEOUT_SECONDS,
      ...(input.description ? { description: input.description } : {}),
      extra: {
        paymentFlow: 'contract-call',
        method: EVM_DEPOSIT_METHOD,
        contract: deployment.escrow,
        spender: deployment.escrow,
        buyer,
        // Stated in the payload, not only in a doc: a bare transfer to
        // `contract` is lost to the buyer and there is no contract-level
        // remedy.
        plainTransferCreditsNobody: true,
      },
    };
  }

  /**
   * Reads the binding out of the **serialized transaction**, not out of a field
   * beside it.
   *
   * Same rule as the SVM memo and for the same reason: a value the client also
   * supplies alongside the transaction proves nothing about what the client is
   * going to submit. What is checked is what the transaction *does* — the
   * contract it calls, the function, the buyer it credits and the amount — and
   * all four are inside the bytes the payer signs.
   *
   * **What this does NOT bind, stated rather than left to be discovered.**
   * `depositFor(address,uint64)` has no free field, so there is nowhere for an
   * intent id to go: two intents for the same buyer and the same amount are
   * both satisfied by one transaction. On SVM the memo closes that; on EVM the
   * closing move is the x402 `authorization.nonce` of an EIP-3009 transfer, and
   * USDG implements neither 3009 nor 2612 (measured). Rail A is off on
   * `eip155:46630` (`chain-metadata.ts` lists `rails: ['B']`), so this method
   * has no production caller today — the gap is left open rather than
   * closed with a signing surface nothing produces.
   */
  assertPayloadBoundToIntent(payload: PaymentPayload, intent: PaymentIntent): void {
    this.assertServes(payload.network);
    if (payload.network !== intent.chainId) {
      throw ChainErrors.payloadNotBoundToIntent({
        intentId: intent.id,
        reason: `payload is for ${payload.network}, intent is on ${intent.chainId}`,
      });
    }

    const transaction = this.parseSerializedTransaction(payload);
    const deployment = this.deploymentFor(payload.network);
    // The CAIP-2 reference IS the EIP-155 chain id, and it is inside the bytes
    // the payer signed — so a transaction built for another EVM chain cannot be
    // replayed onto this intent even though the same key controls the same
    // address everywhere.
    const expectedChain = Number(parseChainId(payload.network).reference);

    if (transaction.chainId !== expectedChain) {
      throw ChainErrors.payloadNotBoundToIntent({
        intentId: intent.id,
        reason: `transaction names chain ${transaction.chainId}`,
      });
    }
    if (!transaction.to || getAddress(transaction.to) !== getAddress(deployment.escrow)) {
      throw ChainErrors.payloadNotBoundToIntent({
        intentId: intent.id,
        reason: 'transaction does not call this chain’s escrow',
      });
    }

    const call = this.decodeEscrowCall(transaction.data);
    if (call.functionName !== 'depositFor') {
      throw ChainErrors.payloadNotBoundToIntent({
        intentId: intent.id,
        reason: `transaction calls ${call.functionName}, not depositFor`,
      });
    }

    const [buyer, amount] = call.args as readonly [string, bigint];
    // `payer`, never `payTo` — the same split `buildPaymentRequirements` makes.
    // `payTo` is the pooled escrow here, so comparing against it refused every
    // real deposit and would have ACCEPTED `depositFor(<the escrow>, amount)`.
    const expectedBuyer = getAddress(this.parseAccountId(intent.payer).address);
    if (getAddress(buyer) !== expectedBuyer) {
      throw ChainErrors.payloadNotBoundToIntent({
        intentId: intent.id,
        reason: 'transaction credits a different buyer',
      });
    }
    // At least, not exactly: the `exact` scheme tolerates overpayment on both
    // chains, and `extractSettledAmount` credits whatever actually landed.
    if (amount < MoneyUtil.toAtomic(intent.amount)) {
      throw ChainErrors.payloadNotBoundToIntent({
        intentId: intent.id,
        reason: 'transaction deposits less than the intent requires',
      });
    }
  }

  /**
   * The observed amount, refusing a foreign chain, a foreign receipt, a
   * different asset, or an underpayment.
   *
   * The x402 `exact` scheme tolerates overpayment on SVM. On EVM the escrow
   * credits exactly what `depositFor` was given, so the two comparisons below
   * behave the same and the SAME guard applies for the same reason — the two
   * chains grow it in one change with one error code rather than two dialects.
   *
   * The asset comparison cannot stand in for the network one here in
   * particular: the same ERC-20 address is deployable on every EVM chain, so
   * two chains can register assets whose CAIP-19 references are byte-identical
   * and only the chain part differs.
   */
  extractSettledAmount(intent: PaymentIntent, receipt: SettlementReceipt): Money {
    this.assertServes(intent.chainId);

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
   * `Deposited(buyer, funder, amount, balance)` — the credit the CONTRACT
   * wrote, not a balance difference computed here.
   *
   * The Solana adapter reads `pre/postTokenBalances` for the same reason: the
   * ledger's own answer beats a decoded instruction, which says what was
   * *requested*. Here the event carries both the delta (`amount`) and the new
   * total (`balance`), and only the first is the transfer — which is why the
   * fixture's two numbers differ.
   *
   * `buyer` and `funder` are both `address` and adjacent. Reading them by
   * position rather than by name would let a swap of the two go unnoticed by
   * every type in this file; `decodeEventLog` returns a named object and this
   * method reads `args.buyer` by name.
   */
  async observeTransfer(
    intent: PaymentIntent,
    transaction: TxRef,
    options?: { readonly commitment?: 'confirmed' | 'finalized' },
  ): Promise<ObservedTransfer | null> {
    this.assertServes(intent.chainId);
    const client = this.clientFor(intent.chainId);
    const deployment = this.deploymentFor(intent.chainId);
    // `payer`, for the reason `assertPayloadBoundToIntent` gives: the event's
    // `buyer` is the account credited, and `payTo` is the pooled contract.
    const buyer = getAddress(this.parseAccountId(intent.payer).address);

    if (!TX_HASH_RE.test(transaction)) {
      return null;
    }

    const receipt = await client
      .getTransactionReceipt({ hash: transaction as `0x${string}` })
      .catch(() => null);

    // Not found, not mined yet, or dropped by a reorg all look identical from
    // here, and a reverted transaction moved nothing. The caller's state
    // machine decides what "nothing observed" means — never a throw.
    if (!receipt || receipt.status !== 'success') {
      return null;
    }
    if (options?.commitment === 'finalized') {
      const finalized = await client.getBlock({ blockTag: 'finalized' }).catch(() => null);
      if (!finalized || finalized.number === null || finalized.number < receipt.blockNumber) {
        return null;
      }
    }

    for (const log of receipt.logs) {
      if (getAddress(log.address) !== getAddress(deployment.escrow)) {
        continue;
      }
      const event = this.decodeEscrowEvent(log);
      if (!event || event.eventName !== 'Deposited') {
        continue;
      }
      const args = event.args as { buyer?: unknown; amount?: unknown };
      if (typeof args.buyer !== 'string' || typeof args.amount !== 'bigint') {
        throw ChainErrors.rpcReplyMalformed({
          method: 'eth_getTransactionReceipt',
          expected: 'a Deposited event with a buyer and an amount',
        });
      }
      if (getAddress(args.buyer) !== buyer) {
        continue;
      }
      return {
        amount: args.amount.toString(),
        asset: intent.amount.asset,
        decimals: getAssetMetadata(intent.amount.asset).decimals,
      };
    }

    // Found, mined, succeeded — and credited somebody else, or nobody. Not a
    // parse failure and not an error: it is the same "this transaction moved
    // you nothing" the not-found case reports, and the caller's state machine
    // is what decides whether that is a problem.
    return null;
  }

  // ── Vouchers (rail B) ────────────────────────────────────────────────────

  /**
   * The 32-byte EIP-712 digest, as bytes.
   *
   * The port's contract is "canonical bytes an agent signs", and on EVM that is
   * the digest a wallet's `signTypedData` produces internally — not a
   * hand-rolled preimage. Returning the digest means the domain never sees the
   * `0x1901` framing, and a wallet handed the same typed data arrives at the
   * same 32 bytes.
   *
   * ## `payTo` is not in the struct, and is not ignored either
   *
   * On EVM one escrow contract serves every buyer, so "which escrow" is fully
   * determined by `verifyingContract` plus `payer`, and a second field naming
   * it would be a second source for one identity. The port's `payTo` must
   * still equal the escrow's CAIP-10.
   *
   * **A throw is the wrong shape for that assertion and this file does
   * something stronger instead.** `payTo` is what supplies
   * `verifyingContract`. So a voucher naming a different escrow is not
   * *detected* — it is signed under a domain no deployed contract will ever
   * accept, which is a property of the bytes rather than of a check somebody
   * could forget to run. `verifyVoucherSignature` additionally refuses any
   * `payTo` that is not this deployment's escrow, so the platform never holds
   * money against one. (It refuses rather than throws because every field of
   * the voucher must be mutable into a `false`, and a throw from `build` would
   * also make "different bytes when any single field is mutated" unsatisfiable
   * for this one field.)
   *
   * Where the hard assertion belongs is the redeemer, which is the only place a
   * wrong `payTo` can cost money; that is the task that builds the on-chain
   * call.
   */
  buildVoucherMessage(voucher: Voucher): Uint8Array {
    const { chainId } = this.parseAccountId(voucher.payer);
    return hexToBytes(hashVoucher(...this.voucherTypedDataArgs(voucher, chainId)));
  }

  /**
   * keccak256 of the resource string, as bare hex — the value
   * `voucherTypedDataArgs` puts in the struct. Bare rather than `sha256:`-
   * prefixed because it is not a sha256; `EvmVoucherRedeemer` takes either.
   */
  voucherResourceHash(resource: string): string {
    return keccak256(stringToBytes(resource)).slice(2);
  }

  verifyVoucherSignature(voucher: Voucher, signature: string, signer: AccountId): boolean {
    const { chainId, address } = this.parseAccountId(signer);
    let digest: `0x${string}`;
    try {
      // The payer's escrow is the verifying contract, so a voucher whose payer
      // is on another chain cannot be checked against this signer at all — and
      // a `payTo` that is not this deployment's escrow is refused outright
      // rather than merely producing a digest nothing will honour.
      if (parseAccountId(voucher.payer).chainId !== chainId) {
        return false;
      }
      const escrow = getAddress(this.deploymentFor(chainId).escrow);
      if (getAddress(parseAccountId(voucher.payTo).address) !== escrow) {
        return false;
      }
      digest = hashVoucher(...this.voucherTypedDataArgs(voucher, chainId));
    } catch {
      // A voucher this adapter cannot even encode is not a voucher this signer
      // signed. The caller asked a yes/no question.
      return false;
    }
    return recoverEvmSigner(digest, signature) === getAddress(address);
  }

  // ── Payout proof ─────────────────────────────────────────────────────────

  buildPayoutProofMessage(challenge: PayoutProofChallenge): Uint8Array {
    const { chainId, address } = this.parseAccountId(challenge.account);
    const domain = evmDomain(chainId, getAddress(this.deploymentFor(chainId).escrow));
    return hexToBytes(hashPayoutProof(toProofMessage(challenge, getAddress(address)), domain));
  }

  payoutProofTypedData(challenge: PayoutProofChallenge): ProofTypedData {
    const { chainId, address } = this.parseAccountId(challenge.account);
    return toProofTypedData(
      payoutProofTypedData(
        toProofMessage(challenge, getAddress(address)),
        evmDomain(chainId, getAddress(this.deploymentFor(chainId).escrow)),
      ),
    );
  }

  verifyPayoutProofSignature(
    challenge: PayoutProofChallenge,
    signature: string,
    signer: AccountId,
  ): boolean {
    const { chainId, address } = this.parseAccountId(signer);
    let digest: `0x${string}`;
    try {
      if (parseAccountId(challenge.account).chainId !== chainId) {
        return false;
      }
      digest = hashPayoutProof(
        toProofMessage(challenge, getAddress(parseAccountId(challenge.account).address)),
        evmDomain(chainId, getAddress(this.deploymentFor(chainId).escrow)),
      );
    } catch {
      return false;
    }
    return recoverEvmSigner(digest, signature) === getAddress(address);
  }

  // ── Stake authority proof ────────────────────────────────────────────────

  buildStakeAuthorityMessage(challenge: StakeAuthorityChallenge): Uint8Array {
    const { chainId, address } = this.parseAccountId(challenge.account);
    // The STAKE contract, not the escrow: the two share a domain name and
    // version, and `verifyingContract` is the only thing separating them.
    const domain = evmDomain(chainId, getAddress(this.deploymentFor(chainId).stake));
    return hexToBytes(hashStakeAuthority(toProofMessage(challenge, getAddress(address)), domain));
  }

  stakeAuthorityTypedData(challenge: StakeAuthorityChallenge): ProofTypedData {
    const { chainId, address } = this.parseAccountId(challenge.account);
    return toProofTypedData(
      stakeAuthorityTypedData(
        toProofMessage(challenge, getAddress(address)),
        evmDomain(chainId, getAddress(this.deploymentFor(chainId).stake)),
      ),
    );
  }

  verifyStakeAuthoritySignature(
    challenge: StakeAuthorityChallenge,
    signature: string,
    signer: AccountId,
  ): boolean {
    const { chainId, address } = this.parseAccountId(signer);
    let digest: `0x${string}`;
    try {
      if (parseAccountId(challenge.account).chainId !== chainId) {
        return false;
      }
      digest = hashStakeAuthority(
        toProofMessage(challenge, getAddress(parseAccountId(challenge.account).address)),
        evmDomain(chainId, getAddress(this.deploymentFor(chainId).stake)),
      );
    } catch {
      return false;
    }
    return recoverEvmSigner(digest, signature) === getAddress(address);
  }

  /**
   * The port's `Voucher` as the eight fields assay-evm's `src/Types.sol` declares, plus
   * the domain they are hashed under.
   *
   * Returned as a pair so that `build` and `verify` cannot drift: there is one
   * conversion, and both halves of the pair call it.
   */
  private voucherTypedDataArgs(
    voucher: Voucher,
    chainId: ChainId,
  ): [EvmVoucher, ReturnType<typeof evmDomain>] {
    const payer = getAddress(this.parseAccountId(voucher.payer).address);
    const payTo = this.parseAccountId(voucher.payTo);
    if (payTo.chainId !== chainId) {
      throw ChainErrors.payloadMalformed({
        reason: 'voucher.payTo is not on the payer’s chain',
      });
    }
    const provider = parseAccountId(voucher.provider);
    if (!isAddress(provider.address, { strict: true })) {
      throw ChainErrors.invalidAddress({ chainId: provider.chainId, address: provider.address });
    }

    const amount = MoneyUtil.toAtomic(voucher.amount);
    const seq = BigInt(voucher.seq);
    const issuedAt = BigInt(voucher.issuedAt);
    const expiresAt = BigInt(voucher.expiresAt);
    for (const [name, value] of [
      ['amount', amount],
      ['seq', seq],
      ['issuedAt', issuedAt],
      ['expiresAt', expiresAt],
    ] as const) {
      if (value < 0n || value > MAX_UINT64) {
        throw ChainErrors.payloadMalformed({ reason: `voucher.${name} does not fit uint64` });
      }
    }

    return [
      {
        payer,
        provider: getAddress(provider.address),
        amount,
        // keccak, not sha256: "the hash function is per-chain and that
        // is fine — it never crosses chains". `stringToBytes` rather than
        // `toBytes`, which would hex-DECODE a resource that happened to start
        // with `0x` and hash something other than the string.
        resourceHash: keccak256(stringToBytes(voucher.resource)),
        requestHash: this.toBytes32(voucher.requestHash),
        seq,
        issuedAt,
        expiresAt,
      },
      // `payTo` IS the verifying contract. See `buildVoucherMessage`.
      evmDomain(chainId, getAddress(payTo.address)),
    ];
  }

  /**
   * The port's `requestHash` is `sha256:<64 hex>` or bare hex; the struct wants
   * 32 bytes.
   *
   * The voucher layout calls this field `keccak256(canonical request)` on EVM, and what
   * actually arrives is the platform's own `computeRequestHash` output, which
   * is sha256. That is not a defect: the contract never recomputes it — it is
   * an opaque anti-replay binding, compared only against what the backend
   * stored — so the 32 bytes are carried through unchanged rather than
   * re-hashed under a second function, which would make the value the buyer
   * signed and the value the platform recorded two different things.
   */
  private toBytes32(value: string): `0x${string}` {
    const hex = value.replace(/^sha256:/, '').replace(/^0x/, '');
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw ChainErrors.payloadMalformed({ reason: 'requestHash is not 32 bytes of hex' });
    }
    return `0x${hex.toLowerCase()}` as `0x${string}`;
  }

  // ── Vault ────────────────────────────────────────────────────────────────

  /**
   * The owner itself. **This is not the degenerate identity function.**
   *
   * `getVaultAccount = (owner) => owner` is an implementation the shared
   * contract cannot refuse, and rightly so — on an account-model chain it is
   * the correct answer, which is what makes it unrefusable in the general case.
   * ATAs vanish on EVM: there is one token contract and one balance mapping.
   *
   * The alternative — returning the pooled `X402Escrow` address — looks like
   * the careful answer and is the dangerous one. It would make every owner
   * share one vault account (so `getVaultBalance` could not be keyed on the
   * owner at all), and it would put the contract address in
   * `PaymentRequirements.payTo`, where a frontend renders it as a deposit
   * target. A plain transfer there credits nobody and is unrecoverable. The
   * contract is named in `extra.contract`, which is a field no wallet
   * treats as an address to send to.
   *
   * The address is normalised on the way out, so one buyer is one string.
   */
  async getVaultAccount(owner: AccountId, asset: AssetId): Promise<AccountId> {
    const { chainId, address } = this.parseAccountId(owner);
    this.assertAssetOnChain(asset, chainId);
    return toAccountId(chainId, getAddress(address));
  }

  /**
   * `escrowOf(owner).balance` — the buyer's slice of the pooled contract.
   *
   * Not `IERC20.balanceOf(owner)`: that is the buyer's *wallet*, which the
   * platform neither holds nor can spend. The balance this port is asked about
   * is the one a voucher draws on.
   */
  async getVaultBalance(owner: AccountId, asset: AssetId): Promise<Money> {
    const { chainId, address } = this.parseAccountId(owner);
    this.assertAssetOnChain(asset, chainId);
    const deployment = this.deploymentFor(chainId);
    this.assertSettlementAsset(asset, deployment);

    const escrow = decodeEscrowView(
      await this.clientFor(chainId).readContract({
        address: getAddress(deployment.escrow),
        abi: X402_ESCROW_ABI,
        functionName: 'escrowOf',
        args: [getAddress(address)],
      }),
    );

    return MoneyUtil.of(escrow.balance.toString(), asset, getAssetMetadata(asset).decimals);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Namespace FIRST so a Solana chain id is refused as a namespace mismatch
   * rather than as an unknown eip155 network, and membership SECOND so a guard
   * written as namespace equality cannot pass — the
   * fail-open that let a devnet deployment reconcile mainnet forever.
   */
  private assertServes(chainId: ChainId): void {
    if (namespaceOf(chainId) !== this.namespace) {
      throw ChainErrors.namespaceMismatch({ expected: this.namespace, actual: chainId });
    }
    if (!this.supportedChains.includes(chainId)) {
      throw ChainErrors.namespaceMismatch({ expected: this.namespace, actual: chainId });
    }
  }

  private assertAssetOnChain(asset: AssetId, chainId: ChainId): void {
    this.assertServes(chainId);
    if (parseAssetId(asset).chainId !== chainId) {
      throw ChainErrors.assetNotOnChain({ asset, chainId });
    }
  }

  /**
   * `Config` fixes exactly one settlement token per deployment, so a balance
   * read for any other asset would answer with the wrong token's number rather
   * than with nothing.
   */
  private assertSettlementAsset(asset: AssetId, deployment: EvmDeployment): void {
    const reference = parseAssetId(asset).assetReference;
    if (!isAddress(reference) || getAddress(reference) !== getAddress(deployment.asset)) {
      throw ChainErrors.assetNotOnChain({ asset, chainId: deployment.chainId });
    }
  }

  private deploymentFor(chainId: ChainId): EvmDeployment {
    const deployment = this.deployments.get(chainId);
    if (!deployment) {
      throw ChainErrors.programNotConfigured({
        what: `the X402Escrow deployment on ${chainId}`,
        variable: 'EVM_DEPLOYMENTS',
      });
    }
    return deployment;
  }

  private clientFor(chainId: ChainId): EvmReadClient {
    const client = this.clients.get(chainId);
    if (!client) {
      throw ChainErrors.programNotConfigured({
        what: `a JSON-RPC client for ${chainId}`,
        variable: 'EVM_RPC_URLS',
      });
    }
    return client;
  }

  private parseSerializedTransaction(payload: PaymentPayload): {
    chainId?: number;
    to?: string | null;
    data?: `0x${string}`;
  } {
    const serialized = payload.payload?.transaction;
    if (typeof serialized !== 'string' || !/^0x[0-9a-fA-F]+$/.test(serialized)) {
      throw ChainErrors.payloadMalformed({
        reason: 'payload.transaction is not a 0x-prefixed serialized transaction',
      });
    }
    try {
      return parseTransaction(serialized as `0x${string}`);
    } catch (error) {
      throw ChainErrors.payloadMalformed({ reason: (error as Error).name });
    }
  }

  private decodeEscrowCall(data: `0x${string}` | undefined): {
    functionName: string;
    args: readonly unknown[];
  } {
    if (!data || data === '0x') {
      throw ChainErrors.payloadMalformed({ reason: 'transaction carries no calldata' });
    }
    try {
      const decoded = decodeFunctionData({ abi: X402_ESCROW_ABI, data });
      return {
        functionName: decoded.functionName,
        args: (decoded.args ?? []) as readonly unknown[],
      };
    } catch (error) {
      throw ChainErrors.payloadMalformed({ reason: (error as Error).name });
    }
  }

  private decodeEscrowEvent(log: EvmLog): { eventName: string; args: unknown } | null {
    try {
      return decodeEventLog({
        abi: X402_ESCROW_ABI,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      }) as unknown as { eventName: string; args: unknown };
    } catch {
      // A log this contract emitted that is not in the vendored ABI — a
      // deliberate partial vendor, not a fault.
      return null;
    }
  }
}

/**
 * Turns viem's decoded struct into an object this file will read by name.
 *
 * The check is on the **names**, and it is exact in both directions: a missing
 * field is a layout the deployed bytecode does not have, and an extra one is a
 * layout this decoder has not been taught. Twelve fields, nine of them
 * `uint64`, is precisely the shape where a type-only check sees nothing.
 */
export function decodeEscrowView(value: unknown): EvmEscrowView {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw ChainErrors.accountLayoutUnexpected({
      account: 'X402Escrow.escrowOf',
      expected: 'a named struct',
      actual: Array.isArray(value) ? 'a positional tuple' : typeof value,
    });
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...ESCROW_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw ChainErrors.accountLayoutUnexpected({
      account: 'X402Escrow.escrowOf',
      expected: expected.join(','),
      actual: keys.join(','),
    });
  }
  const record = value as Record<string, unknown>;
  for (const field of ESCROW_FIELDS) {
    if (typeof record[field] !== 'bigint') {
      throw ChainErrors.accountLayoutUnexpected({
        account: 'X402Escrow.escrowOf',
        expected: `${field} as a bigint`,
        actual: typeof record[field],
      });
    }
  }
  return record as unknown as EvmEscrowView;
}

/**
 * A proof's typed data as it crosses the wire: `domain.chainId` and every
 * integer in `message` as a decimal string. The verifier hashes the SAME
 * structure with `bigint`s, and `eth_signTypedData_v4` encodes a decimal
 * string declared `uint64` to the same bytes — which is what
 * `evm-proof-typed-data.spec.ts` proves with a real wallet signature.
 */
function toProofTypedData(typed: {
  domain: TypedDataDomain;
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: ProofMessage;
}): ProofTypedData {
  return {
    domain: {
      name: String(typed.domain.name),
      version: String(typed.domain.version),
      chainId: String(typed.domain.chainId),
      verifyingContract: String(typed.domain.verifyingContract),
    },
    types: typed.types,
    primaryType: typed.primaryType,
    message: {
      account: typed.message.account,
      organizationId: typed.message.organizationId,
      nonce: typed.message.nonce,
      expiresAt: typed.message.expiresAt.toString(),
    },
  };
}
