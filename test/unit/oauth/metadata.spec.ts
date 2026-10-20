import {
  authorizationServerMetadata,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
} from '@modules/oauth/domain/metadata';

const MCP = 'https://mcp.assay.ai';
const WEB = 'https://app.example.com';

describe('PRM (§6.3.1)', () => {
  it('for path /c/weather has resource === "{MCP}/c/weather"', () => {
    expect(protectedResourceMetadata(MCP, WEB, '/c/weather')).toEqual({
      resource: 'https://mcp.assay.ai/c/weather',
      authorization_servers: ['https://mcp.assay.ai'],
      scopes_supported: ['assay:agent'],
      bearer_methods_supported: ['header'],
      resource_name: 'Assay',
      resource_documentation: 'https://app.example.com/docs/mcp',
    });
  });

  it('the bare PRM has resource === "{MCP}"', () => {
    expect(protectedResourceMetadata(MCP, WEB, '').resource).toBe(MCP);
    expect(protectedResourceMetadata(MCP, WEB, '/').resource).toBe(MCP);
    expect(protectedResourceMetadata(MCP, WEB, undefined).resource).toBe(MCP);
  });

  it('drops a query or fragment from the resource', () => {
    expect(protectedResourceMetadata(MCP, WEB, '/?tools=a').resource).toBe(MCP);
    expect(protectedResourceMetadata(MCP, WEB, '/c/weather?free=1').resource).toBe(
      `${MCP}/c/weather`,
    );
    expect(protectedResourceMetadata(MCP, WEB, '/c/weather#x').resource).toBe(`${MCP}/c/weather`);
  });

  it('keeps an encoded path as it is and encodes characters a URL cannot hold', () => {
    expect(protectedResourceMetadata(MCP, WEB, '/@acme/my%20tools').resource).toBe(
      `${MCP}/@acme/my%20tools`,
    );
    expect(protectedResourceMetadata(MCP, WEB, '/a"b c').resource).toBe(`${MCP}/a%22b%20c`);
  });

  it('lists only assay:agent, never offline_access', () => {
    expect(JSON.stringify(protectedResourceMetadata(MCP, WEB, '/c/weather'))).not.toContain(
      'offline_access',
    );
  });

  it('builds the path-inserted PRM URL (RFC 9728 §3.1)', () => {
    expect(protectedResourceMetadataUrl(MCP, '/c/weather')).toBe(
      'https://mcp.assay.ai/.well-known/oauth-protected-resource/c/weather',
    );
    expect(protectedResourceMetadataUrl(MCP, '/')).toBe(
      'https://mcp.assay.ai/.well-known/oauth-protected-resource',
    );
  });
});

describe('AS metadata (§6.3.2)', () => {
  const metadata = authorizationServerMetadata(MCP, WEB);

  it('has issuer === MCP_PUBLIC_URL exactly', () => {
    expect(metadata.issuer).toBe(MCP);
    expect(authorizationServerMetadata('http://localhost:3200', WEB).issuer).toBe(
      'http://localhost:3200',
    );
  });

  it('equals the spec document field by field', () => {
    expect(metadata).toEqual({
      issuer: 'https://mcp.assay.ai',
      authorization_endpoint: 'https://mcp.assay.ai/oauth/authorize',
      token_endpoint: 'https://mcp.assay.ai/oauth/token',
      registration_endpoint: 'https://mcp.assay.ai/oauth/register',
      revocation_endpoint: 'https://mcp.assay.ai/oauth/revoke',
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['assay:agent', 'offline_access'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      service_documentation: 'https://app.example.com/docs/mcp',
    });
  });

  it('never advertises plain PKCE or a client secret method', () => {
    const json = JSON.stringify(metadata);
    expect(json).not.toContain('plain');
    expect(json).not.toContain('client_secret');
  });

  it('returns fresh arrays each call (callers cannot mutate a shared document)', () => {
    const first = authorizationServerMetadata(MCP, WEB);
    first.scopes_supported.push('x');
    expect(authorizationServerMetadata(MCP, WEB).scopes_supported).toEqual([
      'assay:agent',
      'offline_access',
    ]);
  });
});
