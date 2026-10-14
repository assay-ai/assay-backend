import { WITHHELD_STATUS_BUCKET, WithheldBucket } from '@modules/ledger/domain/withheld';

/**
 * Why a paid call ended without a charge, as the public Explorer says it.
 *
 * A stable key for the screen to switch on, and one plain sentence for a
 * reader who has never seen the product. Derived only from the intent's own
 * outcome columns — `status`, `classification` and `verification_verdict` —
 * so the feed needs no join to the verification evidence, which holds request
 * and response bodies that must never reach a public route.
 *
 * The bucket rides along unchanged from `WITHHELD_STATUS_BUCKET`, because the
 * ledger's rule is that the guarantee firing (`FAILED_VERIFICATION`) and a
 * call that never produced data (`PROVIDER_OR_PLATFORM_ERROR`) are two
 * different claims, and a public page must not merge them either.
 */
export enum NotChargedReason {
  /** `REFUNDED`: verification struck the result down. The guarantee firing. */
  FAILED_CHECK = 'FAILED_CHECK',
  /** `VOIDED` with a `MISAPPLIED` verdict: the request was outside the tool's scope. */
  OUT_OF_SCOPE = 'OUT_OF_SCOPE',
  /** `VOIDED` after a `SYSTEM_ERROR` response: the provider's endpoint failed. */
  PROVIDER_ERROR = 'PROVIDER_ERROR',
  /** `VOIDED` after a `REQUEST_ERROR` response: the provider refused the request. */
  REQUEST_REJECTED = 'REQUEST_REJECTED',
  /** `VOIDED` for any other cause: no usable result came back. */
  NO_USABLE_RESULT = 'NO_USABLE_RESULT',
  /** `EXPIRED` with funds reserved: the call did not finish in time. */
  EXPIRED = 'EXPIRED',
}

export const NOT_CHARGED_REASON_TEXT: Readonly<Record<NotChargedReason, string>> = Object.freeze({
  [NotChargedReason.FAILED_CHECK]:
    'The result failed our check, so the buyer got the held amount back.',
  [NotChargedReason.OUT_OF_SCOPE]:
    'The request was outside what the tool covers, so nobody was charged.',
  [NotChargedReason.PROVIDER_ERROR]:
    'The provider returned an error instead of a result, so the call was not charged.',
  [NotChargedReason.REQUEST_REJECTED]:
    'The provider rejected the request, so the call was not charged.',
  [NotChargedReason.NO_USABLE_RESULT]:
    'The call ended without a usable result, so it was not charged.',
  [NotChargedReason.EXPIRED]: 'The call did not finish in time, so the held amount was released.',
});

export interface NotChargedOutcome {
  readonly status: string;
  readonly classification: string | null;
  readonly verificationVerdict: string | null;
}

/**
 * The reason and bucket for one not-charged call, or `null` when the status is
 * not one that withholds — which the query already excludes, so `null` here is
 * a defect upstream rather than a state to render.
 */
export function notChargedReason(
  outcome: NotChargedOutcome,
): { reason: NotChargedReason; bucket: WithheldBucket } | null {
  const bucket = WITHHELD_STATUS_BUCKET[outcome.status];
  if (!bucket) return null;

  if (outcome.status === 'REFUNDED') return { reason: NotChargedReason.FAILED_CHECK, bucket };
  if (outcome.status === 'EXPIRED') return { reason: NotChargedReason.EXPIRED, bucket };

  if (outcome.verificationVerdict === 'MISAPPLIED') {
    return { reason: NotChargedReason.OUT_OF_SCOPE, bucket };
  }
  if (outcome.classification === 'SYSTEM_ERROR') {
    return { reason: NotChargedReason.PROVIDER_ERROR, bucket };
  }
  if (outcome.classification === 'REQUEST_ERROR') {
    return { reason: NotChargedReason.REQUEST_REJECTED, bucket };
  }
  return { reason: NotChargedReason.NO_USABLE_RESULT, bucket };
}
