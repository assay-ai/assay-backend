import { All, Controller, Inject, Logger, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { sessionBlockedError } from '@modules/blocklist/services/blocklist-session.source';

import { MCP_BEARER_PREFIX } from '../constants/mcp.constants';
import { MCP_SESSION_SOURCE, McpSessionPort } from '../ports/mcp-session.port';
import { McpServerFactory } from '../services/mcp-server.factory';

/**
 * The Streamable HTTP transport.
 *
 * Stateless per request apart from
 * the session token, so the service scales horizontally with no sticky
 * sessions. That is what `sessionIdGenerator: undefined` selects — the SDK's
 * stateless mode, where each request carries its own initialisation and nothing
 * is remembered between them.
 *
 * ## Why this bypasses the platform's HTTP conventions
 *
 * Everything else in the API returns `{ data, statusCode, message }` through
 * `TransformInterceptor`, and every failure returns the one `ErrorResponse`
 * shape. Neither is true here, and neither can be: the body of every request
 * and response on this route is JSON-RPC 2.0, defined by the MCP
 * specification, and a client that reached this endpoint is validating it
 * against that specification. Writing to `@Res()` directly is what keeps the
 * interceptor's hands off it.
 *
 * The one thing that is *not* bypassed is authentication. It happens here,
 * before a transport exists, so an unauthenticated request is refused with the
 * platform's ordinary `401` rather than being answered in JSON-RPC by a server
 * that does not know who is calling.
 *
 * ## `@All` rather than `@Post`
 *
 * Streamable HTTP uses `GET` for the server-to-client stream and `DELETE` to
 * end a session, and the SDK's transport answers all three — including
 * answering `GET` and `DELETE` with a *protocol-correct* `405` in stateless
 * mode. Routing only `POST` here would have Nest answer those with its own
 * `404`, which an MCP client cannot interpret.
 */
@Controller('mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(
    @Inject(MCP_SESSION_SOURCE) private readonly sessions: McpSessionPort,
    private readonly servers: McpServerFactory,
  ) {}

  @All()
  async handle(@Req() request: Request, @Res() response: Response): Promise<void> {
    const session = await this.sessions.resolve(bearerToken(request));
    // A blocked person's session exists so the dashboard can read; nothing on
    // this endpoint is a read of the account's own data — `tools/list` is the
    // shop and `tools/call` spends — so it is refused whole.
    if (session.blocked) throw sessionBlockedError(session.blocked);

    const server = this.servers.create(session);
    const transport = new StreamableHTTPServerTransport({
      // Stateless. See the class comment.
      sessionIdGenerator: undefined,
      // Answer with a plain JSON body rather than an SSE stream. Nothing here
      // streams — a tool call is one request and one result — and an SSE
      // response would hold the connection open for a client that has already
      // got everything it asked for.
      enableJsonResponse: true,
    });

    // Both are per-request and must not outlive it. Without this a client that
    // disconnects mid-call leaks a transport and a server per abandoned
    // request, which is a slow leak driven by exactly the traffic we cannot
    // control.
    response.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);

    // The body is passed explicitly because Nest has already parsed it. The
    // transport would otherwise read the stream a second time and find it
    // consumed.
    await transport.handleRequest(request, response, request.body);
  }
}

/**
 * `Authorization: Bearer <token>`, or nothing.
 *
 * Returns `null` for every malformed variant rather than trying to salvage one.
 * The session source treats a missing token and an invalid token identically,
 * so there is nothing to gain from telling the two apart here — and a header
 * parser that guesses is a header parser that accepts something it should not.
 */
function bearerToken(request: Request): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith(MCP_BEARER_PREFIX)) return null;

  const token = header.slice(MCP_BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}
