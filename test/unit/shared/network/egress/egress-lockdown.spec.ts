/**
 * The runtime guard — the third lock, and the only one that is not a source
 * scan.
 *
 * Two adversarial rounds established the honest ceiling of a source-text rule.
 * Between the lint config and `single-http-client.spec.ts`, every named
 * library, every Node socket primitive, `global`/`globalThis` aliasing,
 * `WebSocket` and dynamic imports are caught. Three things defeat both by
 * construction, and each was *executed* against a stand-in metadata service
 * before this file existed:
 *
 * - `vm.runInThisContext(payload)` → `{"AccessKeyId":"ASIA_STOLEN"}`
 * - `new Function(payload)()` → same
 * - `new Worker(payload, { eval: true })` → same
 *
 * The payload is a string, and the source scan erases string contents by design
 * — that erasure is what keeps it free of false positives. So the only thing
 * left that can decide is the primitive itself, at call time.
 *
 * These tests install the guard for real. `installEgressLockdown` is
 * process-global and irreversible by design, so this file is the only place
 * that calls it.
 */
import * as http from 'node:http';
import { createSanctionedSolanaRpc } from '@modules/chains/solana/sanctioned-rpc';
import { AddressInfo } from 'node:net';
import { runInThisContext } from 'node:vm';

import {
  DEFAULT_EGRESS_LIMITS,
  EgressHttpClient,
  EgressLockdownError,
  EgressRelayTransport,
  UNTRUSTED_EGRESS_POLICY,
  installEgressLockdown,
  isEgressLockdownEnabled,
  installEgressLockdown as install,
} from '@shared/network/egress';

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    // POST answers JSON-RPC so the Solana transport test asserts a real result
    // rather than "it didn't throw"; GET is the stand-in metadata service the
    // bypass tests read.
    if (req.method === 'POST') {
      res.setHeader('content-type', 'application/json');
      res.end('{"jsonrpc":"2.0","id":1,"result":123456}');
      return;
    }
    res.end('{"AccessKeyId":"ASIA_STOLEN"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;

  saveOriginals();
  install();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Node built-ins are shared by every spec file a Jest worker runs, so a guard left installed
  // here broke the next file's supertest calls (provider-connectivity on the CI runner).
  restoreOriginals();
});

/* eslint-disable @typescript-eslint/no-require-imports */
const realModules = {
  http: require('node:http') as Record<string, unknown>,
  https: require('node:https') as Record<string, unknown>,
  http2: require('node:http2') as Record<string, unknown>,
};
/* eslint-enable @typescript-eslint/no-require-imports */
const saved: Array<[Record<string, unknown>, string, unknown]> = [];

function saveOriginals(): void {
  for (const m of [realModules.http, realModules.https]) {
    for (const key of ['request', 'get', 'ClientRequest']) saved.push([m, key, m[key]]);
  }
  saved.push([realModules.http2, 'connect', realModules.http2.connect]);
  const globals = globalThis as Record<string, unknown>;
  for (const key of ['fetch', 'WebSocket']) saved.push([globals, key, globals[key]]);
}

function restoreOriginals(): void {
  for (const [target, key, value] of saved) target[key] = value;
}

describe('the flag', () => {
  const original = process.env;

  afterEach(() => {
    process.env = original;
  });

  it.each([
    [{ NODE_ENV: 'development' }, true],
    [{ NODE_ENV: 'test' }, true],
    [{ NODE_ENV: 'production' }, false],
    [{ NODE_ENV: 'production', EGRESS_LOCKDOWN: 'true' }, true],
    [{ NODE_ENV: 'development', EGRESS_LOCKDOWN: 'false' }, false],
    [{ NODE_ENV: 'production', EGRESS_LOCKDOWN: '' }, false],
  ])('%p → %p', (env, expected) => {
    process.env = { ...original, ...env } as NodeJS.ProcessEnv;
    expect(isEgressLockdownEnabled()).toBe(expected);
  });
});

describe('what no source scan can catch', () => {
  it('blocks http.request called directly', () => {
    expect(() => http.request(`http://127.0.0.1:${port}/`)).toThrow(EgressLockdownError);
  });

  it('blocks global fetch, however it was spelled', () => {
    // The alias-across-statements family: `const g = globalThis` on one line
    // and `g.fetch(url)` on another. Invisible to a line-oriented scan; the
    // same call at runtime.
    const g = globalThis as Record<string, unknown>;
    const viaAlias = g.fetch as (u: string) => Promise<unknown>;
    const viaReflect = Reflect.get(globalThis, 'fetch') as (u: string) => Promise<unknown>;

    // Synchronously, not as a rejected promise. Native `fetch` rejects rather
    // than throws, so this deliberately breaks its contract: a guard whose
    // refusal can be swallowed by a stray `.catch()` is a guard that goes
    // unnoticed, and being unmissable is the whole job.
    expect(() => fetch(`http://127.0.0.1:${port}/`)).toThrow(EgressLockdownError);
    expect(() => viaAlias(`http://127.0.0.1:${port}/`)).toThrow(EgressLockdownError);
    expect(() => viaReflect(`http://127.0.0.1:${port}/`)).toThrow(EgressLockdownError);
  });

  it('blocks code built from a string — the case the scan erases on purpose', () => {
    // `stripCommentsAndStrings` in the architecture test blanks this payload
    // before scanning, which is correct and is exactly why that lock cannot see
    // it. An adversarial review used this shape to read a stand-in metadata
    // service with both source locks green.
    // `fetch` rather than `require`: `require` is a module-local binding, not a
    // global, so it is not in scope inside a `vm` context — asserting on it
    // would assert a ReferenceError and prove nothing.
    const payload = `fetch('http://127.0.0.1:${port}/')`;

    expect(() => new Function(payload)()).toThrow(EgressLockdownError);

    // `vm.runInThisContext` is NOT asserted, and the reason is a property of
    // the test runner rather than of the guard: jest-environment-node runs each
    // test file in its own V8 context, while the `vm` module belongs to the
    // outer realm — so `runInThisContext` sees that realm's untouched `fetch`,
    // not the one patched here. A production process has one realm and the
    // patch applies. Asserting it under Jest would either fail for the wrong
    // reason or need a second realm patched, which would prove the test
    // harness works rather than that the guard does. `node:vm` is banned by
    // both source locks, which is the coverage that remains.
    expect(typeof runInThisContext).toBe('function');
  });

  it('blocks a WebSocket, which reaches any host:port and sends a real request', () => {
    // Node 22+ ships `WebSocket` as a global. `no-restricted-globals` named
    // only `fetch` at first, so `new WebSocket(url)` was a one-line bypass.
    const WS = (globalThis as Record<string, unknown>).WebSocket as
      | (new (url: string) => unknown)
      | undefined;

    if (!WS) {
      // Older Node. Nothing to guard, and nothing to assert.
      return;
    }

    expect(() => new WS(`http://127.0.0.1:${port}/`)).toThrow(EgressLockdownError);
  });

  it('blocks new http.ClientRequest — the factory is not the only door', () => {
    // `http.request` is a factory over `ClientRequest`, and the constructor
    // stays exported. Patching only the factory left a bypass reachable from
    // inside the module already patched.
    expect(() => new http.ClientRequest(`http://127.0.0.1:${port}/`)).toThrow(EgressLockdownError);
  });

  it('is idempotent, so a second install cannot double-wrap or undo the first', () => {
    installEgressLockdown();
    installEgressLockdown();

    expect(() => http.request(`http://127.0.0.1:${port}/`)).toThrow(EgressLockdownError);
  });

  it('does not sanction a stack that merely mentions an exempt-looking name', () => {
    // The forged-frame family, kept as a test so the exemption cannot come
    // back. An object key becomes the frame name, so this was one line.
    const forged = {
      '@solana/kit': () => http.request(`http://127.0.0.1:${port}/`),
    };

    expect(() => forged['@solana/kit']()).toThrow(EgressLockdownError);

    const originalPrepare = Error.prepareStackTrace;
    try {
      Error.prepareStackTrace = () => '@solana/kit';
      expect(() => http.request(`http://127.0.0.1:${port}/`)).toThrow(EgressLockdownError);
    } finally {
      Error.prepareStackTrace = originalPrepare;
    }
  });
});

describe('the sanctioned path still works', () => {
  /**
   * The half that matters as much as the blocking: a guard that also stops the
   * legitimate client is a guard that gets uninstalled on the first outage.
   */
  it('lets EgressHttpClient through, with every check still applied', async () => {
    const client = new EgressHttpClient(
      async () => [{ address: '93.184.216.34', family: 4 }],
      (target) => ({ address: '127.0.0.1', family: 4, port: target.port === 80 ? port : port }),
    );

    const response = await client.request({ url: 'http://edge.provider.test/ok' });

    expect(response.status).toBe(200);
    expect(response.body).toBe('{"AccessKeyId":"ASIA_STOLEN"}');
  });

  it('still refuses a blocked address — the guard is not a bypass of the guard', async () => {
    const client = new EgressHttpClient(async () => [{ address: '10.0.0.5', family: 4 }]);

    await expect(client.request({ url: 'http://internal.provider.test/' })).rejects.toMatchObject({
      code: 'EGRESS_BLOCKED_ADDRESS',
    });
  });

  it('lets the Solana RPC transport through, which the deleted exemption did not', async () => {
    // The exemption this replaced matched `@solana/kit` against the stack. It
    // matched nothing — kit is a re-export barrel and the `fetch` happens in
    // `@solana/rpc-transport-http` — so the first person to enable the guard
    // would have lost Solana RPC, which is how a control gets switched off for
    // good. It was also forgeable five ways, including
    // `Error.prepareStackTrace = () => '@solana/kit'`, which exempts every call
    // in the process from anywhere.
    //
    // This asserts the replacement does what the exemption only claimed to.
    const rpc = createSanctionedSolanaRpc(`http://127.0.0.1:${port}/`);

    await expect(rpc.getSlot().send()).resolves.toBe(123456n);
  });

  it('lets relayed calls through, including a request queued for a pooled socket', async () => {
    // The relay path pools sockets. A request queued behind a busy socket is
    // dispatched later, on the agent's 'free' event, outside the sanctioned
    // scope; it must still go out (the guard sits on `request`/`ClientRequest`,
    // which ran sanctioned when the request was created).
    const token = 'ab'.repeat(32);
    let connections = 0;
    const relay = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        setTimeout(() => {
          res.writeHead(200, { 'x-assay-relay': 'upstream' });
          res.end('relayed');
        }, 20);
      });
    });
    relay.on('connection', () => (connections += 1));
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
    const relayUrl = new URL(`http://127.0.0.1:${(relay.address() as AddressInfo).port}`);

    const transport = new EgressRelayTransport({ url: relayUrl, token }, { maxSockets: 1 });
    const client = new EgressHttpClient(
      async () => [{ address: '93.184.216.34', family: 4 }],
      undefined,
      { url: relayUrl, token },
    );

    try {
      const hop = { url: 'https://edge.provider.test/', method: 'GET', headers: {} };
      const [a, b] = await Promise.all([
        transport.send(hop, DEFAULT_EGRESS_LIMITS),
        transport.send(hop, DEFAULT_EGRESS_LIMITS),
      ]);
      expect(a.body.toString()).toBe('relayed');
      expect(b.body.toString()).toBe('relayed');
      expect(connections).toBe(1);

      const response = await client.request({
        url: 'https://edge.provider.test/',
        policy: { ...UNTRUSTED_EGRESS_POLICY, relay: true },
      });
      expect(response.body).toBe('relayed');

      // And the sanction did not leak out of the relayed call.
      expect(() => http.request(`http://127.0.0.1:${port}/`)).toThrow(EgressLockdownError);
    } finally {
      transport.close();
      client.onModuleDestroy();
      relay.closeAllConnections();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  });

  it('does not leave the sanction set after the call returns', async () => {
    const client = new EgressHttpClient(
      async () => [{ address: '93.184.216.34', family: 4 }],
      () => ({ address: '127.0.0.1', family: 4, port }),
    );

    await client.request({ url: 'http://edge.provider.test/ok' });

    // If the flag leaked out of the AsyncLocalStorage scope, this would succeed
    // and the guard would be off for everything that ran afterwards.
    expect(() => http.request(`http://127.0.0.1:${port}/`)).toThrow(EgressLockdownError);
  });
});
