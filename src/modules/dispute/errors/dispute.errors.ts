import { AssertDomainErrorCodes, createDomainErrorFactory } from '@shared/errors/error-catalog';

/**
 * `DISPUTE_*` — opening, acknowledging, withdrawing and reading disputes
 * Adjudication — who reviews, review SLA, partial-overturn restoration —
 * is not implemented and has no error codes here yet.
 */
export enum DisputeErrorCode {
  DISPUTE_NOT_FOUND = 'DISPUTE_NOT_FOUND',
  DISPUTE_SUBJECT_NOT_FOUND = 'DISPUTE_SUBJECT_NOT_FOUND',
  DISPUTE_ALREADY_ACKNOWLEDGED = 'DISPUTE_ALREADY_ACKNOWLEDGED',
  DISPUTE_NOT_ACKNOWLEDGEABLE = 'DISPUTE_NOT_ACKNOWLEDGEABLE',
  DISPUTE_NOT_WITHDRAWABLE = 'DISPUTE_NOT_WITHDRAWABLE',
}

export type DisputeErrorCodesArePrefixed = AssertDomainErrorCodes<'DISPUTE', `${DisputeErrorCode}`>;

export const DisputeErrors = createDomainErrorFactory('DISPUTE', {
  /** Cross-organization id, or no such row at all — the two are indistinguishable on purpose. */
  disputeNotFound: {
    code: DisputeErrorCode.DISPUTE_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `Dispute not found${context?.id ? ` with id: ${context.id}` : ''}`,
  },
  /**
   * `POST /disputes` named a `subjectId` that does not exist **within the
   * caller's organization** — including a subject that exists but belongs to
   * a different tenant, which must be indistinguishable from one that does
   * not exist at all. `404`, never `403` or `422`: see `backend/docs/api-
   * list-contract.md` §"Cross-organization access returns 404".
   */
  subjectNotFound: {
    code: DisputeErrorCode.DISPUTE_SUBJECT_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `${context?.subjectType ?? 'Subject'} not found` +
      `${context?.subjectId ? ` with id: ${context.subjectId}` : ''}` +
      ` in this organization`,
  },
  /** Re-acknowledging is refused rather than silently re-deriving `deadlineAt` a second time. */
  alreadyAcknowledged: {
    code: DisputeErrorCode.DISPUTE_ALREADY_ACKNOWLEDGED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Dispute already acknowledged` +
      `${context?.id ? `: ${context.id}` : ''}` +
      `${context?.acknowledgedAt ? ` at ${context.acknowledgedAt}` : ''}`,
  },
  /** The dispute is already in a terminal state — nothing left to acknowledge. */
  notAcknowledgeable: {
    code: DisputeErrorCode.DISPUTE_NOT_ACKNOWLEDGEABLE,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Dispute cannot be acknowledged from its current state` +
      `${context?.state ? `: ${context.state}` : ''}`,
  },
  /** The dispute is already in a terminal state — nothing left to withdraw. */
  notWithdrawable: {
    code: DisputeErrorCode.DISPUTE_NOT_WITHDRAWABLE,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Dispute cannot be withdrawn from its current state` +
      `${context?.state ? `: ${context.state}` : ''}`,
  },
});
