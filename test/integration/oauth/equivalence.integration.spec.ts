import request, { Response } from 'supertest';

import { AgentDelegateService } from '@modules/account/services/agent-delegate.service';
import { BlockSubjectKind, subjectKey } from '@modules/blocklist/domain/account-block';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';
import { MCP_SESSION_SOURCE, McpSessionPort } from '@modules/mcp/ports/mcp-session.port';
import { SpendPolicyService } from '@modules/spend-policy/services/spend-policy.service';
import { AccessEpochService } from '@modules/toolset/services/access-epoch.service';

import {
  RunContext,
  TwinOptions,
  TwinResult,
  expectEquivalent,
  normaliser,
  ObservedResponse,
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

/** The method row runs on every kind, and on `/?free=1`, the hosted-connector default. */
const METHOD_URLS = [...KINDS, 'rootFreeOnly'] as const;
type MethodUrl = (typeof METHOD_URLS)[number];

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

  /** Every case compares the provider's requests too (review I3). */
  const equivalent = <T>(
    worlds: World | Record<Via, World>,
    run: (context: RunContext) => Promise<T>,
    options: TwinOptions<T> = {},
  ) =>
    expectEquivalent(worlds, run, {
      provider: apps.market.provider,
      knownIds: apps.knownIds,
      ...options,
    });

  /** The key's normalised result (equal to the grant's once `equivalent` passed). */
  const resultOf = <T>(twins: TwinResult): T => (twins.key as { result: T }).result;

  const methodUrlOf = (kind: MethodUrl): string =>
    kind === 'rootFreeOnly' ? '/?free=1' : urlOf(kind);

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

      await equivalent(
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
    steps.maker = await call(bearer, path, MAKER_TOOL.name);
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

  /** What a step amounted to: the per-kind expectations read this. */
  function outcome(step: ObservedResponse | undefined): string {
    if (!step) return 'absent';
    if (step.status !== 200) return `http ${step.status} ${step.body?.error?.code}`;
    const result = step.body?.result;
    if (!result) return `rpc ${step.body?.error?.code}`;
    if (Array.isArray(result.tools)) {
      return (result.tools as { name: string }[])
        .map((tool) => tool.name)
        .sort()
        .join(',');
    }
    const code = result._meta?.['x402/error']?.code;
    if (code) return code;
    if (result.structuredContent?.answer) {
      return result._meta?.['x402/receipt']?.intentId ? 'paid' : 'served';
    }
    return result.isError ? 'error' : 'ok';
  }

  const outcomes = (steps: Record<string, ObservedResponse>) =>
    Object.fromEntries(Object.entries(steps).map(([step, seen]) => [step, outcome(seen)]));

  const META = 'call_tool,get_tool,search_tools';
  const KIT = [TOOLS.freemium.name, TOOLS.free.name, TOOLS.paid.name].sort().join(',');
  /** A URL that serves all three tools: every step is served, both paid steps paid. */
  const ALL_SERVED = {
    list: KIT,
    free: 'served',
    freemium1: 'served',
    freemium2: 'served',
    freemium3: 'PAYMENT_REQUIRED',
    paidRequirement: 'PAYMENT_REQUIRED',
    paidWithVoucher: 'paid',
    maker: 'TOOL_NOT_IN_TOOLSET',
    search: 'ok',
    getTool: 'ok',
    callToolFree: 'served',
    callToolPaidRequirement: 'PAYMENT_REQUIRED',
    callToolPaidWithVoucher: 'paid',
  };
  /** A URL without the paid tool: the paid steps are refused, so no voucher step runs. */
  const NO_PAID = {
    free: 'served',
    freemium1: 'served',
    freemium2: 'served',
    paidRequirement: 'TOOL_NOT_IN_TOOLSET',
    search: 'ok',
    getTool: 'TOOL_NOT_IN_TOOLSET',
    callToolFree: 'served',
    callToolPaidRequirement: 'TOOL_NOT_IN_TOOLSET',
  };
  /** What each step amounts to on each URL (review I4). */
  const SERVED_BY_KIND: Record<MethodUrl, Record<string, string>> = {
    root: { ...ALL_SERVED, list: META, maker: 'served' },
    category: {
      ...NO_PAID,
      list: [TOOLS.freemium.name, TOOLS.free.name].sort().join(','),
      freemium3: 'PAYMENT_REQUIRED',
      maker: 'TOOL_NOT_IN_TOOLSET',
    },
    handle: {
      list: MAKER_TOOL.name,
      free: 'TOOL_NOT_IN_TOOLSET',
      freemium1: 'TOOL_NOT_IN_TOOLSET',
      freemium2: 'TOOL_NOT_IN_TOOLSET',
      freemium3: 'TOOL_NOT_IN_TOOLSET',
      paidRequirement: 'TOOL_NOT_IN_TOOLSET',
      maker: 'served',
      search: 'ok',
      getTool: 'TOOL_NOT_IN_TOOLSET',
      callToolFree: 'TOOL_NOT_IN_TOOLSET',
      callToolPaidRequirement: 'TOOL_NOT_IN_TOOLSET',
    },
    publicToolset: ALL_SERVED,
    publicToolsetPinned: ALL_SERVED,
    unlisted: ALL_SERVED,
    unlistedPinned: ALL_SERVED,
    myToolset: ALL_SERVED,
    myToolsetPinned: ALL_SERVED,
    // Free only: over the freemium quota no free binding is left.
    rootFreeOnly: {
      ...NO_PAID,
      list: META,
      freemium3: 'TOOL_NO_ELIGIBLE_BINDING',
      maker: 'served',
    },
  };

  describe('URL kinds', () => {
    /** The tools each query form leaves on `/?discovery=full` (the full list). */
    const LISTED_BY_QUERY: Record<string, string> = {
      '': [...Object.values(TOOLS).map((tool) => tool.name), MAKER_TOOL.name].sort().join(','),
      [`?tools=${TOOLS.free.name},${TOOLS.paid.name}`]: [TOOLS.free.name, TOOLS.paid.name]
        .sort()
        .join(','),
      '?category=weather': [TOOLS.free.name, TOOLS.freemium.name].sort().join(','),
      '?free=1': [TOOLS.free.name, TOOLS.freemium.name, MAKER_TOOL.name].sort().join(','),
    };

    it('tools/list is identical on every URL kind, with and without each query', async () => {
      const world = await apps.world();
      await apps.toolsetFor(world, 'kit', 'PRIVATE');
      const twins = await equivalent(world, async ({ bearer }) => {
        const listed: Record<string, unknown> = {};
        for (const kind of KINDS) {
          for (const query of QUERIES) {
            const url = `${urlOf(kind)}${query}`;
            listed[url] = seen(await rpc(bearer, url, 'tools/list'));
          }
        }
        // The query forms on the full list, where each one's effect shows.
        for (const query of Object.keys(LISTED_BY_QUERY)) {
          const url = `/?discovery=full${query.replace('?', '&')}`;
          listed[url] = seen(await rpc(bearer, url, 'tools/list'));
        }
        return listed;
      });
      // Not vacuous: every kind serves a list, and each query form narrows it.
      const listed = resultOf<Record<string, ObservedResponse>>(twins);
      for (const kind of KINDS) expect(listed[urlOf(kind)].status).toBe(200);
      for (const [query, names] of Object.entries(LISTED_BY_QUERY)) {
        expect(outcome(listed[`/?discovery=full${query.replace('?', '&')}`])).toBe(names);
      }
    });

    it('each query form also reaches the call path: a free and a paid call under it', async () => {
      const twins = await equivalent(
        await apps.pair(),
        async ({ bearer }) => {
          const steps: Record<string, unknown> = {};
          for (const query of QUERIES) {
            steps[`free ${query}`] = seen(await call(bearer, `/${query}`, TOOLS.free.name));
            steps[`paid ${query}`] = seen(await call(bearer, `/${query}`, TOOLS.paid.name));
          }
          return steps;
        },
        { dataSource: apps.dataSource },
      );
      const steps = outcomes(resultOf<Record<string, ObservedResponse>>(twins));
      const [tools, category, free, discovery] = QUERIES.slice(1);
      expect(steps).toEqual({
        'free ': 'served',
        'paid ': 'PAYMENT_REQUIRED',
        [`free ${tools}`]: 'served',
        [`paid ${tools}`]: 'PAYMENT_REQUIRED',
        [`free ${category}`]: 'served',
        [`paid ${category}`]: 'TOOL_NOT_IN_TOOLSET',
        [`free ${free}`]: 'served',
        [`paid ${free}`]: 'TOOL_NOT_IN_TOOLSET',
        [`free ${discovery}`]: 'served',
        [`paid ${discovery}`]: 'PAYMENT_REQUIRED',
      });
    });

    it.each(METHOD_URLS)(
      '%s: tools/list; tools/call free, freemium in and over quota, paid rail B both steps; search_tools, get_tool, call_tool free and paid',
      async (kind) => {
        const keys = twoKeys();
        const own: Partial<Record<Via, string>> = {};
        const twins = await equivalent(
          await apps.pair(),
          async ({ world, via, bearer }) => {
            own[via] = (await apps.toolsetFor(world, 'kit', 'PRIVATE')).id;
            const bound = await bindDelegate(bearer, keys[via]);
            authorise(world, keys[via]);
            return {
              bound,
              steps: seenAll(await everyMethod(bearer, methodUrlOf(kind), keys[via])),
            };
          },
          {
            dataSource: apps.dataSource,
            placeholders: ({ via }) => ({
              '<delegate>': keys[via].account,
              '<toolset:my-kit>': own[via],
            }),
          },
        );
        // Not vacuous: each step does what this kind serves (review I4).
        const { steps } = resultOf<{ steps: Record<string, ObservedResponse> }>(twins);
        expect(outcomes(steps)).toEqual(SERVED_BY_KIND[kind]);
        // Intents name the run's own credential, in the same form.
        const footprint = (twins.key as { footprint: Record<string, Record<string, unknown>[]> })
          .footprint;
        for (const intent of footprint.payment_intents ?? []) {
          expect(intent.credential_id).toBe('<credential>');
        }
      },
    );

    it('on /, the steps are what their names say, and the intents carry the grant', async () => {
      const world = await apps.world();
      const key = newDelegateKey();
      await bindDelegate(world.grant.bearer, key);
      authorise(world, key);
      const steps = await everyMethod(world.grant.bearer, '/', key);
      expect(requirementOf(steps.paidRequirement)).toMatchObject({ delegate: key.account });
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
      const twins = await equivalent(
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
      const twins = await equivalent(
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
      const worlds = await apps.pair();
      await inOneWindow(40);
      const twins = await equivalent(
        worlds,
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
      const worlds = await apps.pair();
      await inOneWindow(40);
      const twins = await equivalent(
        worlds,
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
      const twins = await equivalent(world, pausedOutcome);
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
      const twins = await equivalent(rotated, pausedOutcome);
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
      const twins = await equivalent(
        worlds,
        async ({ world, via, credentialId, bearer }) => {
          const sibling = credentialOf(world, via === 'key' ? 'grant' : 'key');
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
            // The other credential of the same agent is untouched (review I1).
            siblingList: seen(await rpc(sibling.bearer, '/', 'tools/list')),
          };
        },
        { dataSource: apps.dataSource },
      );
      expect((twins.key as { result: unknown }).result).toMatchObject({
        siblingList: { status: 200 },
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

    it('the revoke audit entry: one shape, differing only in how the credential was issued (R-OA-26)', async () => {
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
        return normaliser(world, via, {}, { known: apps.knownIds })(row) as {
          after: Record<string, unknown>;
        };
      };
      const [key, grant] = [of('key'), of('grant')];
      expect(key.after).toMatchObject({ issuedVia: 'API_KEY', clientId: null });
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
      const twins = await equivalent(
        await apps.pair(),
        async ({ world, via, credentialId, bearer }) => ({
          patched: await apps.asPerson(
            world,
            'patch',
            `/agent-credentials/${credentialId}/access`,
            NARROW,
          ),
          read: await apps.asPerson(world, 'get', `/agent-credentials/${credentialId}/access`),
          view: await narrowedView(bearer),
          // The other credential keeps the agent's access (review I1).
          sibling: seen(
            await call(
              credentialOf(world, via === 'key' ? 'grant' : 'key').bearer,
              '/',
              TOOLS.paid.name,
            ),
          ),
        }),
        { dataSource: apps.dataSource },
      );
      expect(JSON.stringify(twins.key)).toContain('TOOL_NOT_ALLOWED');
      expect(outcome(resultOf<{ sibling: ObservedResponse }>(twins).sibling)).toBe(
        'PAYMENT_REQUIRED',
      );
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
          provider: apps.market.provider,
          knownIds: apps.knownIds,
          // The replacement is the run's credential; the grant it replaced
          // stays apart, so a read-back of the old one would fail (review M3).
          placeholders: ({ via }) =>
            via === 'grant'
              ? { '<credential>': replacement.id, '<replaced>': worlds.grant.grant.id }
              : {},
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
      const twins = await equivalent(
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
      const twins = await equivalent(
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
      expect(resultOf<{ siblingBound: number }>(twins).siblingBound).toBe(201);
      expect(JSON.stringify(twins.key)).toContain('ACCOUNT_DELEGATE_ALREADY_BOUND');
    });

    it("a voucher signed by another credential's key is refused for both", async () => {
      const own = twoKeys();
      const other = twoKeys();
      const twins = await equivalent(
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
      const twins = await equivalent(
        await apps.pair(),
        async ({ world, via, bearer, credentialId }) => {
          await bindDelegate(bearer, keys[via]);
          authorise(world, keys[via]);
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
    it('credential.created: one shape for both; values differ only in how it was issued (§12.1)', async () => {
      const world = await apps.world();
      const rows = (await apps.dataSource.query(
        `SELECT "resource_id", "resource_type", "actor_type", "actor_id", "before", "after"
           FROM "audit_log_entries"
          WHERE "organization_id" = $1 AND "action" = 'credential.created'`,
        [world.organizationId],
      )) as { resource_id: string; after: Record<string, unknown> }[];
      const entry = (via: Via) =>
        rows.find((row) => row.resource_id === credentialOf(world, via).id)!;
      const [key, grant] = [entry('key'), entry('grant')];
      const shape = ['agentId', 'name', 'scopes', 'expiresAt', 'issuedVia', 'clientId', 'replaces'];
      expect(Object.keys(key.after).sort()).toEqual([...shape].sort());
      expect(Object.keys(grant.after).sort()).toEqual([...shape].sort());
      expect(key.after).toMatchObject({ issuedVia: 'API_KEY', clientId: null, replaces: null });
      // A grant's expiry is its rolling refresh expiry at creation (R-OA-13).
      const [credential] = (await apps.dataSource.query(
        `SELECT "expires_at" FROM "agent_credentials" WHERE "id" = $1`,
        [world.grant.id],
      )) as { expires_at: Date }[];
      expect(grant.after).toMatchObject({
        issuedVia: 'OAUTH',
        clientId: BUILTIN,
        replaces: null,
        expiresAt: credential.expires_at.toISOString(),
      });
      const issuance = (via: Via, row: { after: Record<string, unknown> }) => {
        const after = { ...row.after };
        delete after.issuedVia;
        delete after.clientId;
        delete after.expiresAt;
        return normaliser(world, via, {}, { known: apps.knownIds })({ ...row, after });
      };
      expect(issuance('grant', grant)).toStrictEqual(issuance('key', key));
    });
  });

  // ── Exceptions: a third-party grant (H2, §6.3.13) ──────────────────────────

  describe('Exceptions: a third-party grant on the same agent', () => {
    it('delegate challenge and bind → ACCOUNT_DELEGATE_CLIENT_NOT_ALLOWED (R-OA-22)', async () => {
      const world = await apps.world({ client: 'third-party' });
      const delegates = apps.api.get(AgentDelegateService, { strict: false });
      // The MCP host's session for the grant; the API host refuses it sooner.
      const thirdParty = await sessionSource('mcp').resolve(world.grant.bearer);
      const keySession = await sessionSource('mcp').resolve(world.key.bearer);
      expect(thirdParty).toStrictEqual({
        ...keySession,
        credentialId: world.grant.id,
        paymentsAllowed: false,
      });
      const key = newDelegateKey();
      await expect(delegates.challenge(thirdParty, key.signer.address)).rejects.toMatchObject({
        errorCode: 'ACCOUNT_DELEGATE_CLIENT_NOT_ALLOWED',
      });
      await expect(
        delegates.bind(thirdParty, '00000000-0000-4000-8000-000000000000', '0x00'),
      ).rejects.toMatchObject({ errorCode: 'ACCOUNT_DELEGATE_CLIENT_NOT_ALLOWED' });
      // The API key of the same agent may.
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
        // The key gets through authentication and the host check: no 401, no
        // 403, no 5xx (400 for the empty POST bodies, 404 for no policy yet).
        const served = await onApi(world.key.bearer, method, path, {});
        const passed = ![401, 403].includes(served.status) && served.status < 500;
        expect({ path, status: served.status, passed }).toEqual({
          path,
          status: served.status,
          passed: true,
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
      await equivalent(
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
          // The URLs hosted connectors are handed (`/?free=1` by default, owner rule 5).
          for (const path of ['/?free=1', `/?tools=${TOOLS.free.name},${TOOLS.paid.name}`]) {
            steps[`${path} list`] = seen(await rpc(bearer, path, 'tools/list'));
            steps[`${path} free`] = seen(await call(bearer, path, TOOLS.free.name));
            steps[`${path} call_tool`] = seen(
              await call(bearer, path, 'call_tool', {
                name: TOOLS.free.name,
                arguments: { query: 'moon landing' },
              }),
            );
          }
          steps.search = seen(await call(bearer, '/', 'search_tools', { query: 'weather' }));
          steps.getTool = seen(await call(bearer, '/', 'get_tool', { name: TOOLS.free.name }));
          steps.callTool = seen(
            await call(bearer, '/', 'call_tool', {
              name: TOOLS.free.name,
              arguments: { query: 'moon landing' },
            }),
          );
          // Paid step 1 with no key bound on either side: equal until Task 2.13
          // adds the third-party fixUrl rule and sentence (review M9).
          steps.paidRequirement = seen(await call(bearer, '/', TOOLS.paid.name));
          return steps;
        },
        { dataSource: apps.dataSource },
      );
    });
  });
});
