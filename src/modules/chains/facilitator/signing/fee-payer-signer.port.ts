import { Address } from '@solana/kit';

/** What `KoraFeePayerSigner` / `LocalKeypairFeePayerSigner` returns after broadcasting. */
export interface FeePayerSignResult {
  /** Base58 transaction signature — also `SettleResponseBody.transaction`. */
  readonly signature: string;
  readonly signedTransaction: string;
}

/**
 * The fee payer, behind a port — the seam between the x402 wrapper (ours) and
 * Kora (off-the-shelf).
 * `KoraFeePayerSigner` is the production implementation; `LocalKeypairFeePayerSigner`
 * exists so the facilitator is runnable and testable without a Kora node — see
 * its own file for why it refuses to be the production path.
 */
export interface FeePayerSignerPort {
  readonly name: string;

  /**
   * The account every `/supported` response and every rule-1 check compares
   * against. Not assumed static: a KMS-backed signer can rotate keys, so this
   * is a call, not a constant.
   */
  getFeePayerAddress(): Promise<Address>;

  /**
   * Signs `rawTransactionBase64` as fee payer and submits it. Every check this
   * module runs happens *before* this is called — by the time it is, the
   * facilitator has already decided the transaction is one it is willing to pay
   * for.
   */
  signAndSend(rawTransactionBase64: string): Promise<FeePayerSignResult>;
}

/** DI token for the fee-payer signer the facilitator process resolves to. */
export const FEE_PAYER_SIGNER = 'FEE_PAYER_SIGNER';
