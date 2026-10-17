import { AssertDomainErrorCodes, createDomainErrorFactory } from '@shared/errors/error-catalog';

/**
 * `DISPUTE_*` — opening, acknowledging, withdrawing and reading disputes, and
 * filing, answering and deciding a buyer's dispute over one call (G3.B1).
 */
export enum DisputeErrorCode {
  DISPUTE_NOT_FOUND = 'DISPUTE_NOT_FOUND',
  DISPUTE_SUBJECT_NOT_FOUND = 'DISPUTE_SUBJECT_NOT_FOUND',
  DISPUTE_ALREADY_ACKNOWLEDGED = 'DISPUTE_ALREADY_ACKNOWLEDGED',
  DISPUTE_NOT_ACKNOWLEDGEABLE = 'DISPUTE_NOT_ACKNOWLEDGEABLE',
  DISPUTE_NOT_WITHDRAWABLE = 'DISPUTE_NOT_WITHDRAWABLE',
  DISPUTE_USE_CALL_DISPUTES = 'DISPUTE_USE_CALL_DISPUTES',
  DISPUTE_CALL_NOT_DISPUTABLE = 'DISPUTE_CALL_NOT_DISPUTABLE',
  DISPUTE_FILING_WINDOW_CLOSED = 'DISPUTE_FILING_WINDOW_CLOSED',
  DISPUTE_ALREADY_OPEN = 'DISPUTE_ALREADY_OPEN',
  DISPUTE_RATE_LIMITED = 'DISPUTE_RATE_LIMITED',
  DISPUTE_ALREADY_RESPONDED = 'DISPUTE_ALREADY_RESPONDED',
  DISPUTE_NOT_DECIDABLE = 'DISPUTE_NOT_DECIDABLE',
  DISPUTE_COLLECTION_IN_PROGRESS = 'DISPUTE_COLLECTION_IN_PROGRESS',
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
  /**
   * The generic route was asked to open a buyer's dispute over its own call or
   * verdict. Those go through `POST /call-disputes`, the one path that reaches
   * a decision: two doors would leave one of them undecided.
   */
  useCallDisputes: {
    code: DisputeErrorCode.DISPUTE_USE_CALL_DISPUTES,
    statusCode: 409,
    message: (_context?: Record<string, any>) =>
      'A dispute over your own call is filed through POST /call-disputes',
  },
  /** Not a paid, settled call this buyer may dispute — free, unsettled, or its own. */
  callNotDisputable: {
    code: DisputeErrorCode.DISPUTE_CALL_NOT_DISPUTABLE,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `This call cannot be disputed${context?.reason ? `: ${context.reason}` : ''}`,
  },
  filingWindowClosed: {
    code: DisputeErrorCode.DISPUTE_FILING_WINDOW_CLOSED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `The dispute window for this call has closed` +
      `${context?.closedAt ? ` (closed at ${context.closedAt})` : ''}`,
  },
  alreadyOpen: {
    code: DisputeErrorCode.DISPUTE_ALREADY_OPEN,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `This call already has an open dispute${context?.id ? `: ${context.id}` : ''}`,
  },
  rateLimited: {
    code: DisputeErrorCode.DISPUTE_RATE_LIMITED,
    statusCode: 429,
    message: (context?: Record<string, any>) =>
      `Too many disputes filed in the last 24 hours` +
      `${context?.limit !== undefined ? ` (limit ${context.limit})` : ''}`,
  },
  alreadyResponded: {
    code: DisputeErrorCode.DISPUTE_ALREADY_RESPONDED,
    statusCode: 409,
    message: (_context?: Record<string, any>) =>
      'This dispute already has a response, or is decided',
  },
  notDecidable: {
    code: DisputeErrorCode.DISPUTE_NOT_DECIDABLE,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Dispute cannot be decided from its current state` +
      `${context?.state ? `: ${context.state}` : ''}`,
  },
  /**
   * The call's payment is still being collected (a voucher awaiting
   * redemption, or a replacement in flight). Deciding now could refund a hold
   * whose voucher then lands; retry once collection has finished.
   */
  collectionInProgress: {
    code: DisputeErrorCode.DISPUTE_COLLECTION_IN_PROGRESS,
    statusCode: 409,
    message: (_context?: Record<string, any>) =>
      "The call's payment is still being collected; decide again once it has finished",
  },
});
