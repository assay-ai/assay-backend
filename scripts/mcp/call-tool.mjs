/**
 * Call one tool over MCP as any credential.
 *
 * ```bash
 * yarn mcp:call <token> --list
 * yarn mcp:call <token> get_weather '{"latitude":21.03,"longitude":105.85}'
 * ```
 *
 * `scripts/mcp/session.ts` drives the same transport but is hard-wired to the
 * seed credentials in `credentials.json`. This one takes the token as an
 * argument, which is the only way to exercise a credential a *user* minted in
 * the UI (`x402_sk_live_…`, `DbCredentialMcpSessionSource`) — the path a real
 * agent takes, and the one the demo runbook walks.
 *
 * The client is the reference SDK `Client` over Streamable HTTP for the reason
 * `session.ts` gives: the SDK validates and discards what it does not
 * recognise, so a session driven by `curl` can show a price no real client
 * would ever see.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [token, tool = '--list', rawArgs] = process.argv.slice(2);

if (!token) {
  console.error('usage: yarn mcp:call <token> [tool] [json-arguments]');
  process.exit(1);
}

const url = process.env.MCP_DEMO_URL ?? 'http://127.0.0.1:3200/mcp';
const args = JSON.parse(rawArgs ?? '{}');

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'mcp-call', version: '1.0.0' }, { capabilities: {} });

await client.connect(transport);

const listed = await client.listTools();
console.log('tools:', listed.tools.map((entry) => entry.name).join(', '));

if (tool !== '--list') {
  const result = await client.callTool({ name: tool, arguments: args });
  const receipt = result._meta?.['x402/receipt'];
  const failure = result._meta?.['x402/error'];

  if (receipt) {
    console.log(
      `intent ${receipt.intentId ?? '(none — free tier)'} · ${receipt.status ?? 'no hold'} · charged ${receipt.charged?.display}`,
    );
  }
  if (failure) console.log(`error ${failure.code}: ${failure.detail}`);
  console.log('result:', JSON.stringify(result.structuredContent ?? result.content, null, 1));
}

await client.close();
