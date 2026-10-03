/**
 * Table-driven case matrix for the mapping engine.
 *
 * `backend/src/modules/tool/domain/mapping/mapping.types.ts` is the authoritative
 * contract; this suite exercises the functions the barrel at
 * `@modules/tool/domain/mapping` is expected to export against it, and is
 * never stubbed to make it pass.
 *
 * House style: assert on error CODES via `expectErrorCode`
 * (`test/unit/helpers/expect-error-code.ts`), never on message text.
 */
import {
  EmptyPolicy,
  NullPolicy,
  mapRequest,
  mapResponse,
  normalizeMappingNode,
  normalizeRequestMapping,
  normalizeResponseMapping,
  readPath,
  validateRequestMapping,
  validateResponseMapping,
} from '@modules/tool/domain/mapping';
import type {
  JsonObject,
  JsonSchema,
  JsonValue,
  RequestMappingSpec,
  ResponseMappingSpec,
} from '@modules/tool/domain/mapping';
import { ToolErrorCode } from '@modules/tool/errors/tool.errors';
import { expectErrorCode } from '../helpers/expect-error-code';
import {
  NESTED_EXPECTED_OUTPUT,
  NESTED_RESPONSE_MAPPING,
  NESTED_UPSTREAM_RESPONSE,
  SEARCH_INPUT_SCHEMA,
  SEARCH_OUTPUT_SCHEMA,
  SEARCH_RESPONSE_MAPPING,
  SEARCH_UPSTREAM_EMPTY_RESPONSE,
} from './helpers/mapping-fixtures';

// ---------------------------------------------------------------------------
// The core case matrix: one shape shared by "missing required field", "wrong
// type", "empty array" and "path does not exist", because all four are
// the same question asked of `mapRequest` / `mapResponse` — does this
// spec+input(+schema) produce this value, or raise this code.
// ---------------------------------------------------------------------------

interface RequestCaseBase {
  readonly direction: 'REQUEST';
  readonly spec: RequestMappingSpec;
  readonly input: JsonObject;
  readonly inputSchema?: JsonSchema;
}

interface ResponseCaseBase {
  readonly direction: 'RESPONSE';
  readonly spec: ResponseMappingSpec;
  readonly upstream: JsonValue;
  readonly outputSchema?: JsonSchema;
}

type CoreRequestErrorCase = { readonly name: string } & RequestCaseBase & {
    readonly expectedError: ToolErrorCode;
  };
type CoreRequestValueCase = { readonly name: string } & RequestCaseBase & {
    readonly expectedValue: JsonValue;
  };
type CoreResponseErrorCase = { readonly name: string } & ResponseCaseBase & {
    readonly expectedError: ToolErrorCode;
  };
type CoreResponseValueCase = { readonly name: string } & ResponseCaseBase & {
    readonly expectedValue: JsonValue;
  };

type CoreCase =
  | CoreRequestErrorCase
  | CoreRequestValueCase
  | CoreResponseErrorCase
  | CoreResponseValueCase;

function runCoreCase(c: CoreCase): void {
  const run = (): unknown =>
    c.direction === 'REQUEST'
      ? mapRequest(c.spec, c.input, { inputSchema: c.inputSchema })
      : mapResponse(c.spec, c.upstream, { outputSchema: c.outputSchema });

  if ('expectedError' in c) {
    expectErrorCode(run, c.expectedError);
  } else {
    expect(run()).toEqual(c.expectedValue);
  }
}

describe('missing required field — both directions collapse to REQUIRED_FIELD_MISSING', () => {
  const CASES: readonly CoreCase[] = [
    {
      name: 'request: tool input omits a field inputSchema marks required',
      direction: 'REQUEST',
      // Deliberately does not reference `query` anywhere — isolates the
      // inputSchema check from selector resolution, which has its own
      // failure mode ("path does not exist") that must not be confused with this one.
      spec: { method: 'GET', path: '/v1/search/health' },
      input: {},
      inputSchema: SEARCH_INPUT_SCHEMA,
      expectedError: ToolErrorCode.TOOL_MAPPING_REQUIRED_FIELD_MISSING,
    },
    {
      name: 'response: outputSchema requires a field the mapping never produces',
      direction: 'RESPONSE',
      // The spec maps only `count`; `results` is absent from the produced
      // document entirely, not merely unresolved by a selector.
      spec: { count: { $path: '$.total' } },
      upstream: { total: 5 },
      outputSchema: SEARCH_OUTPUT_SCHEMA,
      expectedError: ToolErrorCode.TOOL_MAPPING_REQUIRED_FIELD_MISSING,
    },
  ];

  it.each(CASES)('$name', runCoreCase);
});

describe('wrong type', () => {
  const CASES: readonly CoreCase[] = [
    {
      name: 'response: a string mapped where the schema requires a number',
      direction: 'RESPONSE',
      spec: { total: { $path: '$.total' } },
      upstream: { total: 'five' },
      outputSchema: {
        type: 'object',
        required: ['total'],
        properties: { total: { type: 'number' } },
      },
      expectedError: ToolErrorCode.TOOL_MAPPING_TYPE_MISMATCH,
    },
    {
      name: 'response: a number mapped where the schema requires a string',
      direction: 'RESPONSE',
      spec: { title: { $path: '$.title' } },
      upstream: { title: 42 },
      outputSchema: {
        type: 'object',
        required: ['title'],
        properties: { title: { type: 'string' } },
      },
      expectedError: ToolErrorCode.TOOL_MAPPING_TYPE_MISMATCH,
    },
    {
      name: 'response: an object mapped where the schema requires an array',
      direction: 'RESPONSE',
      spec: { results: { $path: '$.results' } },
      upstream: { results: { not: 'an array' } },
      outputSchema: {
        type: 'object',
        required: ['results'],
        properties: {
          results: { type: 'array', items: { type: 'string' } },
        },
      },
      expectedError: ToolErrorCode.TOOL_MAPPING_TYPE_MISMATCH,
    },
    {
      name: 'response: a type union admits either member — a string satisfies [string, number]',
      direction: 'RESPONSE',
      spec: { total: { $path: '$.total' } },
      upstream: { total: '5' },
      outputSchema: {
        type: 'object',
        required: ['total'],
        properties: { total: { type: ['string', 'number'] } },
      },
      expectedValue: { total: '5' },
    },
    {
      name: 'request: a tool input field has the wrong type against inputSchema',
      direction: 'REQUEST',
      spec: { method: 'GET', path: '/v1/search/health' },
      input: { query: 12345 },
      inputSchema: SEARCH_INPUT_SCHEMA,
      expectedError: ToolErrorCode.TOOL_MAPPING_TYPE_MISMATCH,
    },
  ];

  it.each(CASES)('$name', runCoreCase);
});

describe('empty array — PASS maps to [], ERROR and schema minItems both reject it', () => {
  const CASES: readonly CoreCase[] = [
    {
      name: 'a. default $onEmpty (PASS) maps an empty collection to [] with no error',
      direction: 'RESPONSE',
      spec: SEARCH_RESPONSE_MAPPING,
      upstream: SEARCH_UPSTREAM_EMPTY_RESPONSE,
      expectedValue: { results: [] },
    },
    {
      name: 'b. $onEmpty: ERROR rejects a legitimately empty collection at that site',
      direction: 'RESPONSE',
      spec: {
        results: {
          $from: '$.data.items[*]',
          $item: { url: { $path: '$.link' } },
          $onEmpty: EmptyPolicy.ERROR,
        },
      },
      upstream: SEARCH_UPSTREAM_EMPTY_RESPONSE,
      expectedError: ToolErrorCode.TOOL_MAPPING_EMPTY_COLLECTION,
    },
    {
      name: 'c. schema minItems: 1 rejects it even though the mapping site itself allows empty',
      direction: 'RESPONSE',
      spec: SEARCH_RESPONSE_MAPPING, // $onEmpty defaults to PASS
      upstream: SEARCH_UPSTREAM_EMPTY_RESPONSE,
      outputSchema: {
        type: 'object',
        required: ['results'],
        properties: {
          results: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['url'],
              properties: { url: { type: 'string' } },
            },
          },
        },
      },
      expectedError: ToolErrorCode.TOOL_MAPPING_EMPTY_COLLECTION,
    },
  ];

  it.each(CASES)('$name', runCoreCase);
});

describe('path does not exist', () => {
  // Writing a selector is an assertion that the field is there: a MISSING
  // read with neither `$default` nor `$optional: true` raises PATH_NOT_FOUND.
  // The alternative — quietly omitting whatever did not resolve — would let a
  // typo'd selector (`$.tiitle`) produce a document silently missing a field,
  // no error anywhere, and an agent charged in full for it. See the
  // `$optional` block below for the declared (not inferred) escape hatch.

  it('a selector into a missing branch raises PATH_NOT_FOUND', () => {
    const spec: ResponseMappingSpec = { value: { $path: '$.a.b.c' } };

    expectErrorCode(() => mapResponse(spec, { a: {} }), ToolErrorCode.TOOL_MAPPING_PATH_NOT_FOUND);
  });

  it('the same missing selector resolves to $default instead of erroring', () => {
    const spec: ResponseMappingSpec = { value: { $path: '$.a.b.c', $default: 'fallback' } };

    expect(mapResponse(spec, { a: {} })).toEqual({ value: 'fallback' });
  });

  it('a $from selector into a missing branch also raises PATH_NOT_FOUND', () => {
    const spec: ResponseMappingSpec = {
      items: { $from: '$.data.missing[*]', $item: { $path: '$.id' } },
    };

    expectErrorCode(
      () => mapResponse(spec, { data: {} }),
      ToolErrorCode.TOOL_MAPPING_PATH_NOT_FOUND,
    );
  });

  it('a {$.selector} request path segment that resolves to nothing raises PATH_NOT_FOUND', () => {
    // mapping.types.ts's own doc comment on `path`: the URL cannot be built
    // from a value that never existed.
    const spec: RequestMappingSpec = { method: 'GET', path: '/v1/cities/{$.cityId}' };

    expectErrorCode(() => mapRequest(spec, {}), ToolErrorCode.TOOL_MAPPING_PATH_NOT_FOUND);
  });

  it('readPath itself reports MISSING for a selector with no branch to follow', () => {
    expect(readPath({ a: {} }, '$.a.b.c')).toEqual({ kind: 'MISSING' });
  });
});

describe('$optional — a declared, not inferred, exemption from PATH_NOT_FOUND', () => {
  it('$optional: true + a missing selector omits the field, no error', () => {
    const spec: ResponseMappingSpec = { value: { $path: '$.value', $optional: true } };

    expect(mapResponse(spec, {})).toEqual({});
  });

  it('$optional: true + a present selector maps the value normally', () => {
    const spec: ResponseMappingSpec = { value: { $path: '$.value', $optional: true } };

    expect(mapResponse(spec, { value: 'hello' })).toEqual({ value: 'hello' });
  });

  it('$optional defaulted (false) + a missing selector still raises PATH_NOT_FOUND', () => {
    const spec: ResponseMappingSpec = { value: { $path: '$.value' } };

    expectErrorCode(() => mapResponse(spec, {}), ToolErrorCode.TOOL_MAPPING_PATH_NOT_FOUND);
  });

  it('request: a query param with $optional: true whose selector misses is omitted, not sent empty', () => {
    const spec: RequestMappingSpec = {
      method: 'GET',
      path: '/v1/search',
      query: {
        region: { $path: '$.region', $optional: true },
        q: { $path: '$.query' },
      },
    };

    const req = mapRequest(spec, { query: 'moon landing' });
    expect(req.query).toEqual({ q: 'moon landing' });
    expect(req.query).not.toHaveProperty('region');
  });

  it('validateResponseMapping rejects a non-boolean $optional', () => {
    expectErrorCode(
      () => validateResponseMapping({ value: { $path: '$.value', $optional: 'yes' } }),
      ToolErrorCode.TOOL_MAPPING_INVALID,
    );
  });
});

describe('deeply nested response — array index mid-path + wildcard, exact output', () => {
  it('flattens $.data.payload.results.groups[0].items[*].meta.source.url to a flat array', () => {
    expect(mapResponse(NESTED_RESPONSE_MAPPING, NESTED_UPSTREAM_RESPONSE)).toEqual(
      NESTED_EXPECTED_OUTPUT,
    );
  });
});

// ---------------------------------------------------------------------------
// null vs absent. Same selector, two upstreams differing in exactly one
// way — `value` present-and-null vs `value` entirely absent — and every row
// asserts the two outcomes are NOT the same. This is the pair most engines
// collapse.
// ---------------------------------------------------------------------------

describe('null vs absent — same selector, sharpest pair the engine must not collapse', () => {
  const NULL_UPSTREAM: JsonValue = { value: null };
  const ABSENT_UPSTREAM: JsonValue = {};

  it('readPath distinguishes an explicit NULL from MISSING', () => {
    expect(readPath(NULL_UPSTREAM, '$.value')).toEqual({ kind: 'NULL' });
    expect(readPath(ABSENT_UPSTREAM, '$.value')).toEqual({ kind: 'MISSING' });
  });

  it('$onNull: PASS (default) + a nullable schema carries null through; absent still has no default to fall back to', () => {
    const spec: ResponseMappingSpec = { value: { $path: '$.value' } }; // $onNull defaults to PASS
    const nullableSchema: JsonSchema = {
      type: 'object',
      properties: { value: { type: ['string', 'null'] } },
    };

    expect(mapResponse(spec, NULL_UPSTREAM, { outputSchema: nullableSchema })).toEqual({
      value: null,
    });
    // Nullability is a fact about the *value*; it says nothing about whether
    // the selector is allowed to miss. With no $default and no $optional,
    // absent still asserts the field must be there.
    expectErrorCode(
      () => mapResponse(spec, ABSENT_UPSTREAM, { outputSchema: nullableSchema }),
      ToolErrorCode.TOOL_MAPPING_PATH_NOT_FOUND,
    );
  });

  it('$onNull: DEFAULT + $default resolves both null and absent to the same fallback', () => {
    const spec: ResponseMappingSpec = {
      value: { $path: '$.value', $onNull: NullPolicy.DEFAULT, $default: 'unknown' },
    };

    expect(mapResponse(spec, NULL_UPSTREAM)).toEqual({ value: 'unknown' });
    expect(mapResponse(spec, ABSENT_UPSTREAM)).toEqual({ value: 'unknown' });
  });

  it('$onNull: ERROR raises NULL_VALUE for an explicit null — absent still raises PATH_NOT_FOUND, not NULL_VALUE', () => {
    const spec: ResponseMappingSpec = { value: { $path: '$.value', $onNull: NullPolicy.ERROR } };

    expectErrorCode(() => mapResponse(spec, NULL_UPSTREAM), ToolErrorCode.TOOL_MAPPING_NULL_VALUE);
    // $onNull governs NULL, not MISSING — absent is still the ordinary
    // "selector resolved to nothing" case with its own, different code.
    expectErrorCode(
      () => mapResponse(spec, ABSENT_UPSTREAM),
      ToolErrorCode.TOOL_MAPPING_PATH_NOT_FOUND,
    );
  });

  it('a non-nullable schema field turns null into NULL_VALUE; absent stays PATH_NOT_FOUND regardless of `required`', () => {
    // `outputSchema.required` states what the *tool contract* needs, not what
    // the provider promised, so it does not reclassify a MISSING selector. A
    // selector that does not resolve is indistinguishable from the mapping
    // being aimed at the wrong field — attributing that to the provider would
    // push an unprovable fault toward a strike, which the routing rules
    // forbid explicitly: a mapping failure is `SYSTEM_ERROR`, never a strike. So: selector
    // missing → always PATH_NOT_FOUND / PLATFORM, whether or not the schema
    // marks the field required. REQUIRED_FIELD_MISSING is reserved for a
    // mapping that has no node at all for a required field ("missing
    // required field") — a gap in the mapping itself, not a failed read.
    const spec: ResponseMappingSpec = { value: { $path: '$.value' } }; // $onNull defaults to PASS
    const requiredSchema: JsonSchema = {
      type: 'object',
      required: ['value'],
      properties: { value: { type: 'string' } },
    };

    expectErrorCode(
      () => mapResponse(spec, NULL_UPSTREAM, { outputSchema: requiredSchema }),
      ToolErrorCode.TOOL_MAPPING_NULL_VALUE,
    );
    expectErrorCode(
      () => mapResponse(spec, ABSENT_UPSTREAM, { outputSchema: requiredSchema }),
      ToolErrorCode.TOOL_MAPPING_PATH_NOT_FOUND,
    );
  });
});

// ---------------------------------------------------------------------------
// Shorthand normalisation — what a provider actually types in the binding editor, resolved
// once at save time by `normalizeMappingNode`.
// ---------------------------------------------------------------------------

describe('shorthand normalisation', () => {
  it.each([
    ['a bare string with no $. / $[ prefix normalizes to a constant', 'en', { $const: 'en' }],
    ['a bare string starting with "$." normalizes to a path', '$.q', { $path: '$.q' }],
    ['a bare string starting with "$[" normalizes to a path', '$[0]', { $path: '$[0]' }],
    ['a bare number normalizes to a constant', 5, { $const: 5 }],
    ['a bare boolean normalizes to a constant', true, { $const: true }],
    ['a bare null normalizes to a constant', null, { $const: null }],
  ])('%s', (_name, raw, expected) => {
    expect(normalizeMappingNode(raw)).toEqual(expected);
  });

  it('an explicit $const is the escape hatch for a constant that looks like a path', () => {
    expect(normalizeMappingNode({ $const: '$.x' })).toEqual({ $const: '$.x' });
  });

  it('normalizes a plain object node recursively, key by key', () => {
    expect(normalizeMappingNode({ q: '$.query', lang: 'en' })).toEqual({
      q: { $path: '$.query' },
      lang: { $const: 'en' },
    });
  });

  it('normalizeRequestMapping normalizes shorthand across query, headers and body', () => {
    const raw = {
      method: 'GET',
      path: '/v1/weather',
      query: { units: 'metric', cityId: '$.cityId' },
      headers: { 'x-api-key': '$.apiKey' },
    };

    expect(normalizeRequestMapping(raw)).toEqual({
      method: 'GET',
      path: '/v1/weather',
      query: { units: { $const: 'metric' }, cityId: { $path: '$.cityId' } },
      headers: { 'x-api-key': { $path: '$.apiKey' } },
    });
  });
});

describe('$from-with-siblings sugar', () => {
  it('normalizeMappingNode resolves "$from + siblings" into "$from + $item"', () => {
    const raw = { $from: '$.data.items[*]', url: '$.link', title: '$.title' };

    expect(normalizeMappingNode(raw)).toEqual({
      $from: '$.data.items[*]',
      $item: { url: { $path: '$.link' }, title: { $path: '$.title' } },
    });
  });

  it('normalizeResponseMapping normalizes the sugar at depth, matching the doc example', () => {
    const raw = {
      results: {
        $from: '$.data.items[*]',
        url: '$.link',
        title: '$.title',
        snippet: '$.description',
        publishedAt: '$.date',
      },
    };

    expect(normalizeResponseMapping(raw)).toEqual(SEARCH_RESPONSE_MAPPING);
  });
});

// ---------------------------------------------------------------------------
// Request-side mechanics: constants + transforms in the body, {$.selector}
// interpolation in `path`, query/header stringification, and a bodyless GET.
// ---------------------------------------------------------------------------

describe('request mapping — constants and named transforms in the body', () => {
  it('applies transforms left to right and carries constants through untouched', () => {
    const spec: RequestMappingSpec = {
      method: 'POST',
      path: '/v1/search',
      body: {
        q: { $path: '$.query', $transform: ['trim', 'lowercase'] },
        lang: { $const: 'en' },
        limit: { $path: '$.maxResults', $transform: [{ name: 'toString' }] },
      },
    };
    const input: JsonObject = { query: '  Moon Landing  ', maxResults: 5 };

    expect(mapRequest(spec, input).body).toEqual({ q: 'moon landing', lang: 'en', limit: '5' });
  });
});

describe('request mapping — {$.selector} interpolation in path', () => {
  it('interpolates a {$.selector} segment from tool input', () => {
    // The exact example from mapping.types.ts's own doc comment on `path`.
    const spec: RequestMappingSpec = { method: 'GET', path: '/v1/cities/{$.cityId}' };
    const input: JsonObject = { cityId: 'nyc-us' };

    expect(mapRequest(spec, input).path).toBe('/v1/cities/nyc-us');
  });

  it('interpolates more than one segment in the same path', () => {
    const spec: RequestMappingSpec = { method: 'GET', path: '/v1/cities/{$.cityId}/days/{$.day}' };
    const input: JsonObject = { cityId: 'nyc-us', day: 'today' };

    expect(mapRequest(spec, input).path).toBe('/v1/cities/nyc-us/days/today');
  });
});

describe('request mapping — query and header stringification', () => {
  it('stringifies non-string values, including numbers and booleans', () => {
    const spec: RequestMappingSpec = {
      method: 'GET',
      path: '/v1/search',
      query: { limit: { $path: '$.maxResults' }, verbose: { $const: true } },
      headers: { 'x-request-id': { $const: 'abc-123' }, 'x-limit': { $path: '$.maxResults' } },
    };
    const input: JsonObject = { maxResults: 5 };

    const req = mapRequest(spec, input);
    expect(req.query).toEqual({ limit: '5', verbose: 'true' });
    expect(req.headers).toEqual({ 'x-request-id': 'abc-123', 'x-limit': '5' });
  });
});

describe('request mapping — GET with no body', () => {
  it('produces no body when the spec declares none', () => {
    const spec: RequestMappingSpec = { method: 'GET', path: '/v1/search' };

    expect(mapRequest(spec, {}).body).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Transform failure — the value is present, well-typed for the selector, and
// the transform itself rejects it. Not swallowed; not passed through raw.
// ---------------------------------------------------------------------------

describe('transform failure', () => {
  it('toNumber on a non-numeric string raises TRANSFORM_FAILED', () => {
    const spec: ResponseMappingSpec = { total: { $path: '$.total', $transform: ['toNumber'] } };

    expectErrorCode(
      () => mapResponse(spec, { total: 'abc' }),
      ToolErrorCode.TOOL_MAPPING_TRANSFORM_FAILED,
    );
  });
});

// ---------------------------------------------------------------------------
// Static validation — what the binding editor calls on Save. Every row here is
// structurally invalid independent of any input/upstream data, so all of them
// collapse to TOOL_MAPPING_INVALID regardless of which side of the binding
// they appear on.
// ---------------------------------------------------------------------------

describe('static validation — structural rejections', () => {
  const BAD_NODES: ReadonlyArray<[string, unknown]> = [
    ['an unknown transform name', { $path: '$.q', $transform: ['this_transform_does_not_exist'] }],
    ['an unknown $directive', { $unknown: 'x' }],
    ['a malformed selector missing the leading "$"', { $path: 'q.without.dollar' }],
    ['a $from with no $item and no siblings to sugar into one', { $from: '$.items[*]' }],
    // Names a fallback that does not exist — accepting it would leave the
    // engine to invent a default at runtime that the author never wrote.
    ['$onNull: DEFAULT with no $default to fall back to', { $path: '$.q', $onNull: 'DEFAULT' }],
  ];

  it.each(BAD_NODES)('validateResponseMapping rejects %s', (_name, node) => {
    expectErrorCode(
      () => validateResponseMapping({ field: node }),
      ToolErrorCode.TOOL_MAPPING_INVALID,
    );
  });

  it.each(BAD_NODES)('validateRequestMapping rejects %s in the body', (_name, node) => {
    expectErrorCode(
      () => validateRequestMapping({ method: 'POST', body: { field: node } }),
      ToolErrorCode.TOOL_MAPPING_INVALID,
    );
  });
});
