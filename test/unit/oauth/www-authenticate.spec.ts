import { challengeHeader } from '@modules/oauth/domain/www-authenticate';

const MCP = 'https://mcp.assay.ai';

describe('WWW-Authenticate challenge (§6.3.3)', () => {
  it('equals the spec header for /c/weather without a token', () => {
    expect(challengeHeader(MCP, '/c/weather', false)).toBe(
      'Bearer resource_metadata="https://mcp.assay.ai/.well-known/oauth-protected-resource/c/weather", scope="assay:agent"',
    );
  });

  it('appends error="invalid_token" only when a token was presented', () => {
    expect(challengeHeader(MCP, '/c/weather', true)).toBe(
      'Bearer resource_metadata="https://mcp.assay.ai/.well-known/oauth-protected-resource/c/weather", scope="assay:agent", error="invalid_token"',
    );
    expect(challengeHeader(MCP, '/c/weather', false)).not.toContain('error');
  });

  it('never contains offline_access', () => {
    for (const presented of [true, false]) {
      expect(challengeHeader(MCP, '/c/weather', presented)).not.toContain('offline_access');
      expect(challengeHeader(MCP, '/', presented)).not.toContain('offline_access');
    }
  });

  it('points the root at the bare PRM', () => {
    expect(challengeHeader(MCP, '/', false)).toBe(
      'Bearer resource_metadata="https://mcp.assay.ai/.well-known/oauth-protected-resource", scope="assay:agent"',
    );
    expect(challengeHeader(MCP, '', false)).toContain(
      'resource_metadata="https://mcp.assay.ai/.well-known/oauth-protected-resource"',
    );
  });

  it("maps a URL with a query to the path's PRM", () => {
    expect(challengeHeader(MCP, '/?tools=a,b', false)).toContain(
      'resource_metadata="https://mcp.assay.ai/.well-known/oauth-protected-resource"',
    );
    expect(challengeHeader(MCP, '/c/weather?free=1', false)).toContain(
      '/.well-known/oauth-protected-resource/c/weather"',
    );
  });

  it('cannot be broken out of its quoted string or split into lines', () => {
    for (const path of [
      '/a"b',
      '/a\\b',
      '/a", error="x',
      '/a\r\nSet-Cookie: x=1',
      '/a\u0000b',
      '/é',
    ]) {
      const header = challengeHeader(MCP, path, false);
      expect(header).toMatch(/^[\x20-\x7e]+$/);
      expect(header).not.toContain('\\');
      expect(header.split('"')).toHaveLength(5);
      expect(header).toMatch(
        /^Bearer resource_metadata="https:\/\/mcp\.assay\.ai\/\.well-known\/oauth-protected-resource\/[^"]+", scope="assay:agent"$/,
      );
    }
  });
});
