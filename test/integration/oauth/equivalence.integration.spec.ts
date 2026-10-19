import request, { Response } from 'supertest';

import { AgentDelegateService } from '@modules/account/services/agent-delegate.service';
import { BlockSubjectKind, subjectKey } from '@modules/blocklist/domain/account-block';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';
import { MCP_SESSION_SOURCE, McpSessionPort } from '@modules/mcp/ports/mcp-session.port';
import { SpendPolicyService } from '@modules/spend-policy/services/spend-policy.service';
import { AccessEpochService } from '@modules/toolset/services/access-epoch.service';

import {
  RunContext,
  expectEquivalent,
  normaliser,
  observed,
  runTwins,
} from '../helpers/equivalence-compare';
import {
  BOTH,
  BUILTIN,
  CREDENTIAL_NAME,
  DelegateKey,
  EquivalenceApps,
  FREEMIUM_QUOTA,
  MAKER_TOOL,
  PaymentRequirement,
  SharedUrls,
  TOOLS,
  USDG,
  Via,
  World,
  bootEquivalenceApps,
  credentialOf,
  newDelegateKey,
  signBindingChallenge,
  signVoucher,
} from '../helpers/equivalence-fixtures';

// `bull-board.module.ts` has a type error ts-jest reports and the build does
// not; the API app imports it, and it has nothing to do with this suite.
jest.mock('../../../src/bull-board/bull-board.module', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Module } = require('@nestjs/common');
  class BullBoardConfigModule {}
  Module({})(BullBoardConfigModule);
  return { BullBoardConfigModule };
});

/** Free calls an agent gets a day, platform-wide (`FREE_QUOTA_PLATFORM_AGENT_DAILY_LIMIT`). */
const PLATFORM_FREE_CALLS = 6;

/** Every MCP URL kind (§7.4), in the order of spec §12.1. */
const KINDS = [
  'root',
  'category',
  'handle',
  'publicToolset',
  'publicToolsetPinned',
  'unlisted',
  'unlistedPinned',
  'myToolset',
  'myToolsetPinned',
] as const;
type Kind = (typeof KINDS)[number];

const QUERIES = [
  '',
  `?tools=${TOOLS.free.name},${TOOLS.paid.name}`,
  '?category=weather',
  '?free=1',
  '?discovery=full',
];

/**
 * The equivalence suite (spec §12.1, Task 1.17; owner rule 1, G3, R-OA-18,
 * R-OA-22).
 *
 * The owner's rule: an OAuth grant is only another way to obtain an API key.
 * On every MCP path an `assay-mcp` access token must behave exactly as an API
 * key of the same agent: the same session, limits, toolset access, blocklist,
 * revocation and audit. Every case below runs once with each, on the real
 * `AppMcpModule` and `AppApiModule` over HTTP, and compares the status, the
 * JSON-RPC result (`x402/error.code` and every `_meta` key with it) and every
 * row the run left in the database; `equivalence-compare.ts` names the only
 * differences allowed.
 *
 * The exceptions (H2, §6.3.13) run on a third-party grant: it cannot bind a
 * payment key, cannot use the API host, and gets no enable-paid link; every
 * free MCP case is still equal to the key.
 *
 * This file is in the Part 1, 2 and 3 gate commands. Every task that touches
 * the MCP call path re-runs it.
 */
describe('OAuth = API key: the equivalence suite (§12.1)', () => {
  let apps: EquivalenceApps;
  let shared: SharedUrls;

  beforeAll(async () => {
    apps = await bootEquivalenceApps({
      database: 'assay_oauth_equivalence_test',
      env: { FREE_QUOTA_PLATFORM_AGENT_DAILY_LIMIT: String(PLATFORM_FREE_CALLS) },
    });
    shared = await apps.publishMarket();
  }, 300_000);

  afterAll(async () => {
    await apps?.close();
  });

  // ── callers ────────────────────────────────────────────────────────────────

  let rpcId = 0;
  const rpc = (bearer: string, path: string, method: string, params?: unknown) =>
    request(apps.mcp.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${bearer}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) });

  /** `tools/call`, with the call's own `_meta` when given. */
  const call = (
    bearer: string,
    path: string,
    name: string,
    args: Record<string, unknown> = { query: 'moon landing' },
    meta?: Record<string, unknown>,
  ) => rpc(bearer, path, 'tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) });

  /** A request on the API host with an agent credential. */
  const onApi = (
    bearer: string,
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    body?: object,
  ) => {
    const pending = request(apps.api.getHttpServer())
      [method](`/api/v1${path}`)
      .set('Authorization', `Bearer ${bearer}`);
    return body ? pending.send(body) : pending;
  };

  /** What an MCP client sees, the JSON-RPC `id` aside (a counter of this file). */
  const seen = (response: Response) => {
    const view = observed(response) as { body?: Record<string, unknown> };
    if (view.body && typeof view.body === 'object') delete view.body.id;
    return view;
  };

  const requirementOf = (response: Response): PaymentRequirement | null =>
    (response.body?.result?._meta?.['x402/paymentRequired'] as PaymentRequirement) ?? null;

  const errorCodeOf = (response: Response): string | undefined =>
    response.body?.result?._meta?.['x402/error']?.code ?? response.body?.error?.code;

  /** Binds `key` to the run's credential over the API host, as `assay-mcp` does (F4). */
  async function bindDelegate(bearer: string, key: DelegateKey) {
    const challenge = await onApi(bearer, 'post', '/agents/me/delegate/challenge', {
      delegate: key.signer.address,
    });
    const typedData = challenge.body?.data?.typedData;
    const bind = typedData
      ? await onApi(bearer, 'post', '/agents/me/delegate', {
          challengeId: challenge.body.data.challengeId,
          signature: await signBindingChallenge(key, typedData),
        })
      : null;
    return { challenge: observed(challenge), bind: bind ? observed(bind) : null };
  }

  /** The payer authorises `key` on chain (a person's act, never the server's). */
  const authorise = (world: World, key: DelegateKey) =>
    apps.market.chain.authorize(world.wallet, key.account);

  const sessionSource = (app: 'mcp' | 'api') =>
    apps[app].get<McpSessionPort>(MCP_SESSION_SOURCE, { strict: false });

  /** Waits for a fresh minute when fewer than `seconds` remain in this one (fixed windows). */
  async function inOneWindow(seconds: number): Promise<void> {
    const left = 60 - new Date().getUTCSeconds();
    if (left < seconds) await new Promise((resolve) => setTimeout(resolve, left * 1000 + 250));
  }

  const urlOf = (kind: Kind): string =>
    ({
      root: '/',
      category: '/c/weather',
      handle: `/@${shared.handle}`,
      publicToolset: `/@${shared.handle}/kit`,
      publicToolsetPinned: `/@${shared.handle}/kit@1`,
      unlisted: `/u/${shared.unlistedToken}`,
      unlistedPinned: `/u/${shared.unlistedToken}@1`,
      myToolset: '/my/kit',
      myToolsetPinned: '/my/kit@1',
    })[kind];

  const twoKeys = (): Record<Via, DelegateKey> => ({
    key: newDelegateKey(),
    grant: newDelegateKey(),
  });

  // ── Session ────────────────────────────────────────────────────────────────

  describe('Session', () => {
    it('the full McpSession equals the API key session but for credentialId, on both hosts (R-OA-18)', async () => {
      const world = await apps.world();
      for (const app of ['mcp', 'api'] as const) {
        const viaKey = await sessionSource(app).resolve(world.key.bearer);
        const viaGrant = await sessionSource(app).resolve(world.grant.bearer);
        expect(viaGrant).toStrictEqual({ ...viaKey, credentialId: world.grant.id });
        expect(viaGrant.paymentsAllowed).toBe(true);
      }
    });

    it('with the same narrowing and a bound delegate on each, the sessions still match', async () => {
      const world = await apps.world();
      const keys = twoKeys();
      for (const via of BOTH) {
        const credential = credentialOf(world, via);
        const narrowed = await apps.asPerson(
          world,
          'patch',
          `/agent-credentials/${credential.id}/access`,
          { accessMode: 'RESTRICTED', allowedToolIds: [TOOLS.free.id, TOOLS.paid.id] },
        );
        expect(narrowed.status).toBe(200);
        expect((await bindDelegate(credential.bearer, keys[via])).bind?.status).toBe(201);
      }

      await expectEquivalent(
        world,
        async ({ bearer }) => ({
          mcp: await sessionSource('mcp').resolve(bearer),
          api: await sessionSource('api').resolve(bearer),
        }),
        { placeholders: ({ via }) => ({ '<delegate>': keys[via].account }) },
      );
      const viaGrant = await sessionSource('mcp').resolve(world.grant.bearer);
      expect(viaGrant.delegateAccount).toBe(keys.grant.account);
      expect(viaGrant.paymentsAllowed).toBe(true);
    });
  });

  // ── URL kinds and methods ──────────────────────────────────────────────────

  /** The §12.1 method row, in order, on one URL. */
  async function everyMethod(bearer: string, path: string, key: DelegateKey) {
    const steps: Record<string, Response> = {};
    steps.list = await rpc(bearer, path, 'tools/list');
    steps.free = await call(bearer, path, TOOLS.free.name);
    for (let n = 1; n <= FREEMIUM_QUOTA + 1; n += 1) {
      steps[`freemium${n}`] = await call(bearer, path, TOOLS.freemium.name);
    }
    steps.paidRequirement = await call(bearer, path, TOOLS.paid.name);
    const requirement = requirementOf(steps.paidRequirement);
    if (requirement) {
      steps.paidWithVoucher = await call(bearer, path, TOOLS.paid.name, undefined, {
        'x402/voucher': signVoucher(apps.mcp, requirement, key),
      });
    }
    steps.search = await call(bearer, path, 'search_tools', { query: 'weather' });
    steps.getTool = await call(bearer, path, 'get_tool', { name: TOOLS.paid.name });
    steps.callToolFree = await call(bearer, path, 'call_tool', {
      name: TOOLS.free.name,
      arguments: { query: 'moon landing' },
    });
    const paidArgs = { name: TOOLS.paid.name, arguments: { query: 'moon landing' } };
    steps.callToolPaidRequirement = await call(bearer, path, 'call_tool', paidArgs);
    const metaRequirement = requirementOf(steps.callToolPaidRequirement);
    if (metaRequirement) {
      steps.callToolPaidWithVoucher = await call(bearer, path, 'call_tool', paidArgs, {
        'x402/voucher': signVoucher(apps.mcp, metaRequirement, key),
      });
    }
    return steps;
  }

  const seenAll = (steps: Record<string, Response>) =>
    Object.fromEntries(Object.entries(steps).map(([step, response]) => [step, seen(response)]));

  describe('URL kinds', () => {
    it('tools/list is identical on every URL kind, with and without each query', async () => {
      const world = await apps.world();
      await apps.toolsetFor(world, 'kit', 'PRIVATE');
      const twins = await expectEquivalent(world, async ({ bearer }) => {
        const listed: Record<string, unknown> = {};
        for (const kind of KINDS) {
          for (const query of QUERIES) {
            const url = `${urlOf(kind)}${query}`;
            listed[url] = seen(await rpc(bearer, url, 'tools/list'));
          }
        }
        return listed;
      });
      // Not vacuous: every kind serves a list.
      const listed = twins.key as Record<string, { status: number }>;
      for (const kind of KINDS) expect(listed[urlOf(kind)].status).toBe(200);
    });

    it.each(KINDS)(
      '%s: tools/list; tools/call free, freemium in and over quota, paid rail B both steps; search_tools, get_tool, call_tool free and paid',
      async (kind) => {
        const keys = twoKeys();
        const twins = await expectEquivalent(
          await apps.pair(),
          async ({ world, via, bearer }) => {
            await apps.toolsetFor(world, 'kit', 'PRIVATE');
            const bound = await bindDelegate(bearer, keys[via]);
            authorise(world, keys[via]);
            return { bound, steps: seenAll(await everyMethod(bearer, urlOf(kind), keys[via])) };
          },
          {
            dataSource: apps.dataSource,
            placeholders: ({ via }) => ({ '<delegate>': keys[via].account }),
          },
        );
        // Intents name the run's own credential, in the same form.
        const footprint = (twins.key as { footprint: Record<string, Record<string, unknown>[]> })
          .footprint;
        for (const intent of footprint.payment_intents ?? []) {
          expect(intent.credential_id).toBe('<credential>');
        }
      },
    );

    it('the method row is not vacuous: on / each step does what its name says, and intents carry the credential', async () => {
      const world = await apps.world();
      const key = newDelegateKey();
      await bindDelegate(world.grant.bearer, key);
      authorise(world, key);
      const steps = await everyMethod(world.grant.bearer, '/', key);
      expect(steps.free.body.result.structuredContent).toEqual({ answer: 'forty-two' });
      expect(steps.freemium1.body.result.structuredContent).toEqual({ answer: 'forty-two' });
      expect(errorCodeOf(steps[`freemium${FREEMIUM_QUOTA + 1}`])).toBe('PAYMENT_REQUIRED');
      expect(errorCodeOf(steps.paidRequirement)).toBe('PAYMENT_REQUIRED');
      expect(requirementOf(steps.paidRequirement)).toMatchObject({ delegate: key.account });
      for (const paid of [steps.paidWithVoucher, steps.callToolPaidWithVoucher]) {
        expect(paid.body.result._meta['x402/receipt'].intentId).toEqual(expect.any(String));
      }
      expect(errorCodeOf(steps.search)).toBeUndefined();
      expect(errorCodeOf(steps.getTool)).toBeUndefined();
      expect(steps.callToolFree.body.result.structuredContent).toEqual({ answer: 'forty-two' });

      const intents = (await apps.dataSource.query(
        `SELECT "credential_id" FROM "payment_intents" WHERE "organization_id" = $1`,
        [world.organizationId],
      )) as { credential_id: string }[];
      expect(intents.length).toBe(2);
      for (const intent of intents) expect(intent.credential_id).toBe(world.grant.id);
    });
  });

  // ── Limits ─────────────────────────────────────────────────────────────────

  describe('Limits', () => {
    const policy = (world: World, patch: Record<string, unknown>) =>
      apps.mcp
        .get(SpendPolicyService, { strict: false })
        .patch(
          world.organizationId,
          world.agentId,
          { assetId: USDG, decimals: 6, ...patch },
          { type: 'user', id: `user-${world.person.agentId}` },
        );

    it('spend-policy refusals: a per-call ceiling, then paused', async () => {
      const keys = twoKeys();
      const twins = await expectEquivalent(
        await apps.pair(),
        async ({ world, via, bearer }) => {
          await bindDelegate(bearer, keys[via]);
          authorise(world, keys[via]);
          const outcomes: Record<string, unknown> = {};
          for (const [label, patch] of [
            ['overCeiling', { perCallMax: '10000' }],
            ['paused', { perCallMax: null, paused: true }],
          ] as const) {
            await policy(world, patch);
            const unpaid = await call(bearer, '/', TOOLS.paid.name);
            outcomes[`${label}Requirement`] = seen(unpaid);
            const requirement = requirementOf(unpaid);
            if (requirement) {
              outcomes[`${label}Voucher`] = seen(
                await call(bearer, '/', TOOLS.paid.name, undefined, {
                  'x402/voucher': signVoucher(apps.mcp, requirement, keys[via]),
                }),
              );
            }
          }
          outcomes.freeWhilePaused = seen(await call(bearer, '/', TOOLS.free.name));
          return outcomes;
        },
        {
          dataSource: apps.dataSource,
          placeholders: ({ via }) => ({ '<delegate>': keys[via].account }),
        },
      );
      expect(JSON.stringify(twins.key)).toMatch(
        /MCP_SPEND_LIMIT_EXCEEDED[\s\S]*MCP_POLICY_AGENT_PAUSED/,
      );
    });

    it('the free budget: the platform daily free calls, then refused', async () => {
      const twins = await expectEquivalent(
        await apps.pair(),
        async ({ bearer }) => {
          const outcomes: unknown[] = [];
          for (let n = 0; n <= PLATFORM_FREE_CALLS; n += 1) {
            outcomes.push(seen(await call(bearer, '/', TOOLS.free.name)));
          }
          return outcomes;
        },
        { dataSource: apps.dataSource },
      );
      const outcomes = (twins.key as { result: { body: { result: { isError?: boolean } } }[] })
        .result;
      expect(outcomes[0].body.result.isError).toBeUndefined();
      expect(outcomes[PLATFORM_FREE_CALLS].body.result.isError).toBe(true);
    });

    it('the refusal rate limit: refusals counted per agent, then every call RATE_LIMITED', async () => {
      await inOneWindow(40);
      const twins = await expectEquivalent(
        await apps.pair(),
        async ({ world, credentialId, bearer }) => {
          // Narrowed to the free tool: every paid call is a refusal.
          await apps.asPerson(world, 'patch', `/agent-credentials/${credentialId}/access`, {
            accessMode: 'RESTRICTED',
            allowedToolIds: [TOOLS.free.id],
          });
          const outcomes: unknown[] = [];
          for (let n = 0; n < 62; n += 1)
            outcomes.push(seen(await call(bearer, '/', TOOLS.paid.name)));
          return outcomes;
        },
        { dataSource: apps.dataSource },
      );
      const outcomes = (twins.key as { result: unknown[] }).result.map((o) => JSON.stringify(o));
      expect(outcomes[0]).toContain('TOOL_NOT_ALLOWED');
      expect(outcomes[61]).toContain('RATE_LIMITED');
    });

    it('the meta-tool rate limits: search_tools and get_tool, per agent', async () => {
      await inOneWindow(40);
      const twins = await expectEquivalent(
        await apps.pair(),
        async ({ bearer }) => {
          const search: unknown[] = [];
          const getTool: unknown[] = [];
          for (let n = 0; n < 31; n += 1) {
            search.push(seen(await call(bearer, '/', 'search_tools', { query: 'weather' })));
          }
          for (let n = 0; n < 121; n += 1) {
            getTool.push(seen(await call(bearer, '/', 'get_tool', { name: TOOLS.free.name })));
          }
          return { search, getTool };
        },
        { dataSource: apps.dataSource },
      );
      const { search, getTool } = (twins.key as { result: Record<string, unknown[]> }).result;
      expect(JSON.stringify(search[29])).not.toContain('RATE_LIMITED');
      expect(JSON.stringify(search[30])).toContain('RATE_LIMITED');
      expect(JSON.stringify(getTool[120])).toContain('RATE_LIMITED');
    });
  });

  // ── Pause ──────────────────────────────────────────────────────────────────

  describe('Pause', () => {
    /** What every caller of a paused world sees, on both hosts. */
    const pausedOutcome = async ({ bearer }: RunContext) => ({
      list: seen(await rpc(bearer, '/', 'tools/list')),
      call: seen(await call(bearer, '/', TOOLS.free.name)),
      apiHost: observed(await onApi(bearer, 'get', '/agents/me/delegate')),
    });

    const suspendAgent = (world: World) =>
      apps.dataSource.query(`UPDATE "agents" SET "status" = 'SUSPENDED' WHERE "id" = $1`, [
        world.agentId,
      ]);

    /** An operator's block, as the operator console writes it, seen by both apps at once. */
    async function block(kind: 'ORGANIZATION' | 'WALLET', subject: string): Promise<void> {
      const [operator] = (await apps.dataSource.query(
        `INSERT INTO "operators" ("subject", "display_name", "email")
         VALUES ($1, 'Equivalence operator', 'operator@example.test') RETURNING "id"`,
        [`operator-${subject}`],
      )) as { id: string }[];
      await apps.dataSource.query(
        `INSERT INTO "account_blocks"
           ("subject_kind", "subject", "subject_key", "reason_code", "note", "blocked_by")
         VALUES ($1, $2, $3, 'EQUIVALENCE', $4, $5)`,
        [
          kind,
          subject,
          subjectKey(kind as BlockSubjectKind, subject),
          'Blocked by the equivalence suite: both credentials must be refused alike.',
          operator.id,
        ],
      );
      for (const app of [apps.mcp, apps.api]) {
        await app.get(AccountBlocklistService, { strict: false }).refresh();
      }
    }

    const states: [string, string, (world: World) => Promise<unknown>][] = [
      ['agent suspended', 'AUTH_AGENT_SUSPENDED', suspendAgent],
      [
        'organization suspended',
        'AUTH_ORGANIZATION_SUSPENDED',
        (world) =>
          apps.dataSource.query(
            `UPDATE "organizations" SET "status" = 'SUSPENDED' WHERE "id" = $1`,
            [world.organizationId],
          ),
      ],
      [
        'wallet not linked',
        'AUTH_WALLET_NOT_LINKED',
        (world) =>
          apps.dataSource.query(
            `UPDATE "agents" SET "primary_account_id" = NULL, "chain_id" = NULL WHERE "id" = $1`,
            [world.agentId],
          ),
      ],
      [
        'organization blocked',
        'AUTH_ORGANIZATION_SUSPENDED',
        (world) => block('ORGANIZATION', world.organizationId),
      ],
      ['payer wallet blocked', 'ACCOUNT_BLOCKED', (world) => block('WALLET', world.wallet)],
    ];

    it.each(states)('%s: the same refusal for both, on both hosts', async (_state, code, pause) => {
      const world = await apps.world();
      await pause(world);
      const twins = await expectEquivalent(world, pausedOutcome);
      expect(JSON.stringify(twins.key)).toContain(code);
    });

    it('suspended during a refresh: rotation succeeds, and the next call gets the same AUTH_* code as the key', async () => {
      const world = await apps.world();
      await suspendAgent(world);
      const refreshed = await request(apps.mcp.getHttpServer())
        .post('/oauth/token')
        .type('form')
        .send({
          grant_type: 'refresh_token',
          refresh_token: world.grant.refresh,
          client_id: BUILTIN,
        });
      expect(refreshed.status).toBe(200);
      const rotated: World = {
        ...world,
        grant: { ...world.grant, bearer: refreshed.body.access_token },
      };
      const twins = await expectEquivalent(rotated, pausedOutcome);
      expect(JSON.stringify(twins.key)).toContain('AUTH_AGENT_SUSPENDED');
    });
  });

  // ── Revoke ─────────────────────────────────────────────────────────────────

  describe('Revoke', () => {
    const refresh = (world: World) =>
      request(apps.mcp.getHttpServer()).post('/oauth/token').type('form').send({
        grant_type: 'refresh_token',
        refresh_token: world.grant.refresh,
        client_id: BUILTIN,
      });

    it('the next request is 401 for both; the access epoch moves; the grant refresh is invalid_grant', async () => {
      const epochs = apps.mcp.get(AccessEpochService, { strict: false });
      const worlds = await apps.pair();
      const twins = await expectEquivalent(
        worlds,
        async ({ world, credentialId, bearer }) => {
          const before = await epochs.current(world.organizationId);
          const revoked = await apps.asPerson(
            world,
            'delete',
            `/agents/${world.agentId}/credentials/${credentialId}`,
          );
          return {
            revoked: revoked.status,
            epochMoved: before !== (await epochs.current(world.organizationId)),
            list: seen(await rpc(bearer, '/', 'tools/list')),
            call: seen(await call(bearer, '/', TOOLS.free.name)),
            apiHost: observed(await onApi(bearer, 'get', '/agents/me/delegate')),
          };
        },
        { dataSource: apps.dataSource },
      );
      expect((twins.key as { result: unknown }).result).toMatchObject({
        revoked: 204,
        epochMoved: true,
        list: { status: 401 },
        call: { status: 401 },
        apiHost: { status: 401 },
      });
      const refused = await refresh(worlds.grant);
      expect({ status: refused.status, body: refused.body }).toEqual({
        status: 400,
        body: { error: 'invalid_grant' },
      });
    });

    it('the revoke audit entry differs only in naming how the credential was issued (R-OA-26)', async () => {
      const world = await apps.world();
      for (const via of BOTH) {
        const credential = credentialOf(world, via);
        await apps.asPerson(
          world,
          'delete',
          `/agents/${world.agentId}/credentials/${credential.id}`,
        );
      }
      const rows = (await apps.dataSource.query(
        `SELECT "resource_id", "resource_type", "actor_type", "actor_id", "before", "after"
           FROM "audit_log_entries"
          WHERE "organization_id" = $1 AND "action" = 'credential.revoked'`,
        [world.organizationId],
      )) as { resource_id: string; after: Record<string, unknown> }[];
      const of = (via: Via) => {
        const row = rows.find((entry) => entry.resource_id === credentialOf(world, via).id)!;
        return normaliser(world, via)(row) as { after: Record<string, unknown> };
      };
      const [key, grant] = [of('key'), of('grant')];
      expect(key.after).toMatchObject({ issuedVia: 'API_KEY' });
      expect(key.after).not.toHaveProperty('clientId');
      expect(grant.after).toMatchObject({ issuedVia: 'OAUTH', clientId: BUILTIN });
      const strip = (entry: { after: Record<string, unknown> }) => {
        const after = { ...entry.after };
        delete after.issuedVia;
        delete after.clientId;
        return { ...entry, after };
      };
      expect(strip(grant)).toStrictEqual(strip(key));
    });
  });

  // ── Narrowing ──────────────────────────────────────────────────────────────

  describe('Narrowing', () => {
    const NARROW = { accessMode: 'RESTRICTED', allowedToolIds: [TOOLS.free.id] };

    const narrowedView = async (bearer: string) => ({
      root: seen(await rpc(bearer, '/?discovery=full', 'tools/list')),
      category: seen(await rpc(bearer, '/c/weather', 'tools/list')),
      allowed: seen(await call(bearer, '/', TOOLS.free.name)),
      refused: seen(await call(bearer, '/', TOOLS.paid.name)),
    });

    it('PATCH /agent-credentials/:id/access has the same effect on both', async () => {
      const twins = await expectEquivalent(
        await apps.pair(),
        async ({ world, credentialId, bearer }) => ({
          patched: await apps.asPerson(
            world,
            'patch',
            `/agent-credentials/${credentialId}/access`,
            NARROW,
          ),
          read: await apps.asPerson(world, 'get', `/agent-credentials/${credentialId}/access`),
          view: await narrowedView(bearer),
        }),
        { dataSource: apps.dataSource },
      );
      expect(JSON.stringify(twins.key)).toContain('TOOL_NOT_ALLOWED');
    });

    it('the narrowing survives an F5 replacement of the grant (assay_replaces)', async () => {
      const worlds = await apps.pair();
      for (const via of BOTH) {
        const credential = credentialOf(worlds[via], via);
        await apps.asPerson(
          worlds[via],
          'patch',
          `/agent-credentials/${credential.id}/access`,
          NARROW,
        );
      }
      const replacement = await apps.grantFor(worlds.grant, { replaces: worlds.grant.grant.id });
      // The key keeps its narrowing; the grant's replacement inherits it.
      const twins = await runTwins(
        worlds,
        async ({ world, via, credentialId, bearer }) => {
          const id = via === 'grant' ? replacement.id : credentialId;
          return {
            read: await apps.asPerson(world, 'get', `/agent-credentials/${id}/access`),
            view: await narrowedView(via === 'grant' ? replacement.bearer : bearer),
          };
        },
        {
          placeholders: ({ via }) => (via === 'grant' ? { '<credential>': replacement.id } : {}),
        },
      );
      expect(twins.grant).toStrictEqual(twins.key);
      expect(JSON.stringify(twins.key)).toContain('TOOL_NOT_ALLOWED');
      // And the replaced grant no longer authenticates.
      expect((await rpc(worlds.grant.grant.bearer, '/', 'tools/list')).status).toBe(401);
    });
  });

  // ── Delegate ───────────────────────────────────────────────────────────────

  describe('Delegate', () => {
    it('binds for both, and GET /agents/me/delegate reads it back (API host)', async () => {
      const keys = twoKeys();
      const twins = await expectEquivalent(
        await apps.pair(),
        async ({ via, bearer }) => ({
          before: observed(await onApi(bearer, 'get', '/agents/me/delegate')),
          bound: await bindDelegate(bearer, keys[via]),
          after: observed(await onApi(bearer, 'get', '/agents/me/delegate')),
        }),
        {
          dataSource: apps.dataSource,
          placeholders: ({ via }) => ({ '<delegate>': keys[via].account }),
        },
      );
      expect((twins.key as { result: unknown }).result).toMatchObject({
        bound: { challenge: { status: 201 }, bind: { status: 201 } },
        after: { status: 200, body: { data: { delegate: 'eip155:46630:<delegate>' } } },
      });
      expect(apps.market.chain.writes).toEqual([]);
    });

    it('one live credential per key: a key the sibling holds is refused for both', async () => {
      const keys = twoKeys();
      const twins = await expectEquivalent(
        await apps.pair(),
        async ({ world, via, bearer }) => {
          const sibling = credentialOf(world, via === 'key' ? 'grant' : 'key');
          const held = await bindDelegate(sibling.bearer, keys[via]);
          return {
            siblingBound: held.bind?.status,
            refused: await bindDelegate(bearer, keys[via]),
          };
        },
        { placeholders: ({ via }) => ({ '<delegate>': keys[via].account }) },
      );
      expect((twins.key as Record<string, unknown>).siblingBound).toBe(201);
      expect(JSON.stringify(twins.key)).toContain('ACCOUNT_DELEGATE_ALREADY_BOUND');
    });

    it("a voucher signed by another credential's key is refused for both", async () => {
      const own = twoKeys();
      const other = twoKeys();
      const twins = await expectEquivalent(
        await apps.pair(),
        async ({ world, via, bearer }) => {
          const sibling = credentialOf(world, via === 'key' ? 'grant' : 'key');
          await bindDelegate(bearer, own[via]);
          await bindDelegate(sibling.bearer, other[via]);
          authorise(world, own[via]);
          authorise(world, other[via]);
          const unpaid = await call(bearer, '/', TOOLS.paid.name);
          return seen(
            await call(bearer, '/', TOOLS.paid.name, undefined, {
              'x402/voucher': signVoucher(apps.mcp, requirementOf(unpaid)!, other[via]),
            }),
          );
        },
        {
          dataSource: apps.dataSource,
          placeholders: ({ via }) => ({
            '<delegate>': own[via].account,
            '<other-delegate>': other[via].account,
          }),
        },
      );
      expect(JSON.stringify(twins.key)).toContain('PAYMENT_VOUCHER_DELEGATE_NOT_BOUND');
    });

    it('after a 30-day idle expiry, the re-login binds the existing key with 0 signatures (F5)', async () => {
      const keys = twoKeys();
      const renewed: Partial<Record<Via, string>> = {};
      const writesBefore = apps.market.chain.writes.length;
      const twins = await expectEquivalent(
        await apps.pair(),
        async ({ world, via, bearer, credentialId }) => {
          await bindDelegate(bearer, keys[via]);
          authorise(world, keys[via]);
          const authorisations = apps.market.chain.delegations.size;
          // Idle past its expiry: the credential is not live and holds no key.
          await apps.dataSource.query(
            `UPDATE "agent_credentials" SET "expires_at" = now() - interval '1 second' WHERE "id" = $1`,
            [credentialId],
          );
          await apps.dataSource.query(
            `UPDATE "oauth_refresh_tokens" SET "expires_at" = now() - interval '1 second'
              WHERE "credential_id" = $1`,
            [credentialId],
          );
          const expired = seen(await rpc(bearer, '/', 'tools/list'));
          // Re-login: a new key, or a grant that replaces the old one.
          const fresh =
            via === 'key'
              ? await apps.keyFor(world, CREDENTIAL_NAME)
              : await apps.grantFor(world, { replaces: credentialId });
          renewed[via] = fresh.id;
          const rebound = await bindDelegate(fresh.bearer, keys[via]);
          const unpaid = await call(fresh.bearer, '/', TOOLS.paid.name);
          const paid = await call(fresh.bearer, '/', TOOLS.paid.name, undefined, {
            'x402/voucher': signVoucher(apps.mcp, requirementOf(unpaid)!, keys[via]),
          });
          return {
            expired,
            rebound,
            requirement: seen(unpaid),
            paid: seen(paid),
            newAuthorisations: apps.market.chain.delegations.size - authorisations,
          };
        },
        {
          dataSource: apps.dataSource,
          placeholders: ({ via }) => ({
            '<delegate>': keys[via].account,
            '<renewed-credential>': renewed[via],
          }),
        },
      );
      expect((twins.key as { result: unknown }).result).toMatchObject({
        expired: { status: 401 },
        rebound: { bind: { status: 201 } },
        newAuthorisations: 0,
      });
      expect(JSON.stringify((twins.key as { result: { paid: unknown } }).result.paid)).toContain(
        'x402/receipt',
      );
      // No chain write: the on-chain authorisation is per key, not per credential.
      expect(apps.market.chain.writes.length).toBe(writesBefore);
    });
  });

  // ── last_used_at ───────────────────────────────────────────────────────────

  describe('last_used_at', () => {
    const stamp = async (id: string): Promise<Date | null> => {
      const [row] = (await apps.dataSource.query(
        `SELECT "last_used_at" FROM "agent_credentials" WHERE "id" = $1`,
        [id],
      )) as { last_used_at: Date | null }[];
      return row.last_used_at;
    };

    it.each([
      ['an MCP call', (bearer: string) => rpc(bearer, '/', 'tools/list')],
      ['the API host', (bearer: string) => onApi(bearer, 'get', '/agents/me/delegate')],
    ])('is stamped for both by %s', async (_by, use) => {
      const world = await apps.world();
      for (const via of BOTH) expect(await stamp(credentialOf(world, via).id)).toBeNull();
      for (const via of BOTH) await use(credentialOf(world, via).bearer);
      await new Promise((resolve) => setTimeout(resolve, 250));
      for (const via of BOTH) expect(await stamp(credentialOf(world, via).id)).not.toBeNull();
    });
  });

  // ── Audit ──────────────────────────────────────────────────────────────────

  describe('Audit', () => {
    // Fails today, and is reported (Task 1.17): an API key's entry carries
    // `scopes` and `expiresAt` in `after`, a grant's carries `replaces` instead.
    it.failing(
      'credential.created: equal but for after.issuedVia and after.clientId (§12.1)',
      async () => {
        const world = await apps.world();
        const rows = (await apps.dataSource.query(
          `SELECT "resource_id", "resource_type", "actor_type", "actor_id", "before", "after"
             FROM "audit_log_entries"
            WHERE "organization_id" = $1 AND "action" = 'credential.created'`,
          [world.organizationId],
        )) as { resource_id: string; after: Record<string, unknown> }[];
        const of = (via: Via) => {
          const row = rows.find((entry) => entry.resource_id === credentialOf(world, via).id)!;
          const after = { ...row.after };
          delete after.issuedVia;
          delete after.clientId;
          return normaliser(world, via)({ ...row, after });
        };
        expect(of('grant')).toStrictEqual(of('key'));
      },
    );
  });

  // ── Exceptions: a third-party grant (H2, §6.3.13) ──────────────────────────

  describe('Exceptions: a third-party grant on the same agent', () => {
    it('delegate challenge and bind → ACCOUNT_DELEGATE_CLIENT_NOT_ALLOWED (R-OA-22)', async () => {
      const world = await apps.world({ client: 'third-party' });
      const delegates = apps.api.get(AgentDelegateService, { strict: false });
      // The MCP host's session for the grant; the API host refuses it sooner.
      const thirdParty = await sessionSource('mcp').resolve(world.grant.bearer);
      expect(thirdParty.paymentsAllowed).toBe(false);
      const key = newDelegateKey();
      await expect(delegates.challenge(thirdParty, key.signer.address)).rejects.toMatchObject({
        errorCode: 'ACCOUNT_DELEGATE_CLIENT_NOT_ALLOWED',
      });
      await expect(
        delegates.bind(thirdParty, '00000000-0000-4000-8000-000000000000', '0x00'),
      ).rejects.toMatchObject({ errorCode: 'ACCOUNT_DELEGATE_CLIENT_NOT_ALLOWED' });
      // The API key of the same agent may.
      const keySession = await sessionSource('mcp').resolve(world.key.bearer);
      await expect(delegates.challenge(keySession, key.signer.address)).resolves.toMatchObject({
        delegate: key.account,
      });
      // Over HTTP the grant never reaches the service: the API host refuses it.
      const overHttp = await bindDelegate(world.grant.bearer, key);
      expect(overHttp.challenge).toMatchObject({
        status: 403,
        body: { error: { code: 'AUTH_CLIENT_NOT_ALLOWED_HERE' } },
      });
      expect(overHttp.bind).toBeNull();
    });

    it('any API route → 403 AUTH_CLIENT_NOT_ALLOWED_HERE; the key of the same agent is served (R-OA-21)', async () => {
      const world = await apps.world({ client: 'third-party' });
      for (const [method, path] of [
        ['get', '/agents/me/delegate'],
        ['post', '/agents/me/delegate/challenge'],
        ['post', '/agents/me/delegate'],
        ['get', '/spend-policy'],
        ['get', '/toolsets'],
      ] as const) {
        const refused = await onApi(world.grant.bearer, method, path, {});
        expect({ path, status: refused.status, code: refused.body?.error?.code }).toEqual({
          path,
          status: 403,
          code: 'AUTH_CLIENT_NOT_ALLOWED_HERE',
        });
        const served = await onApi(world.key.bearer, method, path, {});
        expect({ path, code: served.body?.error?.code }).not.toEqual({
          path,
          code: 'AUTH_CLIENT_NOT_ALLOWED_HERE',
        });
      }
    });

    it('the enable-paid page has nothing to approve: the grant is no payment client', async () => {
      const clientOf = async (world: World) => {
        const listed = await apps.asPerson(world, 'get', `/agents/${world.agentId}/credentials`);
        const rows = (listed.body.items ?? listed.body) as {
          id: string;
          oauthClient: { paymentClient: boolean } | null;
        }[];
        return rows.find((row) => row.id === world.grant.id)?.oauthClient;
      };
      expect(await clientOf(await apps.world())).toMatchObject({ paymentClient: true });
      expect(await clientOf(await apps.world({ client: 'third-party' }))).toMatchObject({
        paymentClient: false,
      });
    });

    it.todo(
      'PAYMENT_REQUIRED has no fixUrl and ends with " Paid tools need the Assay app on your computer." (Task 2.13)',
    );

    it('every free MCP case equals the key, on every URL kind', async () => {
      await expectEquivalent(
        await apps.pair({ client: 'third-party' }),
        async ({ world, bearer }) => {
          await apps.toolsetFor(world, 'kit', 'PRIVATE');
          const steps: Record<string, unknown> = {};
          for (const kind of KINDS) {
            const path = urlOf(kind);
            steps[`${kind} list`] = seen(await rpc(bearer, path, 'tools/list'));
            steps[`${kind} free`] = seen(await call(bearer, path, TOOLS.free.name));
            steps[`${kind} maker`] = seen(await call(bearer, path, MAKER_TOOL.name));
          }
          for (let n = 1; n <= FREEMIUM_QUOTA; n += 1) {
            steps[`freemium${n}`] = seen(await call(bearer, '/', TOOLS.freemium.name));
          }
          steps.search = seen(await call(bearer, '/', 'search_tools', { query: 'weather' }));
          steps.getTool = seen(await call(bearer, '/', 'get_tool', { name: TOOLS.free.name }));
          steps.callTool = seen(
            await call(bearer, '/', 'call_tool', {
              name: TOOLS.free.name,
              arguments: { query: 'moon landing' },
            }),
          );
          return steps;
        },
        { dataSource: apps.dataSource },
      );
    });
  });
});
