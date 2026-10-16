import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { applyHttpSecurity } from '@shared/security/security-headers';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';
import { StructuredLogger } from '@shared/observability';
import { LoggingInterceptor } from '@shared/interceptors/logging.interceptor';
import { AppMcpModule } from './app.module';

/**
 * The MCP server process — the interface agents actually reach the
 * platform through.
 *
 * **No `setGlobalPrefix`, no versioning.** The route is exactly `/mcp`, because
 * that is a URL an operator pastes into an agent's configuration and an MCP
 * client sends JSON-RPC to. `/api/v1/mcp` would work equally well as HTTP and
 * would be one more thing every integration has to be told.
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
  const app = await NestFactory.create(AppMcpModule, {
    logger: new StructuredLogger(),
  });

  const port = app.get(ConfigService).get<number>('app.mcp.port');

  // An MCP client may be a browser-hosted agent. `Authorization` has to be
  // allowed explicitly — it is not a CORS-safelisted request header — and
  // `mcp-session-id` / `mcp-protocol-version` are the Streamable HTTP headers a
  // client must be able to send and read back. Any origin, but without
  // credentials: the bearer token is a header, not a cookie, so nothing is
  // lost, and `*` with credentials is the pairing R17-R-02 removed.
  applyHttpSecurity(app);
  app.enableCors({
    origin: '*',
    allowedHeaders: ['content-type', 'authorization', 'mcp-session-id', 'mcp-protocol-version'],
    exposedHeaders: ['mcp-session-id', 'mcp-protocol-version'],
  });

  app.useGlobalFilters(new AllExceptionsFilter());

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
  🔌 [MCP SERVER] Streamable HTTP transport on: http://localhost:${port}/mcp
  `);
}

export { bootstrapMcp };
