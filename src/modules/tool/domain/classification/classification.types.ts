/**
 * Response classification.
 *
 * Runs the instant the provider's call returns, before verification, and
 * answers exactly one question:
 *
 * > **Is this response even a candidate for a quality judgement?**
 *
 * Most failures are not. The classes are not severity levels — they are
 * *attributions*, and the attribution decides whether a provider's staked
 * capital is reachable at all:
 *
 * ```text
 * SYSTEM_ERROR   → void  → no charge, no strike, no verification, STAKE UNTOUCHED
 * REQUEST_ERROR  → void  → no charge, no strike, no verification, STAKE UNTOUCHED
 * DATA_RESULT    → verify ─┬─ PASS → settle
 *                          └─ FAIL → refund + strike → the only road to a slash
 * ```
 *
 * The rule is one that "must not be wrong": `SYSTEM_ERROR`
 * and `REQUEST_ERROR` **never** touch stake. Every boundary decision in this
 * folder is therefore resolved the same way when it is genuinely ambiguous:
 * **toward the class that cannot cost the provider money.** Misclassifying a
 * real `DATA_RESULT` as `SYSTEM_ERROR` loses us one quality signal out of
 * thousands. Misclassifying a truncated body as `DATA_RESULT` takes money from
 * someone who did nothing wrong, and there is no refund path for the reputation
 * that goes with it.
 */

import { JsonValue } from '../mapping/mapping.types';

// ---------------------------------------------------------------------------
// The three classes
// ---------------------------------------------------------------------------

export enum ResponseClass {
  /**
   * The provider's infrastructure failed. Nothing is known about data quality
   * because no usable data arrived.
   *
   * Rate limits and outages are operational facts, not dishonesty. Turning them
   * into slashable events would make running a provider uninsurable.
   */
  SYSTEM_ERROR = 'SYSTEM_ERROR',

  /**
   * The provider rejected the request as invalid. The default assumption is
   * that the request may have been at fault, and a status code alone cannot
   * tell us whether the agent sent something wrong or the provider is
   * misbehaving — so nobody is penalised.
   */
  REQUEST_ERROR = 'REQUEST_ERROR',

  /**
   * The provider returned data. This is the only class that reaches
   * verification, and therefore the only class that can ever end in a slash.
   *
   * Note the boundary carefully: `DATA_RESULT` says data *arrived*, not that it
   * is *good*. An empty result set (`{"results": []}`) is a `DATA_RESULT` that
   * will very likely fail verification. Classification decides whether a
   * quality judgement is applicable; verification makes the judgement.
   */
  DATA_RESULT = 'DATA_RESULT',
}

/**
 * Why a response landed in its class.
 *
 * Carried alongside the class rather than folded into it because the three
 * classes are the *policy* surface and these are the *evidence*. A receipt that
 * says "SYSTEM_ERROR" tells a provider nothing; "SYSTEM_ERROR because the
 * socket was reset after 812 bytes" tells them where to look. The reason is
 * also what `classification_override_rate` (the classifier's own accuracy
 * metric) is grouped by — a rising override rate on one reason means one rule
 * is wrong, which a bare class count could never localise.
 */
export enum ClassificationReason {
  // --- transport: the request never produced a complete application response
  TRANSPORT_TIMEOUT = 'TRANSPORT_TIMEOUT',
  TRANSPORT_CONNECTION_REFUSED = 'TRANSPORT_CONNECTION_REFUSED',
  TRANSPORT_CONNECTION_RESET = 'TRANSPORT_CONNECTION_RESET',
  TRANSPORT_DNS_FAILURE = 'TRANSPORT_DNS_FAILURE',
  TRANSPORT_TLS_FAILURE = 'TRANSPORT_TLS_FAILURE',
  TRANSPORT_BODY_TRUNCATED = 'TRANSPORT_BODY_TRUNCATED',
  TRANSPORT_UNKNOWN = 'TRANSPORT_UNKNOWN',

  // --- per-tool policy overrode the default for this status
  POLICY_SYSTEM_ERROR_STATUS = 'POLICY_SYSTEM_ERROR_STATUS',
  POLICY_DATA_RESULT_STATUS = 'POLICY_DATA_RESULT_STATUS',

  // --- status-driven defaults
  UPSTREAM_RATE_LIMITED = 'UPSTREAM_RATE_LIMITED',
  UPSTREAM_SERVER_ERROR = 'UPSTREAM_SERVER_ERROR',
  UPSTREAM_UNEXPECTED_STATUS = 'UPSTREAM_UNEXPECTED_STATUS',
  REQUEST_REJECTED = 'REQUEST_REJECTED',

  // --- body-driven, inside an otherwise successful status
  BODY_EMPTY = 'BODY_EMPTY',
  BODY_NOT_JSON = 'BODY_NOT_JSON',
  BODY_ERROR_ENVELOPE = 'BODY_ERROR_ENVELOPE',
  BODY_PREDICATE_MATCHED = 'BODY_PREDICATE_MATCHED',

  // --- the mapping engine reported a fault
  MAPPING_FAULT_AGENT = 'MAPPING_FAULT_AGENT',
  MAPPING_FAULT_PLATFORM = 'MAPPING_FAULT_PLATFORM',
  MAPPING_FAULT_PROVIDER = 'MAPPING_FAULT_PROVIDER',

  /** A 2xx carrying a JSON body that nothing objected to. */
  OK = 'OK',
}

// ---------------------------------------------------------------------------
// Transport failures
// ---------------------------------------------------------------------------

/**
 * A failure that happened below the application layer, so there is no status
 * code to reason about.
 *
 * Every kind here is `SYSTEM_ERROR` without exception — that is the point of
 * naming them separately from statuses. They are enumerated rather than
 * collapsed into one value because the *router* treats them differently even
 * though the *classifier* does not: `CONNECTION_REFUSED` means retry elsewhere
 * immediately, `TIMEOUT` means the deadline budget is already spent, and
 * `DNS_FAILURE` frequently means our binding's endpoint is stale rather than
 * the provider being down. Erasing that at classification time would force
 * the router to re-derive it from a string.
 */
export enum TransportErrorKind {
  /** Our deadline expired — headers or body never completed in time. */
  TIMEOUT = 'TIMEOUT',
  /** Nothing was listening. `ECONNREFUSED`. */
  CONNECTION_REFUSED = 'CONNECTION_REFUSED',
  /** The socket died mid-conversation. `ECONNRESET`, `EPIPE`, premature close. */
  CONNECTION_RESET = 'CONNECTION_RESET',
  /** The hostname did not resolve. `ENOTFOUND`, `EAI_AGAIN`. */
  DNS_FAILURE = 'DNS_FAILURE',
  /** Certificate or handshake failure. */
  TLS_FAILURE = 'TLS_FAILURE',
  /**
   * The response announced more bytes than it delivered. Distinct from
   * `CONNECTION_RESET` because the framing itself, not the socket, is what
   * proved the body incomplete.
   */
  BODY_TRUNCATED = 'BODY_TRUNCATED',
  /** Recognised as a transport failure, but not as one of the above. */
  UNKNOWN = 'UNKNOWN',
}

export interface TransportError {
  readonly kind: TransportErrorKind;
  /**
   * Bytes that did arrive before the failure, when any did.
   *
   * Recorded for diagnostics and **never** parsed, never promoted, never shown
   * to verification. A body cut off halfway is byte-identical to a provider who
   * returned half an answer, and we cannot tell which happened — so the partial
   * bytes are evidence for a human, not input to a judgement.
   */
  readonly partialBody?: string | null;
  /** The underlying error's code/message, for the provider dashboard and the receipt. */
  readonly detail?: string;
}

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------

export enum ResponseBodyKind {
  /** Zero bytes, or bytes that are entirely whitespace. */
  EMPTY = 'EMPTY',
  /** Parsed as JSON. */
  JSON = 'JSON',
  /** Bytes arrived and are not JSON — HTML error page, plain text, binary. */
  NON_JSON = 'NON_JSON',
}

export type ResponseBody =
  | { readonly kind: ResponseBodyKind.EMPTY }
  | { readonly kind: ResponseBodyKind.JSON; readonly value: JsonValue }
  | { readonly kind: ResponseBodyKind.NON_JSON; readonly raw: string; readonly detail: string };

/**
 * What the classifier is given: one completed (or failed) attempt against one
 * binding.
 *
 * Deliberately a value, not a client handle. Classification is a pure decision
 * over an observation, which is what lets a disputed call be re-classified
 * months later from the stored receipt and produce the same answer — a
 * requirement for dispute arbitration, where "we would classify it the
 * same way today" has to be demonstrable rather than asserted.
 */
export interface ProviderResponse {
  /**
   * The HTTP status. Meaningless when `transportError` is set — no status was
   * ever received — and by convention `0` there.
   */
  readonly status: number;
  /** Lower-cased header names. Only `retry-after` is read today. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: ResponseBody;
  readonly transportError?: TransportError | null;
}

// ---------------------------------------------------------------------------
// Per-tool policy
// ---------------------------------------------------------------------------

/**
 * A tool-specific test for "this 2xx body is actually an error envelope".
 *
 * `id` is required so that a manual reclassification can name the predicate
 * that produced the wrong answer. An anonymous lambda in a policy is a rule
 * nobody can audit after the fact.
 */
export interface BodyPredicate {
  readonly id: string;
  matches(body: JsonValue): boolean;
}

/**
 * Per-tool overrides of the defaults.
 *
 * The defaults are chosen to be safe across every tool, which necessarily makes
 * them wrong for some. A lookup tool where `404` genuinely means "no such
 * record" wants that verified and paid for; a search tool where `404` means our
 * URL is wrong does not. The tool's policy decides, and the policy is data so
 * that changing it is not a deploy.
 */
export interface ClassificationPolicy {
  readonly toolId: string;

  /**
   * Statuses that count as `SYSTEM_ERROR` despite being 4xx — typically
   * `[401, 403]`. A `401` means *our* credentials for that provider are broken,
   * which is our problem or theirs but never the agent's, so charging the agent
   * for it (or striking the provider) are both wrong.
   */
  readonly systemErrorStatuses?: readonly number[];

  /** Statuses that count as `DATA_RESULT` and are verified — e.g. `[404]`. */
  readonly dataResultStatuses?: readonly number[];

  /** Extra "this 2xx is really an error" tests beyond the built-in envelope check. */
  readonly bodyPredicates?: readonly BodyPredicate[];

  /**
   * Allow a body that is not JSON to reach verification.
   *
   * Off by default: a tool contract is a JSON `outputSchema`, so a non-JSON
   * body is far more often an HTML error page from a proxy than a real answer,
   * and sending an HTML error page to verification produces a FAIL and a strike
   * for an infrastructure event. On for tools that genuinely return text or
   * CSV, where verification knows how to read it.
   */
  readonly acceptsNonJsonBody?: boolean;

  /**
   * Allow a zero-byte body to reach verification.
   *
   * Off by default, and this is the single most important default in the file.
   * A `200` with no body is byte-identical to a `200` whose body a load
   * balancer truncated to nothing — see `ResponseBodyKind.EMPTY` and the
   * `BODY_EMPTY` branch in `classify.ts`. On for tools where "no content" is
   * the answer, which in practice means it is set together with
   * `dataResultStatuses: [404]` or a `204` contract.
   */
  readonly acceptsEmptyBody?: boolean;
}

/** The policy for a tool that has declared nothing. All defaults. */
export const DEFAULT_CLASSIFICATION_POLICY: ClassificationPolicy = { toolId: '*' };

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

export interface Classification {
  readonly responseClass: ResponseClass;
  readonly reason: ClassificationReason;
  /** Human-readable specifics — the status, the parse failure, the predicate id. */
  readonly detail?: string;
  /**
   * `Retry-After` from the upstream, in milliseconds, when it sent one.
   *
   * **Advisory, and never a delay.** `RetryPolicy.backoffMs` is `0` because an
   * agent is blocked on the response; failing over immediately to a *different*
   * provider is the entire value of routing, so we never sleep on an upstream's
   * say-so. What this feeds is the routing cool-down: a provider that asks for
   * 60 seconds gets its weight suppressed for 60 seconds instead of being
   * hammered and generating 60 seconds of avoidable `SYSTEM_ERROR`s.
   */
  readonly retryAfterMs?: number | null;
}

// ---------------------------------------------------------------------------
// Consequences — the slash policy, as data
// ---------------------------------------------------------------------------

export interface ClassConsequence {
  /** Is the agent charged, ever, on this class? */
  readonly settle: boolean;
  /** Does this class record a strike against the provider? */
  readonly strike: boolean;
  /** Does this class reach verification? */
  readonly verify: boolean;
  /** Can this class, through any downstream path, reach the provider's stake? */
  readonly slashable: boolean;
  /** Which reputation metric it moves. */
  readonly metric: 'availability' | 'compatibility' | 'quality';
}

/**
 * The slash policy by response class, expressed as code so that a test
 * can assert it rather than a reviewer having to remember it.
 *
 * The two middle rows of that table are the whole of the rule:
 * upstream being down is not the provider's fault, and an agent sending bad
 * parameters is not either. `slashable` is `false` on both, and the invariant
 * test in `test/unit/tool/response-classification.spec.ts` fails the build if
 * anyone ever flips one.
 *
 * `DATA_RESULT.slashable` is `true` meaning *reachable*, not *reached*: only a
 * `DATA_FAIL` verdict out of verification proposes a slash, only a signed
 * attestation from an approved verifier can execute one, and shadow
 * mode suppresses execution entirely until the measured false-positive
 * rate is under 2%.
 */
export const RESPONSE_CLASS_CONSEQUENCE: Readonly<Record<ResponseClass, ClassConsequence>> =
  Object.freeze({
    [ResponseClass.SYSTEM_ERROR]: Object.freeze({
      settle: false,
      strike: false,
      verify: false,
      slashable: false,
      metric: 'availability',
    }),
    [ResponseClass.REQUEST_ERROR]: Object.freeze({
      settle: false,
      strike: false,
      verify: false,
      slashable: false,
      metric: 'compatibility',
    }),
    [ResponseClass.DATA_RESULT]: Object.freeze({
      settle: true,
      strike: true,
      verify: true,
      slashable: true,
      metric: 'quality',
    }),
  } as const);

/** Does this class go on to verification at all? */
export function reachesVerification(responseClass: ResponseClass): boolean {
  return RESPONSE_CLASS_CONSEQUENCE[responseClass].verify;
}

/**
 * Can this class, by any route, end in the provider's stake being touched?
 *
 * The one-line form of the rule the MVP doc marks "must not be wrong". Call this
 * rather than comparing classes by hand: a `!== SYSTEM_ERROR` written at a call
 * site is a rule that silently stops being true the day a fourth class exists.
 */
export function canEverSlash(responseClass: ResponseClass): boolean {
  return RESPONSE_CLASS_CONSEQUENCE[responseClass].slashable;
}

/**
 * Only `SYSTEM_ERROR` is retryable, and only against a *different* provider.
 *
 * `REQUEST_ERROR` is not retried: if the request was malformed it will be
 * malformed again. `DATA_RESULT` is not retried regardless of what verification
 * later says, because verification is asynchronous and the agent already has
 * the response — retrying would mean charging twice or delaying the answer.
 */
export function isRetryable(responseClass: ResponseClass): boolean {
  return responseClass === ResponseClass.SYSTEM_ERROR;
}
