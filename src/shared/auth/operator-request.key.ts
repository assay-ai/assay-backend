/**
 * The request property `OperatorAuthGuard` attaches the resolved operator
 * session to.
 *
 * In its own file, importing nothing — same layout as `session-request.key.ts`
 * and for the same reason: keeping the constant free of the port it is keyed
 * to means anything that only needs to *read* the property (a future cache
 * interceptor, a log middleware) does not have to import the operator
 * console's DI wiring for the sake of one string.
 */
export const OPERATOR_REQUEST_KEY = 'operator' as const;
