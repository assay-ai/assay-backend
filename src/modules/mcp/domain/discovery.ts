import { JsonSchema } from '@modules/tool/domain/mapping';
import {
  DiscoveryMode,
  defaultDiscoveryFor,
  staticDiscoveryDefault,
} from '@modules/toolset/domain/mcp-url';
import {
  DEFAULT_SEARCH_THRESHOLD,
  McpEndpointView,
  ViewDiscovery,
} from '@modules/toolset/domain/view';
import { MAX_PINNED_TOOLS } from '@modules/toolset/config/mcp-host.config';

import { SearchDetail } from './search-cursor';

/**
 * Discovery modes and the meta tools (design spec §7.4, FR-12).
 *
 * ```text
 * FULL    tools/list = every tool in view ∩ access
 * SEARCH  tools/list = pinned tools (0–5) + search_tools + get_tool + call_tool
 * AUTO    FULL when view ∩ access holds ≤ search_threshold tools, else SEARCH
 * ```
 *
 * Pure. The meta tools are served on every URL — a client that cached a
 * SEARCH list keeps working when AUTO later turns FULL — and are listed only
 * in SEARCH. They reach exactly view ∩ access, nothing else.
 */

export const SEARCH_TOOLS = 'search_tools';
export const GET_TOOL = 'get_tool';
export const CALL_TOOL = 'call_tool';

export const META_TOOL_NAMES: ReadonlySet<string> = new Set([SEARCH_TOOLS, GET_TOOL, CALL_TOOL]);

export const SEARCH_QUERY_MAX_LENGTH = 500;
export const SEARCH_LIMIT_MAX = 50;
/** `limit` when omitted (or below 1), by `detail` (§7.4). */
export const SEARCH_DEFAULT_LIMITS: Readonly<Record<SearchDetail, number>> = Object.freeze({
  names: 10,
  summary: 5,
  full: 3,
});
/** The safety net on one `search_tools` response. */
export const SEARCH_RESPONSE_MAX_BYTES = 256 * 1024;
/** `summary`: the list's short description, until `tool_versions.summary` (T3) holds one. */
export const SUMMARY_MAX_LENGTH = 200;

/** The URL's discovery settings, or the path's defaults when the resolver set none. */
export function discoveryOf(view: Pick<McpEndpointView, 'path' | 'discovery'>): ViewDiscovery {
  return (
    view.discovery ?? {
      mode: staticDiscoveryDefault(view.path) ?? DiscoveryMode.AUTO,
      searchThreshold: DEFAULT_SEARCH_THRESHOLD,
      pinnedTools: [],
    }
  );
}

/**
 * FULL or SEARCH for this request: `?discovery=` first, then AUTO for a
 * `?tools=` selection, then the URL's own mode, with AUTO decided on the
 * size of view ∩ access.
 */
export function effectiveMode(
  view: Pick<McpEndpointView, 'path' | 'discovery' | 'filter'>,
  scopedToolCount: number,
): DiscoveryMode.FULL | DiscoveryMode.SEARCH {
  const settings = discoveryOf(view);
  // A `?tools=` list is an explicit selection (at most 50 names): it is listed
  // like AUTO, so `/?tools=a,b` serves exactly those tools (§8.2 C).
  const mode = view.filter.discovery ?? defaultDiscoveryFor(view.filter, settings.mode);
  if (mode === DiscoveryMode.FULL || mode === DiscoveryMode.SEARCH) return mode;
  return scopedToolCount <= settings.searchThreshold ? DiscoveryMode.FULL : DiscoveryMode.SEARCH;
}

/**
 * The names a SEARCH list loads directly: the URL's pins (its toolset's, or
 * the root's), then the agent's, deduplicated, at most 5. The caller keeps
 * only those in view ∩ access.
 */
export function pinnedNames(
  view: Pick<McpEndpointView, 'path' | 'discovery'>,
  agentPins: readonly string[],
): string[] {
  return [...new Set([...discoveryOf(view).pinnedTools, ...agentPins])];
}

/** Keep `names` that are in `available`, in order, at most 5. */
export function pinnedWithin<T extends { readonly name: string }>(
  names: readonly string[],
  available: readonly T[],
): T[] {
  const byName = new Map(available.map((item) => [item.name, item]));
  return names.flatMap((name) => byName.get(name) ?? []).slice(0, MAX_PINNED_TOOLS);
}

/** The clamped `limit` (§7.4): above 50 is 50, below 1 or absent is the detail's default. */
export function limitFor(detail: SearchDetail, requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested < 1) {
    return SEARCH_DEFAULT_LIMITS[detail];
  }
  return Math.min(SEARCH_LIMIT_MAX, Math.floor(requested));
}

/** A one-line summary of a description: whole sentences up to 200 characters. */
export function summaryOf(description: string): string {
  const text = description.replace(/\s+/g, ' ').trim();
  if (text.length <= SUMMARY_MAX_LENGTH) return text;
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [];
  let summary = '';
  for (const sentence of sentences) {
    if ((summary + sentence).trim().length > SUMMARY_MAX_LENGTH) break;
    summary += sentence;
  }
  if (summary.trim().length > 0) return summary.trim();
  return `${text.slice(0, SUMMARY_MAX_LENGTH - 1).trimEnd()}…`;
}

/** Argument names and their descriptions, for the search index. */
export function argumentText(schema: JsonSchema | undefined): string {
  const properties = (schema as { properties?: Record<string, { description?: string }> })
    ?.properties;
  if (!properties || typeof properties !== 'object') return '';
  return Object.entries(properties)
    .map(([name, property]) =>
      `${name} ${typeof property?.description === 'string' ? property.description : ''}`.trim(),
    )
    .join(' ');
}

// ---------------------------------------------------------------------------
// The meta tools as `tools/list` shows them
// ---------------------------------------------------------------------------

export interface MetaToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema & Record<string, unknown>;
  readonly annotations: Record<string, unknown>;
}

export const SEARCH_TOOLS_INPUT: JsonSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'What the tool should do, in a few words (at most 500 characters).',
    },
    category: { type: 'string', description: 'Only tools in this category.' },
    limit: {
      type: 'integer',
      description: 'How many results, 1 to 50. Defaults: names 10, summary 5, full 3.',
    },
    detail: {
      type: 'string',
      enum: ['names', 'summary', 'full'],
      description: 'names, summary (default) or full (adds each input schema).',
    },
    cursor: {
      type: 'string',
      description: 'nextCursor from a previous search, to get its next page.',
    },
  },
  additionalProperties: false,
} as JsonSchema;

export const GET_TOOL_INPUT: JsonSchema = {
  type: 'object',
  properties: { name: { type: 'string', description: 'The tool name from search_tools.' } },
  required: ['name'],
  additionalProperties: false,
} as JsonSchema;

export const CALL_TOOL_INPUT: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'The tool to call.' },
    arguments: { type: 'object', description: "The tool's arguments, as get_tool describes." },
  },
  required: ['name'],
  additionalProperties: false,
} as JsonSchema;

/**
 * The three meta tools. `reachable` and `categories` describe this URL for
 * this caller, so the model knows what searching can find. `call_tool`
 * declares no `outputSchema`: it returns whichever tool's result unchanged.
 */
export function metaToolDefinitions(
  reachable: number,
  categories: readonly string[],
): MetaToolDefinition[] {
  const topics =
    categories.length > 0
      ? ` Categories: ${categories.slice(0, 20).join(', ')}${categories.length > 20 ? ', …' : ''}.`
      : '';
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  return [
    {
      name: SEARCH_TOOLS,
      description:
        `Search the ${reachable} tools this server can run, by what they do. ` +
        `Returns names, prices and summaries; read one with get_tool, run it with call_tool. Free.${topics}`,
      inputSchema: SEARCH_TOOLS_INPUT as JsonSchema & Record<string, unknown>,
      annotations: readOnly,
    },
    {
      name: GET_TOOL,
      description: "A tool's full description, input and output schemas, price and version. Free.",
      inputSchema: GET_TOOL_INPUT as JsonSchema & Record<string, unknown>,
      annotations: readOnly,
    },
    {
      name: CALL_TOOL,
      description:
        "Run a tool found with search_tools: { name, arguments }. Returns that tool's result " +
        "unchanged and is charged at that tool's price.",
      inputSchema: CALL_TOOL_INPUT as JsonSchema & Record<string, unknown>,
      annotations: { openWorldHint: true },
    },
  ];
}
