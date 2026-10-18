import { normaliseResource } from '@modules/oauth/domain/resource';
import { normaliseScope } from '@modules/oauth/domain/scope';

const MCP = 'https://mcp.assay.ai';

describe('normaliseScope', () => {
  it('always grants assay:agent', () => {
    expect(normaliseScope(undefined)).toBe('assay:agent');
    expect(normaliseScope(null)).toBe('assay:agent');
    expect(normaliseScope('')).toBe('assay:agent');
    expect(normaliseScope('assay:agent')).toBe('assay:agent');
  });

  it('keeps offline_access when asked', () => {
    expect(normaliseScope('offline_access')).toBe('assay:agent offline_access');
    expect(normaliseScope('offline_access assay:agent')).toBe('assay:agent offline_access');
    expect(normaliseScope('assay:agent  offline_access offline_access')).toBe(
      'assay:agent offline_access',
    );
  });

  it('drops unknown scopes', () => {
    expect(normaliseScope('openid profile email admin')).toBe('assay:agent');
    expect(normaliseScope('assay:admin offline_access write')).toBe('assay:agent offline_access');
  });

  it('is case-sensitive and does not match substrings', () => {
    expect(normaliseScope('OFFLINE_ACCESS')).toBe('assay:agent');
    expect(normaliseScope('offline_access_x')).toBe('assay:agent');
    expect(normaliseScope('offline_accessassay:agent')).toBe('assay:agent');
    expect(normaliseScope('offline_access,assay:agent')).toBe('assay:agent');
  });

  it('ignores non-string input', () => {
    expect(normaliseScope(['offline_access'] as unknown as string)).toBe('assay:agent');
    expect(normaliseScope(42 as unknown as string)).toBe('assay:agent');
  });
});

describe('normaliseResource', () => {
  const ok = { ok: true, resource: MCP };
  const bad = { ok: false, error: 'invalid_target' };

  it('missing gives {MCP}', () => {
    expect(normaliseResource(undefined, MCP)).toEqual(ok);
    expect(normaliseResource(null, MCP)).toEqual(ok);
  });

  it('same origin with any path gives {MCP}', () => {
    for (const raw of [
      MCP,
      `${MCP}/`,
      `${MCP}/c/weather`,
      `${MCP}/@acme/tools`,
      `${MCP}/?tools=a,b`,
      'https://mcp.assay.ai:443/c/weather',
    ]) {
      expect(normaliseResource(raw, MCP)).toEqual(ok);
    }
  });

  it('works for the local http origin', () => {
    const local = 'http://localhost:3200';
    expect(normaliseResource('http://localhost:3200/c/x', local)).toEqual({
      ok: true,
      resource: local,
    });
    expect(normaliseResource('http://localhost:3201/c/x', local)).toEqual(bad);
  });

  it('anything else gives invalid_target', () => {
    for (const raw of [
      '',
      ' ',
      'mcp.assay.ai',
      '/c/weather',
      'http://mcp.assay.ai',
      'https://mcp.assay.ai:8443',
      'https://api.assay.ai',
      'https://assay.ai',
      'https://mcp.assay.ai.evil.example',
      'https://evil.example/https://mcp.assay.ai',
      'https://evil.example?https://mcp.assay.ai',
      'https://mcp.assay.ai@evil.example',
      'https://user@mcp.assay.ai/',
      'https://mcp.assay.ai/#f',
      'https://mcp.assay.ai/c#',
      'https://mcp.assay.ai\\@evil.example',
      ' https://mcp.assay.ai',
      'https://mcp.assay.ai\n',
      'urn:assay:mcp',
    ]) {
      expect(normaliseResource(raw, MCP)).toEqual(bad);
    }
  });

  it('refuses a non-string (e.g. a repeated form parameter)', () => {
    expect(normaliseResource([MCP] as unknown as string, MCP)).toEqual(bad);
    expect(normaliseResource(1 as unknown as string, MCP)).toEqual(bad);
  });
});
