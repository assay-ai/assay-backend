import { Inject, Injectable } from '@nestjs/common';

import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import { MCP_HOST_CONFIG, McpHostConfig } from '@modules/toolset/config/mcp-host.config';
import { parseMcpUrl } from '@modules/toolset/domain/mcp-url';

import { BuiltinClientDocument, builtinClientDocument } from '../domain/builtin-client';
import {
  AuthorizationServerMetadata,
  PRM_WELL_KNOWN,
  ProtectedResourceMetadata,
  authorizationServerMetadata,
  protectedResourceMetadata,
} from '../domain/metadata';

/**
 * The documents behind `OAuthMetadataController` (spec §6.3.1, §6.3.2,
 * §6.3.6 item 3), built from the public origins only.
 *
 * The path-inserted PRM echoes the path exactly as the client sent it (query
 * dropped, unsafe characters percent-encoded by `resourcePath`), because a
 * strict RFC 9728 client compares `resource` with the URL it derived. The
 * 401 challenge points at it with the same request path, so the two agree. A
 * path that is not an MCP URL has no protected resource and answers 404, as
 * the catch-all would.
 */
@Injectable()
export class OAuthDiscoveryService {
  constructor(@Inject(MCP_HOST_CONFIG) private readonly host: McpHostConfig) {}

  /** `originalUrl` of a request under `/.well-known/oauth-protected-resource`. */
  protectedResource(originalUrl: string): ProtectedResourceMetadata {
    const path = pathAfterPrefix(originalUrl);
    if (path === null || !parseMcpUrl(path === '' ? '/' : path)) throw McpErrors.urlNotFound();
    return protectedResourceMetadata(this.host.mcpPublicUrl, path);
  }

  authorizationServer(): AuthorizationServerMetadata {
    return authorizationServerMetadata(this.host.mcpPublicUrl);
  }

  /** The AS is not an OpenID provider (§6.3.2). */
  openIdConfiguration(): never {
    throw McpErrors.urlNotFound();
  }

  builtinClient(): BuiltinClientDocument {
    return builtinClientDocument(this.host.mcpPublicUrl);
  }
}

/**
 * The raw path after `/.well-known/oauth-protected-resource`, without the
 * query: `''` for the bare form, `null` when the request did not start with
 * the prefix in exactly that spelling.
 */
function pathAfterPrefix(originalUrl: string): string | null {
  const [rawPath] = originalUrl.split('?', 1);
  if (!rawPath.startsWith(PRM_WELL_KNOWN)) return null;
  const rest = rawPath.slice(PRM_WELL_KNOWN.length);
  if (rest !== '' && !rest.startsWith('/')) return null;
  return rest;
}
