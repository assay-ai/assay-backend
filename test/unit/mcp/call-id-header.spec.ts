import { offerSolanaRailAInThisSuite } from '../helpers/solana-rail-b';
/**
 * `X-Assay-Call-Id` end to end — a real HTTP server, the real
 * `ProviderRouterService`, the real `EgressBindingInvoker`, and the real
 * `McpToolCallService`. Only the payment-intent store and the ledger are
 * fakes (see `mcp-harness.ts`'s own doc comment for why that split is the
 * right one).
 *
 * The thing under test is that the id minted once by `McpToolCallService.call()`
 * is the *same* value that: (a) lands on the payment intent, and (b) arrives
 * on the wire as the `X-Assay-Call-Id` header a provider's own access log would
 * record. A mock invoker cannot prove (b) — this is why `binding-invoker.spec.ts`
 * and this file both use a real socket instead of a script.
 *
 * `EgressHttpClient` runs `UNTRUSTED_EGRESS_POLICY`, which blocks
 * private/loopback addresses by design (`src/shared/network/egress/`) — the
 * DNS/connect seam is faked here exactly as `binding-invoker.spec.ts` does it,
 * so the address rules run unmodified and the already-approved connection
 * lands on a local server. This relaxation exists only in this test file.
 */
import { AddressInfo } from 'node:net';
import * as http from 'node:http';

import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';
import { EgressBindingInvoker } from '@modules/tool/services/egress-binding.invoker';
import { EgressHttpClient } from '@shared/network/egress';

import { buildBinding, buildProvider, usdc } from '../tool/helpers/routing-fixtures';
import { SESSION, buildMcpHarness } from './helpers/mcp-harness';

// This spec dials a real local socket inside the parallel unit suite. On a
// two-core CI runner it has timed out under load (TOOL_ALL_BINDINGS_FAILED, the
// assertion never reached); retrying keeps the assertion and drops the timing flake.
jest.retryTimes(2, { logErrorsBeforeRetry: true });

const PROVIDER_ADDRESS = '93.184.216.34';

const lookup = jest.fn(async (hostname: string) => {
  if (hostname.endsWith('.example.com')) return [{ address: PROVIDER_ADDRESS, family: 4 as const }];
  const error: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
  error.code = 'ENOTFOUND';
  throw error;
});

let server: http.Server;
let port: number;
let receivedHeaders: http.IncomingHttpHeaders = {};
const openSockets: Array<{ destroy: () => void }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    receivedHeaders = req.headers;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ answer: 'forty-two' }));
  });
  server.on('connection', (socket) => openSockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const socket of openSockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function realInvoker(): EgressBindingInvoker {
  return new EgressBindingInvoker(
    new EgressHttpClient(lookup, (target) => ({
      address: '127.0.0.1',
      family: 4,
      port: target.port === 80 ? port : target.port,
    })),
  );
}

describe('X-Assay-Call-Id reaches the upstream endpoint', () => {
  // Solana has no paid rail by default (review 2026-10-15, C1); these cases
  // pin the rail-A code that is kept for when it is switched back on.
  offerSolanaRailAInThisSuite();

  it('the header the provider receives equals the call id recorded on the intent', async () => {
    const { calls, intents } = buildMcpHarness({
      bindings: [
        buildBinding('provider-a', {
          endpoint: 'http://provider-a.example.com/api',
          // Generous on purpose. This test asserts a *header*, not a latency
          // budget, but it dials a real socket inside the parallel unit suite
          // — and a loaded machine that blows the fixture's default 5s budget
          // turns into a `SYSTEM_ERROR`, a failover with no second provider,
          // and a `TOOL_ALL_BINDINGS_FAILED` that says nothing about the thing
          // under test. Observed once under concurrent load. Raising the
          // budget removes the timing dependency without weakening the
          // assertion: the header still has to arrive, byte-identical.
          timeoutMs: 30_000,
        }),
      ],
      providers: [buildProvider('provider-a')],
      stakes: { 'provider-a': usdc(1000) },
      invoker: realInvoker(),
    });

    const outcome = await calls.call(SESSION, 'Search the web', { query: 'solar flare' });

    expect(outcome.kind).toBe('RESULT');

    console.log('Captured upstream headers:', JSON.stringify(receivedHeaders, null, 2));

    const intent = intents.only;
    expect(intent.callId).toBeTruthy();
    expect(intent.status).toBe(PaymentIntentStatus.VERIFYING);

    // (b): the wire and the payment record agree, byte-identical.
    expect(receivedHeaders['x-assay-call-id']).toBe(intent.callId);

    // The id is genuinely independent of the intent's own id — the whole
    // point of the call-id design (see the migration's doc comment).
    expect(receivedHeaders['x-assay-call-id']).not.toBe(intent.id);
  });
});
