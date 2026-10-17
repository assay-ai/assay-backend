import { loadMcpHostConfig } from '@modules/toolset/config/mcp-host.config';

/** Where the MCP host and the web app live: config, never a hard-coded host. */
describe('loadMcpHostConfig', () => {
  it('defaults to localhost, with paths at the root, outside production', () => {
    expect(loadMcpHostConfig({ NODE_ENV: 'development' })).toEqual({
      mcpPublicUrl: 'http://localhost:3200',
      webAppUrl: 'http://localhost:4000',
      rootPinnedTools: [],
    });
  });

  it('defaults the MCP host to mcp.assay.ai in production, and requires the web app', () => {
    expect(() => loadMcpHostConfig({ NODE_ENV: 'production' })).toThrow(/WEB_APP_URL/);
    expect(
      loadMcpHostConfig({ NODE_ENV: 'production', WEB_APP_URL: 'https://app.example.com' }),
    ).toEqual({
      mcpPublicUrl: 'https://mcp.assay.ai',
      webAppUrl: 'https://app.example.com',
      rootPinnedTools: [],
    });
  });

  it('accepts a bare origin, with or without a trailing slash', () => {
    expect(
      loadMcpHostConfig({ MCP_PUBLIC_URL: 'https://mcp.example.com/', NODE_ENV: 'test' })
        .mcpPublicUrl,
    ).toBe('https://mcp.example.com');
  });

  it('refuses a path or something that is not a URL', () => {
    expect(() => loadMcpHostConfig({ MCP_PUBLIC_URL: 'https://example.com/mcp' })).toThrow(
      /bare origin/,
    );
    expect(() => loadMcpHostConfig({ WEB_APP_URL: 'not a url' })).toThrow(/not a URL/);
  });

  it('reads the root pinned tools: names, deduplicated, at most 5', () => {
    expect(
      loadMcpHostConfig({ MCP_ROOT_PINNED_TOOLS: ' get_weather, geocode_place ,get_weather' })
        .rootPinnedTools,
    ).toEqual(['get_weather', 'geocode_place']);
    expect(() => loadMcpHostConfig({ MCP_ROOT_PINNED_TOOLS: 'a1,b1,c1,d1,e1,f1' })).toThrow(
      /at most 5/,
    );
    expect(() => loadMcpHostConfig({ MCP_ROOT_PINNED_TOOLS: 'Not A Tool' })).toThrow(
      /not a tool name/,
    );
  });
});
