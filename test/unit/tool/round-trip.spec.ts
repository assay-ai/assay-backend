import {
  JsonObject,
  JsonValue,
  mapRequest,
  mapResponse,
  validateRequestMapping,
  validateResponseMapping,
} from '@modules/tool/domain/mapping';
import { JsonSchema } from '@modules/tool/domain/mapping/schema-validator';

/**
 * The round trip: tool input → upstream request → upstream response → tool
 * output, with meaning preserved end to end.
 *
 * This is the property the whole binding model rests on, and it is not the
 * same claim as "both mappers work". Each direction can be individually
 * correct while the pair loses something between them — a parameter the
 * request drops, a field the response cannot address, a unit converted one way
 * and not back. The agent never sees the upstream, so a loss here is invisible
 * until someone compares a receipt against a provider's own dashboard.
 *
 * The fake upstream in these tests is deliberately *hostile*: it reads only
 * from what `mapRequest` actually produced, so a parameter the request mapping
 * failed to carry cannot reappear in the response by accident. That is the
 * only way the test can prove the request half did its job.
 */

const SEARCH_TOOL = {
  id: 'search_web',
  inputSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string' },
      maxResults: { type: 'integer' },
      language: { type: 'string' },
    },
  } as JsonSchema,
  outputSchema: {
    type: 'object',
    required: ['query', 'results'],
    properties: {
      query: { type: 'string' },
      language: { type: 'string' },
      results: {
        type: 'array',
        items: {
          type: 'object',
          required: ['url', 'title'],
          properties: {
            url: { type: 'string' },
            title: { type: 'string' },
            snippet: { type: ['string', 'null'] },
            publishedAt: { type: ['string', 'null'] },
          },
        },
      },
    },
  } as JsonSchema,
};

/**
 * A provider whose API looks nothing like the tool: different field names,
 * a nested envelope, epoch-second timestamps, and a comma-joined filter.
 * Exactly the case `docs/mapping-format.md` §12 promises we can absorb without
 * asking them to change.
 */
const REQUEST_MAPPING = validateRequestMapping({
  method: 'POST',
  path: '/v1/search',
  query: { hl: '$.language' },
  body: {
    q: '$.query',
    num: { $path: '$.maxResults', $default: 10 },
    safe: 'active',
  },
});

const RESPONSE_MAPPING = validateResponseMapping({
  query: '$.request.q',
  language: '$.request.hl',
  results: {
    $from: '$.data.items[*]',
    url: '$.link',
    title: '$.title',
    snippet: { $path: '$.description', $onNull: 'PASS' },
    publishedAt: { $path: '$.ts', $transform: ['epochSecondsToIso'], $default: null },
  },
});

/**
 * Stands in for the provider. It echoes the request it was given — which is
 * what makes the round trip a real test rather than two fixtures agreeing with
 * each other — and returns results in its own native shape.
 */
function fakeUpstream(request: {
  readonly query: Readonly<Record<string, string>>;
  readonly body?: JsonValue;
}): JsonValue {
  const body = (request.body ?? {}) as JsonObject;
  const term = String(body.q ?? '');
  const count = Number(body.num ?? 0);

  return {
    request: { q: term, hl: request.query.hl ?? 'en' },
    data: {
      items: Array.from({ length: count }, (_unused, index) => ({
        link: `https://example.test/${encodeURIComponent(term)}/${index}`,
        title: `${term} — result ${index}`,
        description: index === 0 ? null : `A snippet about ${term}`,
        ts: 1_700_000_000 + index,
      })),
    },
  };
}

describe('round trip — tool input → upstream → response → tool output', () => {
  const input: JsonObject = { query: 'solana rent exemption', maxResults: 3, language: 'fr' };

  const request = mapRequest(REQUEST_MAPPING, input, { inputSchema: SEARCH_TOOL.inputSchema });
  const upstream = fakeUpstream(request);
  const output = mapResponse(RESPONSE_MAPPING, upstream, {
    outputSchema: SEARCH_TOOL.outputSchema,
  }) as JsonObject;

  it('carries the request to a shape the provider already accepts', () => {
    expect(request).toEqual({
      method: 'POST',
      path: '/v1/search',
      query: { hl: 'fr' },
      headers: {},
      body: { q: 'solana rent exemption', num: 3, safe: 'active' },
    });
  });

  it('returns the agent its own query, unchanged, after the full trip', () => {
    expect(output.query).toBe(input.query);
  });

  it('preserves the language the agent asked for, through query string and echo', () => {
    expect(output.language).toBe(input.language);
  });

  it('preserves the requested result count', () => {
    // `maxResults` is only observable in the output as a length. If the
    // request mapping dropped it, the fake upstream would return zero items
    // and this is the assertion that notices.
    expect(output.results).toHaveLength(input.maxResults as number);
  });

  it('satisfies the tool output schema, which is the contract routing depends on', () => {
    // `mapResponse` already validated; asserting the shape here states what
    // that validation bought — an agent-facing document, not the provider's.
    expect(output.results).toEqual([
      {
        url: 'https://example.test/solana%20rent%20exemption/0',
        title: 'solana rent exemption — result 0',
        snippet: null,
        publishedAt: '2023-11-14T22:13:20.000Z',
      },
      {
        url: 'https://example.test/solana%20rent%20exemption/1',
        title: 'solana rent exemption — result 1',
        snippet: 'A snippet about solana rent exemption',
        publishedAt: '2023-11-14T22:13:21.000Z',
      },
      {
        url: 'https://example.test/solana%20rent%20exemption/2',
        title: 'solana rent exemption — result 2',
        snippet: 'A snippet about solana rent exemption',
        publishedAt: '2023-11-14T22:13:22.000Z',
      },
    ]);
  });

  it('leaves no provider-native field names in the agent-facing document', () => {
    // The provider says `link` / `ts`; the tool says `url` / `publishedAt`. A
    // leak here means the agent is coupled to whoever served the call, which
    // is the coupling the binding model exists to remove.
    const serialized = JSON.stringify(output);
    for (const nativeField of ['"link"', '"ts"', '"description"', '"items"', '"hl"']) {
      expect(serialized).not.toContain(nativeField);
    }
  });

  it('is stable: mapping the same input twice produces the same output', () => {
    const again = mapResponse(RESPONSE_MAPPING, fakeUpstream(mapRequest(REQUEST_MAPPING, input)), {
      outputSchema: SEARCH_TOOL.outputSchema,
    });
    expect(again).toEqual(output);
  });

  it('survives a defaulted parameter: the default reaches the upstream and comes back', () => {
    // `maxResults` omitted — `$default: 10` supplies it, and the only evidence
    // that the default was actually applied is on the far side of the trip.
    const defaulted = mapRequest(
      REQUEST_MAPPING,
      { query: 'x', language: 'en' },
      {
        inputSchema: SEARCH_TOOL.inputSchema,
      },
    );
    const returned = mapResponse(RESPONSE_MAPPING, fakeUpstream(defaulted), {
      outputSchema: SEARCH_TOOL.outputSchema,
    }) as JsonObject;

    expect(defaulted.body).toEqual({ q: 'x', num: 10, safe: 'active' });
    expect(returned.results).toHaveLength(10);
  });
});

/**
 * The same tool, a second provider with a completely different API.
 *
 * This is the substitutability claim made concrete: routing may swap providers
 * mid-request after a `SYSTEM_ERROR`, and the agent must not be able to tell.
 * Two bindings, two upstream shapes, one output document.
 */
describe('round trip — a second provider, same tool contract', () => {
  const OTHER_REQUEST_MAPPING = validateRequestMapping({
    method: 'GET',
    path: '/search/{$.query}',
    query: { limit: '$.maxResults', locale: '$.language' },
  });

  const OTHER_RESPONSE_MAPPING = validateResponseMapping({
    query: '$.meta.term',
    language: '$.meta.locale',
    results: {
      $from: '$.payload.hits[*]',
      $item: {
        url: '$.target.href',
        title: '$.target.label',
        snippet: { $path: '$.excerpt', $default: null },
        publishedAt: { $path: '$.published', $transform: ['isoDate'], $default: null },
      },
    },
  });

  function otherUpstream(request: {
    readonly path: string;
    readonly query: Readonly<Record<string, string>>;
  }): JsonValue {
    const term = decodeURIComponent(request.path.replace('/search/', ''));
    const limit = Number(request.query.limit ?? 0);

    return {
      meta: { term, locale: request.query.locale ?? 'en' },
      payload: {
        hits: Array.from({ length: limit }, (_unused, index) => ({
          target: {
            href: `https://other.test/${encodeURIComponent(term)}/${index}`,
            label: `${term} — hit ${index}`,
          },
          excerpt: `Excerpt ${index}`,
          published: '2023-11-14T22:13:20Z',
        })),
      },
    };
  }

  it('produces a document indistinguishable in shape from the first provider', () => {
    const input: JsonObject = { query: 'anchor pda', maxResults: 2, language: 'en' };

    const request = mapRequest(OTHER_REQUEST_MAPPING, input, {
      inputSchema: SEARCH_TOOL.inputSchema,
    });
    expect(request.path).toBe('/search/anchor%20pda');

    const output = mapResponse(OTHER_RESPONSE_MAPPING, otherUpstream(request), {
      outputSchema: SEARCH_TOOL.outputSchema,
    }) as JsonObject;

    expect(output.query).toBe(input.query);
    expect(output.results).toHaveLength(2);
    expect(Object.keys(output).sort()).toEqual(['language', 'query', 'results']);
    expect(Object.keys((output.results as JsonObject[])[0]).sort()).toEqual([
      'publishedAt',
      'snippet',
      'title',
      'url',
    ]);
  });
});
