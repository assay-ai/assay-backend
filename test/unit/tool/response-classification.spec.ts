/**
 * The case matrix for the response classifier.
 *
 * One row per case, one test per row. Adding a case means adding a row to
 * {@link CASES} and nothing else — the per-case suite, the coverage check and
 * the "no non-DATA_RESULT row is slashable" invariant all read the same table,
 * so a row that is added is a row that is enforced three ways.
 *
 * The invariant at the bottom is the reason this file exists in this shape.
 * The slash-policy-by-class table is the one that "must not be wrong":
 * `SYSTEM_ERROR` and `REQUEST_ERROR` never touch a provider's stake. That is a
 * property of the whole table, not of any one row, and it is asserted as one.
 */
import {
  ClassificationPolicy,
  MAX_RESPONSE_JSON_DEPTH,
  ClassificationReason,
  ProviderResponse,
  RESPONSE_CLASS_CONSEQUENCE,
  ResponseBodyKind,
  ResponseClass,
  TransportErrorKind,
  canEverSlash,
  classifyMappingFault,
  classifyResponse,
  isRetryable,
  parseRetryAfter,
  reachesVerification,
  readResponseBody,
} from '@modules/tool/domain/classification';
import { MappingFault } from '@modules/tool/domain/mapping';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOOL = 'search_web';

const DEFAULT_POLICY: ClassificationPolicy = { toolId: TOOL };

/** A lookup tool: "not found" is a real answer, and it comes with no body. */
const LOOKUP_POLICY: ClassificationPolicy = {
  toolId: 'lookup_company',
  dataResultStatuses: [404],
  acceptsEmptyBody: true,
};

/** A tool whose provider credentials are ours to keep working. */
const CREDENTIALLED_POLICY: ClassificationPolicy = {
  toolId: 'premium_feed',
  systemErrorStatuses: [401, 403],
};

const NON_JSON_POLICY: ClassificationPolicy = { toolId: 'export_csv', acceptsNonJsonBody: true };

const PREDICATE_POLICY: ClassificationPolicy = {
  toolId: 'flaky_feed',
  bodyPredicates: [
    {
      id: 'quota-exhausted',
      matches: (body) =>
        typeof body === 'object' &&
        body !== null &&
        !Array.isArray(body) &&
        (body as Record<string, unknown>).quota_remaining === 0,
    },
  ],
};

/** A response that reached the application layer. */
function http(
  status: number,
  rawBody?: string | null,
  headers?: Record<string, string>,
): ProviderResponse {
  return { status, headers, body: readResponseBody(rawBody) };
}

/** A response that never did. `status` is 0 by convention — none was received. */
function transport(kind: TransportErrorKind, partialBody?: string | null): ProviderResponse {
  return {
    status: 0,
    body: readResponseBody(null),
    transportError: { kind, partialBody: partialBody ?? null, detail: `simulated ${kind}` },
  };
}

const OK_BODY = '{"results":[{"title":"x"}]}';

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

interface Case {
  /** Used as the test name, so it reads as the case, not as an id. */
  readonly name: string;
  readonly response: ProviderResponse;
  readonly policy: ClassificationPolicy;
  readonly expected: ResponseClass;
  readonly reason: ClassificationReason;
  /** Set only where the case is about `Retry-After`. */
  readonly retryAfterMs?: number | null;
  /** Statuses this row is the designated coverage for. */
  readonly covers?: number;
}

const CASES: readonly Case[] = [
  // --- one row per representative status code -----------------------------
  {
    name: '500 Internal Server Error → SYSTEM_ERROR (their infrastructure, not their data)',
    response: http(500, '{"error":"boom"}'),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.SYSTEM_ERROR,
    reason: ClassificationReason.UPSTREAM_SERVER_ERROR,
    covers: 500,
  },
  {
    name: '502 Bad Gateway → SYSTEM_ERROR',
    response: http(502, '<html>bad gateway</html>'),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.SYSTEM_ERROR,
    reason: ClassificationReason.UPSTREAM_SERVER_ERROR,
    covers: 502,
  },
  {
    name: '503 Service Unavailable → SYSTEM_ERROR',
    response: http(503, null),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.SYSTEM_ERROR,
    reason: ClassificationReason.UPSTREAM_SERVER_ERROR,
    covers: 503,
  },
  {
    name: '429 Too Many Requests → SYSTEM_ERROR (a rate limit is capacity, not dishonesty)',
    response: http(429, '{"error":"slow down"}'),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.SYSTEM_ERROR,
    reason: ClassificationReason.UPSTREAM_RATE_LIMITED,
    covers: 429,
  },
  {
    name: '400 Bad Request → REQUEST_ERROR',
    response: http(400, '{"error":"missing q"}'),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.REQUEST_ERROR,
    reason: ClassificationReason.REQUEST_REJECTED,
    covers: 400,
  },
  {
    name: '401 Unauthorized → REQUEST_ERROR by default (still no penalty for anyone)',
    response: http(401, '{"error":"bad key"}'),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.REQUEST_ERROR,
    reason: ClassificationReason.REQUEST_REJECTED,
    covers: 401,
  },
  {
    name: '404 Not Found → REQUEST_ERROR by default (a search tool 404 is a routing bug)',
    response: http(404, '{"error":"no such path"}'),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.REQUEST_ERROR,
    reason: ClassificationReason.REQUEST_REJECTED,
    covers: 404,
  },
  {
    name: '422 Unprocessable Entity → REQUEST_ERROR',
    response: http(422, '{"error":"lang not supported"}'),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.REQUEST_ERROR,
    reason: ClassificationReason.REQUEST_REJECTED,
    covers: 422,
  },

  // --- the hard cases -----------------------------------------------------
  {
    name: '200 with an empty body → SYSTEM_ERROR (indistinguishable from a dropped payload)',
    response: http(200, ''),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.SYSTEM_ERROR,
    reason: ClassificationReason.BODY_EMPTY,
  },
  {
    name: '200 with a whitespace-only body → SYSTEM_ERROR (same case, flushed headers only)',
    response: http(200, '\n   \n'),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.SYSTEM_ERROR,
    reason: ClassificationReason.BODY_EMPTY,
  },
  {
    name: '200 with a non-JSON body → SYSTEM_ERROR (a proxy error page is not an answer)',
    response: http(200, '<html><body>502 from the edge</body></html>', {
      'content-type': 'application/json',
    }),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.SYSTEM_ERROR,
    reason: ClassificationReason.BODY_NOT_JSON,
  },
  {
    name: '200 with a truncated JSON body → SYSTEM_ERROR (unparseable is unparseable)',
    response: http(200, '{"results":[{"title":"x"'),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.SYSTEM_ERROR,
    reason: ClassificationReason.BODY_NOT_JSON,
  },
  {
    name: '503 with Retry-After → SYSTEM_ERROR, and the delay is carried as advice',
    response: http(503, null, { 'retry-after': '120' }),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.SYSTEM_ERROR,
    reason: ClassificationReason.UPSTREAM_SERVER_ERROR,
    retryAfterMs: 120_000,
    covers: 503,
  },
  {
    name: '429 with Retry-After → SYSTEM_ERROR, delay carried',
    response: http(429, null, { 'retry-after': '30' }),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.SYSTEM_ERROR,
    reason: ClassificationReason.UPSTREAM_RATE_LIMITED,
    retryAfterMs: 30_000,
  },
  {
    name: 'timeout half-way through the body → SYSTEM_ERROR, partial bytes never promoted',
    response: transport(TransportErrorKind.TIMEOUT, '{"results":[{"title":"x"'),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.SYSTEM_ERROR,
    reason: ClassificationReason.TRANSPORT_TIMEOUT,
  },
  {
    name: 'connection closed abruptly → SYSTEM_ERROR',
    response: transport(TransportErrorKind.CONNECTION_RESET, '{"resu'),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.SYSTEM_ERROR,
    reason: ClassificationReason.TRANSPORT_CONNECTION_RESET,
  },
  {
    name: 'connection refused → SYSTEM_ERROR',
    response: transport(TransportErrorKind.CONNECTION_REFUSED),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.SYSTEM_ERROR,
    reason: ClassificationReason.TRANSPORT_CONNECTION_REFUSED,
  },
  {
    name: 'DNS failure → SYSTEM_ERROR',
    response: transport(TransportErrorKind.DNS_FAILURE),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.SYSTEM_ERROR,
    reason: ClassificationReason.TRANSPORT_DNS_FAILURE,
  },
  {
    name: 'TLS handshake failure → SYSTEM_ERROR',
    response: transport(TransportErrorKind.TLS_FAILURE),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.SYSTEM_ERROR,
    reason: ClassificationReason.TRANSPORT_TLS_FAILURE,
  },
  {
    name: 'declared body length not delivered → SYSTEM_ERROR',
    response: transport(TransportErrorKind.BODY_TRUNCATED, '{"results":['),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.SYSTEM_ERROR,
    reason: ClassificationReason.TRANSPORT_BODY_TRUNCATED,
  },
  {
    name: 'an endpoint whose scheme production refuses → SYSTEM_ERROR, named HTTPS_REQUIRED',
    response: transport(TransportErrorKind.SCHEME_NOT_ALLOWED),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.SYSTEM_ERROR,
    reason: ClassificationReason.TRANSPORT_HTTPS_REQUIRED,
  },
  {
    name: 'an unrecognised transport failure → SYSTEM_ERROR (uncertainty never penalises)',
    response: transport(TransportErrorKind.UNKNOWN),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.SYSTEM_ERROR,
    reason: ClassificationReason.TRANSPORT_UNKNOWN,
  },

  // --- 2xx bodies that are really errors -----------------------------------
  {
    name: '200 with an error envelope and no payload → SYSTEM_ERROR',
    response: http(200, '{"error":"rate limit exceeded","code":"RATE_LIMITED"}'),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.SYSTEM_ERROR,
    reason: ClassificationReason.BODY_ERROR_ENVELOPE,
  },
  {
    name: '200 with success:false → SYSTEM_ERROR even next to a payload (an explicit self-report)',
    response: http(200, '{"success":false,"data":{"partial":true}}'),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.SYSTEM_ERROR,
    reason: ClassificationReason.BODY_ERROR_ENVELOPE,
  },
  {
    name: '200 with an error field ALONGSIDE data → DATA_RESULT (partial success is verification’s call)',
    response: http(200, '{"error":"one shard timed out","results":[{"title":"x"}]}'),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.DATA_RESULT,
    reason: ClassificationReason.OK,
  },
  {
    name: '200 with error:null → DATA_RESULT (the widest "no error" convention there is)',
    response: http(200, '{"error":null,"payload":{"title":"x"}}'),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.DATA_RESULT,
    reason: ClassificationReason.OK,
  },
  {
    name: '200 with errors:[] → DATA_RESULT (an empty error list is not an error)',
    response: http(200, '{"errors":[],"payload":{"title":"x"}}'),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.DATA_RESULT,
    reason: ClassificationReason.OK,
  },
  {
    name: 'a tool predicate matching a 200 → SYSTEM_ERROR',
    response: http(200, '{"results":[],"quota_remaining":0}'),
    policy: PREDICATE_POLICY,
    expected: ResponseClass.SYSTEM_ERROR,
    reason: ClassificationReason.BODY_PREDICATE_MATCHED,
  },

  // --- the DATA_RESULT boundary -------------------------------------------
  {
    name: '200 with results → DATA_RESULT',
    response: http(200, OK_BODY),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.DATA_RESULT,
    reason: ClassificationReason.OK,
    covers: 200,
  },
  {
    name: '200 with an EMPTY result set → DATA_RESULT (data arrived; verification judges it)',
    response: http(200, '{"results":[]}'),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.DATA_RESULT,
    reason: ClassificationReason.OK,
  },
  {
    name: '201 with a body → DATA_RESULT (the whole 2xx range, not just 200)',
    response: http(201, OK_BODY),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.DATA_RESULT,
    reason: ClassificationReason.OK,
  },
  {
    name: '204 No Content → SYSTEM_ERROR by default (nothing to verify, so nothing to charge for)',
    response: http(204, null),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.SYSTEM_ERROR,
    reason: ClassificationReason.BODY_EMPTY,
  },

  // --- per-tool policy -----------------------------------------------------
  {
    name: 'a lookup tool declaring 404 a real answer → DATA_RESULT',
    response: http(404, '{"found":false}'),
    policy: LOOKUP_POLICY,
    expected: ResponseClass.DATA_RESULT,
    reason: ClassificationReason.POLICY_DATA_RESULT_STATUS,
  },
  {
    name: 'a lookup tool declaring 404 a real answer, with an empty body → DATA_RESULT (opted in)',
    response: http(404, ''),
    policy: LOOKUP_POLICY,
    expected: ResponseClass.DATA_RESULT,
    reason: ClassificationReason.POLICY_DATA_RESULT_STATUS,
  },
  {
    name: 'a policy-promoted 404 carrying an HTML page → SYSTEM_ERROR (the gate still runs)',
    response: http(404, '<html>not found</html>'),
    policy: LOOKUP_POLICY,
    expected: ResponseClass.SYSTEM_ERROR,
    reason: ClassificationReason.BODY_NOT_JSON,
  },
  {
    name: 'a policy-promoted 404 carrying an error envelope → SYSTEM_ERROR (the gate still runs)',
    response: http(404, '{"error":"upstream quota exhausted"}'),
    policy: LOOKUP_POLICY,
    expected: ResponseClass.SYSTEM_ERROR,
    reason: ClassificationReason.BODY_ERROR_ENVELOPE,
  },
  {
    name: '401 on a tool that declares it ours to fix → SYSTEM_ERROR',
    response: http(401, '{"error":"expired key"}'),
    policy: CREDENTIALLED_POLICY,
    expected: ResponseClass.SYSTEM_ERROR,
    reason: ClassificationReason.POLICY_SYSTEM_ERROR_STATUS,
  },
  {
    name: '403 on a tool that declares it ours to fix → SYSTEM_ERROR',
    response: http(403, '{"error":"forbidden"}'),
    policy: CREDENTIALLED_POLICY,
    expected: ResponseClass.SYSTEM_ERROR,
    reason: ClassificationReason.POLICY_SYSTEM_ERROR_STATUS,
  },
  {
    name: 'a CSV tool receiving CSV → DATA_RESULT (opted in)',
    response: http(200, 'name,score\nx,1\n'),
    policy: NON_JSON_POLICY,
    expected: ResponseClass.DATA_RESULT,
    reason: ClassificationReason.OK,
  },
  {
    name: 'a policy cannot promote a timeout — transport is decided before policy',
    response: transport(TransportErrorKind.TIMEOUT),
    policy: LOOKUP_POLICY,
    expected: ResponseClass.SYSTEM_ERROR,
    reason: ClassificationReason.TRANSPORT_TIMEOUT,
  },

  // --- statuses that should never arrive -----------------------------------
  {
    name: '302 reaching the classifier → SYSTEM_ERROR (our client should have followed it)',
    response: http(302, null, { location: 'https://elsewhere.example' }),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.SYSTEM_ERROR,
    reason: ClassificationReason.UPSTREAM_UNEXPECTED_STATUS,
  },
  {
    name: '100 Continue reaching the classifier → SYSTEM_ERROR',
    response: http(100, null),
    policy: DEFAULT_POLICY,
    expected: ResponseClass.SYSTEM_ERROR,
    reason: ClassificationReason.UPSTREAM_UNEXPECTED_STATUS,
  },
];

// ---------------------------------------------------------------------------
// One test per row
// ---------------------------------------------------------------------------

describe('response classifier — case matrix', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    const result = classifyResponse(testCase.response, testCase.policy);

    expect(result.responseClass).toBe(testCase.expected);
    expect(result.reason).toBe(testCase.reason);

    if (testCase.retryAfterMs !== undefined) {
      expect(result.retryAfterMs).toBe(testCase.retryAfterMs);
    }
  });
});

// ---------------------------------------------------------------------------
// Properties of the table as a whole
// ---------------------------------------------------------------------------

describe('response classifier — the table as a whole', () => {
  const REQUIRED_STATUSES = [500, 502, 503, 429, 400, 401, 404, 422];

  it('covers every required status code', () => {
    const covered = new Set(CASES.map((c) => c.covers).filter((s): s is number => s !== undefined));
    expect(REQUIRED_STATUSES.filter((s) => !covered.has(s))).toEqual([]);
  });

  it('reaches every classification reason the classifier can produce, except the mapping ones', () => {
    const produced = new Set(CASES.map((c) => c.reason));
    const unreached = Object.values(ClassificationReason).filter(
      (reason) => !produced.has(reason) && !reason.startsWith('MAPPING_FAULT_'),
    );
    expect(unreached).toEqual([]);
  });

  /**
   * The load-bearing assertion. Every row that is not a `DATA_RESULT` must be
   * unable to reach the provider's stake, checked through the same helper the
   * settlement path calls rather than by re-stating the rule here.
   */
  it('lets no SYSTEM_ERROR or REQUEST_ERROR case reach verification or a slash', () => {
    const offenders = CASES.filter((c) => c.expected !== ResponseClass.DATA_RESULT).filter(
      (c) =>
        canEverSlash(classifyResponse(c.response, c.policy).responseClass) ||
        reachesVerification(classifyResponse(c.response, c.policy).responseClass),
    );
    expect(offenders.map((c) => c.name)).toEqual([]);
  });

  it('sends every DATA_RESULT case to verification and nowhere else', () => {
    const dataRows = CASES.filter((c) => c.expected === ResponseClass.DATA_RESULT);
    expect(dataRows.length).toBeGreaterThan(0);
    for (const row of dataRows) {
      const { responseClass } = classifyResponse(row.response, row.policy);
      expect(reachesVerification(responseClass)).toBe(true);
      expect(isRetryable(responseClass)).toBe(false);
    }
  });

  it('prints the matrix', () => {
    const rows = CASES.map((c) => {
      const actual = classifyResponse(c.response, c.policy);
      return [
        c.expected.padEnd(13),
        canEverSlash(actual.responseClass) ? 'slashable' : 'no-slash ',
        actual.reason.padEnd(30),
        c.name,
      ].join('  ');
    });
    // Printed, not asserted: the assertions are the tests above. This exists so
    // the run output shows the whole policy at a glance during review.
    console.log(`\n${rows.join('\n')}\n`);
    expect(rows).toHaveLength(CASES.length);
  });
});

// ---------------------------------------------------------------------------
// The slash policy itself
// ---------------------------------------------------------------------------

describe('slash policy by class ("must not be wrong")', () => {
  it('never settles, strikes, verifies or slashes a SYSTEM_ERROR', () => {
    expect(RESPONSE_CLASS_CONSEQUENCE[ResponseClass.SYSTEM_ERROR]).toEqual({
      settle: false,
      strike: false,
      verify: false,
      slashable: false,
      metric: 'availability',
    });
  });

  it('never settles, strikes, verifies or slashes a REQUEST_ERROR', () => {
    expect(RESPONSE_CLASS_CONSEQUENCE[ResponseClass.REQUEST_ERROR]).toEqual({
      settle: false,
      strike: false,
      verify: false,
      slashable: false,
      metric: 'compatibility',
    });
  });

  it('makes DATA_RESULT the only class that can reach stake', () => {
    const slashable = Object.values(ResponseClass).filter(canEverSlash);
    expect(slashable).toEqual([ResponseClass.DATA_RESULT]);
  });

  it('retries SYSTEM_ERROR only', () => {
    const retryable = Object.values(ResponseClass).filter(isRetryable);
    expect(retryable).toEqual([ResponseClass.SYSTEM_ERROR]);
  });
});

// ---------------------------------------------------------------------------
// The mapping-fault bridge (mapping engine → classifier)
// ---------------------------------------------------------------------------

describe('mapping fault → class', () => {
  it('blames nobody for the agent’s arguments', () => {
    const result = classifyMappingFault(MappingFault.AGENT);
    expect(result.responseClass).toBe(ResponseClass.REQUEST_ERROR);
    expect(canEverSlash(result.responseClass)).toBe(false);
  });

  it('never lets our own broken selector look like provider garbage', () => {
    const result = classifyMappingFault(MappingFault.PLATFORM);
    expect(result.responseClass).toBe(ResponseClass.SYSTEM_ERROR);
    expect(canEverSlash(result.responseClass)).toBe(false);
  });

  it('sends a resolved-but-wrong payload to verification', () => {
    const result = classifyMappingFault(MappingFault.PROVIDER);
    expect(result.responseClass).toBe(ResponseClass.DATA_RESULT);
    expect(reachesVerification(result.responseClass)).toBe(true);
  });

  it('covers every fault the mapping engine can report', () => {
    for (const fault of Object.values(MappingFault)) {
      expect(classifyMappingFault(fault).responseClass).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Body reading and Retry-After, at the edges
// ---------------------------------------------------------------------------

describe('readResponseBody', () => {
  it('treats absent, empty and whitespace-only bodies as EMPTY', () => {
    expect(readResponseBody(null).kind).toBe(ResponseBodyKind.EMPTY);
    expect(readResponseBody(undefined).kind).toBe(ResponseBodyKind.EMPTY);
    expect(readResponseBody('').kind).toBe(ResponseBodyKind.EMPTY);
    expect(readResponseBody('  \r\n ').kind).toBe(ResponseBodyKind.EMPTY);
  });

  it('parses JSON regardless of a content-type that disagrees', () => {
    const body = readResponseBody('{"a":1}', 'text/plain');
    expect(body.kind).toBe(ResponseBodyKind.JSON);
  });

  it('reports non-JSON regardless of a content-type that claims otherwise', () => {
    const body = readResponseBody('<html></html>', 'application/json');
    expect(body.kind).toBe(ResponseBodyKind.NON_JSON);
    if (body.kind === ResponseBodyKind.NON_JSON) {
      expect(body.detail).toContain('application/json');
    }
  });

  it('keeps a bare JSON scalar as JSON', () => {
    expect(readResponseBody('42').kind).toBe(ResponseBodyKind.JSON);
    expect(readResponseBody('null').kind).toBe(ResponseBodyKind.JSON);
  });

  // Review P-3: V8 parses 100 000 levels, but the recursive serialisers after
  // it (job payload, canonicalJson, jsonb) throw, and the hold was stranded.
  it('refuses a body nested past the depth limit as NON_JSON, so the call is not charged', () => {
    const deep = `{"x":${'['.repeat(100_000)}${']'.repeat(100_000)}}`;
    const body = readResponseBody(deep);

    expect(body.kind).toBe(ResponseBodyKind.NON_JSON);
    expect(classifyResponse({ status: 200, body }, { toolId: 't' }).responseClass).toBe(
      ResponseClass.SYSTEM_ERROR,
    );
  });

  it('accepts nesting at the limit and ignores brackets inside strings', () => {
    const atLimit = `${'['.repeat(MAX_RESPONSE_JSON_DEPTH)}${']'.repeat(MAX_RESPONSE_JSON_DEPTH)}`;
    expect(readResponseBody(atLimit).kind).toBe(ResponseBodyKind.JSON);
    expect(readResponseBody(`{"s":"${'['.repeat(1000)}\\"{"}`).kind).toBe(ResponseBodyKind.JSON);
    expect(readResponseBody(`[${atLimit}]`).kind).toBe(ResponseBodyKind.NON_JSON);
  });
});

describe('parseRetryAfter', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('120')).toBe(120_000);
  });

  it('reads an HTTP-date against an injected clock', () => {
    const now = Date.parse('Wed, 21 Oct 2015 07:28:00 GMT');
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:29:00 GMT', now)).toBe(60_000);
  });

  it('clamps a date in the past to zero rather than going negative', () => {
    const now = Date.parse('Wed, 21 Oct 2015 07:30:00 GMT');
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', now)).toBe(0);
  });

  it('refuses to guess at a date with no clock supplied', () => {
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT')).toBeNull();
  });

  it('returns null for absent or unparseable values', () => {
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });

  it('never changes the class it travels with', () => {
    const withHeader = classifyResponse(http(503, null, { 'retry-after': '600' }), DEFAULT_POLICY);
    const without = classifyResponse(http(503, null), DEFAULT_POLICY);
    expect(withHeader.responseClass).toBe(without.responseClass);
    expect(withHeader.retryAfterMs).toBe(600_000);
    expect(without.retryAfterMs).toBeNull();
  });
});
