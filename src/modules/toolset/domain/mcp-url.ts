/**
 * MCP server URLs on the MCP host (`mcp.assay.ai`): parsing, the canonical
 * form, the browser check and the web page a browser is sent to (design spec
 * §7.4).
 *
 * Pure. The canonical string is the cache key, the attribution value and the
 * key of `agent_connect_urls`, so it is computed in exactly one place.
 *
 * ```text
 * /                          ROOT              the whole LISTED catalogue      T1
 * /my/{slug}[@n]             MY_TOOLSET        the org's own toolset            T1 (Draft; @n is T2)
 * /c/{category}              CATEGORY          one topic                        T2
 * /@{handle}                 HANDLE            one maker                        T4
 * /@{handle}/{slug}[@n]      PUBLIC_TOOLSET    a PUBLIC toolset                 T2
 * /u/{token}[@n]             UNLISTED_TOOLSET  an UNLISTED toolset              T2
 * ```
 *
 * Every form is parsed today so the canonical form and the browser redirect
 * are stable across phases; which forms are *served* is the endpoint
 * resolver's decision (`McpEndpointResolver`), and the ones a later phase
 * serves answer 404 until then.
 */

/** What a URL's path names. */
export enum McpPathKind {
  ROOT = 'ROOT',
  MY_TOOLSET = 'MY_TOOLSET',
  CATEGORY = 'CATEGORY',
  HANDLE = 'HANDLE',
  PUBLIC_TOOLSET = 'PUBLIC_TOOLSET',
  UNLISTED_TOOLSET = 'UNLISTED_TOOLSET',
}

/** `endpoint_kind` on calls and intents (§7.2): the four URL purposes. */
export enum EndpointKind {
  ROOT = 'ROOT',
  HANDLE = 'HANDLE',
  CATEGORY = 'CATEGORY',
  TOOLSET = 'TOOLSET',
}

export type McpPath =
  | { readonly kind: McpPathKind.ROOT }
  | {
      readonly kind: McpPathKind.MY_TOOLSET;
      readonly slug: string;
      readonly version: number | null;
    }
  | { readonly kind: McpPathKind.CATEGORY; readonly category: string }
  | { readonly kind: McpPathKind.HANDLE; readonly handle: string }
  | {
      readonly kind: McpPathKind.PUBLIC_TOOLSET;
      readonly handle: string;
      readonly slug: string;
      readonly version: number | null;
    }
  | {
      readonly kind: McpPathKind.UNLISTED_TOOLSET;
      readonly token: string;
      readonly version: number | null;
    };

/** `discovery=` values (T2 serves them; T1 parses and keeps them canonical). */
export enum DiscoveryMode {
  AUTO = 'auto',
  FULL = 'full',
  SEARCH = 'search',
}

/** One `?tools=` name, optionally pinned to a contract major (`get_weather@1`). */
export interface ToolSelector {
  readonly name: string;
  readonly major: number | null;
}

/** The view filters of a URL (§7.4). They only ever narrow. */
export interface ViewFilter {
  readonly tools: readonly ToolSelector[] | null;
  readonly categories: readonly string[] | null;
  readonly free: boolean;
  readonly discovery: DiscoveryMode | null;
}

export interface ParsedMcpUrl {
  readonly path: McpPath;
  readonly filter: ViewFilter;
}

export const MAX_MCP_URL_LENGTH = 2_048;
export const MAX_TOOLS_IN_FILTER = 50;

const SLUG_RE = /^[a-z0-9-]{2,64}$/;
const HANDLE_RE = /^[a-z][a-z0-9-]{2,23}$/;
const CATEGORY_RE = /^[a-z][a-z0-9-]{1,63}$/;
/** At least 128 bits, base64url. */
const TOKEN_RE = /^[a-z0-9_-]{22,64}$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9_-]{1,47}$/;
const VERSION_RE = /^[1-9][0-9]{0,5}$/;

const QUERY_ORDER = ['tools', 'category', 'free', 'discovery'] as const;

/**
 * `path?query` (as received, still percent-encoded) → its parsed form, or
 * `null` for anything that is not one of the accepted forms. `null` is a 404.
 *
 * Normalisation: `%40` becomes `@` and the path is lowercased; a trailing
 * slash is removed (except on `/`); empty segments (`//`), `.` and `..`, any
 * other percent-encoding in the path, and anything longer than
 * {@link MAX_MCP_URL_LENGTH} are refused. Unknown query parameters are dropped.
 */
export function parseMcpUrl(pathAndQuery: string): ParsedMcpUrl | null {
  if (pathAndQuery.length > MAX_MCP_URL_LENGTH) return null;

  const queryAt = pathAndQuery.indexOf('?');
  const rawPath = queryAt === -1 ? pathAndQuery : pathAndQuery.slice(0, queryAt);
  const rawQuery = queryAt === -1 ? '' : pathAndQuery.slice(queryAt + 1);

  const path = parsePath(rawPath);
  if (!path) return null;

  const filter = parseQuery(rawQuery);
  if (!filter) return null;

  return {
    path,
    filter: withoutDefaultDiscovery(
      filter,
      defaultDiscoveryFor(filter, staticDiscoveryDefault(path)),
    ),
  };
}

/** A full URL (`https://mcp.example.com/my/x?…`) → parsed, when it is on `base`'s origin. */
export function parseMcpAbsoluteUrl(url: string, base: string): ParsedMcpUrl | null {
  if (url.length > MAX_MCP_URL_LENGTH) return null;
  let parsed: URL;
  let origin: URL;
  try {
    parsed = new URL(url);
    origin = new URL(base);
  } catch {
    return null;
  }
  if (parsed.origin !== origin.origin) return null;
  if (parsed.username || parsed.password) return null;
  // `URL` resolves `..` and `.` itself; re-read the raw path from the input so
  // a dot segment is refused rather than quietly resolved.
  const afterOrigin = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '');
  const withoutFragment = afterOrigin.split('#')[0];
  return parseMcpUrl(withoutFragment === '' ? '/' : withoutFragment);
}

/** The canonical path: `/`, `/my/research`, `/@acme/kit@3`. */
export function canonicalPath(path: McpPath): string {
  switch (path.kind) {
    case McpPathKind.ROOT:
      return '/';
    case McpPathKind.MY_TOOLSET:
      return `/my/${path.slug}${versionSuffix(path.version)}`;
    case McpPathKind.CATEGORY:
      return `/c/${path.category}`;
    case McpPathKind.HANDLE:
      return `/@${path.handle}`;
    case McpPathKind.PUBLIC_TOOLSET:
      return `/@${path.handle}/${path.slug}${versionSuffix(path.version)}`;
    case McpPathKind.UNLISTED_TOOLSET:
      return `/u/${path.token}${versionSuffix(path.version)}`;
  }
}

/**
 * The canonical query: parameters in a fixed order, lists deduplicated and
 * sorted, defaults dropped. Empty string when there is nothing to say.
 */
export function canonicalQuery(filter: ViewFilter): string {
  const parts: string[] = [];
  for (const key of QUERY_ORDER) {
    if (key === 'tools' && filter.tools) {
      parts.push(`tools=${filter.tools.map(selectorText).join(',')}`);
    }
    if (key === 'category' && filter.categories) {
      parts.push(`category=${filter.categories.join(',')}`);
    }
    if (key === 'free' && filter.free) parts.push('free=1');
    if (key === 'discovery' && filter.discovery) parts.push(`discovery=${filter.discovery}`);
  }
  return parts.join('&');
}

/** `base` + canonical path + canonical query. `base` has no trailing slash. */
export function canonicalUrl(base: string, parsed: ParsedMcpUrl): string {
  const query = canonicalQuery(parsed.filter);
  return `${trimBase(base)}${canonicalPath(parsed.path)}${query ? `?${query}` : ''}`;
}

/** The filter as `view_filter` stores it: only what differs from the default, or `null`. */
export function viewFilterRecord(filter: ViewFilter): Record<string, unknown> | null {
  const record: Record<string, unknown> = {};
  if (filter.tools) record.tools = filter.tools.map(selectorText);
  if (filter.categories) record.category = [...filter.categories];
  if (filter.free) record.free = true;
  if (filter.discovery) record.discovery = filter.discovery;
  return Object.keys(record).length > 0 ? record : null;
}

/** `view_filter` back into a filter — the inverse of {@link viewFilterRecord}. */
export function viewFilterFromRecord(record: Record<string, unknown> | null): ViewFilter {
  const query = new URLSearchParams();
  if (record?.tools && Array.isArray(record.tools)) query.set('tools', record.tools.join(','));
  if (record?.category && Array.isArray(record.category)) {
    query.set('category', record.category.join(','));
  }
  if (record?.free === true) query.set('free', '1');
  if (typeof record?.discovery === 'string') query.set('discovery', record.discovery);
  return parseQuery(query.toString()) ?? EMPTY_FILTER;
}

export const EMPTY_FILTER: ViewFilter = Object.freeze({
  tools: null,
  categories: null,
  free: false,
  discovery: null,
});

/** The `endpoint_kind` a path is attributed to. */
export function endpointKindOf(path: McpPath): EndpointKind {
  switch (path.kind) {
    case McpPathKind.ROOT:
      return EndpointKind.ROOT;
    case McpPathKind.CATEGORY:
      return EndpointKind.CATEGORY;
    case McpPathKind.HANDLE:
      return EndpointKind.HANDLE;
    default:
      return EndpointKind.TOOLSET;
  }
}

/**
 * The discovery mode a path defaults to when nothing in the database decides
 * it: the root searches, a topic or a maker is AUTO. A toolset's default is its
 * own `discovery` column, so `null` here — the resolver drops a `discovery=`
 * equal to it (see {@link withoutDefaultDiscovery}).
 */
export function staticDiscoveryDefault(path: McpPath): DiscoveryMode | null {
  switch (path.kind) {
    case McpPathKind.ROOT:
      return DiscoveryMode.SEARCH;
    case McpPathKind.CATEGORY:
    case McpPathKind.HANDLE:
      return DiscoveryMode.AUTO;
    default:
      return null;
  }
}

/**
 * The discovery mode a URL defaults to, given its filters: a `?tools=`
 * selection (at most 50 names) on a URL that would search is listed like
 * AUTO instead, so `/?tools=a,b` serves exactly those tools (§8.2 C) and
 * `discovery=search` there is not a default to drop. FULL and AUTO stay.
 */
export function defaultDiscoveryFor(
  filter: Pick<ViewFilter, 'tools'>,
  pathDefault: DiscoveryMode | null,
): DiscoveryMode | null {
  return filter.tools && pathDefault === DiscoveryMode.SEARCH ? DiscoveryMode.AUTO : pathDefault;
}

/** `discovery=` dropped when it equals `defaultMode` (a parameter equal to the default). */
export function withoutDefaultDiscovery(
  filter: ViewFilter,
  defaultMode: DiscoveryMode | null,
): ViewFilter {
  return filter.discovery && filter.discovery === defaultMode
    ? { ...filter, discovery: null }
    : filter;
}

// ---------------------------------------------------------------------------
// The browser view
// ---------------------------------------------------------------------------

export interface BrowserRequestShape {
  readonly method: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/**
 * A person's browser, not an MCP client (§7.4, "Browser view"): a `GET` that
 * accepts `text/html` but not `text/event-stream`, and carries neither
 * `Mcp-Protocol-Version` nor `Authorization`. MCP clients always send
 * `text/event-stream` on `GET`, so they are never redirected.
 */
export function isBrowserRequest(request: BrowserRequestShape): boolean {
  if (request.method.toUpperCase() !== 'GET') return false;
  const accept = headerText(request.headers.accept).toLowerCase();
  if (!accept.includes('text/html') || accept.includes('text/event-stream')) return false;
  return (
    !hasHeader(request.headers, 'mcp-protocol-version') &&
    !hasHeader(request.headers, 'authorization')
  );
}

/**
 * The web page a browser opening `parsed` is sent to. The web app is a static
 * export, so every target is a query-string page; version pins and view
 * filters are carried over. `null` (an unknown path) is the catalogue's
 * not-found page.
 */
export function browserRedirectTarget(
  webBase: string,
  parsed: ParsedMcpUrl | null,
  mcpCanonicalUrl: string | null,
): string {
  const web = trimBase(webBase);
  if (!parsed) return `${web}/catalogue/not-found`;

  if ((parsed.filter.tools || parsed.filter.categories) && mcpCanonicalUrl) {
    return `${web}/connect/preview?url=${encodeURIComponent(mcpCanonicalUrl)}`;
  }

  const extra = new URLSearchParams();
  if (parsed.filter.free) extra.set('free', '1');
  if (parsed.filter.discovery) extra.set('discovery', parsed.filter.discovery);

  const { path } = parsed;
  switch (path.kind) {
    case McpPathKind.ROOT:
      return withQuery(`${web}/catalogue`, extra);
    case McpPathKind.CATEGORY:
      return withQuery(`${web}/catalogue`, prepend(extra, [['category', path.category]]));
    case McpPathKind.HANDLE:
      return withQuery(`${web}/toolsets/handle`, prepend(extra, [['handle', path.handle]]));
    case McpPathKind.PUBLIC_TOOLSET:
      return withQuery(
        `${web}/toolsets/view`,
        prepend(extra, [
          ['handle', path.handle],
          ['slug', path.slug],
          ...versionParam(path.version),
        ]),
      );
    case McpPathKind.UNLISTED_TOOLSET: {
      // The token is the permission: it rides in the fragment, which never
      // reaches a server log or a referrer.
      const fragment = prepend(extra, [['token', path.token], ...versionParam(path.version)]);
      return `${web}/toolsets/view#${fragment.toString()}`;
    }
    case McpPathKind.MY_TOOLSET:
      return withQuery(
        `${web}/toolsets/mine`,
        prepend(extra, [['slug', path.slug], ...versionParam(path.version)]),
      );
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * First path segments that are never an MCP server: the held `t`, the host's
 * own routes (`/.well-known/*`, `/health`, `/oauth/*`) and the ones kept for
 * later pages. A URL starting with one of these parses to `null`, whatever
 * follows, so no toolset slug or route can shadow them (R-OA-28). Lowercase,
 * compared after the path is lowercased.
 *
 * This list is the single source: the frontend parser
 * (`assay-frontend/src/features/connect/mcp-url.ts`) must refuse exactly
 * these first segments too.
 */
export const RESERVED_FIRST_SEGMENTS: readonly string[] = Object.freeze([
  't',
  '.well-known',
  'health',
  'status',
  'docs',
  'oauth',
]);

function parsePath(raw: string): McpPath | null {
  if (!raw.startsWith('/')) return null;
  // `%40` is the one encoding a client may legitimately send (an encoded
  // `@`); any other escape in a path is a trick, not an address.
  const decoded = raw.replace(/%40/gi, '@');
  if (decoded.includes('%')) return null;
  const lower = decoded.toLowerCase();

  if (lower === '/') return { kind: McpPathKind.ROOT };

  const trimmed = lower.endsWith('/') ? lower.slice(0, -1) : lower;
  const segments = trimmed.slice(1).split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null;
  }

  const [first, ...rest] = segments;
  if (RESERVED_FIRST_SEGMENTS.includes(first)) return null;

  if (first.startsWith('@')) {
    const handle = first.slice(1);
    if (!HANDLE_RE.test(handle)) return null;
    if (rest.length === 0) return { kind: McpPathKind.HANDLE, handle };
    if (rest.length !== 1) return null;
    const pinned = splitVersion(rest[0]);
    if (!pinned || !SLUG_RE.test(pinned.name)) return null;
    return { kind: McpPathKind.PUBLIC_TOOLSET, handle, slug: pinned.name, version: pinned.version };
  }

  if (rest.length !== 1) return null;
  const [second] = rest;

  switch (first) {
    case 'my': {
      const pinned = splitVersion(second);
      if (!pinned || !SLUG_RE.test(pinned.name)) return null;
      return { kind: McpPathKind.MY_TOOLSET, slug: pinned.name, version: pinned.version };
    }
    case 'c':
      return CATEGORY_RE.test(second) ? { kind: McpPathKind.CATEGORY, category: second } : null;
    case 'u': {
      const pinned = splitVersion(second);
      if (!pinned || !TOKEN_RE.test(pinned.name)) return null;
      return { kind: McpPathKind.UNLISTED_TOOLSET, token: pinned.name, version: pinned.version };
    }
    default:
      // Every other first segment; the reserved ones never get this far.
      return null;
  }
}

function parseQuery(raw: string): ViewFilter | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return null;
  }

  const toolTexts = listParam(params, 'tools');
  let tools: ToolSelector[] | null = null;
  if (toolTexts) {
    const selectors = new Map<string, ToolSelector>();
    for (const text of toolTexts) {
      const selector = parseSelector(text);
      if (!selector) return null;
      selectors.set(selectorText(selector), selector);
    }
    if (selectors.size > MAX_TOOLS_IN_FILTER) return null;
    tools = [...selectors.values()].sort((a, b) => compare(selectorText(a), selectorText(b)));
  }

  const categoryTexts = listParam(params, 'category');
  let categories: string[] | null = null;
  if (categoryTexts) {
    if (categoryTexts.some((category) => !CATEGORY_RE.test(category))) return null;
    categories = [...new Set(categoryTexts)].sort(compare);
  }

  // `0` or `1` and nothing else: a `free=true` silently read as "not free"
  // would serve paid tools to a URL its author meant to be free only.
  const freeValues = params.getAll('free').map((value) => value.trim());
  if (freeValues.some((value) => value !== '0' && value !== '1')) return null;
  const free = freeValues.length > 0 && freeValues[freeValues.length - 1] === '1';

  const discoveryValues = params.getAll('discovery');
  let discovery: DiscoveryMode | null = null;
  if (discoveryValues.length > 0) {
    const value = discoveryValues[discoveryValues.length - 1].trim().toLowerCase();
    if (!Object.values(DiscoveryMode).includes(value as DiscoveryMode)) return null;
    discovery = value as DiscoveryMode;
  }

  return { tools, categories, free, discovery };
}

/** Every value of a comma-list parameter, trimmed and lowercased; `null` when absent or empty. */
function listParam(params: URLSearchParams, key: string): string[] | null {
  const values = params
    .getAll(key)
    .flatMap((value) => value.split(','))
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value !== '');
  return values.length > 0 ? values : null;
}

function parseSelector(text: string): ToolSelector | null {
  const pinned = splitVersion(text);
  if (!pinned || !TOOL_NAME_RE.test(pinned.name)) return null;
  return { name: pinned.name, major: pinned.version };
}

function splitVersion(text: string): { name: string; version: number | null } | null {
  const at = text.lastIndexOf('@');
  if (at === -1) return { name: text, version: null };
  const version = text.slice(at + 1);
  if (!VERSION_RE.test(version)) return null;
  return { name: text.slice(0, at), version: Number(version) };
}

function selectorText(selector: ToolSelector): string {
  return selector.major === null ? selector.name : `${selector.name}@${selector.major}`;
}

function versionSuffix(version: number | null): string {
  return version === null ? '' : `@${version}`;
}

function versionParam(version: number | null): [string, string][] {
  return version === null ? [] : [['v', String(version)]];
}

function prepend(params: URLSearchParams, first: [string, string][]): URLSearchParams {
  const out = new URLSearchParams(first);
  params.forEach((value, key) => out.append(key, value));
  return out;
}

function withQuery(url: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${url}?${query}` : url;
}

function trimBase(base: string): string {
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

function headerText(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(',');
  return value ?? '';
}

function hasHeader(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): boolean {
  const value = headers[name];
  return value !== undefined && headerText(value) !== '';
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
