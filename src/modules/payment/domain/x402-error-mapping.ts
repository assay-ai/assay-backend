import { X402_INVALID_REASON } from '@modules/chains/facilitator/facilitator.wire';

import { PaymentErrors } from '../errors/payment.errors';

/**
 * The x402 error mapping, applied.
 *
 * The reference mapping table is written against the EVM row names
 * (`invalid_exact_evm_payload_signature`, `…_valid_before`) because that is
 * what existed when it was written; `facilitator.wire.ts`'s
 * `X402_INVALID_REASON` is the vocabulary the self-hosted SVM facilitator
 * actually emits, and it enumerates several `invalid_exact_svm_payload_*`
 * reasons that table never itemises. This function is the authoritative mapping
 * for what we actually run today — Solana only — and it is intentionally
 * more granular than the reference table where it is silent, folding the
 * SVM structural-validation reasons it doesn't name into
 * `PAYMENT_INVALID_PAYLOAD` rather than inventing a code per reason nobody
 * would branch on differently.
 *
 * Pure and total: every value `X402_INVALID_REASON` can produce, plus
 * `undefined` (a facilitator that failed to reach us at all — see
 * `HttpFacilitatorAdapter`), maps to something. Throws rather than returns,
 * so a call site reads as a straight-line failure rather than
 * `throw mapReason(...)` that a reviewer has to double-check always throws.
 */
export function throwForX402InvalidReason(reason: string | undefined): never {
  switch (reason) {
    case X402_INVALID_REASON.INSUFFICIENT_FUNDS:
      throw PaymentErrors.insufficientFunds({ reason });

    case X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_SIGNATURE:
    case X402_INVALID_REASON.INVALID_EXACT_EVM_PAYLOAD_SIGNATURE:
      throw PaymentErrors.invalidSignature({ reason });

    // The SVM analogue of EVM's `validBefore` expiry: the recentBlockhash the
    // client signed over is dead. Same code, same retry advice — request a
    // fresh `402`, never resubmit.
    case X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_BLOCKHASH:
      throw PaymentErrors.authorizationExpired({ reason });

    case X402_INVALID_REASON.INVALID_NETWORK:
      throw PaymentErrors.unsupportedNetwork({ reason });

    case X402_INVALID_REASON.INVALID_SCHEME:
    case X402_INVALID_REASON.UNSUPPORTED_SCHEME:
      throw PaymentErrors.unsupportedScheme({ reason });

    case X402_INVALID_REASON.DUPLICATE_SETTLEMENT:
      throw PaymentErrors.duplicateSettlement({ reason });

    // The EVM simulation reason belongs here too: a revert there is almost
    // always a missing `approve` or a short USDG balance — the caller's to fix,
    // so 4xx, not the 503 of `default`.
    case X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_TRANSACTION:
    case X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_INSTRUCTIONS:
    case X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_FEE_PAYER:
    case X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_COMPUTE_BUDGET:
    case X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_TRANSFER:
    case X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_ASSET:
    case X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_RECIPIENT:
    case X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_AMOUNT:
    case X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_MEMO:
    case X402_INVALID_REASON.INVALID_EXACT_EVM_PAYLOAD_TRANSACTION:
    case X402_INVALID_REASON.INVALID_EXACT_EVM_PAYLOAD_RECIPIENT:
    case X402_INVALID_REASON.INVALID_EXACT_EVM_PAYLOAD_AMOUNT:
    case X402_INVALID_REASON.INVALID_EXACT_EVM_PAYLOAD_SIMULATION:
      throw PaymentErrors.invalidPayload({ reason });

    case X402_INVALID_REASON.UNEXPECTED_SETTLE_ERROR:
    default:
      // Includes `undefined` — a facilitator we could not even get a reason
      // from is exactly the "unexpected" case, and `503` says the fault is
      // ours-to-retry, not the caller's to fix.
      throw PaymentErrors.settlementFailed({ reason });
  }
}
