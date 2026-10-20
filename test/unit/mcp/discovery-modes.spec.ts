import { loadMcpDiscoveryConfig } from '@modules/mcp/config/mcp-discovery.config';
import {
  SEARCH_LIMIT_MAX,
  discoveryOf,
  effectiveMode,
  limitFor,
  pinnedNames,
  pinnedWithin,
  summaryOf,
} from '@modules/mcp/domain/discovery';
import { DiscoveryMode, parseMcpUrl } from '@modules/toolset/domain/mcp-url';
import { McpEndpointView } from '@modules/toolset/domain/view';

function view(
  url: string,
  discovery?: McpEndpointView['discovery'],
): Pick<McpEndpointView, 'path' | 'filter' | 'discovery'> {
  const parsed = parseMcpUrl(url)!;
  return { path: parsed.path, filter: parsed.filter, discovery };
}

const settings = (mode: DiscoveryMode, threshold = 25, pinnedTools: string[] = []) => ({
  mode,
  searchThreshold: threshold,
  pinnedTools,
});

/** Discovery modes (design spec §7.4). */
describe('discovery modes', () => {
  it('the root defaults to SEARCH, whatever its size', () => {
    expect(effectiveMode(view('/'), 1)).toBe(DiscoveryMode.SEARCH);
    expect(discoveryOf(view('/')).mode).toBe(DiscoveryMode.SEARCH);
  });

  it('AUTO is FULL up to search_threshold tools in view ∩ access, SEARCH above', () => {
    const auto = view('/c/weather', settings(DiscoveryMode.AUTO, 25));
    expect(effectiveMode(auto, 0)).toBe(DiscoveryMode.FULL);
    expect(effectiveMode(auto, 25)).toBe(DiscoveryMode.FULL);
    expect(effectiveMode(auto, 26)).toBe(DiscoveryMode.SEARCH);
    const small = view('/my/kit', settings(DiscoveryMode.AUTO, 3));
    expect(effectiveMode(small, 3)).toBe(DiscoveryMode.FULL);
    expect(effectiveMode(small, 4)).toBe(DiscoveryMode.SEARCH);
  });

  it('a path with no settings falls back to its static default (category: AUTO)', () => {
    expect(effectiveMode(view('/c/weather'), 25)).toBe(DiscoveryMode.FULL);
    expect(effectiveMode(view('/c/weather'), 26)).toBe(DiscoveryMode.SEARCH);
  });

  it('FULL and SEARCH ignore the size', () => {
    expect(effectiveMode(view('/my/kit', settings(DiscoveryMode.FULL)), 1_000)).toBe(
      DiscoveryMode.FULL,
    );
    expect(effectiveMode(view('/my/kit', settings(DiscoveryMode.SEARCH)), 1)).toBe(
      DiscoveryMode.SEARCH,
    );
  });

  it('?discovery= overrides the URL', () => {
    expect(effectiveMode(view('/?discovery=full'), 10_000)).toBe(DiscoveryMode.FULL);
    expect(effectiveMode(view('/my/kit?discovery=search', settings(DiscoveryMode.FULL)), 1)).toBe(
      DiscoveryMode.SEARCH,
    );
    expect(effectiveMode(view('/?discovery=auto'), 3)).toBe(DiscoveryMode.FULL);
  });

  it('a ?tools= selection lists like AUTO, so /?tools=a,b serves exactly those (§8.2 C)', () => {
    expect(effectiveMode(view('/?tools=get_weather,geocode_place'), 2)).toBe(DiscoveryMode.FULL);
    expect(effectiveMode(view('/?tools=get_weather&discovery=search'), 1)).toBe(
      DiscoveryMode.SEARCH,
    );
  });
});

describe('pinned tools', () => {
  it('the URL pins come first, then the agent pins, deduplicated', () => {
    const v = view('/my/kit', settings(DiscoveryMode.SEARCH, 25, ['a_tool', 'b_tool']));
    expect(pinnedNames(v, ['b_tool', 'c_tool'])).toEqual(['a_tool', 'b_tool', 'c_tool']);
  });

  it('keeps only names in view ∩ access, in order, at most 5', () => {
    const available = ['b', 'c', 'd', 'e', 'f', 'g'].map((name) => ({ name }));
    expect(pinnedWithin(['x', 'g', 'b', 'c', 'd', 'e', 'f'], available).map((t) => t.name)).toEqual(
      ['g', 'b', 'c', 'd', 'e'],
    );
    expect(pinnedWithin(['not_here'], available)).toEqual([]);
  });
});

describe('search_tools limits', () => {
  it('defaults by detail: names 10, summary 5, full 3', () => {
    expect(limitFor('names', undefined)).toBe(10);
    expect(limitFor('summary', undefined)).toBe(5);
    expect(limitFor('full', undefined)).toBe(3);
  });

  it('lowers a limit above 50 to 50, and treats one below 1 as the default', () => {
    expect(limitFor('full', 500)).toBe(SEARCH_LIMIT_MAX);
    expect(limitFor('names', 50)).toBe(50);
    expect(limitFor('summary', 0)).toBe(5);
    expect(limitFor('summary', -3)).toBe(5);
    expect(limitFor('full', 7)).toBe(7);
  });
});

describe('summaryOf', () => {
  it('keeps a short description, and cuts a long one at a sentence within 200 characters', () => {
    expect(summaryOf('Short.')).toBe('Short.');
    const long = `${'A sentence of words. '.repeat(8)}${'x'.repeat(100)}`;
    const summary = summaryOf(long);
    expect(summary.length).toBeLessThanOrEqual(200);
    expect(summary.endsWith('.')).toBe(true);
    expect(summaryOf('y'.repeat(300))).toHaveLength(200);
  });
});

describe('loadMcpDiscoveryConfig', () => {
  it('requires a cursor secret of 32+ characters in production, and makes one up elsewhere', () => {
    expect(() => loadMcpDiscoveryConfig({ NODE_ENV: 'production' })).toThrow(
      /MCP_SEARCH_CURSOR_SECRET/,
    );
    expect(() =>
      loadMcpDiscoveryConfig({ NODE_ENV: 'production', MCP_SEARCH_CURSOR_SECRET: 'short' }),
    ).toThrow(/32/);
    const secret = 'z'.repeat(40);
    expect(
      loadMcpDiscoveryConfig({ NODE_ENV: 'production', MCP_SEARCH_CURSOR_SECRET: secret }),
    ).toEqual({ cursorSecret: secret });
    expect(loadMcpDiscoveryConfig({ NODE_ENV: 'test' }).cursorSecret).toHaveLength(64);
  });
});
