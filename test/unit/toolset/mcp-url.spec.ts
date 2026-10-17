import {
  DiscoveryMode,
  EndpointKind,
  McpPathKind,
  browserRedirectTarget,
  canonicalUrl,
  endpointKindOf,
  isBrowserRequest,
  parseMcpAbsoluteUrl,
  parseMcpUrl,
  viewFilterFromRecord,
  viewFilterRecord,
} from '@modules/toolset/domain/mcp-url';

const BASE = 'https://mcp.example.com';
const WEB = 'https://app.example.com';

const canonical = (pathAndQuery: string) => {
  const parsed = parseMcpUrl(pathAndQuery);
  return parsed ? canonicalUrl(BASE, parsed) : null;
};

/**
 * MCP URLs on the MCP host (design spec §7.4): the accepted forms, the
 * canonical form every cache, attribution row and connect URL is keyed on,
 * and everything else a 404.
 */
describe('MCP URLs — paths', () => {
  it('parses the root and the forms of every phase', () => {
    expect(parseMcpUrl('/')?.path).toEqual({ kind: McpPathKind.ROOT });
    expect(parseMcpUrl('/my/research')?.path).toEqual({
      kind: McpPathKind.MY_TOOLSET,
      slug: 'research',
      version: null,
    });
    expect(parseMcpUrl('/my/research@3')?.path).toEqual({
      kind: McpPathKind.MY_TOOLSET,
      slug: 'research',
      version: 3,
    });
    expect(parseMcpUrl('/c/weather')?.path).toEqual({
      kind: McpPathKind.CATEGORY,
      category: 'weather',
    });
    expect(parseMcpUrl('/@acme')?.path).toEqual({ kind: McpPathKind.HANDLE, handle: 'acme' });
    expect(parseMcpUrl('/@acme/twitter-kit@3')?.path).toEqual({
      kind: McpPathKind.PUBLIC_TOOLSET,
      handle: 'acme',
      slug: 'twitter-kit',
      version: 3,
    });
    expect(parseMcpUrl('/u/abcdefghijklmnopqrstuv')?.path).toEqual({
      kind: McpPathKind.UNLISTED_TOOLSET,
      token: 'abcdefghijklmnopqrstuv',
      version: null,
    });
  });

  it('turns an encoded @ into @, either case', () => {
    expect(canonical('/%40acme')).toBe(`${BASE}/@acme`);
    expect(canonical('/%40ACME/Kit')).toBe(`${BASE}/@acme/kit`);
    expect(canonical('/my/research%40%32')).toBeNull();
  });

  it('lowercases the path and removes a trailing slash', () => {
    expect(canonical('/MY/Research/')).toBe(`${BASE}/my/research`);
    expect(canonical('/')).toBe(`${BASE}/`);
  });

  it.each([
    ['a dot-dot segment', '/my/../my/research'],
    ['a dot segment', '/my/./research'],
    ['a double slash', '//my/research'],
    ['an empty inner segment', '/my//research'],
    ['two trailing slashes', '/my/research//'],
    ['an encoded slash', '/my%2Fresearch'],
    ['an encoded dot', '/my/%2e%2e/x'],
    ['an unknown first segment', '/foo/bar'],
    ['the held "t" segment', '/t/anything'],
    ['.well-known', '/.well-known/oauth-protected-resource'],
    ['a bare /my', '/my'],
    ['a too-short slug', '/my/x'],
    ['an underscore in a handle', '/@acme_co'],
    ['a version zero', '/my/research@0'],
    ['a version that is not a number', '/my/research@latest'],
    ['too many segments', '/@acme/kit/extra'],
    ['a short unlisted token', '/u/short'],
    ['no leading slash', 'my/research'],
  ])('refuses %s (404)', (_name, path) => {
    expect(parseMcpUrl(path)).toBeNull();
  });

  it('refuses a URL longer than 2,048 characters', () => {
    expect(parseMcpUrl(`/?tools=${'a'.repeat(2_050)}`)).toBeNull();
  });

  it('attributes each form to its endpoint kind', () => {
    expect(endpointKindOf({ kind: McpPathKind.ROOT })).toBe(EndpointKind.ROOT);
    expect(endpointKindOf({ kind: McpPathKind.MY_TOOLSET, slug: 'ab', version: null })).toBe(
      EndpointKind.TOOLSET,
    );
    expect(endpointKindOf({ kind: McpPathKind.HANDLE, handle: 'acme' })).toBe(EndpointKind.HANDLE);
  });
});

describe('MCP URLs — the canonical query', () => {
  it('orders the parameters, deduplicates and sorts the lists, drops unknown ones', () => {
    expect(
      canonical(
        '/?utm_source=x&free=1&category=weather,maps,weather&tools=geocode_place,get_weather,geocode_place',
      ),
    ).toBe(`${BASE}/?tools=geocode_place,get_weather&category=maps,weather&free=1`);
  });

  it('merges a repeated list parameter', () => {
    expect(canonical('/?tools=b_tool&tools=a_tool')).toBe(`${BASE}/?tools=a_tool,b_tool`);
  });

  it('drops a parameter equal to the default, such as discovery=search on /', () => {
    expect(canonical('/?discovery=search')).toBe(`${BASE}/`);
    expect(canonical('/?discovery=full')).toBe(`${BASE}/?discovery=full`);
    expect(canonical('/c/weather?discovery=auto')).toBe(`${BASE}/c/weather`);
    // A toolset's default is its own column, so the parser keeps it.
    expect(canonical('/my/research?discovery=auto')).toBe(`${BASE}/my/research?discovery=auto`);
  });

  it('keeps free=1 only, and a contract pin on a tool', () => {
    expect(canonical('/?free=0')).toBe(`${BASE}/`);
    expect(canonical('/?free=1&free=0')).toBe(`${BASE}/`);
    expect(canonical('/?tools=get_weather@1')).toBe(`${BASE}/?tools=get_weather@1`);
  });

  it('refuses more than 50 tool names, and a malformed name', () => {
    const names = Array.from({ length: 51 }, (_, i) => `tool_${i}`).join(',');
    expect(parseMcpUrl(`/?tools=${names}`)).toBeNull();
    expect(parseMcpUrl('/?tools=Not A Tool')).toBeNull();
    expect(parseMcpUrl('/?discovery=everything')).toBeNull();
    // `free=` is `0` or `1`; anything else is refused like an unknown `discovery=`.
    for (const value of ['true', 'yes', '', '2']) {
      expect(parseMcpUrl(`/?free=${value}`)).toBeNull();
    }
  });

  it('stores only the filters that differ from the default, and reads them back', () => {
    const parsed = parseMcpUrl('/?tools=get_weather&free=1');
    const record = viewFilterRecord(parsed!.filter);
    expect(record).toEqual({ tools: ['get_weather'], free: true });
    expect(viewFilterFromRecord(record)).toEqual(parsed!.filter);
    expect(viewFilterRecord(parseMcpUrl('/')!.filter)).toBeNull();
  });
});

describe('MCP URLs — absolute URLs (the Connect preview)', () => {
  it('accepts this host only', () => {
    expect(parseMcpAbsoluteUrl(`${BASE}/my/research`, BASE)?.path.kind).toBe(
      McpPathKind.MY_TOOLSET,
    );
    expect(parseMcpAbsoluteUrl('https://mcp.example.org/my/research', BASE)).toBeNull();
    expect(parseMcpAbsoluteUrl('http://mcp.example.com/my/research', BASE)).toBeNull();
    expect(parseMcpAbsoluteUrl('not a url', BASE)).toBeNull();
  });

  it('reads the raw path, so a dot segment is refused rather than resolved', () => {
    expect(parseMcpAbsoluteUrl(`${BASE}/my/../my/research`, BASE)).toBeNull();
    expect(parseMcpAbsoluteUrl(`${BASE}`, BASE)?.path.kind).toBe(McpPathKind.ROOT);
    expect(parseMcpAbsoluteUrl(`${BASE}/?tools=get_weather#x`, BASE)?.filter.tools).toEqual([
      { name: 'get_weather', major: null },
    ]);
  });

  it('refuses credentials in the URL', () => {
    expect(parseMcpAbsoluteUrl('https://user:pw@mcp.example.com/', BASE)).toBeNull();
  });
});

describe('MCP URLs — the browser view', () => {
  const browser = { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };

  it('is a GET accepting text/html, without event-stream, protocol version or token', () => {
    expect(isBrowserRequest({ method: 'GET', headers: browser })).toBe(true);
    expect(isBrowserRequest({ method: 'POST', headers: browser })).toBe(false);
    expect(
      isBrowserRequest({ method: 'GET', headers: { accept: 'text/html, text/event-stream' } }),
    ).toBe(false);
    expect(
      isBrowserRequest({
        method: 'GET',
        headers: { ...browser, 'mcp-protocol-version': '2025-11-25' },
      }),
    ).toBe(false);
    expect(
      isBrowserRequest({ method: 'GET', headers: { ...browser, authorization: 'Bearer t' } }),
    ).toBe(false);
    expect(isBrowserRequest({ method: 'GET', headers: { accept: 'application/json' } })).toBe(
      false,
    );
  });

  const target = (path: string) => {
    const parsed = parseMcpUrl(path);
    return browserRedirectTarget(WEB, parsed, parsed ? canonicalUrl(BASE, parsed) : null);
  };

  it.each([
    ['/', `${WEB}/catalogue`],
    ['/c/weather', `${WEB}/catalogue?category=weather`],
    ['/@acme', `${WEB}/toolsets/handle?handle=acme`],
    ['/@acme/kit', `${WEB}/toolsets/view?handle=acme&slug=kit`],
    ['/@acme/kit@3', `${WEB}/toolsets/view?handle=acme&slug=kit&v=3`],
    ['/u/abcdefghijklmnopqrstuv@2', `${WEB}/toolsets/view#token=abcdefghijklmnopqrstuv&v=2`],
    ['/my/research', `${WEB}/toolsets/mine?slug=research`],
    ['/my/research@4?free=1', `${WEB}/toolsets/mine?slug=research&v=4&free=1`],
    ['/nowhere/at/all', `${WEB}/catalogue/not-found`],
  ])('maps %s to its web page', (path, expected) => {
    expect(target(path)).toBe(expected);
  });

  it('sends a filtered URL to the Connect preview, with the canonical URL encoded', () => {
    expect(target('/?tools=get_weather,geocode_place')).toBe(
      `${WEB}/connect/preview?url=${encodeURIComponent(`${BASE}/?tools=geocode_place,get_weather`)}`,
    );
  });

  it('keeps the unlisted token out of the query string', () => {
    expect(target('/u/abcdefghijklmnopqrstuv')).not.toContain('?');
  });

  it('keeps the discovery override', () => {
    expect(target('/?discovery=full')).toBe(`${WEB}/catalogue?discovery=${DiscoveryMode.FULL}`);
  });
});
