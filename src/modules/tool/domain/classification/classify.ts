/**
 * The classifier itself.
 *
 * One function, evaluated in a fixed order, with every boundary case commented
 * where the decision is made rather than in a document nobody opens while
 * reading the branch. The order is load-bearing and is:
 *
 * ```text
 * 1. transport failure   — no status was ever received, nothing else can apply
 * 2. per-tool policy     — the tool owner's declaration beats our default
 * 3. status defaults     — 429/5xx → SYSTEM, other 4xx → REQUEST
 * 4. the body gate       — everything heading for DATA_RESULT must be readable
 * 5. anything else       — SYSTEM_ERROR, the class with no penalty
 * ```
 *
 * Step 4 running *after* step 2 is deliberate: the obvious sketch returns
 * immediately on a policy match. See `applyBodyGate` for why.
 */

import {
  Classification,
  ClassificationPolicy,
  ClassificationReason,
  ProviderResponse,
  ResponseBody,
  ResponseBodyKind,
  ResponseClass,
  TransportErrorKind,
} from './classification.types';
import { MappingFault } from '../mapping/mapping.types';
import { parseRetryAfter } from './response-body';

export interface ClassifyOptions {
  /**
   * Wall time, only ever used to turn an HTTP-date `Retry-After` into a
   * duration. Injected rather than read so that classification stays a pure
   * function of its inputs — a receipt re-classified during a dispute
   * has to produce the same answer it produced live.
   */
  readonly nowMs?: number;
}

const TRANSPORT_REASON = {
  TIMEOUT: ClassificationReason.TRANSPORT_TIMEOUT,
  CONNECTION_REFUSED: ClassificationReason.TRANSPORT_CONNECTION_REFUSED,
  CONNECTION_RESET: ClassificationReason.TRANSPORT_CONNECTION_RESET,
  DNS_FAILURE: ClassificationReason.TRANSPORT_DNS_FAILURE,
  TLS_FAILURE: ClassificationReason.TRANSPORT_TLS_FAILURE,
  BODY_TRUNCATED: ClassificationReason.TRANSPORT_BODY_TRUNCATED,
  SCHEME_NOT_ALLOWED: ClassificationReason.TRANSPORT_HTTPS_REQUIRED,
  PLATFORM_UNAVAILABLE: ClassificationReason.PLATFORM_UNAVAILABLE,
  UNUSABLE_RESPONSE: ClassificationReason.BODY_NOT_JSON,
  UNKNOWN: ClassificationReason.TRANSPORT_UNKNOWN,
} as const satisfies Record<TransportErrorKind, ClassificationReason>;

export function classifyResponse(
  response: ProviderResponse,
  policy: ClassificationPolicy,
  options: ClassifyOptions = {},
): Classification {
  const retryAfterMs = parseRetryAfter(response.headers?.['retry-after'], options.nowMs);

  // -------------------------------------------------------------------------
  // 1. Transport-level failures never reached the application.
  // -------------------------------------------------------------------------
  // Nothing below this point can apply, because there is no status code to
  // apply it to. This runs before policy on purpose: a tool that declares
  // `dataResultStatuses: [404]` is making a statement about what a 404 from
  // this provider *means*, and a timeout is not a 404 — a policy must never be
  // able to promote a connection failure into a verifiable answer.
  //
  // Every kind lands in SYSTEM_ERROR, including the two that superficially
  // look like the provider produced something:
  //
  //   * TIMEOUT with a partial body. Bytes arrived, then our deadline expired.
  //     The temptation is to verify what we got. We do not: a truncated body is
  //     byte-identical to a provider answering half a question, we cannot tell
  //     which happened, and one of the two readings costs them their stake.
  //   * BODY_TRUNCATED. Same argument, with the incompleteness proven by the
  //     framing rather than inferred from the clock.
  if (response.transportError) {
    return {
      responseClass: ResponseClass.SYSTEM_ERROR,
      reason: TRANSPORT_REASON[response.transportError.kind],
      detail: response.transportError.detail,
      retryAfterMs,
    };
  }

  const { status } = response;

  // -------------------------------------------------------------------------
  // 2. Per-tool overrides win over defaults.
  // -------------------------------------------------------------------------
  // The defaults are a compromise across every tool in the catalogue, so each
  // tool gets to say where its own truth differs. Two directions, and they are
  // not symmetric in risk:
  //
  //   * → SYSTEM_ERROR (typically 401/403). Strictly safer than the default.
  //     `REQUEST_ERROR` already carries no penalty, so this override only moves
  //     which reputation metric moves — from "this agent sends bad requests" to
  //     "our credentials for this provider are broken", which is the truth.
  //   * → DATA_RESULT (typically 404 on a lookup tool). This one is the only
  //     way a non-2xx becomes slashable, so it goes through the same body gate
  //     as a 2xx below rather than returning here.
  if (policy.systemErrorStatuses?.includes(status)) {
    return {
      responseClass: ResponseClass.SYSTEM_ERROR,
      reason: ClassificationReason.POLICY_SYSTEM_ERROR_STATUS,
      detail: `status ${status} declared SYSTEM_ERROR by tool ${policy.toolId}`,
      retryAfterMs,
    };
  }

  if (policy.dataResultStatuses?.includes(status)) {
    return applyBodyGate(response.body, policy, {
      responseClass: ResponseClass.DATA_RESULT,
      reason: ClassificationReason.POLICY_DATA_RESULT_STATUS,
      detail: `status ${status} declared DATA_RESULT by tool ${policy.toolId}`,
      retryAfterMs,
    });
  }

  // -------------------------------------------------------------------------
  // 3. Status defaults.
  // -------------------------------------------------------------------------
  // 429 sits with the 5xx family rather than with its 4xx neighbours, and that
  // placement is the whole reason this branch is written before the generic 4xx
  // one. A rate limit is the provider saying "not now", which is an operational
  // fact about their capacity — the same category as being down. Reading it as
  // "the agent sent a bad request" would be wrong in attribution, and reading
  // it as a data result would be catastrophic: a provider under load would be
  // slashed for the load.
  if (status === 429) {
    return {
      responseClass: ResponseClass.SYSTEM_ERROR,
      reason: ClassificationReason.UPSTREAM_RATE_LIMITED,
      detail: `status ${status}`,
      retryAfterMs,
    };
  }

  // 500, 502, 503, 504 and everything else above. The provider's infrastructure
  // failed; nothing is known about data quality because there is no data. Note
  // that a 5xx *with* a body is still SYSTEM_ERROR — an error page is not an
  // answer, and no amount of JSON in it makes the call verifiable.
  if (status >= 500) {
    return {
      responseClass: ResponseClass.SYSTEM_ERROR,
      reason: ClassificationReason.UPSTREAM_SERVER_ERROR,
      detail: `status ${status}`,
      retryAfterMs,
    };
  }

  // 400, 401, 403, 404, 422 and the rest of the 4xx range. The provider rejected
  // the request and we cannot tell from a status code alone whether the agent
  // sent something invalid or the provider is misbehaving — so nobody is
  // penalised and the tool's `compatibility_rate` takes the signal. 401/403 have
  // a real argument for SYSTEM_ERROR (broken credentials are never the agent's
  // doing) and 404 has a real argument for DATA_RESULT on a lookup tool; both
  // are policy decisions per tool, made in step 2, not defaults here.
  if (status >= 400) {
    return {
      responseClass: ResponseClass.REQUEST_ERROR,
      reason: ClassificationReason.REQUEST_REJECTED,
      detail: `status ${status}`,
      retryAfterMs,
    };
  }

  // -------------------------------------------------------------------------
  // 4. 2xx — the only default road to DATA_RESULT.
  // -------------------------------------------------------------------------
  if (status >= 200 && status < 300) {
    return applyBodyGate(response.body, policy, {
      responseClass: ResponseClass.DATA_RESULT,
      reason: ClassificationReason.OK,
      detail: `status ${status}`,
      retryAfterMs,
    });
  }

  // -------------------------------------------------------------------------
  // 5. 1xx, 3xx, and anything else that should not be here.
  // -------------------------------------------------------------------------
  // The HTTP client follows redirects and consumes informational responses, so
  // reaching this line means the client behaved unexpectedly — our problem, not
  // the provider's. The default for anything unrecognised is the class with no
  // penalty: when classification is uncertain, fail toward not penalising.
  return {
    responseClass: ResponseClass.SYSTEM_ERROR,
    reason: ClassificationReason.UPSTREAM_UNEXPECTED_STATUS,
    detail: `status ${status}`,
    retryAfterMs,
  };
}

/**
 * The gate every candidate `DATA_RESULT` passes through.
 *
 * This runs for policy-promoted statuses as well as for 2xx, rather than
 * returning immediately on a policy match. The reason: `dataResultStatuses` is
 * the only route by which a
 * non-2xx becomes slashable, and a tool owner declaring "404 means not-found
 * here" is making a claim about the *status*, not a waiver on whether the body
 * arrived intact. Returning early would let a truncated or HTML-substituted
 * body reach verification on exactly the path that has the least oversight.
 *
 * Three ways out, in order:
 */
function applyBodyGate(
  body: ResponseBody,
  policy: ClassificationPolicy,
  candidate: Classification,
): Classification {
  // (a) Zero bytes.
  //
  // A `DATA_RESULT` is "a 2xx with a body", and this is that
  // clause enforced. It is worth being precise about what is being excluded,
  // because it is a narrow thing: `{"results": []}` is NOT empty — that is a
  // present, parseable, honest "I found nothing", it goes to verification, and
  // `EMPTY_CONFIRMED` is a first-class verdict for it. What is excluded is a
  // body of zero bytes, which carries no answer at all and is what a load
  // balancer that dropped the payload produces. Since we cannot distinguish
  // "the provider sent nothing" from "something between us ate it", the class
  // is SYSTEM_ERROR. Tools where no-content is genuinely the answer opt in with
  // `acceptsEmptyBody`.
  if (body.kind === ResponseBodyKind.EMPTY && !policy.acceptsEmptyBody) {
    return {
      responseClass: ResponseClass.SYSTEM_ERROR,
      reason: ClassificationReason.BODY_EMPTY,
      detail: `${candidate.detail ?? ''} with an empty body`.trim(),
      retryAfterMs: candidate.retryAfterMs,
    };
  }

  // (b) Bytes that are not JSON.
  //
  // A tool contract is a JSON `outputSchema`, so bytes we cannot parse cannot
  // be measured against it. In the field this is overwhelmingly an
  // intermediary's HTML — a proxy error page, a WAF block, a captive portal —
  // arriving with a 200 the provider never sent. Handing that to verification
  // produces a guaranteed FAIL and a strike for an infrastructure event, which
  // is the precise harm the classifier exists to prevent. "Malformed response
  // body" is a SYSTEM_ERROR for this reason.
  //
  // The counter-argument — a provider genuinely returning garbage deserves the
  // FAIL — is real, and it is not enough. We cannot tell the two apart from
  // here, and the rule when we cannot tell is to fail toward not penalising.
  // Tools that legitimately serve text or CSV set `acceptsNonJsonBody`.
  if (body.kind === ResponseBodyKind.NON_JSON && !policy.acceptsNonJsonBody) {
    return {
      responseClass: ResponseClass.SYSTEM_ERROR,
      reason: ClassificationReason.BODY_NOT_JSON,
      detail: `${candidate.detail ?? ''}: ${body.detail}`.trim(),
      retryAfterMs: candidate.retryAfterMs,
    };
  }

  // (c) A success status wrapped around an error envelope.
  //
  //   HTTP 200 OK
  //   { "error": "rate limit exceeded", "code": "RATE_LIMITED" }
  //
  // Common enough to be a default check rather than something verification is
  // left to discover. The status says success; the provider is telling us it is
  // overloaded. Calling it DATA_RESULT would send it to verification, fail it,
  // and record a strike for what is plainly an availability problem — the 429
  // mistake, wearing a 200.
  if (body.kind === ResponseBodyKind.JSON) {
    const predicate = policy.bodyPredicates?.find((p) => p.matches(body.value));
    if (predicate) {
      return {
        responseClass: ResponseClass.SYSTEM_ERROR,
        reason: ClassificationReason.BODY_PREDICATE_MATCHED,
        detail: `body predicate "${predicate.id}" matched`,
        retryAfterMs: candidate.retryAfterMs,
      };
    }

    if (looksLikeErrorEnvelope(body.value)) {
      return {
        responseClass: ResponseClass.SYSTEM_ERROR,
        reason: ClassificationReason.BODY_ERROR_ENVELOPE,
        detail: `${candidate.detail ?? ''} with an error envelope`.trim(),
        retryAfterMs: candidate.retryAfterMs,
      };
    }
  }

  return candidate;
}

/**
 * Is this 2xx body actually the provider reporting a failure?
 *
 * Deliberately conservative in one specific way: an `error` field *alongside* a
 * `data` or `results` field is a partial success and is passed through to
 * verification, which is far better equipped to judge "half the answer plus a
 * warning" than a structural check is. Only an envelope that carries an error
 * and no payload is treated as one.
 *
 * The conservatism runs in the safe direction here, which is worth stating
 * because it runs the opposite way to the body gate above: a false positive in
 * this function costs a verifiable call (we void something that was fine), a
 * false negative costs a provider a strike for an outage. Both are errors; only
 * the second one takes money.
 */
function looksLikeErrorEnvelope(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;

  const record = body as Record<string, unknown>;
  const hasPayload = 'data' in record || 'results' in record;

  // `error: null` is the widest convention for "no error", and treating the
  // mere presence of the key as a failure would void every response from every
  // provider that uses it.
  const hasErrorField =
    ('error' in record && record.error !== null && record.error !== false) ||
    ('errors' in record && isNonEmptyErrors(record.errors));

  if (hasErrorField && !hasPayload) return true;

  // An explicit self-report. Trusted even next to a payload, because unlike an
  // `error` key this is unambiguous: the provider is not describing a field,
  // it is describing the call.
  return record.success === false || record.status === 'error';
}

function isNonEmptyErrors(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined && value !== false;
}

/**
 * The mapping engine's fault attribution, translated into a class.
 *
 * This is the consumer of `MappingFault`. The
 * mapping engine reports who it believes is at fault, and only this function
 * turns that belief into a consequence — the engine deliberately does not
 * classify, because "who wrote the broken thing" and "whose stake is reachable"
 * are different questions and the second one is the one with money attached.
 *
 * A mapping failure means the response never became a tool-contract document,
 * so this classification *replaces* the status-derived one. The three cases:
 *
 * - `AGENT` — the arguments did not satisfy the tool's `inputSchema`. The call
 *   never reached the provider, or reached it carrying the agent's mistake.
 *   `REQUEST_ERROR`, no charge, nobody penalised.
 * - `PLATFORM` — our selector pointed at a field this provider never had. The
 *   provider served a response and *we* failed to read it. `SYSTEM_ERROR`, and
 *   this is the case the whole fault split exists to protect: a mistyped
 *   JSONPath in our own binding must never look like provider garbage.
 * - `PROVIDER` — the mapping resolved and the data was wrong: null where a
 *   value is required, a string where a number belongs, an empty collection
 *   where the contract promises results. `DATA_RESULT` — the provider returned
 *   data and the data is the problem, which is exactly the question
 *   verification exists to answer. Note this is the only fault that reaches a
 *   slashable class, and it still only *reaches* it: verification decides, and
 *   an unverifiable mapping failure is not itself a verdict.
 */
export function classifyMappingFault(fault: MappingFault): Classification {
  switch (fault) {
    case MappingFault.AGENT:
      return {
        responseClass: ResponseClass.REQUEST_ERROR,
        reason: ClassificationReason.MAPPING_FAULT_AGENT,
        detail: 'tool arguments did not satisfy the input schema',
      };
    case MappingFault.PLATFORM:
      return {
        responseClass: ResponseClass.SYSTEM_ERROR,
        reason: ClassificationReason.MAPPING_FAULT_PLATFORM,
        detail: 'our mapping could not read the response the provider served',
      };
    case MappingFault.PROVIDER:
      return {
        responseClass: ResponseClass.DATA_RESULT,
        reason: ClassificationReason.MAPPING_FAULT_PROVIDER,
        detail: 'the mapping resolved and the payload did not honour the contract',
      };
  }
}
