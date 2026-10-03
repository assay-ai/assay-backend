import { SetMetadata } from '@nestjs/common';

export const RAW_RESPONSE_KEY = 'x402:raw-response';

/**
 * Exempt a handler from `TransformInterceptor`'s `{ data, statusCode, message }`
 * envelope.
 *
 * The envelope is the platform's API contract and almost every route wants it.
 * A handful of routes are not on that contract at all because their body format
 * is specified by somebody else:
 *
 * - `GET /metrics` is Prometheus text exposition format. A scraper parses it
 *   line by line and a JSON wrapper makes it unparseable.
 * - `GET /operator/dashboard` is an HTML document. Wrapped, a browser renders
 *   the JSON rather than the page.
 *
 * Both of those set an explicit `@Header('Content-Type', …)`, which is what
 * made the bug hard to see from the code: the response *claimed* `text/html`
 * while carrying JSON, so it only showed up on opening the page. The header is
 * not the contract — this decorator is.
 *
 * Prefer it over `@Res()`. Taking the raw response object also opts the handler
 * out of Nest's exception layer, so an error inside it stops producing the one
 * `ErrorResponse` shape `AllExceptionsFilter` guarantees.
 */
export const RawResponse = (): MethodDecorator & ClassDecorator =>
  SetMetadata(RAW_RESPONSE_KEY, true);
