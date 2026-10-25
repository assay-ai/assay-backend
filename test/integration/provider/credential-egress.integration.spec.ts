import { KeyObject, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';

import { Logger } from '@nestjs/common';

import { BindingCredentialRepository } from '@database/postgres/repositories/binding-credential.repository';
import { CredentialVaultService } from '@modules/provider/credentials/credential-vault.service';
import { VaultKeks } from '@modules/provider/credentials/credential-vault.keys';
import { SaveToolBindingBodyDto } from '@modules/provider/dto/save-tool-binding.dto';
import { BindingTestOutcome } from '@modules/provider/ports/binding-test.types';
import { ProviderResponse } from '@modules/tool/domain/classification';
import { REDACTED } from '@modules/tool/domain/egress/credential-redaction';
import { RequestSignerService } from '@modules/tool/request-auth/request-signer.service';
import { signatureBase } from '@modules/tool/request-auth/signature-base';
import { BindingAuthMode, PricingMode } from '@modules/tool/ports/tool.types';
import { toToolBinding } from '@modules/tool/services/database-tool-catalogue';
import { EgressBindingInvoker } from '@modules/tool/services/egress-binding.invoker';
import { EgressHttpClient } from '@shared/network/egress';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  BindingEditorTestContext,
  STAKE_CHAIN,
  TOOL,
  USDC_ASSET,
  USDC_DECIMALS,
  createBindingEditorTestContext,
} from '../helpers/binding-editor-test-context';

/**
 * Stored provider credentials reach exactly the origin they were stored for,
 * and nowhere else: not another origin after an endpoint edit, not a
 * cross-origin redirect target, and not any log line, tester report, stored
 * run or database row.
 *
 * Real `EgressHttpClient` against two local servers (`a.example.com`,
 * `b.example.com`), a real vault on Postgres and a real Ed25519 signer.
 */
const SUBJECT = 'credential-egress';
const CANARY = 'CANARY-7f3a9c';
const HOST_A = 'a.example.com';
const HOST_B = 'b.example.com';
const ORIGIN_A = `http://${HOST_A}`;
const ORIGIN_B = `http://${HOST_B}`;

const lookup = jest.fn(async (hostname: string) => {
  if (hostname.endsWith('.example.com')) return [{ address: '93.184.216.34', family: 4 as const }];
  const error: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
  error.code = 'ENOTFOUND';
  throw error;
});

type Mode = 'ok' | 'error' | 'hang' | 'redirect' | 'echo-json' | 'echo-html';

/** A second credential with every character class that encodes differently. */
const ECHO_SECRET = `ECHO-s3cr3t/v+1&<x> "q" 'z'`;

/** Every form an upstream might echo a value back in. */
function echoForms(value: string): Record<string, string> {
  return {
    raw: value,
    base64: Buffer.from(value).toString('base64'),
    base64url: Buffer.from(value).toString('base64url'),
    percentLower: [...Buffer.from(value)]
      .map((b) => `%${b.toString(16).padStart(2, '0')}`)
      .join(''),
    htmlEntities: [...value].map((c) => `&#x${c.charCodeAt(0).toString(16)};`).join(''),
  };
}

let mode: Mode = 'ok';
const received: Record<'a' | 'b', http.IncomingHttpHeaders[]> = { a: [], b: [] };
const servers: Record<'a' | 'b', { server: http.Server; port: number }> = {} as never;
const openSockets: Array<{ destroy: () => void }> = [];

/** The last request A received, as it arrived on the wire. */
let lastA: { method: string; path: string; body: string } | null = null;

function serverA(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
  received.a.push(req.headers);
  lastA = { method: req.method ?? '', path: req.url ?? '', body };
  if (mode === 'hang') return; // never answers; the deadline ends it
  if (mode === 'error') {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'boom' }));
    return;
  }
  if (mode === 'redirect') {
    res.writeHead(302, { location: `${ORIGIN_B}/landing` });
    res.end();
    return;
  }
  if (mode === 'echo-json' || mode === 'echo-html') {
    const echoed = [req.headers['x-vendor-auth'], req.headers['x-vendor-secret']]
      .filter((v): v is string => typeof v === 'string')
      .map(echoForms);
    const headers = { 'x-echo': String(req.headers['x-vendor-auth'] ?? '') };
    if (mode === 'echo-json') {
      res.writeHead(200, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify({ data: { answer: 'forty-two', echoed } }));
    } else {
      res.writeHead(500, { 'content-type': 'text/html', ...headers });
      const lines = echoed.flatMap((forms) => Object.values(forms));
      res.end(`<html><body><pre>${lines.join('\n')}</pre></body></html>`);
    }
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: { answer: 'forty-two' } }));
}

function serverB(req: http.IncomingMessage, res: http.ServerResponse): void {
  received.b.push(req.headers);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: { answer: 'from b' } }));
}

async function listen(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  server.on('connection', (socket) => openSockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

function body(overrides: Partial<SaveToolBindingBodyDto> = {}): SaveToolBindingBodyDto {
  return {
    toolId: TOOL.id,
    endpoint: `${ORIGIN_A}/api`,
    requestMapping: { method: 'POST', path: '/search', body: { q: '$.query' } },
    responseMapping: { answer: '$.data.answer' },
    pricingMode: PricingMode.PAID,
    priceAmount: '50000',
    assetId: USDC_ASSET,
    settlementChains: [STAKE_CHAIN],
    slaFailureRate: 0.02,
    timeoutMs: 400,
    ...overrides,
  } as SaveToolBindingBodyDto;
}

const kek = { keyId: 'k1', key: randomBytes(32) };
const keks: VaultKeks = { active: kek, byId: new Map([[kek.keyId, kek]]) };

let context: BindingEditorTestContext;
let vault: CredentialVaultService;
let invoker: EgressBindingInvoker;
let publicKey: KeyObject;
const logged: string[] = [];

beforeAll(async () => {
  servers.a = await listen(serverA);
  servers.b = await listen(serverB);

  const pair = generateKeyPairSync('ed25519');
  publicKey = pair.publicKey;
  const seed = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const signer = new RequestSignerService([{ keyId: 'it-1', seed, claimedPublicKey: null }]);

  // The context needs the invoker and the vault needs the context's database,
  // so the invoker reads the vault through a late-bound reference.
  const lateVault = {
    headersFor: (organizationId: string, bindingId: string, origin: string) =>
      vault.headersFor(organizationId, bindingId, origin),
  } as unknown as CredentialVaultService;

  invoker = new EgressBindingInvoker(
    new EgressHttpClient(lookup, (target) => ({
      address: '127.0.0.1',
      family: 4,
      port: target.url.hostname === HOST_B ? servers.b.port : servers.a.port,
    })),
    lateVault,
    signer,
  );

  context = await createBindingEditorTestContext(invoker, undefined, signer);
  vault = new CredentialVaultService(new BindingCredentialRepository(context.dataSource), keks);

  for (const level of ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      logged.push(JSON.stringify(args.map(String)));
    });
    jest.spyOn(Logger, level).mockImplementation((...args: unknown[]) => {
      logged.push(JSON.stringify(args.map(String)));
    });
  }
});

afterAll(async () => {
  jest.restoreAllMocks();
  for (const socket of openSockets) socket.destroy();
  await Promise.all(
    Object.values(servers).map(
      ({ server }) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  await context.close();
});

let bindingId: string;

beforeEach(async () => {
  mode = 'ok';
  received.a = [];
  received.b = [];
  await context.reset();
  await context.registerProvider();
  context.stakes.set(context.organizationId, MoneyUtil.of('100000000', USDC_ASSET, USDC_DECIMALS));
  bindingId = (await context.editor.create(context.organizationId, SUBJECT, body())).id;
  await vault.put(
    context.organizationId,
    bindingId,
    ORIGIN_A,
    [{ name: 'X-Vendor-Auth', value: CANARY }],
    SUBJECT,
  );
});

function runTester() {
  return context.tester.run(context.organizationId, SUBJECT, bindingId, { query: 'anything' });
}

describe('credential egress', () => {
  it('sends the credential and the signature to the origin they were stored for', async () => {
    // Only SIGNATURE and BOTH bindings are signed.
    await context.editor.update(context.organizationId, SUBJECT, bindingId, {
      authMode: BindingAuthMode.SIGNATURE,
    });
    const report = await runTester();

    expect(report.outcome).toBe(BindingTestOutcome.PASSED);
    // The tested call, then the tester's unsigned probe.
    expect(received.a).toHaveLength(2);
    expect(received.a[1].signature).toBeUndefined();
    expect(received.a[0]['x-vendor-auth']).toBe(CANARY);
    expect(received.a[0].signature).toMatch(/^assay=:.+:$/);
    expect(received.a[0]['signature-input']).toMatch(/^assay=\(/);
    expect(received.a[0]['content-digest']).toMatch(/^sha-256=:.+:$/);

    // The signature verifies over what A actually received: method, authority,
    // the path as sent, the digest of the body and the call id.
    const headers = received.a[0] as Record<string, string>;
    const params =
      /created=(\d+);expires=(\d+);nonce="([^"]+)";keyid="([^"]+)";alg="ed25519";tag="[^"]+";aud="([^"]+)"/.exec(
        headers['signature-input'],
      );
    expect(params).not.toBeNull();
    const base = signatureBase(
      {
        method: lastA!.method,
        url: `http://${headers.host}${lastA!.path}`,
        headers,
        body: lastA!.body,
      },
      {
        created: +params![1],
        expires: +params![2],
        nonce: params![3],
        keyId: params![4],
        audience: params![5],
      },
    );
    // Signed for this provider, so no other provider's verifier accepts it.
    expect(params![5]).toBe(context.organizationId);
    const signature = Buffer.from(/^assay=:(.+):$/.exec(headers.signature)![1], 'base64');
    expect(verify(null, Buffer.from(base, 'utf8'), publicKey, signature)).toBe(true);
  });

  it('sends no credential to a new origin after the endpoint is edited', async () => {
    await context.editor.update(context.organizationId, SUBJECT, bindingId, {
      endpoint: `${ORIGIN_B}/api`,
      authMode: BindingAuthMode.SIGNATURE,
    });

    await runTester();
    // Stored again for A while the endpoint is B: still only A's.
    await vault.put(
      context.organizationId,
      bindingId,
      ORIGIN_A,
      [{ name: 'X-Vendor-Auth', value: CANARY }],
      SUBJECT,
    );
    await runTester();

    expect(received.a).toHaveLength(0);
    // Each run: the tested call, then the tester's unsigned probe.
    expect(received.b).toHaveLength(4);
    for (const headers of received.b) {
      expect(headers['x-vendor-auth']).toBeUndefined();
      expect(JSON.stringify(headers)).not.toContain(CANARY);
    }
    // Still signed: the signature is Assay's, not the provider's secret.
    expect(
      received.b.filter((headers) => /^assay=:.+:$/.test(String(headers.signature ?? ''))),
    ).toHaveLength(2);
  });

  it('strips the credential and the signature on a cross-origin redirect', async () => {
    mode = 'redirect';
    await runTester();

    expect(received.a).toHaveLength(1);
    expect(received.a[0]['x-vendor-auth']).toBe(CANARY);
    expect(received.b).toHaveLength(1);
    expect(received.b[0]['x-vendor-auth']).toBeUndefined();
    expect(received.b[0].signature).toBeUndefined();
    expect(received.b[0]['signature-input']).toBeUndefined();
    expect(received.b[0]['content-digest']).toBeUndefined();
    expect(received.b[0]['x-assay-call-id']).toBeDefined();
  });

  it('leaks the credential into no log, report, stored run, response or row', async () => {
    const reports: unknown[] = [];
    const responses: ProviderResponse[] = [];

    for (const next of ['ok', 'error', 'hang', 'redirect'] as const) {
      mode = next;
      reports.push(await runTester());
    }

    // The router's path too: the ProviderResponse the invoker hands back.
    const binding = toToolBinding(
      await context.editor.loadEditable(context.organizationId, bindingId),
    );
    for (const next of ['ok', 'error', 'hang', 'redirect'] as const) {
      mode = next;
      responses.push(
        await invoker.invoke({
          tool: TOOL,
          binding,
          input: { query: 'anything' },
          timeoutMs: 400,
          callId: `it-${next}`,
        }),
      );
    }

    // Every request in fact carried it to A, so the absence below is meaningful.
    expect(received.a.filter((h) => h['x-vendor-auth'] === CANARY)).toHaveLength(8);
    expect(responses.map((r) => r.status)).toEqual([200, 500, 0, 200]);

    // The spy is live (the redirect hop logs), so silence below means something.
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join('\n')).not.toContain(CANARY);
    expect(JSON.stringify(reports)).not.toContain(CANARY);
    expect(JSON.stringify(responses)).not.toContain(CANARY);

    const runs = await context.dataSource.query(
      `SELECT report::text AS report FROM binding_test_runs WHERE binding_id = $1`,
      [bindingId],
    );
    expect(runs.length).toBe(4);
    for (const { report } of runs) expect(report).not.toContain(CANARY);

    const tables: Array<{ table_name: string }> = await context.dataSource.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          AND table_name <> 'binding_credentials'`,
    );
    expect(tables.map((t) => t.table_name)).toEqual(
      expect.arrayContaining(['tool_bindings', 'binding_test_runs', 'providers']),
    );
    for (const { table_name } of tables) {
      const [hit] = await context.dataSource.query(
        `SELECT count(*)::int AS n FROM "${table_name}" t WHERE t::text LIKE $1`,
        [`%${CANARY}%`],
      );
      expect({ table: table_name, rows: hit.n }).toEqual({ table: table_name, rows: 0 });
    }
  });

  it('redacts a credential the provider echoes back, in every encoding', async () => {
    await vault.put(
      context.organizationId,
      bindingId,
      ORIGIN_A,
      [
        { name: 'X-Vendor-Auth', value: CANARY },
        { name: 'X-Vendor-Secret', value: ECHO_SECRET },
      ],
      SUBJECT,
    );
    const forms = [...Object.values(echoForms(CANARY)), ...Object.values(echoForms(ECHO_SECRET))];
    logged.length = 0;

    const reports: unknown[] = [];
    for (const next of ['echo-json', 'echo-html'] as const) {
      mode = next;
      reports.push(await runTester());
    }
    const binding = toToolBinding(
      await context.editor.loadEditable(context.organizationId, bindingId),
    );
    const responses: ProviderResponse[] = [];
    for (const next of ['echo-json', 'echo-html'] as const) {
      mode = next;
      responses.push(
        await invoker.invoke({
          tool: TOOL,
          binding,
          input: { query: 'anything' },
          timeoutMs: 400,
          callId: `it-${next}`,
        }),
      );
    }

    // The provider did receive both values and did echo them.
    expect(received.a).toHaveLength(4);
    for (const headers of received.a) {
      expect(headers['x-vendor-auth']).toBe(CANARY);
      expect(headers['x-vendor-secret']).toBe(ECHO_SECRET);
    }
    expect(JSON.stringify(responses)).toContain(REDACTED);
    expect(JSON.stringify(reports)).toContain(REDACTED);
    expect(responses[0].headers?.['x-echo']).toBe(REDACTED);

    const runs: Array<{ report: string }> = await context.dataSource.query(
      `SELECT report::text AS report FROM binding_test_runs WHERE binding_id = $1`,
      [bindingId],
    );
    expect(runs).toHaveLength(2);

    const surfaces: Record<string, string> = {
      reports: JSON.stringify(reports),
      responses: JSON.stringify(responses),
      runs: runs.map((run) => run.report).join('\n'),
      logs: logged.join('\n'),
    };
    for (const [surface, text] of Object.entries(surfaces)) {
      for (const form of forms) {
        // JSON.stringify escapes `"` and `\`, so look for both spellings.
        const escaped = JSON.stringify(form).slice(1, -1);
        expect({ surface, form, found: text.includes(form) || text.includes(escaped) }).toEqual({
          surface,
          form,
          found: false,
        });
      }
    }
  });
});
