import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import Redis from 'ioredis';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { ToolCallRecordRepository } from '@database/postgres/repositories/tool-call-record.repository';
import { ToolRepository } from '@database/postgres/repositories/tool.repository';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { ToolCallRecordWriter } from '@modules/free-tier/services/tool-call-record-writer.service';
import { McpErrorCode } from '@modules/mcp/errors/mcp.errors';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { ProviderMode } from '@modules/tool/domain/routing';
import { ToolTier } from '@modules/tool/ports/tool.types';
import { InMemoryToolCatalogue } from '@modules/tool/services/in-memory-tool-catalogue';
import { AccessMode, accessAllows } from '@modules/toolset/domain/access';
import { RefusalLayer } from '@modules/toolset/domain/attribution';
import { EndpointKind, parseMcpUrl } from '@modules/toolset/domain/mcp-url';
import { ToolsetErrorCode } from '@modules/toolset/errors/toolset.errors';
import { RefusedCallsService } from '@modules/toolset/services/refused-calls.service';

import { ensureTestDatabase, testConnectionOptions } from '../helpers/test-database';
import { toolsetTestContext } from '../helpers/toolset-test-context';

const DATABASE = 'assay_toolsets_access_test';
const HOST = { mcpPublicUrl: 'https://mcp.example.com', webAppUrl: 'https://app.example.com' };
const CHAIN = CHAIN_IDS.SOLANA_DEVNET;
const ACTOR = { type: 'user' as const, id: 'login-integration' };

const redisOptions = () => ({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: 1,
});

const WEATHER = { id: randomUUID(), name: 'get_weather', category: 'weather' };
const GEOCODE = { id: randomUUID(), name: 'geocode_place', category: 'maps' };
const TOOLS = [WEATHER, GEOCODE].map((tool) => ({
  ...tool,
  tags: [],
  description: `${tool.name}.`,
  inputSchema: { type: 'object' as const },
  outputSchema: { type: 'object' as const },
  verificationPolicyId: 'policy-default',
  tier: ToolTier.VERIFIED,
}));

/**
 * Toolsets, access policies and the MCP views over them, against a database
 * built from every migration and a real Redis (design spec, phase T1):
 * the `tools` reference, the Draft served live, 404 for other organizations,
 * access written as a policy version and seen at once on another instance,
 * key narrowing, refused calls kept out of the free quota, Servers in use.
 */
describe('toolsets and access, against a real database and Redis', () => {
  let dataSource: DataSource;
  const redises: Redis[] = [];
  let orgA: string;
  let orgB: string;
  let agentA: string;

  function services() {
    const redis = new Redis(redisOptions());
    redises.push(redis);
    const catalogue = new InMemoryToolCatalogue({ tools: TOOLS, bindings: [] });
    return {
      ...toolsetTestContext({ dataSource, redis, host: HOST, catalogue, chainId: CHAIN }),
      records: new ToolCallRecordWriter(new ToolCallRecordRepository(dataSource)),
      refused: new RefusedCallsService(
        new ToolCallRecordRepository(dataSource),
        new ProviderRepository(dataSource),
      ),
      recordsRepo: new ToolCallRecordRepository(dataSource),
    };
  }

  const sessionOf = (
    organizationId: string,
    agentId: string,
    credentialId?: string,
  ): McpSession => ({
    credentialId: credentialId ?? 'login',
    storedCredential: credentialId !== undefined,
    organizationId,
    agentId,
    agentAccount: `${CHAIN}:AgentWallet111111111111111111111111111111` as never,
    chainId: CHAIN,
    label: null,
    callerKind: credentialId ? McpCallerKind.AGENT : McpCallerKind.HUMAN,
    paymentsAllowed: true,
  });

  const errorOf = (work: Promise<unknown>) =>
    work.then(
      () => null,
      (error: { errorCode?: string; statusCode?: number }) => ({
        code: error.errorCode,
        status: error.statusCode,
      }),
    );

  beforeAll(async () => {
    const connection = testConnectionOptions();
    const admin = new Client({
      host: connection.host,
      port: connection.port,
      user: connection.username,
      password: connection.password,
      database: 'postgres',
    });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
    await admin.end();
    await ensureTestDatabase(DATABASE);

    dataSource = new DataSource({
      type: 'postgres',
      ...connection,
      database: DATABASE,
      entities: [join(__dirname, '../../../src/database/postgres/entities/*.entity.ts')],
      migrations: [join(__dirname, '../../../src/database/postgres/migrations/*.ts')],
      synchronize: false,
      migrationsRun: false,
    });
    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'each' });

    const { 0: a } = await dataSource.query(
      `INSERT INTO organizations (name) VALUES ('Org A, Paris') RETURNING id`,
    );
    const { 0: b } = await dataSource.query(
      `INSERT INTO organizations (name) VALUES ('Org B, Paris') RETURNING id`,
    );
    orgA = a.id;
    orgB = b.id;
    const { 0: agent } = await dataSource.query(
      `INSERT INTO agents (organization_id, privy_user_id, label) VALUES ($1, 'privy:a', 'research-bot')
       RETURNING id`,
      [orgA],
    );
    agentA = agent.id;

    await new ToolRepository(dataSource).upsertSeeded(
      TOOLS.map((tool) => ({ id: tool.id, name: tool.name, category: tool.category, tags: [] })),
    );
  }, 300_000);

  afterAll(async () => {
    await Promise.all(redises.map((redis) => redis.quit()));
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  describe('the tools table', () => {
    it('is what tool_bindings references', async () => {
      await expect(
        dataSource.query(
          `INSERT INTO tool_bindings
             (id, organization_id, tool_id, endpoint, request_mapping, response_mapping,
              pricing_mode, price_amount, asset_id, sla_failure_rate, timeout_ms,
              settlement_chains, status)
           VALUES ($1, $2, $3, 'https://provider.example.com', '{}'::jsonb, '{}'::jsonb, 'PAID',
                   1000, 'x', 0.02, 1000, ARRAY['solana:x']::varchar[], 'DRAFT')`,
          [randomUUID(), orgA, randomUUID()],
        ),
      ).rejects.toThrow(/fk_tool_bindings_tool/);
    });

    it('upserts the seed idempotently, keeping the row id', async () => {
      const repository = new ToolRepository(dataSource);
      await repository.upsertSeeded([
        { id: WEATHER.id, name: 'get_weather', category: 'weather', tags: ['forecast'] },
      ]);
      const [row] = await repository.findByIds([WEATHER.id]);
      expect(row).toMatchObject({
        kind: 'STANDARD',
        visibility: 'LISTED',
        status: 'ACTIVE',
        tags: ['forecast'],
      });
    });
  });

  describe('toolsets', () => {
    it('creates one with a generated slug, serves its Draft live at /my/{slug}, and 404s for others', async () => {
      const s = services();
      const created = await s.toolsets.create(
        orgA,
        {
          name: 'Weather Desk',
          entries: [
            { toolId: WEATHER.id, providerMode: ProviderMode.EXCLUDE, providerIds: [randomUUID()] },
          ],
        },
        ACTOR,
      );
      expect(created).toMatchObject({
        slug: 'weather-desk',
        category: 'weather',
        visibility: 'PRIVATE',
        toolCount: 1,
        mcpUrl: 'https://mcp.example.com/my/weather-desk',
      });

      const view = await s.endpoints.resolve(orgA, parseMcpUrl('/my/weather-desk')!);
      expect(view).toMatchObject({
        kind: EndpointKind.TOOLSET,
        baseToolIds: [WEATHER.id],
        toolset: { id: created.id, version: null },
      });
      expect(view.entryRules.get(WEATHER.id)?.mode).toBe(ProviderMode.EXCLUDE);

      // Another organization: the same 404 as a slug that does not exist.
      expect(await errorOf(s.endpoints.resolve(orgB, parseMcpUrl('/my/weather-desk')!))).toEqual({
        code: McpErrorCode.MCP_URL_NOT_FOUND,
        status: 404,
      });
      expect(await errorOf(s.toolsets.get(orgB, created.id))).toEqual({
        code: ToolsetErrorCode.TOOLSET_NOT_FOUND,
        status: 404,
      });

      // An edit reaches the URL at once, on another instance too.
      const other = services();
      await other.endpoints.resolve(orgA, parseMcpUrl('/my/weather-desk')!);
      await s.toolsets.replaceEntries(
        orgA,
        created.id,
        [{ toolId: WEATHER.id }, { toolId: GEOCODE.id }],
        ACTOR,
      );
      const refreshed = await other.endpoints.resolve(orgA, parseMcpUrl('/my/weather-desk')!);
      expect(refreshed.baseToolIds).toEqual([WEATHER.id, GEOCODE.id]);
      expect(refreshed.entryRules.size).toBe(0);
    });

    it('refuses a taken slug with a free suggestion', async () => {
      const s = services();
      await s.toolsets.create(orgA, { name: 'Maps', slug: 'maps' }, ACTOR);
      const refusal = await s.toolsets
        .create(orgA, { name: 'Maps again', slug: 'maps' }, ACTOR)
        .catch((error: { errorCode: string; context: Record<string, unknown> }) => error);
      expect(refusal).toMatchObject({
        errorCode: ToolsetErrorCode.TOOLSET_SLUG_TAKEN,
        context: { suggestion: 'maps-2' },
      });
      // Another organization may use the same slug.
      await expect(
        s.toolsets.create(orgB, { name: 'Maps', slug: 'maps' }, ACTOR),
      ).resolves.toMatchObject({
        slug: 'maps',
      });
    });

    it('a deleted toolset stops serving and frees its slug', async () => {
      const s = services();
      const created = await s.toolsets.create(
        orgA,
        { name: 'Gone soon', slug: 'gone-soon' },
        ACTOR,
      );
      await s.toolsets.delete(orgA, created.id, ACTOR);
      expect(
        (await errorOf(s.endpoints.resolve(orgA, parseMcpUrl('/my/gone-soon')!)))?.status,
      ).toBe(404);
      await expect(
        s.toolsets.create(orgA, { name: 'Again', slug: 'gone-soon' }, ACTOR),
      ).resolves.toBeDefined();
    });

    it('the database refuses an entry whose provider list does not match its mode', async () => {
      const s = services();
      const created = await s.toolsets.create(orgA, { name: 'Raw' }, ACTOR);
      await expect(
        dataSource.query(
          `INSERT INTO toolset_entries (toolset_id, position, tool_id, provider_mode, provider_ids)
           VALUES ($1, 0, $2, 'BEST', ARRAY[$3]::uuid[])`,
          [created.id, WEATHER.id, randomUUID()],
        ),
      ).rejects.toThrow(/chk_toolset_entries_provider_ids/);
    });
  });

  describe('access', () => {
    it('writes access as a policy version on top of the organization default, seen at once elsewhere', async () => {
      const writer = services();
      const reader = services();
      const toolset = await writer.toolsets.create(
        orgA,
        { name: 'Allowed set', entries: [{ toolId: GEOCODE.id }] },
        ACTOR,
      );
      const session = sessionOf(orgA, agentA);

      expect(accessAllows(await reader.resolver.resolve(session), WEATHER.id, null)).toBe(true);

      const written = await writer.access.patch(
        orgA,
        agentA,
        {
          accessMode: AccessMode.RESTRICTED,
          allowedToolIds: [WEATHER.id],
          allowedToolsets: [{ toolsetId: toolset.id, version: null, viaUrlOnly: true }],
          rules: {
            excludeProviderIds: [randomUUID()],
            maxPrice: '10000',
            minTier: null,
            minQuality: 0.9,
          },
          pinnedTools: ['get_weather'],
        },
        ACTOR,
      );
      expect(written).toMatchObject({
        scope: 'AGENT',
        accessMode: AccessMode.RESTRICTED,
        allowedToolIds: [WEATHER.id],
        allowedToolsets: [{ toolsetId: toolset.id, viaUrlOnly: true, deleted: false }],
        rules: { maxPrice: { amount: '10000' }, minQuality: 0.9 },
        pinnedTools: ['get_weather'],
      });

      // The organization default the agent row inherits its caps from.
      const [orgDefault] = await dataSource.query(
        `SELECT per_call_max FROM spend_policies
          WHERE organization_id = $1 AND agent_id IS NULL AND superseded_at IS NULL`,
        [orgA],
      );
      expect(orgDefault.per_call_max).not.toBeNull();

      const access = await reader.resolver.resolve(session);
      expect(accessAllows(access, WEATHER.id, null)).toBe(true);
      expect(accessAllows(access, GEOCODE.id, null)).toBe(false);
      expect(accessAllows(access, GEOCODE.id, toolset.id)).toBe(true);
      expect(access.rules?.minQuality).toBe(0.9);
    });

    it('refuses another organization’s toolset, a version pin and more than 5 pinned tools', async () => {
      const s = services();
      const foreign = await s.toolsets.create(orgB, { name: 'Foreign' }, ACTOR);
      expect(
        (
          await errorOf(
            s.access.patch(orgA, agentA, { allowedToolsets: [{ toolsetId: foreign.id }] }, ACTOR),
          )
        )?.code,
      ).toBe(ToolsetErrorCode.TOOLSET_ACCESS_INVALID);

      const own = await s.toolsets.create(orgA, { name: 'Own for pins' }, ACTOR);
      expect(
        (
          await errorOf(
            s.access.patch(
              orgA,
              agentA,
              { allowedToolsets: [{ toolsetId: own.id, version: 2 }] },
              ACTOR,
            ),
          )
        )?.code,
      ).toBe(ToolsetErrorCode.TOOLSET_ACCESS_INVALID);

      expect(
        await errorOf(
          s.access.patch(orgA, agentA, { pinnedTools: ['a', 'b', 'c', 'd', 'e', 'f'] }, ACTOR),
        ),
      ).toEqual({ code: ToolsetErrorCode.TOOLSET_LIMIT_EXCEEDED, status: 429 });
    });

    it('an agent of another organization is a 404', async () => {
      expect((await errorOf(services().access.get(orgB, agentA)))?.status).toBe(404);
    });

    it('a key narrows its agent, and only narrows', async () => {
      const s = services();
      const credentialId = randomUUID();
      await dataSource.query(
        `INSERT INTO agent_credentials (id, organization_id, agent_id, name, prefix, token_hash)
         VALUES ($1, $2, $3, 'ci', 'assay_sk_li', $4)`,
        [credentialId, orgA, agentA, `hash-${credentialId}`],
      );
      await s.access.patch(orgA, agentA, { accessMode: AccessMode.ALL }, ACTOR);

      await s.access.patchCredential(
        orgA,
        credentialId,
        { accessMode: AccessMode.RESTRICTED, allowedToolIds: [GEOCODE.id] },
        ACTOR,
      );
      const narrowed = await s.resolver.resolve(sessionOf(orgA, agentA, credentialId));
      expect(accessAllows(narrowed, GEOCODE.id, null)).toBe(true);
      expect(accessAllows(narrowed, WEATHER.id, null)).toBe(false);
      // The person's own session is not narrowed by that key.
      expect(
        accessAllows(await s.resolver.resolve(sessionOf(orgA, agentA)), WEATHER.id, null),
      ).toBe(true);

      // A PATCH that omits `accessMode` keeps the narrowing and its lists.
      await s.access.patchCredential(orgA, credentialId, {}, ACTOR);
      const kept = await s.access.getCredential(orgA, credentialId);
      expect(kept).toMatchObject({
        accessMode: AccessMode.RESTRICTED,
        allowedToolIds: [GEOCODE.id],
      });
      await s.access.patchCredential(
        orgA,
        credentialId,
        { allowedToolIds: [GEOCODE.id, WEATHER.id] },
        ACTOR,
      );
      expect(await s.access.getCredential(orgA, credentialId)).toMatchObject({
        accessMode: AccessMode.RESTRICTED,
        allowedToolIds: [GEOCODE.id, WEATHER.id],
      });

      await s.access.patchCredential(orgA, credentialId, { accessMode: null }, ACTOR);
      expect(
        accessAllows(
          await s.resolver.resolve(sessionOf(orgA, agentA, credentialId)),
          WEATHER.id,
          null,
        ),
      ).toBe(true);

      expect((await errorOf(s.access.patchCredential(orgB, credentialId, {}, ACTOR)))?.status).toBe(
        404,
      );
    });

    it('a revoked or expired key is not narrowed: 404, nothing written', async () => {
      const s = services();
      for (const dead of [
        { revoked_at: new Date(Date.now() - 60_000), expires_at: null },
        { revoked_at: null, expires_at: new Date(Date.now() - 60_000) },
      ]) {
        const credentialId = randomUUID();
        await dataSource.query(
          `INSERT INTO agent_credentials
             (id, organization_id, agent_id, name, prefix, token_hash, revoked_at, revoked_by,
              expires_at)
           VALUES ($1, $2, $3, 'ci', 'assay_sk_li', $4, $5, $6, $7)`,
          [
            credentialId,
            orgA,
            agentA,
            `hash-${credentialId}`,
            dead.revoked_at,
            dead.revoked_at ? 'user:example' : null,
            dead.expires_at,
          ],
        );
        const patch = s.access.patchCredential(
          orgA,
          credentialId,
          { accessMode: AccessMode.RESTRICTED, allowedToolIds: [GEOCODE.id] },
          ACTOR,
        );
        expect((await errorOf(patch))?.status).toBe(404);
        const [row] = (await dataSource.query(
          `SELECT access_mode FROM agent_credentials WHERE id = $1`,
          [credentialId],
        )) as { access_mode: string | null }[];
        expect(row.access_mode).toBeNull();
      }
    });

    it('a PATCH waiting on a grant that is being replaced fails once the replacement commits', async () => {
      const s = services();
      const credentialId = randomUUID();
      await dataSource.query(
        `INSERT INTO agent_credentials (id, organization_id, agent_id, name, prefix, token_hash)
         VALUES ($1, $2, $3, 'ci', 'assay_sk_li', $4)`,
        [credentialId, orgA, agentA, `hash-${credentialId}`],
      );

      // The replacement exchange: it locks the old row, copies its narrowing
      // and revokes it in one transaction (OAuthGrantWriter.createGrant).
      const exchange = dataSource.createQueryRunner();
      await exchange.connect();
      await exchange.startTransaction();
      let settled = false;
      try {
        await exchange.query(`SELECT id FROM agent_credentials WHERE id = $1 FOR UPDATE`, [
          credentialId,
        ]);

        const patch = s.access
          .patchCredential(
            orgA,
            credentialId,
            { accessMode: AccessMode.RESTRICTED, allowedToolIds: [GEOCODE.id] },
            ACTOR,
          )
          .finally(() => {
            settled = true;
          });
        const outcome = errorOf(patch);

        // The PATCH is blocked on the row lock, not finished.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(settled).toBe(false);

        await exchange.query(
          `UPDATE agent_credentials SET revoked_at = now(), revoked_by = 'system:oauth-replaced'
            WHERE id = $1`,
          [credentialId],
        );
        await exchange.commitTransaction();

        expect((await outcome)?.status).toBe(404);
      } finally {
        if (exchange.isTransactionActive) await exchange.rollbackTransaction();
        await exchange.release();
      }

      const [row] = (await dataSource.query(
        `SELECT access_mode, allowed_tool_ids FROM agent_credentials WHERE id = $1`,
        [credentialId],
      )) as { access_mode: string | null; allowed_tool_ids: string[] | null }[];
      expect(row).toEqual({ access_mode: null, allowed_tool_ids: null });
    });
  });

  describe('refused calls and Servers in use', () => {
    it('records a refused call, lists it, and never counts it as a free call', async () => {
      const s = services();
      const callId = randomUUID();
      await s.records.writeRefusal({
        organizationId: orgA,
        agentId: agentA,
        callId,
        toolId: WEATHER.id,
        toolName: 'get_weather',
        refusalCode: 'NO_PROVIDER_MATCHES_RULES',
        refusalLayer: RefusalLayer.AGENT_LIMITS,
        refusalDetail: {
          toolId: WEATHER.id,
          providers: [
            { providerId: randomUUID(), reason: 'EXCLUDED_BY_AGENT', source: 'AGENT', detail: 'x' },
          ],
        },
        latencyMs: 3,
        attribution: {
          endpointKind: EndpointKind.ROOT,
          toolsetId: null,
          toolsetVersion: null,
          endpointHandle: null,
          viewFilter: { tools: ['get_weather'] },
        },
      });

      const page = await s.refused.list(orgA, { limit: 25, agentId: agentA } as never);
      expect(page.items).toEqual([
        expect.objectContaining({
          callId,
          refusalCode: 'NO_PROVIDER_MATCHES_RULES',
          refusalLayer: RefusalLayer.AGENT_LIMITS,
          charged: false,
          // No registered provider by that id: the name reads as null, not as an error.
          providers: [
            expect.objectContaining({
              reason: 'EXCLUDED_BY_AGENT',
              source: 'AGENT',
              providerName: null,
            }),
          ],
        }),
      ]);
      expect((await errorOf(s.refused.get(orgB, callId)))?.status).toBe(404);

      expect(await s.recordsRepo.countForAgentSince(orgA, agentA, new Date(0))).toBe(0);
    });

    it('lists a handed-out URL as waiting, and a called-through URL with its last call', async () => {
      const s = services();
      // A served (free) call through `/?tools=get_weather`; the refused call
      // above came through the same URL and must not count as a server in use.
      await s.records.write({
        organizationId: orgA,
        agentId: agentA,
        callId: randomUUID(),
        toolId: WEATHER.id,
        bindingId: null,
        providerId: null,
        pricingMode: 'FREE' as never,
        classification: 'DATA_RESULT' as never,
        latencyMs: 12,
        requestHash: null,
        attribution: {
          endpointKind: EndpointKind.ROOT,
          toolsetId: null,
          toolsetVersion: null,
          endpointHandle: null,
          viewFilter: { tools: ['get_weather'] },
        },
      });
      await s.records.writeRefusal({
        organizationId: orgA,
        agentId: agentA,
        callId: randomUUID(),
        toolId: GEOCODE.id,
        toolName: 'geocode_place',
        refusalCode: 'TOOL_NOT_ALLOWED',
        refusalLayer: RefusalLayer.AGENT_LIMITS,
        refusalDetail: null,
        latencyMs: 1,
        attribution: {
          endpointKind: EndpointKind.ROOT,
          toolsetId: null,
          toolsetVersion: null,
          endpointHandle: null,
          viewFilter: { tools: ['geocode_place'] },
        },
      });
      await s.connectUrls.record(orgA, agentA, {
        url: 'https://mcp.example.com/my/WEATHER-DESK/',
        serverName: 'weather',
        client: 'claude-code',
      });
      const rows = await s.connectUrls.serversInUse(orgA, agentA);

      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            canonicalUrl: 'https://mcp.example.com/my/weather-desk',
            serverName: 'weather',
            client: 'claude-code',
            firstCallAt: null,
            lastCallAt: null,
          }),
          expect.objectContaining({
            canonicalUrl: 'https://mcp.example.com/?tools=get_weather',
            endpointKind: EndpointKind.ROOT,
            handedOutAt: null,
          }),
        ]),
      );

      expect(rows.map((row) => row.canonicalUrl)).not.toContain(
        'https://mcp.example.com/?tools=geocode_place',
      );

      await s.connectUrls.markFirstCall(orgA, agentA, 'https://mcp.example.com/my/weather-desk');
      const after = await s.connectUrls.serversInUse(orgA, agentA);
      expect(
        after.find((row) => row.canonicalUrl === 'https://mcp.example.com/my/weather-desk')
          ?.firstCallAt,
      ).not.toBeNull();
    });

    it('refuses a URL of any other host without fetching it', async () => {
      expect(
        (
          await errorOf(
            services().connectUrls.record(orgA, agentA, {
              url: 'http://203.0.113.7/my/research',
              serverName: null,
              client: null,
            }),
          )
        )?.code,
      ).toBe('URL_NOT_RECOGNISED');
    });

    it('"only what is connected" restricts to the servers in use', async () => {
      const s = services();
      const result = await s.access.onlyConnected(orgA, agentA, ACTOR);
      const desk = (await s.toolsets.list(orgA, { limit: 100 } as never)).items.find(
        (toolset) => toolset.slug === 'weather-desk',
      );
      expect(result).toMatchObject({
        everything: false,
        accessMode: AccessMode.RESTRICTED,
        allowedToolIds: [WEATHER.id],
        allowedToolsets: [{ toolsetId: desk?.id, viaUrlOnly: true }],
      });
    });
  });
});
