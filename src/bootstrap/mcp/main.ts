import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';

import { applyHttpSecurity } from '@shared/security/security-headers';
import { StructuredLogger } from '@shared/observability';
import { LoggingInterceptor } from '@shared/interceptors/logging.interceptor';
import { assertTrustProxyHopsConfigured } from '@config/app.config';
import { loadMcpDiscoveryConfig } from '@modules/mcp/config/mcp-discovery.config';

import { AppMcpModule } from './app.module';
import { mcpCorsOptions } from './mcp-cors';
import { McpExceptionsFilter } from './mcp-exceptions.filter';

/**
 * The MCP server process — the interface agents actually reach the
 * platform through.
 *
 * **No `setGlobalPrefix`, no versioning, no `/mcp`.** The service is its own
 * host (`mcp.assay.ai`, `MCP_PUBLIC_URL`) and every path at its root is an MCP
 * server: `/` is the whole catalogue, `/my/{slug}` a toolset (design spec
 * §7.4). A URL an operator pastes into an agent's configuration is as short as
 * it can be, and the subdomain already says what the host is for.
 *
 * **No `ValidationPipe`, no `TransformInterceptor`.** Every body on this route
 * is JSON-RPC 2.0 and is validated by the MCP SDK against the specification;
 * a `whitelist: true` pipe would strip fields out of a protocol it does not
 * know, and the transform interceptor would wrap a JSON-RPC response in
 * `{ data, statusCode, message }` — which no MCP client can parse.
 *
 * `AllExceptionsFilter` **is** installed, and covers exactly the gap before the
 * protocol starts: a request with no bearer token never reaches a transport, so
 * it leaves as the platform's ordinary `401` `ErrorResponse` rather than as a
 * JSON-RPC error from a server that does not know who is calling.
 */
async function bootstrapMcp() {
  // Fails the boot, not the first paged search, when the cursor secret is
  // missing in production.
  loadMcpDiscoveryConfig();

  const app = await NestFactory.create<NestExpressApplication>(AppMcpModule, {
    logger: new StructuredLogger(),
  });

  const configService = app.get(ConfigService);
  const port = configService.get<number>('app.mcp.port');

  // Client address, as in `api/main.ts`. Both processes sit behind the same
  // balancer, so they share `API_TRUST_PROXY_HOPS`: without it `request.ip`
  // here is the balancer's address and every IP-keyed limit (the public demo)
  // counts all callers as one. Production refuses to start with it unset.
  assertTrustProxyHopsConfigured();
  app.set('trust proxy', configService.get<number>('app.api.trustProxyHops') ?? 0);

  // An MCP client may be a browser-hosted agent, and an OAuth client may run
  // in a browser too. CORS is per route family (`mcp-cors.ts`, spec §6.3):
  // the catch-all allows the MCP headers and exposes the 401 challenge;
  // discovery, token and revocation get a narrow public policy; register and
  // authorize get none. Never with credentials.
  applyHttpSecurity(app);
  app.enableCors(mcpCorsOptions);

  // `AllExceptionsFilter`, except that a body the parser refuses on the OAuth
  // token, revoke and register routes answers in RFC 6749 shape.
  app.useGlobalFilters(new McpExceptionsFilter());

  // The ONLY interceptor this process takes. `TransformInterceptor`
  // is deliberately absent (JSON-RPC has its own envelope) and that must not
  // change — but `LoggingInterceptor` alters no response, it opens the
  // `RequestContext` a `tools/call` is traced by. This is where a trace
  // STARTS: the requestId stamped here is what `VerificationJudgePublisher`
  // puts on the job, and what the worker re-enters after the agent has
  // already been answered.
  app.useGlobalInterceptors(new LoggingInterceptor());

  await app.listen(port);

  console.log(`
  🔌 [MCP SERVER] Streamable HTTP transport on every path of: http://localhost:${port}/
  `);
}

export { bootstrapMcp };
