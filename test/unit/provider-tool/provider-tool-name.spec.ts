import {
  PROVIDER_TOOL_LOCAL_MAX,
  TOOL_NAME_MAX,
  parseProviderToolName,
  providerToolName,
  providerToolNameProblems,
} from '@modules/tool/domain/provider-tool-name';

/** §7.1: `{handle}__{tool}`, `{tool}` ≤ 40, the whole name ≤ 48, hard caps. */
describe('provider tool names', () => {
  it('names a tool under its handle', () => {
    expect(providerToolName('acme', 'search_posts')).toBe('acme__search_posts');
    expect(providerToolNameProblems('acme', 'search_posts')).toEqual([]);
  });

  it('caps {tool} at 40 characters and the full name at 48', () => {
    expect(PROVIDER_TOOL_LOCAL_MAX).toBe(40);
    expect(TOOL_NAME_MAX).toBe(48);
    expect(providerToolNameProblems('acme', 'a'.repeat(40))).toEqual([]);
    expect(providerToolNameProblems('acme', 'a'.repeat(41))).not.toEqual([]);
    // A 24-character handle leaves 22 for {tool}.
    const handle = 'h'.repeat(24);
    expect(providerToolNameProblems(handle, 'a'.repeat(22))).toEqual([]);
    expect(providerToolNameProblems(handle, 'a'.repeat(23)).join(' ')).toMatch(/at most 48/);
  });

  it('refuses "__" inside {tool}, uppercase, a leading digit and one character', () => {
    expect(providerToolNameProblems('acme', 'search__posts').join(' ')).toMatch(/"__"/);
    expect(providerToolNameProblems('acme', 'Search')).not.toEqual([]);
    expect(providerToolNameProblems('acme', '1search')).not.toEqual([]);
    expect(providerToolNameProblems('acme', 'a')).not.toEqual([]);
    expect(providerToolNameProblems('acme', 'search-posts')).not.toEqual([]);
  });

  it('refuses the meta tool names as {tool}', () => {
    for (const reserved of ['search_tools', 'get_tool', 'call_tool']) {
      expect(providerToolNameProblems('acme', reserved).join(' ')).toMatch(/reserved/);
    }
  });

  it('parses a provider tool name', () => {
    expect(parseProviderToolName('acme__search_posts')).toEqual({
      handle: 'acme',
      local: 'search_posts',
    });
    expect(parseProviderToolName('get_weather')).toBeNull();
  });
});
