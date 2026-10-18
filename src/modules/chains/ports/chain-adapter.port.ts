import { DelegateBindingChallenge, DelegateBindingTypedData } from './delegate-binding.types';
import { VoucherAuthorityAnswer } from './voucher-authority.types';
import { AccountId, AssetId, ChainId, ChainNamespace } from './caip.types';
import { Money } from './money.types';
import { PayoutProofChallenge, ProofTypedData } from './payout-proof.types';
import { StakeAuthorityChallenge } from './stake-authority.types';
import {
  BuildRequirementsInput,
  ObservedTransfer,
  PaymentIntent,
  PaymentPayload,
  PaymentRequirements,
  SettlementReceipt,
  TxRef,
  Voucher,
} from './x402.types';

/**
 * Everything that differs between chain namespaces, and nothing that does not.
 *
 * One implementation per CAIP-2 namespace. Adding a namespace must produce
 * zero changes under `src/modules/` outside `chains/` — if it does not, the
 * abstraction leaked, and the leak is the finding worth writing down.
 */
export interface ChainAdapter {
  readonly namespace: ChainNamespace;
  readonly supportedChains: readonly ChainId[];

  /**
   * This chain separates the **payer** from the **fee payer**, so a `402` on it
   * must advertise the account that will pay the gas
   * ({@link BuildRequirementsInput.feePayer}).
   *
   * `true` on Solana, where a transaction names a fee payer in its own right
   * and the client must leave that signature slot empty for the facilitator to
   * occupy. `false` on EVM, where gas comes from whoever sends the transaction
   * and there is no second party to name — a buyer with no native token is
   * served by the separate gas-grant path, not by a co-signature.
   *
   * Declared here rather than inferred by the caller because the alternative is
   * a namespace branch in a chain-neutral service. `DepositService` used to
   * fetch a fee payer for every chain unconditionally, and on `eip155:46630`
   * that answered — measured, on the running API, with the deposit asset and
   * the escrow opener already fixed:
   *
   * ```text
   * 502 CHAIN_FACILITATOR_UNAVAILABLE
   * "Facilitator could not be reached for eip155:46630:
   *  facilitator advertises no fee payer for this network"
   * ```
   *
   * — a 502 blaming an upstream for not having a concept the chain does not
   * have. The read is skipped where this is `false`, which is also one fewer
   * HTTP round trip on the EVM deposit path.
   */
  readonly requiresFeePayer: boolean;

  // ── Identity ─────────────────────────────────────────────────────────────

  isValidAddress(chainId: ChainId, address: string): boolean;
  toAccountId(chainId: ChainId, address: string): AccountId;
  parseAccountId(accountId: AccountId): { chainId: ChainId; address: string };

  // ── x402 ─────────────────────────────────────────────────────────────────

  /**
   * Build one `accepts[]` entry for this chain.
   *
   * Asynchronous because the receiving account is not always the address we
   * were given: on SVM it is a program-derived associated token account.
   */
  buildPaymentRequirements(input: BuildRequirementsInput): Promise<PaymentRequirements>;

  /**
   * Assert the client's payload is bound to this intent and matches what we
   * advertised. SVM checks the transaction's memo; EVM checks
   * `authorization.nonce`. Throws when binding fails — never returns a boolean
   * that a caller can forget to read.
   */
  assertPayloadBoundToIntent(payload: PaymentPayload, intent: PaymentIntent): void;

  /**
   * The amount actually transferred, which is not always `intent.amount` — the
   * SVM `exact` scheme tolerates overpayment. Crediting the intent amount
   * instead of the observed one silently loses the difference.
   *
   * Takes the intent rather than the payload because underpayment has to be
   * rejected here or nowhere: the payload does not say what was required.
   */
  extractSettledAmount(intent: PaymentIntent, receipt: SettlementReceipt): Money;

  /**
   * Reads the confirmed transaction back from the chain and reports what it
   * actually moved into `intent.payTo`'s vault account, for `intent.amount`'s
   * asset — or, on a chain where tokens land in a pooled contract (EVM), what
   * that contract credited to `intent.payer`.
   *
   * The facilitator's `/settle` response (`SettleResponseBody`) carries no
   * amount — only a transaction reference. This is the only source of truth
   * for "what landed", which `extractSettledAmount` then compares against
   * what was required. `commitment` defaults to the chain's fastest durable
   * read; a caller re-checking for finality (the deposit `DEPOSIT_PENDING` to
   * `DEPOSIT_CONFIRM` promotion) asks for a stronger one explicitly.
   *
   * Returns `null` — not a throw — when the transaction cannot be found at
   * the requested commitment. That is not always an error: asking for
   * `finalized` moments after a `confirmed` settle can legitimately miss, and
   * asking for `finalized` after a reorg dropped the transaction is exactly
   * the signal the deposit finality sweep needs to write `DEPOSIT_REJECT`. A
   * transaction that *is* found but whose contents cannot be parsed is a
   * different failure and still throws.
   */
  observeTransfer(
    intent: PaymentIntent,
    transaction: TxRef,
    options?: { readonly commitment?: 'confirmed' | 'finalized' },
  ): Promise<ObservedTransfer | null>;

  // ── Vouchers (rail B) ────────────────────────────────────────────────────

  /** Canonical bytes an agent signs. Identical semantics across chains. */
  buildVoucherMessage(voucher: Voucher): Uint8Array;
  verifyVoucherSignature(voucher: Voucher, signature: string, signer: AccountId): boolean;
  /**
   * Who authorised this voucher, by the CHAIN's full rule — the payer's key
   * or a delegate the payer authorised on chain — read from chain state and
   * failing closed. See `voucher-authority.types.ts`.
   *
   * Optional: a chain with no delegation (Solana) has only the payer's key, and
   * {@link verifyVoucherSignature} already answers that. The payment domain
   * asks this only after the payer's own key did not verify.
   */
  authorizeVoucherSigner?(
    voucher: Voucher,
    signature: string,
    nowSeconds: number,
  ): Promise<VoucherAuthorityAnswer>;
  /**
   * `resource`'s hash exactly as this chain's voucher signs it, in the form
   * this chain's redeemer takes back.
   *
   * Stored on the intent at redemption time and replayed into
   * `redeem_voucher` minutes later, where nothing recomputes it — so it must
   * be the SIGNED bytes. The digest is per chain (sha256 on Solana, keccak256
   * on eip155), which is why the payment domain asks rather than hashes.
   */
  voucherResourceHash(resource: string): string;

  // ── Payout proof ─────────────────────────────────────────────────────────

  /**
   * Canonical bytes an agent signs to prove control of a wallet named as a
   * provider's payout address. Not a reuse of the voucher pair: a generic
   * `verifyMessageSignature(bytes, …)` would let the domain verify a signature
   * over bytes *it* assembled, and this is the one signature request the
   * console must be able to promise can never also authorise a payment. The
   * adapter deciding what was signed is what makes that promise checkable
   * rather than merely intended.
   */
  buildPayoutProofMessage(challenge: PayoutProofChallenge): Uint8Array;
  /**
   * The same challenge as the EIP-712 request a wallet signs, or `null` where
   * the proof is a plain message whose bytes {@link buildPayoutProofMessage}
   * already are (Solana). See `ProofTypedData`.
   */
  payoutProofTypedData(challenge: PayoutProofChallenge): ProofTypedData | null;
  verifyPayoutProofSignature(
    challenge: PayoutProofChallenge,
    signature: string,
    signer: AccountId,
  ): boolean;

  // ── Stake authority proof ────────────────────────────────────────────────

  /**
   * Canonical bytes a provider signs to prove control of the wallet that
   * opened their on-chain stake account. A fourth pair, sitting beside the
   * payout-proof one rather than reusing it, because these two are the pair
   * most easily confused: both prove key control, and the fields they cover
   * are the same. What differs is what the proved key is trusted with — a
   * payout proof names where *the signer's own* earnings go, while this one
   * attaches collateral that a router gate reads and a slash attestation
   * points at. Reusing the payout pair would mean a proof collected for the
   * harmless claim could satisfy the dangerous one, and the loss would land
   * on whoever actually owns the stake account.
   *
   * As with the other three pairs, there is no generic
   * `verifyMessageSignature(bytes, …)`: the adapter decides what the signed
   * bytes are, so the domain cannot verify a signature over a message it
   * assembled itself with a field left out.
   */
  buildStakeAuthorityMessage(challenge: StakeAuthorityChallenge): Uint8Array;
  /** {@link payoutProofTypedData}'s twin, for the stake authority proof. */
  stakeAuthorityTypedData(challenge: StakeAuthorityChallenge): ProofTypedData | null;
  verifyStakeAuthoritySignature(
    challenge: StakeAuthorityChallenge,
    signature: string,
    signer: AccountId,
  ): boolean;

  /**
   * A voucher as the EIP-712 request a WALLET signs, on chains where the
   * voucher IS typed data (eip155): what a console hands the payer's wallet to
   * settle a buyer debt with a replacement voucher. The digest it signs is
   * `buildVoucherMessage`'s. Optional: absent on chains without one.
   */
  voucherTypedData?(voucher: Voucher): ProofTypedData;

  // ── Delegate binding proof (agent payment delegation) ────────────────────

  /**
   * The challenge an agent signs WITH ITS DELEGATE KEY to bind that key to its
   * credential, as an EIP-712 request. Optional: only a chain whose escrow has
   * voucher delegation (eip155) has anything to bind.
   */
  delegateBindingTypedData?(challenge: DelegateBindingChallenge): DelegateBindingTypedData;
  /** Did the challenge's own `delegate` sign it? */
  verifyDelegateBindingSignature?(challenge: DelegateBindingChallenge, signature: string): boolean;

  // ── Vault ────────────────────────────────────────────────────────────────

  /** The account that actually holds `asset` for `owner` (an ATA on SVM). */
  getVaultAccount(owner: AccountId, asset: AssetId): Promise<AccountId>;
  getVaultBalance(owner: AccountId, asset: AssetId): Promise<Money>;
}

/** DI token for the array of adapters the registry is built from. */
export const CHAIN_ADAPTERS = 'CHAIN_ADAPTERS';
