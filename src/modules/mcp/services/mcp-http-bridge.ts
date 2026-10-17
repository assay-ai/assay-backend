import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';

import {
  AuthInfo,
  McpHttpHandler,
  McpRequestContext,
  Server,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isJsonContentType,
  isLegacyRequest,
} from '@modelcontextprotocol/server';

import { McpScope } from '../ports/mcp-scope';
import { McpSession } from '../ports/mcp-session.port';

/** What one request's server is built for: the caller and the URL's scope. */
export interface McpServerBinding {
  readonly session: McpSession;
  readonly scope: McpScope;
}

/** Builds the per-request server; `McpServerFactory.create` in production. */
export type McpServerBuilder = (session: McpSession, scope: McpScope) => Server;

/**
 * The Streamable HTTP transport for both protocol eras, on an Express request
 * that authentication and URL resolution have already passed.
 *
 * ```text
 * POST, 2026-07-28 envelope  → createMcpHandler (modern, sessionless, JSON)   ttlMs on lists
 * POST, 2025-era (no claim)  → a stateless Streamable HTTP transport (JSON)   no TTL
 * GET / DELETE / anything    → 405: no stream and no session on this host
 * ```
 *
 * The era is decided per request by the SDK's own classifier
 * (`isLegacyRequest`), so an older client keeps working unchanged and a newer
 * one gets the 2026-07-28 wire shape. Both legs build their server from the
 * same builder, so the two eras can never serve different tools.
 *
 * The caller's session and scope ride `authInfo.extra` into the SDK's factory
 * call: the entry passes `authInfo` through untouched and never serializes it.
 */
export class McpHttpBridge {
  private readonly modern: McpHttpHandler;

  constructor(private readonly build: McpServerBuilder) {
    this.modern = createMcpHandler((context) => this.serverFor(context), {
      // Legacy traffic never reaches this handler; see `serve`.
      legacy: 'reject',
      // One request, one JSON body: the server sends nothing before its result.
      responseMode: 'json',
    });
  }

  async serve(
    request: ExpressRequest,
    response: ExpressResponse,
    binding: McpServerBinding,
  ): Promise<void> {
    if (request.method.toUpperCase() !== 'POST') {
      // Stateless and JSON only: there is no server-to-client stream to open
      // (GET) and no session to end (DELETE).
      response
        .status(405)
        .set('Allow', 'POST')
        .json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed.' },
          id: null,
        });
      return;
    }
    if (!isJsonContentType(headerText(request.headers['content-type']))) {
      response.status(415).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Content-Type must be application/json.' },
        id: null,
      });
      return;
    }

    const aborted = new AbortController();
    response.on('close', () => {
      if (!response.writableFinished) aborted.abort();
    });

    const body: unknown = request.body;
    const web = toWebRequest(request, body, aborted.signal);
    const authInfo = authInfoOf(binding);

    const answer = (await isLegacyRequest(web, body))
      ? await this.serveLegacy(web, body, authInfo, binding)
      : await this.modern.fetch(web, { authInfo, parsedBody: body });

    await writeWebResponse(answer, response);
  }

  /** The 2025-era leg: a fresh server on a stateless JSON transport, for this request only. */
  private async serveLegacy(
    web: Request,
    body: unknown,
    authInfo: AuthInfo,
    binding: McpServerBinding,
  ): Promise<Response> {
    const server = this.build(binding.session, binding.scope);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(web, { parsedBody: body, authInfo });
    } finally {
      void transport.close();
      void server.close();
    }
  }

  private serverFor(context: McpRequestContext): Server {
    const binding = context.authInfo?.extra?.[BINDING_KEY] as McpServerBinding | undefined;
    // Unreachable through `serve`, which always binds one; a server with no
    // caller would be a server for nobody, so it is refused outright.
    if (!binding) throw new Error('MCP request reached the SDK without a resolved caller');
    return this.build(binding.session, binding.scope);
  }
}

const BINDING_KEY = 'assay/binding';

function authInfoOf(binding: McpServerBinding): AuthInfo {
  return {
    // The bearer token is the platform's to keep; nothing downstream reads it.
    token: '',
    clientId: binding.session.credentialId,
    scopes: [],
    extra: { [BINDING_KEY]: binding },
  };
}

/** Hop-by-hop or recomputed headers that must not be copied onto a rebuilt request. */
const DROPPED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
]);
const DROPPED_RESPONSE_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection']);

/** The Express request (body already parsed by Nest) → a web `Request` the SDK reads. */
function toWebRequest(request: ExpressRequest, body: unknown, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || DROPPED_REQUEST_HEADERS.has(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  // The origin is not used for routing (the path was resolved already); a
  // fixed one keeps a forged Host header out of everything the SDK sees.
  return new Request(`http://mcp.internal${request.originalUrl}`, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
}

async function writeWebResponse(answer: Response, response: ExpressResponse): Promise<void> {
  response.status(answer.status);
  answer.headers.forEach((value, name) => {
    if (!DROPPED_RESPONSE_HEADERS.has(name)) response.setHeader(name, value);
  });
  response.end(Buffer.from(await answer.arrayBuffer()));
}

function headerText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(', ') : (value ?? '');
}
