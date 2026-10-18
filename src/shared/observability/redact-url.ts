import { REDACTED, redactSecretsInText } from './redact';

/**
 * The consent request id in a consent API path, under any prefix
 * (`/api/v1/oauth/requests/{rid}`, `…/{rid}/approve`, `…/{rid}/deny`).
 */
const OAUTH_REQUEST_PATH = /(\/oauth\/requests\/)[^/?#\s'"]+/gi;

/**
 * Routes whose whole query string is dropped: `/oauth/authorize` carries
 * `state`, `code_challenge`, `redirect_uri`, `client_id` and `assay_replaces`
 * (a credential id), `continue` carries the rid; the consent API takes none.
 * Only the path is kept.
 */
const QUERYLESS_PATH = /\/oauth\/(?:authorize|requests\/)/i;

/** The same routes inside free text: the path up to its query, then the query. */
const QUERYLESS_PATH_IN_TEXT = /(\/oauth\/(?:authorize|requests\/)[^\s?#'"]*)\?[^\s#'"]*/gi;

/**
 * Query keys whose value is never logged or echoed. `request` is the rid on
 * `/oauth/authorize/continue`; the rest are defensive (none of them is ever a
 * query parameter of ours, but a client may put one there).
 */
const SECRET_QUERY_KEYS = new Set([
  'request',
  'rid',
  'code',
  'code_verifier',
  'code_challenge',
  'access_token',
  'refresh_token',
  'token',
  'client_secret',
]);

function decodedKey(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

/**
 * A request URL as it may be logged or put in `error.path` (R-OA-27): the
 * consent request id and every secret query value become {@link REDACTED},
 * the query of `/oauth/authorize*` and `/oauth/requests/*` is dropped,
 * and the token-shaped value backstop runs over the rest. Everything else is
 * left exactly as it was, so a log line still names the route.
 */
export function redactOAuthUrl(url: string): string {
  const queryStart = url.indexOf('?');
  const path = queryStart === -1 ? url : url.slice(0, queryStart);
  const query = queryStart === -1 ? null : url.slice(queryStart + 1);

  const safePath = path.replace(OAUTH_REQUEST_PATH, `$1${REDACTED}`);
  const safeQuery =
    query === null || QUERYLESS_PATH.test(path)
      ? ''
      : '?' +
        query
          .split('&')
          .map((pair) => {
            const equals = pair.indexOf('=');
            if (equals === -1) return pair;
            const key = pair.slice(0, equals);
            return SECRET_QUERY_KEYS.has(decodedKey(key).toLowerCase())
              ? `${key}=${REDACTED}`
              : pair;
          })
          .join('&');

  return redactSecretsInText(safePath + safeQuery);
}

/** `key=value` inside free text, for every key of {@link SECRET_QUERY_KEYS}. */
const SECRET_QUERY_IN_TEXT = new RegExp(
  `([?&](?:${[...SECRET_QUERY_KEYS].join('|')})=)[^&\\s#'"]*`,
  'gi',
);

/**
 * {@link redactOAuthUrl} for text that merely *contains* a URL — Nest's
 * `Cannot GET /api/v1/oauth/requests/{rid}/approve`, Express's
 * `Failed to decode param '…'`: the rid, the query of the OAuth routes and
 * every secret query value are replaced, then the value backstop runs.
 */
export function redactOAuthText(text: string): string {
  return redactSecretsInText(
    text
      .replace(QUERYLESS_PATH_IN_TEXT, '$1')
      .replace(OAUTH_REQUEST_PATH, `$1${REDACTED}`)
      .replace(SECRET_QUERY_IN_TEXT, `$1${REDACTED}`),
  );
}
