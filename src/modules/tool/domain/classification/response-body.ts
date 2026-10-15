/**
 * Reading a provider's response body into the three shapes classification can
 * reason about.
 *
 * The split is `EMPTY` / `JSON` / `NON_JSON` and not "parsed or not", because
 * the two failure shapes attribute differently in the router's eyes even though
 * both are `SYSTEM_ERROR` by default: an empty body is usually an intermediary
 * that dropped the payload, and a non-JSON body is usually an intermediary that
 * *substituted* one — a proxy's HTML error page, a captive portal, a WAF block
 * page. Neither is the provider telling us anything about data quality.
 */

import { JsonValue } from '../mapping/mapping.types';
import { ResponseBody, ResponseBodyKind } from './classification.types';

const EMPTY_BODY: ResponseBody = Object.freeze({ kind: ResponseBodyKind.EMPTY });

/**
 * The deepest object/array nesting a provider body may have.
 *
 * V8's `JSON.parse` copes with 100 000 levels; the recursive serialisers
 * downstream of it (the verification job payload, `canonicalJson`, the `jsonb`
 * column, the MCP reply) do not, and a body that parses here but cannot be
 * written there strands the agent's hold after the call has already been
 * charged. No real tool output comes near 64 levels.
 */
export const MAX_RESPONSE_JSON_DEPTH = 64;

/**
 * Parse raw response bytes.
 *
 * `contentType` is accepted but deliberately **not** trusted to decide the
 * kind. A provider that sends `application/json` and a body of `<html>` has
 * sent non-JSON; a provider that sends `text/plain` and a body of `{"a":1}` has
 * sent JSON. What we can actually parse is the fact; the header is a claim, and
 * classification runs on facts because a claim is exactly what a broken
 * intermediary gets wrong. The header survives only as `detail`, to make the
 * mismatch visible on the receipt.
 *
 * Whitespace-only is `EMPTY`, not `NON_JSON`: a body of `"\n"` is what a proxy
 * that flushed headers and nothing else produces, and calling that a malformed
 * payload would point the provider at their serialiser instead of their edge.
 */
export function readResponseBody(
  raw: string | null | undefined,
  contentType?: string | null,
): ResponseBody {
  if (raw === null || raw === undefined || raw.trim().length === 0) {
    return EMPTY_BODY;
  }

  const depth = jsonNestingDepth(raw);
  if (depth > MAX_RESPONSE_JSON_DEPTH) {
    return {
      kind: ResponseBodyKind.NON_JSON,
      raw,
      detail:
        `JSON nested deeper than ${MAX_RESPONSE_JSON_DEPTH} levels` +
        (contentType ? ` (content-type: ${contentType})` : '') +
        ` (${raw.length} bytes)`,
    };
  }

  try {
    return { kind: ResponseBodyKind.JSON, value: JSON.parse(raw) as JsonValue };
  } catch (error) {
    return {
      kind: ResponseBodyKind.NON_JSON,
      raw,
      detail:
        `${(error as Error).message}` +
        (contentType ? ` (content-type: ${contentType})` : '') +
        ` (${raw.length} bytes)`,
    };
  }
}

/**
 * The deepest `{`/`[` nesting in `raw`, ignoring brackets inside strings.
 *
 * A linear scan rather than a reviver: it runs before `JSON.parse`, so an
 * over-deep body is refused without ever being materialised. It does not
 * validate — malformed input is left for `JSON.parse` to reject.
 */
function jsonNestingDepth(raw: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw.charCodeAt(i);
    if (inString) {
      if (char === 0x5c /* \ */) i += 1;
      else if (char === 0x22 /* " */) inString = false;
    } else if (char === 0x22) {
      inString = true;
    } else if (char === 0x7b /* { */ || char === 0x5b /* [ */) {
      depth += 1;
      if (depth > max) max = depth;
    } else if (char === 0x7d /* } */ || char === 0x5d /* ] */) {
      depth -= 1;
    }
  }

  return max;
}

/**
 * `Retry-After`, in milliseconds, or `null` if absent/unparseable.
 *
 * Both wire forms are accepted — delta-seconds (`Retry-After: 120`) and
 * HTTP-date (`Retry-After: Wed, 21 Oct 2015 07:28:00 GMT`). The date form needs
 * a clock, so the clock is a parameter: this module reads no wall time of its
 * own, which is what keeps a stored receipt re-classifiable to the same answer
 * during a dispute. With no `nowMs` supplied, the date form yields `null`
 * rather than a guess.
 *
 * A negative or nonsense value clamps to `0` — an upstream naming a moment in
 * the past is saying "now", not "never".
 */
export function parseRetryAfter(value: string | undefined | null, nowMs?: number): number | null {
  if (!value) return null;

  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  if (nowMs === undefined) return null;

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}
