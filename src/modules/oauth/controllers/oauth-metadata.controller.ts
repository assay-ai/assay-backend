import { Controller, Get, Header, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { BUILTIN_CLIENT_PATH } from '../domain/client-id';
import { BuiltinClientDocument } from '../domain/builtin-client';
import {
  AuthorizationServerMetadata,
  PRM_WELL_KNOWN,
  ProtectedResourceMetadata,
} from '../domain/metadata';
import { OAuthDiscoveryService } from '../services/oauth-discovery.service';

/** PRM documents change only with a deploy (spec §6.3.1). */
const PRM_CACHE_CONTROL = 'public, max-age=3600';
const PRM_ROUTE = PRM_WELL_KNOWN.slice(1);

/**
 * Discovery on the MCP host (spec §6.3.1, §6.3.2, §6.3.6 item 3):
 *
 * ```text
 * GET /.well-known/oauth-protected-resource           PRM, resource = {MCP}
 * GET /.well-known/oauth-protected-resource/{path}    PRM, resource = {MCP}{path}
 * GET /.well-known/oauth-authorization-server         AS metadata, issuer = {MCP}
 * GET /.well-known/openid-configuration               404 (not an OpenID provider)
 * GET /oauth/clients/assay-mcp                        the built-in client document
 * ```
 *
 * Public: no guard, no token, nothing keyed to a tenant. Mounted by
 * `OAuthMcpModule`, which `AppMcpModule` imports before the MCP catch-all, so
 * these routes win (R-OA-29).
 */
@ApiTags('OAuth')
@Controller()
export class OAuthMetadataController {
  constructor(private readonly discovery: OAuthDiscoveryService) {}

  @Get(PRM_ROUTE)
  @Header('Cache-Control', PRM_CACHE_CONTROL)
  @ApiOperation({ summary: 'Protected resource metadata for the root URL (RFC 9728)' })
  rootResource(@Req() request: Request): ProtectedResourceMetadata {
    return this.discovery.protectedResource(request.originalUrl);
  }

  @Get(`${PRM_ROUTE}/{*path}`)
  @Header('Cache-Control', PRM_CACHE_CONTROL)
  @ApiOperation({ summary: 'Protected resource metadata for one MCP URL (RFC 9728 §3.3)' })
  pathResource(@Req() request: Request): ProtectedResourceMetadata {
    return this.discovery.protectedResource(request.originalUrl);
  }

  @Get('.well-known/oauth-authorization-server')
  @ApiOperation({ summary: 'Authorization server metadata (RFC 8414)' })
  authorizationServer(): AuthorizationServerMetadata {
    return this.discovery.authorizationServer();
  }

  @Get('.well-known/openid-configuration')
  @ApiOperation({ summary: 'Not an OpenID provider: 404' })
  openIdConfiguration(): never {
    return this.discovery.openIdConfiguration();
  }

  @Get(BUILTIN_CLIENT_PATH.slice(1))
  @ApiOperation({ summary: 'The built-in assay-mcp client document' })
  builtinClient(): BuiltinClientDocument {
    return this.discovery.builtinClient();
  }
}
