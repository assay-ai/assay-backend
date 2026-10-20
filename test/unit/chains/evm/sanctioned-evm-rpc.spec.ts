import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { parseAbi } from 'viem';

import { createSanctionedEvmClient } from '@modules/chains/evm/sanctioned-evm-rpc';
import {
  EgressHttpClient,
  EgressRequest,
  EgressResponse,
  EgressTrust,
  UNTRUSTED_EGRESS_POLICY,
} from '@shared/network/egress';

/**
 * The chain object `createSanctionedEvmClient` now requires — the numeric id it
 * asserts against and the multicall address viem needs before it will batch.
 */
const TEST_CHAIN = {
  id: 46630,
  name: 'eip155:46630',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [] } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
} as const;

const EVM_SOURCE_DIR = join(__dirname, '../../../../src/modules/chains/evm');

const RPC_URL = 'https://rpc.testnet.chain.robinhood.com';

/**
 * A stand-in for the real {@link EgressHttpClient}.
 *
 * It is typed as the real class rather than as a structural duplicate on
 * purpose: `createSanctionedEvmClient` takes an `EgressHttpClient` and there is
 * no second code path, so the only thing this fake changes is which instance
 * answers. A transport that reached `fetch` instead would not compile against
 * this seam, let alone pass.
 */
function fakeEgress(reply: (request: EgressRequest) => Partial<EgressResponse>): {
  client: EgressHttpClient;
  requests: EgressRequest[];
} {
  const requests: EgressRequest[] = [];
  const client = {
    async request(request: EgressRequest): Promise<EgressResponse> {
      requests.push(request);
      const overrides = reply(request);
      return {
        status: 200,
        headers: {},
        body: '',
        bytes: 0,
        url: request.url,
        redirects: 0,
        ...overrides,
      };
    },
  } as unknown as EgressHttpClient;
  return { client, requests };
}

describe('the EVM JSON-RPC client is declared to the egress guard', () => {
  it('issues every request through EgressHttpClient, which is what sanctions the hop', async () => {
    const { client: egress, requests } = fakeEgress(() => ({
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xb666' }),
    }));

    const client = createSanctionedEvmClient(RPC_URL, egress, TEST_CHAIN as never);
    const chainId = await client.getChainId();

    // 0xb666. Written after observing what the fixture actually produced — the
    // fixture exists to prove the transport is consulted, not to encode a real
    // chain id (46630 is `0xb606`).
    expect(chainId).toBe(46_694);

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.url).toBe(RPC_URL);
    expect(request.method).toBe('POST');
    expect(request.headers?.['content-type']).toBe('application/json');
    expect(JSON.parse(String(request.body))).toEqual({
      jsonrpc: '2.0',
      id: expect.any(Number),
      method: 'eth_chainId',
      params: undefined,
    });
  });

  it('declares INTERNAL_ALLOWED, because the RPC URL is operator configuration', async () => {
    // Not decoration. The default is `PUBLIC_ONLY`, and under it an operator's
    // own node on a loopback or private address is refused `BLOCKED_ADDRESS` —
    // measured against `http://127.0.0.1:8545`, where every eip155 read failed
    // and `GET /escrow` degraded to `chainReadable: false`. `EVM_RPC_URLS` is
    // read from `process.env` at boot, which is the one case
    // `EgressTrust.INTERNAL_ALLOWED` exists for.
    const { client: egress, requests } = fakeEgress(() => ({
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xb666' }),
    }));

    await createSanctionedEvmClient(RPC_URL, egress, TEST_CHAIN as never).getChainId();

    expect(requests).toHaveLength(1);
    expect(requests[0].policy?.trust).toBe(EgressTrust.INTERNAL_ALLOWED);
    // The negative half: the assertion above must be able to fail. The default
    // policy this call site would have had is the strict one, and it is a
    // different value.
    expect(UNTRUSTED_EGRESS_POLICY.trust).toBe(EgressTrust.PUBLIC_ONLY);
    expect(requests[0].policy?.trust).not.toBe(UNTRUSTED_EGRESS_POLICY.trust);
    // …and nothing else was widened: the scheme list is still http/https only.
    expect(requests[0].policy?.allowedProtocols).toEqual(['http:', 'https:']);
  });

  it('reports a JSON-RPC error without quoting what it was given', async () => {
    // Signing-key rule 6, applied to the transport: an error that echoes its
    // input is how a key or a signed payload reaches a log line. The node's
    // code is enough to diagnose with.
    const { client: egress } = fakeEgress(() => ({
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32_000, message: 'execution reverted 0xdeadbeefSECRET' },
      }),
    }));

    const client = createSanctionedEvmClient(RPC_URL, egress, TEST_CHAIN as never);

    await expect(client.getChainId()).rejects.toThrow(/eth_chainId/);
    await expect(client.getChainId()).rejects.toThrow(/-32000/);
    await expect(client.getChainId()).rejects.not.toThrow(/SECRET/);
  });

  it('reports a revert with empty data as a revert, which an older contract answers with', async () => {
    // A Config that predates the dispute upgrade has no `slashDelaySeconds()`
    // and the node says `execution reverted, data: "0x"`. That must reach the
    // caller as viem's ContractFunctionRevertedError — not a TypeError from
    // inside viem — so `readConfigTerms` can tell an old contract from an
    // outage. Measured shape: eip155:46630 on 2026-10-14.
    const { client: egress } = fakeEgress(() => ({
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: 3, message: 'execution reverted', data: '0x' },
      }),
    }));
    const client = createSanctionedEvmClient(RPC_URL, egress, TEST_CHAIN as never);

    const error = await client
      .readContract({
        address: '0xBF2DE8e24254Cf6f2313Ab4B5CeBE8066bBdb0e5',
        abi: parseAbi(['function slashDelaySeconds() view returns (uint64)']),
        functionName: 'slashDelaySeconds',
      })
      .catch((caught: unknown) => caught);

    const names: string[] = [];
    for (let current = error; current; current = (current as { cause?: unknown }).cause) {
      names.push((current as Error).name);
    }
    expect(names).toContain('ContractFunctionRevertedError');
    expect(names).not.toContain('TypeError');
  });

  it('refuses a non-2xx answer rather than decoding whatever body came back', async () => {
    // The positive control is the first test above: the same fixture with a 200
    // succeeds. Without this, a 502 HTML error page decodes to `undefined` and
    // reads as a successful call that returned nothing.
    const { client: egress } = fakeEgress(() => ({
      status: 502,
      body: '<html>bad gateway</html>',
    }));

    const client = createSanctionedEvmClient(RPC_URL, egress, TEST_CHAIN as never);

    await expect(client.getChainId()).rejects.toThrow(/502/);
  });

  it('no file under chains/evm reaches a network primitive directly', () => {
    // The source lock is the primary control for this directory: every network
    // call here must go through the egress client.
    const files = sourceFiles(EVM_SOURCE_DIR);

    // Non-vacuity: a scan that found nothing passes every assertion below.
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const matched = FORBIDDEN.exec(stripComments(readFileSync(file, 'utf8')))?.[0] ?? null;
      expect({ file, matched }).toEqual({ file, matched: null });
    }
  });

  it('the source lock actually recognises the shapes it bans', () => {
    // The other half of the control. `FORBIDDEN` is a regex; a regex that
    // matches nothing passes the scan above against any source tree at all.
    // Every case runs through `stripComments` too, so the stripper cannot be
    // what makes the scan green.
    for (const bad of [
      "const ws = new WebSocket('wss://rpc');",
      "import { webSocket } from 'viem'; const t = webSocket(url);",
      "const t = http('https://rpc');",
      'await globalThis.fetch(url);',
      'const body = await fetch(url);',
      "const WS = require('ws');",
      "import WebSocket from 'ws';",
      "import { WebSocket } from 'isows';",
      "/** viem's http() transport is not used. */\nconst t = http(url);",
    ]) {
      expect(FORBIDDEN.test(stripComments(bad))).toBe(true);
    }
  });

  it('the scan reads code and not prose, which is the one thing it will miss', () => {
    // Deliberate and recorded: the files here DISCUSS `http()` and `webSocket()`
    // at length, because explaining why they are not used is the whole point of
    // the header. Scanning raw text made the lock fail on its own documentation.
    // The cost is that a ban token hidden inside a comment is invisible — which
    // is fine, because a comment opens no socket.
    expect(FORBIDDEN.test(stripComments('// const t = http(url);'))).toBe(false);
    expect(FORBIDDEN.test(stripComments('/* new WebSocket(url) */'))).toBe(false);
  });
});

/** Drops line and block comments so the lock reads code rather than prose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Every network door the EVM directory must not open.
 *
 * `http(` and `webSocket(` are viem's own transports: both reach global `fetch`
 * or the global `WebSocket` from inside the library, which is the case
 * `sanctioned-evm-rpc.ts` exists to replace. `isows` is viem's WebSocket
 * dependency and is reachable without naming `ws`.
 */
const FORBIDDEN =
  /\bnew WebSocket\b|\bwebSocket\s*\(|\bhttp\s*\(|globalThis\.fetch|\bfetch\s*\(|require\(\s*['"]ws['"]\s*\)|from\s+['"]ws['"]|from\s+['"]isows['"]/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}
