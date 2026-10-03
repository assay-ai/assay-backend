import { ChainId } from '../ports/caip.types';
import { PaymentPayload, PaymentRequirements } from '../ports/x402.types';

/**
 * The x402 v2 facilitator wire contract — `/verify`, `/settle`, `/supported`.
 *
 * This file is the seam between the two halves of the self-hosted facilitator.
 * The **server** half
 * (`facilitator.controller.ts`, our self-hosted Kora wrapper) must produce
 * exactly these shapes; the **client** half (`http-facilitator.adapter.ts`,
 * which the payments domain reaches through `FacilitatorPort`) parses exactly
 * these shapes. Neither imports the other — both import this.
 *
 * The shapes are the specification's, not ours: a third-party facilitator must
 * be droppable in front of the same client, and a standard x402 client must be
 * able to talk to our facilitator. Where the x402 specification is silent (the error body of
 * a 4xx) we return the platform `ErrorResponse` like every other endpoint, so
 * `AllExceptionsFilter` stays the only serialiser.
 *
 * Reference:
 * https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md
 */

/** The protocol version this facilitator speaks. There is no other. */
export const X402_VERSION = 2;

/** Request body of `POST /verify` and `POST /settle` — identical for both. */
export interface FacilitatorRequestBody {
  readonly x402Version: number;
  readonly paymentPayload: PaymentPayload;
  readonly paymentRequirements: PaymentRequirements;
}

/**
 * Response body of `POST /verify`.
 *
 * `isValid: false` is a **200**, not a 4xx: "this payload does not pay for this
 * resource" is a successful answer to the question asked. Only a malformed
 * request — one that does not describe a payment at all — is a 4xx.
 */
export interface VerifyResponseBody {
  readonly isValid: boolean;
  /** One of `X402_INVALID_REASON`, absent when `isValid`. */
  readonly invalidReason?: string;
  /** Bare chain address of the payer, when it could be determined. */
  readonly payer?: string;
}

/** Response body of `POST /settle`. */
export interface SettleResponseBody {
  readonly success: boolean;
  readonly errorReason?: string;
  /** CAIP-2. Echoed so a client holding several settlements can tell them apart. */
  readonly network: ChainId;
  /** Transaction signature on SVM, transaction hash on EVM. Absent on failure. */
  readonly transaction?: string;
  readonly payer?: string;
}

/** One entry of `GET /supported`. */
export interface SupportedKind {
  readonly x402Version: number;
  readonly scheme: string;
  readonly network: ChainId;
  /**
   * Everything a client needs before it can build a payload for this kind. On
   * SVM that is the fee payer — the client must leave that account slot free
   * and unsigned, and it cannot know which account to leave free otherwise.
   */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** Response body of `GET /supported`. */
export interface SupportedResponseBody {
  readonly kinds: readonly SupportedKind[];
}

/**
 * The `invalidReason` vocabulary.
 *
 * These strings are the protocol's, and they are what the error mapping
 * translates into `PAYMENT_*` codes. Inventing a reason here breaks that table
 * silently — the mapper falls through to a generic failure and the caller loses
 * the retry advice that made the distinction worth drawing.
 */
export const X402_INVALID_REASON = {
  INSUFFICIENT_FUNDS: 'insufficient_funds',
  INVALID_SCHEME: 'invalid_scheme',
  INVALID_NETWORK: 'invalid_network',
  UNSUPPORTED_SCHEME: 'unsupported_scheme',
  DUPLICATE_SETTLEMENT: 'duplicate_settlement',
  UNEXPECTED_SETTLE_ERROR: 'unexpected_settle_error',

  // ── SVM `exact`, from `scheme_exact_svm.md` ────────────────────────────────
  INVALID_EXACT_SVM_PAYLOAD_TRANSACTION: 'invalid_exact_svm_payload_transaction',
  INVALID_EXACT_SVM_PAYLOAD_SIGNATURE: 'invalid_exact_svm_payload_signature',
  INVALID_EXACT_SVM_PAYLOAD_INSTRUCTIONS: 'invalid_exact_svm_payload_instructions',
  INVALID_EXACT_SVM_PAYLOAD_FEE_PAYER: 'invalid_exact_svm_payload_fee_payer',
  INVALID_EXACT_SVM_PAYLOAD_COMPUTE_BUDGET: 'invalid_exact_svm_payload_compute_budget',
  INVALID_EXACT_SVM_PAYLOAD_TRANSFER: 'invalid_exact_svm_payload_transfer',
  INVALID_EXACT_SVM_PAYLOAD_ASSET: 'invalid_exact_svm_payload_asset',
  INVALID_EXACT_SVM_PAYLOAD_RECIPIENT: 'invalid_exact_svm_payload_recipient',
  INVALID_EXACT_SVM_PAYLOAD_AMOUNT: 'invalid_exact_svm_payload_amount',
  INVALID_EXACT_SVM_PAYLOAD_MEMO: 'invalid_exact_svm_payload_memo',
  INVALID_EXACT_SVM_PAYLOAD_BLOCKHASH: 'invalid_exact_svm_payload_blockhash',

  // ── EVM `exact`, contract-call flow (`EvmFacilitator`) ─────────────────────
  // Not the upstream EIP-3009 reasons: USDG implements neither 3009 nor 2612,
  // so what is verified here is a signed `depositFor` transaction, and these
  // name what can be wrong with one.
  INVALID_EXACT_EVM_PAYLOAD_TRANSACTION: 'invalid_exact_evm_payload_transaction',
  INVALID_EXACT_EVM_PAYLOAD_SIGNATURE: 'invalid_exact_evm_payload_signature',
  INVALID_EXACT_EVM_PAYLOAD_RECIPIENT: 'invalid_exact_evm_payload_recipient',
  INVALID_EXACT_EVM_PAYLOAD_AMOUNT: 'invalid_exact_evm_payload_amount',
  INVALID_EXACT_EVM_PAYLOAD_SIMULATION: 'invalid_exact_evm_payload_simulation',
} as const;

export type X402InvalidReason = (typeof X402_INVALID_REASON)[keyof typeof X402_INVALID_REASON];

/** Route paths, so client and server cannot drift on a string literal. */
export const FACILITATOR_ROUTES = {
  VERIFY: '/verify',
  SETTLE: '/settle',
  SUPPORTED: '/supported',
} as const;
