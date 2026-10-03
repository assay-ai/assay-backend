/// <reference types="node" />
/**
 * A full MCP session against the running server, with every JSON-RPC frame
 * printed.
 *
 * ```bash
 * yarn start:mcp      # in another shell
 * yarn mcp:session
 * ```
 *
 * The client is the reference `@modelcontextprotocol/sdk` `Client` over the
 * Streamable HTTP transport — the same code path an agent host uses — rather
 * than hand-rolled `fetch` calls. That matters for one specific reason: the SDK
 * validates every response against the specification's schemas and discards
 * what it does not recognise, so a session driven by `curl` can show a price
 * that no real client would ever see.
 *
 * `fetch` is wrapped rather than replaced, so what is printed is the actual
 * bytes on the wire, in order, including the frames the SDK sends on its own
 * initiative (`notifications/initialized`).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { FUNDED, MCP_URL, UNFUNDED } from './demo-config';

async function main(): Promise<void> {
  installWireLog();

  await section('1. A funded agent: initialize, tools/list, tools/call', async () => {
    const client = await connect(FUNDED.token);

    await client.listTools();
    await client.callTool({
      name: 'get_weather',
      arguments: { latitude: 21.03, longitude: 105.85 },
    });

    await client.close();
  });

  await section('2. Error: a tool that does not exist', async () => {
    const client = await connect(FUNDED.token);
    await client.callTool({ name: 'search_the_moon', arguments: {} });
    await client.close();
  });

  await section('3. Error: a required argument is missing', async () => {
    const client = await connect(FUNDED.token);
    await client.callTool({ name: 'get_weather', arguments: { latitude: 21.03 } });
    await client.close();
  });

  await section('4. Error: the agent cannot afford the call', async () => {
    const client = await connect(UNFUNDED.token);
    await client.callTool({
      name: 'get_weather',
      arguments: { latitude: 21.03, longitude: 105.85 },
    });
    await client.close();
  });

  await section('5. Error: no bearer token at all', async () => {
    const response = await globalThis.fetch(MCP_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    console.log(`   HTTP ${response.status}`);
  });
}

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'x402-demo-agent', version: '0.1.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

async function section(title: string, run: () => Promise<void>): Promise<void> {
  console.log(`\n${'═'.repeat(78)}\n${title}\n${'═'.repeat(78)}`);
  try {
    await run();
  } catch (error) {
    console.log(`   ✗ ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Print every request and response body, unmodified.
 *
 * The response is `tee`'d through a clone so the SDK still receives an unread
 * stream — reading it here directly would consume the body and leave the client
 * parsing nothing.
 */
function installWireLog(): void {
  const original = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body) {
      console.log(`\n→ ${format(init.body as string)}`);
    }

    const response = await original(input, init);
    const text = await response.clone().text();
    console.log(`← HTTP ${response.status} ${format(text)}`);

    return response;
  };
}

/** Streamable HTTP may answer as SSE; strip the framing so the JSON is readable. */
function format(raw: string): string {
  const payload = raw.startsWith('event:')
    ? (raw.split('\n').find((line) => line.startsWith('data: ')) ?? raw).slice(6)
    : raw;

  try {
    return JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    return payload.trim();
  }
}

export type { CallToolResult };

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
