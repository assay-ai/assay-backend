import { AssertDomainErrorCodes, createDomainErrorFactory } from '@shared/errors/error-catalog';

/**
 * `API_*` — failures of the **request envelope**, not of any domain.
 *
 * A malformed cursor, a sort field that does not exist, a reversed time window:
 * none of these are a payment problem, a ledger problem or a verification
 * problem, and giving them a domain prefix would put them in the wrong alert
 * bucket and the wrong runbook. They belong to the surface itself, which is why
 * they get their own catalog rather than being sprinkled through the modules
 * that happen to raise them.
 *
 * Every code here is a **4xx**. Each one describes something the caller can fix
 * by changing the request, which is the test for whether a failure belongs in
 * this file at all — contrast `ORGANIZATION_*`, which are 500s precisely
 * because the caller cannot do anything about them.
 */
export enum ApiErrorCode {
  /** The cursor is not one we issued, or not one for this query. */
  API_INVALID_CURSOR = 'API_INVALID_CURSOR',
  /** `sort` names a field the resource does not expose for ordering. */
  API_UNKNOWN_SORT_FIELD = 'API_UNKNOWN_SORT_FIELD',
  /** `from` is not before `to`. */
  API_INVALID_TIME_RANGE = 'API_INVALID_TIME_RANGE',
  /** A filter value is outside the set the resource accepts. */
  API_INVALID_FILTER = 'API_INVALID_FILTER',
}

export type ApiErrorCodesArePrefixed = AssertDomainErrorCodes<'API', `${ApiErrorCode}`>;

export const ApiErrors = createDomainErrorFactory('API', {
  /**
   * One code for every way a cursor can be unusable, and deliberately one
   * message shape for all of them.
   *
   * A cursor is **opaque**. Telling a caller *how* it was malformed — bad
   * base64, missing field, wrong sort spec — invites them to construct one by
   * hand, and a hand-built cursor is a client coupled to an encoding we intend
   * to change. `detail` exists for the server log, not for the caller's
   * parser: it is folded into the message, never returned as its own field,
   * because the error contract has no optional members.
   */
  invalidCursor: {
    code: ApiErrorCode.API_INVALID_CURSOR,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `The cursor is not valid for this query${context?.detail ? ` — ${context.detail}` : ''}. ` +
      `Cursors are opaque: pass back the exact \`nextCursor\` from the previous page, ` +
      `or omit it to start from the beginning`,
  },

  unknownSortField: {
    code: ApiErrorCode.API_UNKNOWN_SORT_FIELD,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Cannot sort by "${context?.field}"` +
      `${context?.allowed ? `. Sortable fields: ${(context.allowed as string[]).join(', ')}` : ''}`,
  },

  invalidTimeRange: {
    code: ApiErrorCode.API_INVALID_TIME_RANGE,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `\`from\` (${context?.from}) must be earlier than \`to\` (${context?.to})`,
  },

  invalidFilter: {
    code: ApiErrorCode.API_INVALID_FILTER,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `"${context?.value}" is not a valid value for \`${context?.filter}\`` +
      `${context?.allowed ? `. Accepted: ${(context.allowed as string[]).join(', ')}` : ''}`,
  },
});
