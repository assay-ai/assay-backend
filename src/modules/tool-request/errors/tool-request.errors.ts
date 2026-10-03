import { AssertDomainErrorCodes, createDomainErrorFactory } from '@shared/errors/error-catalog';

/** `TOOL_REQUEST_*` — the tool request ticket queue (MVP slice only). */
export enum ToolRequestErrorCode {
  TOOL_REQUEST_NOT_FOUND = 'TOOL_REQUEST_NOT_FOUND',
  TOOL_REQUEST_INVALID_TRANSITION = 'TOOL_REQUEST_INVALID_TRANSITION',
  TOOL_REQUEST_RESOLUTION_NOTE_REQUIRED = 'TOOL_REQUEST_RESOLUTION_NOTE_REQUIRED',
}

export type ToolRequestErrorCodesArePrefixed = AssertDomainErrorCodes<
  'TOOL_REQUEST',
  `${ToolRequestErrorCode}`
>;

export const ToolRequestErrors = createDomainErrorFactory('TOOL_REQUEST', {
  /** Cross-organization id or no such row — indistinguishable, on purpose (404, never 403). */
  notFound: {
    code: ToolRequestErrorCode.TOOL_REQUEST_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `Tool request not found${context?.id ? ` with id: ${context.id}` : ''}`,
  },
  /**
   * A move the state machine does not allow.
   *
   * `409`, and usually a race rather than a misuse: two operators answering
   * the same ticket, or a retried PATCH landing after the first one already
   * closed it. The message names both states so the loser can tell which
   * happened, mirroring `SlashErrors.invalidTransition`.
   */
  invalidTransition: {
    code: ToolRequestErrorCode.TOOL_REQUEST_INVALID_TRANSITION,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Cannot move a tool request from ${context?.from ?? 'its current state'} to ` +
      `${context?.to ?? 'the requested state'}`,
  },
  /** `chk_tool_requests_closed_is_whole`: ACCEPTED/DECLINED must carry a reason. */
  resolutionNoteRequired: {
    code: ToolRequestErrorCode.TOOL_REQUEST_RESOLUTION_NOTE_REQUIRED,
    statusCode: 422,
    message: () => 'Accepting or declining a tool request requires a resolution note',
  },
});
