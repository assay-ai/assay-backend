/**
 * Shared fixtures for `mapping-cases.spec.ts`.
 *
 * Modeled on the reference `search_web` binding — a provider that already runs
 * a `POST /v1/search` endpoint with its
 * own response shape (`data.items[]`, `link` / `title` / `description` / `date`),
 * unaware that x402 or a tool contract exists on the other end of it.
 */
import type {
  JsonObject,
  JsonSchema,
  JsonValue,
  RequestMappingSpec,
  ResponseMappingSpec,
} from '@modules/tool/domain/mapping';

/** The agent-facing contract for `search_web`'s tool arguments. */
export const SEARCH_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['query'],
  properties: {
    query: { type: 'string' },
    maxResults: { type: 'integer' },
  },
};

/** The agent-facing contract every binding's response mapping must satisfy. */
export const SEARCH_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['url', 'title'],
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          snippet: { type: ['string', 'null'] },
          publishedAt: { type: 'string' },
        },
      },
    },
  },
};

/** Canonical request mapping — the doc's example, already normalised. */
export const SEARCH_REQUEST_MAPPING: RequestMappingSpec = {
  method: 'POST',
  path: '/v1/search',
  body: {
    q: { $path: '$.query' },
    limit: { $path: '$.maxResults', $default: 10 },
    lang: { $const: 'en' },
  },
};

/** Canonical response mapping — the doc's example, already normalised. */
export const SEARCH_RESPONSE_MAPPING: ResponseMappingSpec = {
  results: {
    $from: '$.data.items[*]',
    $item: {
      url: { $path: '$.link' },
      title: { $path: '$.title' },
      snippet: { $path: '$.description' },
      publishedAt: { $path: '$.date' },
    },
  },
};

/** A native provider response with two results — the "happy path" upstream body. */
export const SEARCH_UPSTREAM_RESPONSE: JsonValue = {
  data: {
    items: [
      {
        link: 'https://example.com/moon-landing',
        title: 'Apollo 11 Moon Landing',
        description: "Humanity's first crewed Moon landing, July 1969.",
        date: '1969-07-20',
      },
      {
        link: 'https://example.com/moon-geology',
        title: 'Lunar Geology Overview',
        description: "A survey of the Moon's regolith and mare basalts.",
        date: '2021-03-04',
      },
    ],
  },
};

/** A native provider response with zero results — a legitimate answer, not an error. */
export const SEARCH_UPSTREAM_EMPTY_RESPONSE: JsonValue = {
  data: { items: [] },
};

export const SEARCH_TOOL_INPUT: JsonObject = { query: 'moon landing', maxResults: 5 };

// ---------------------------------------------------------------------------
// A second, unrelated provider shape for the deeply-nested response case: six
// levels deep, an array index mid-path, then a wildcard, flattened to one field.
// ---------------------------------------------------------------------------

export const NESTED_RESPONSE_MAPPING: ResponseMappingSpec = {
  sourceUrls: {
    $from: '$.data.payload.results.groups[0].items[*]',
    $item: { $path: '$.meta.source.url' },
  },
};

export const NESTED_UPSTREAM_RESPONSE: JsonValue = {
  data: {
    payload: {
      results: {
        groups: [
          {
            items: [
              { meta: { source: { url: 'https://provider.example/a' } } },
              { meta: { source: { url: 'https://provider.example/b' } } },
            ],
          },
          // A second group the mapping never selects — proves `groups[0]` really
          // pins the index rather than flattening across every group.
          {
            items: [{ meta: { source: { url: 'https://provider.example/unreachable' } } }],
          },
        ],
      },
    },
  },
};

export const NESTED_EXPECTED_OUTPUT: JsonValue = {
  sourceUrls: ['https://provider.example/a', 'https://provider.example/b'],
};
