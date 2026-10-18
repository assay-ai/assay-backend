import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import Redis from 'ioredis';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { ToolRepository } from '@database/postgres/repositories/tool.repository';
import {} from '@database/postgres/repositories/toolset.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { FreeQuotaService } from '@modules/free-tier/services/free-quota.service';
import { McpErrorCode } from '@modules/mcp/errors/mcp.errors';
import { McpScope } from '@modules/mcp/ports/mcp-scope';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { McpCatalogueService } from '@modules/mcp/services/mcp-catalogue.service';
import { McpDiscoveryService } from '@modules/mcp/services/mcp-discovery.service';
import { MCP_RATE_LIMITS, McpRateLimiter } from '@modules/mcp/services/mcp-rate-limiter.service';
import { ToolAccessErrorCode } from '@modules/tool/errors/tool-access.errors';
import { PricingMode, ToolTier } from '@modules/tool/ports/tool.types';
import { InMemoryToolCatalogue } from '@modules/tool/services/in-memory-tool-catalogue';
import { QuoteIndexService } from '@modules/tool/services/quote-index.service';
import { AccessMode } from '@modules/toolset/domain/access';
import { ToolsetVisibility } from '@modules/toolset/domain/sharing';
import { attributionOf } from '@modules/toolset/domain/attribution';
import { DiscoveryMode, parseMcpUrl } from '@modules/toolset/domain/mcp-url';
import { CacheService } from '@shared/cache/redis-cache/cache.service';
import { MoneyUtil } from '@utils/money.util';

import { ensureTestDatabase, testConnectionOptions } from '../helpers/test-database';
import { toolsetTestContext } from '../helpers/toolset-test-context';

const DATABASE = 'assay_mcp_discovery_test';
const HOST = {
  mcpPublicUrl: 'https://mcp.example.com',
  webAppUrl: 'https://app.example.com',
  rootPinnedTools: ['geocode_place'],
};
const CHAIN = CHAIN_IDS.SOLANA_DEVNET;
const ACTOR = { type: 'user' as const, id: 'login-integration' };
const SECRET = 'integration-cursor-secret-0123456789abcdef';

const redisOptions = () => ({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: 1,
});

const WEATHER = { id: randomUUID(), name: 'get_weather', category: 'weather' };
const FORECAST = { id: randomUUID(), name: 'get_forecast', category: 'weather' };
const GEOCODE = { id: randomUUID(), name: 'geocode_place', category: 'maps' };
const TOOLS = [WEATHER, FORECAST, GEOCODE].map((tool) => ({
  ...tool,
  tags: [],
  description: `${tool.name.replace(/_/g, ' ')}: temperature, rain or places.`,
  inputSchema: { type: 'object' as const },
  outputSchema: { type: 'object' as const },
  verificationPolicyId: 'policy-default',
  tier: ToolTier.VERIFIED,
}));

/** Prices every tool at a fixed quote: discovery is the subject here, not routing. */
function pricedCatalogue(): McpCatalogueService {
  const usdc = MoneyUtil.of('10000', ASSET_IDS.USDC_SOLANA_DEVNET, 6);
  const quotes = {
    quoteMany: async (ids: readonly string[]) =>
      new Map(
        ids.map((id) => [
          id,
          {
            tool: TOOLS.find((tool) => tool.id === id),
            price: usdc,
            cheapestPrice: usdc,
            pricingMode: PricingMode.PAID,
            routableBindings: 1,
            paidBindings: 1,
            settlementChains: [CHAIN],
            p95LatencyMs: null,
            qualityRate: null,
            unroutableReason: null,
          },
        ]),
      ),
  } as unknown as QuoteIndexService;
  return new McpCatalogueService(
    new InMemoryToolCatalogue({ tools: TOOLS, bindings: [] }),
    undefined as never,
    {
      remainingForTool: async () => null,
      dailyAllowance: () => null,
    } as unknown as FreeQuotaService,
    [CHAIN],
    quotes,
  );
}

/**
 * Discovery against a database built from every migration and a real Redis
 * (design spec, phase T2): a toolset's own discovery settings and pins, the
 * agent's pins written through its access, `/c/{category}`, cursors that work
 * across instances and nowhere else, and the per-agent limits in Redis.
 */
describe('MCP discovery, against a real database and Redis', () => {
  let dataSource: DataSource;
  const redises: Redis[] = [];
  let orgA: string;
  let agentA: string;

  function services() {
    const redis = new Redis(redisOptions());
    redises.push(redis);
    const cache = new CacheService(redis);
    const catalogue = new InMemoryToolCatalogue({ tools: TOOLS, bindings: [] });
    return {
      ...toolsetTestContext({ dataSource, redis, host: HOST, catalogue, chainId: CHAIN }),
      limiter: new McpRateLimiter(cache),
      discovery: new McpDiscoveryService(pricedCatalogue(), new McpRateLimiter(cache), {
        cursorSecret: SECRET,
      }),
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
  });

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
      `INSERT INTO organizations (name) VALUES ('Org A') RETURNING id`,
    );
    orgA = a.id;
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

  async function scopeFor(s: ReturnType<typeof services>, url: string, session: McpSession) {
    const view = await s.endpoints.resolve(session.organizationId, parseMcpUrl(url)!);
    const scope: McpScope = {
      view,
      access: await s.resolver.resolve(session),
      attribution: attributionOf(view),
    };
    return scope;
  }

  const viewer = (session: McpSession) => ({
    organizationId: session.organizationId,
    agentId: session.agentId,
    chainId: session.chainId,
  });

  it('the database refuses a tool named after a meta tool', async () => {
    for (const name of ['search_tools', 'get_tool', 'call_tool']) {
      await expect(
        dataSource.query(
          `INSERT INTO tools (id, name, kind, category, visibility, status)
           VALUES ($1, $2, 'STANDARD', 'misc', 'LISTED', 'ACTIVE')`,
          [randomUUID(), name],
        ),
      ).rejects.toThrow(/chk_tools_name_not_reserved/);
    }
  });

  it('a SEARCH toolset lists its own pins, then the agent pins written through its access', async () => {
    const s = services();
    const session = sessionOf(orgA, agentA);
    await s.toolsets.create(
      orgA,
      {
        name: 'Weather search',
        slug: 'weather-search',
        discovery: 'SEARCH',
        pinnedTools: [FORECAST.name],
        entries: [{ toolId: WEATHER.id }, { toolId: FORECAST.id }, { toolId: GEOCODE.id }],
      },
      ACTOR,
    );
    await s.access.patch(orgA, agentA, { pinnedTools: [GEOCODE.name, FORECAST.name] }, ACTOR);

    const scope = await scopeFor(s, '/my/weather-search', session);
    const listing = await s.discovery.list(viewer(session), scope);
    expect(listing.mode).toBe(DiscoveryMode.SEARCH);
    expect(listing.tools.map((tool) => tool.name)).toEqual([
      FORECAST.name,
      GEOCODE.name,
      'search_tools',
      'get_tool',
      'call_tool',
    ]);

    // ?discovery=full on the same URL lists every entry.
    const full = await s.discovery.list(
      viewer(session),
      await scopeFor(s, '/my/weather-search?discovery=full', session),
    );
    expect(full.tools.map((tool) => tool.name)).toEqual([
      WEATHER.name,
      FORECAST.name,
      GEOCODE.name,
    ]);
  });

  it('published views serve their snapshot’s discovery settings, and meta tools stay in view ∩ access', async () => {
    const s = services();
    const [{ id: owner }] = await dataSource.query(
      `INSERT INTO organizations (name) VALUES ('Snapshot owner') RETURNING id`,
    );
    const [{ id: ownerAgent }] = await dataSource.query(
      `INSERT INTO agents (organization_id, privy_user_id, label) VALUES ($1, $2, 'owner')
       RETURNING id`,
      [owner, `privy:${randomUUID()}`],
    );
    await dataSource.query(
      `INSERT INTO buyer_escrows (organization_id, account_id, asset_id, escrow_account_id,
                                  escrow_asset_account_id, opened_at)
       VALUES ($1, $2, 'asset', $3, $4, now())`,
      [owner, `${CHAIN}:SnapshotOwner`, randomUUID(), randomUUID()],
    );
    await s.handles.claim(sessionOf(owner, ownerAgent), 'snapshot-co', ACTOR);
    const created = await s.toolsets.create(
      owner,
      {
        name: 'Snapshot',
        slug: 'snapshot',
        discovery: 'SEARCH',
        pinnedTools: [FORECAST.name],
        entries: [{ toolId: WEATHER.id }, { toolId: FORECAST.id }, { toolId: GEOCODE.id }],
      },
      ACTOR,
    );
    await s.publishing.publish(owner, created.id, { visibility: ToolsetVisibility.PUBLIC }, ACTOR);
    // A Draft edit after publishing changes nothing a shared URL serves.
    await s.toolsets.update(owner, created.id, { discovery: 'FULL', pinnedTools: [] }, ACTOR);

    const session = sessionOf(orgA, agentA);
    const shared = await scopeFor(s, '/@snapshot-co/snapshot', session);
    const listing = await s.discovery.list(viewer(session), shared);
    expect(listing.mode).toBe(DiscoveryMode.SEARCH);
    // The snapshot's pin, then the agent's own pins (set by the first test).
    expect(listing.tools.map((tool) => tool.name)).toEqual([
      FORECAST.name,
      GEOCODE.name,
      'search_tools',
      'get_tool',
      'call_tool',
    ]);
    const ownerSession = sessionOf(owner, ownerAgent);
    expect(
      (
        await s.discovery.list(
          viewer(ownerSession),
          await scopeFor(s, '/my/snapshot@1', ownerSession),
        )
      ).mode,
    ).toBe(DiscoveryMode.SEARCH);
    expect(
      (
        await s.discovery.list(
          viewer(ownerSession),
          await scopeFor(s, '/my/snapshot', ownerSession),
        )
      ).mode,
    ).toBe(DiscoveryMode.FULL);

    // Access allows only get_weather: search and get_tool on the shared URL see nothing else.
    await s.access.patch(
      orgA,
      agentA,
      { accessMode: AccessMode.RESTRICTED, allowedToolIds: [WEATHER.id], allowedToolsets: [] },
      ACTOR,
    );
    const restricted = await scopeFor(s, '/@snapshot-co/snapshot', session);
    const found = await s.discovery.search(session, restricted, {
      query: 'weather places',
      limit: 10,
    });
    expect(found.results.map((result) => result.name)).toEqual([WEATHER.name]);
    await expect(
      s.discovery.getTool(session, restricted, { name: GEOCODE.name }),
    ).rejects.toBeTruthy();
    await s.access.patch(orgA, agentA, { accessMode: AccessMode.ALL }, ACTOR);

    // A link-only version published FULL serves FULL on /u/, while /@… keeps v1.
    await s.toolsets.update(owner, created.id, { discovery: 'FULL' }, ACTOR);
    const v2 = await s.publishing.publish(
      owner,
      created.id,
      { visibility: ToolsetVisibility.UNLISTED },
      ACTOR,
    );
    const link = await scopeFor(s, `/u/${v2.toolset.unlistedToken}`, session);
    expect((await s.discovery.list(viewer(session), link)).mode).toBe(DiscoveryMode.FULL);
    expect((await scopeFor(s, '/@snapshot-co/snapshot', session)).view.toolset?.version).toBe(1);
  });

  it('the root searches, with the root pins; /c/{category} serves one topic and 404s for none', async () => {
    const s = services();
    const session = sessionOf(orgA, agentA);
    await s.access.patch(orgA, agentA, { pinnedTools: [] }, ACTOR);
    const root = await s.discovery.list(viewer(session), await scopeFor(s, '/', session));
    expect(root.tools.map((tool) => tool.name)).toEqual([
      GEOCODE.name,
      'search_tools',
      'get_tool',
      'call_tool',
    ]);

    const weather = await s.discovery.list(
      viewer(session),
      await scopeFor(s, '/c/weather', session),
    );
    expect(weather.mode).toBe(DiscoveryMode.FULL);
    expect(weather.tools.map((tool) => tool.name)).toEqual([WEATHER.name, FORECAST.name]);

    await expect(s.endpoints.resolve(orgA, parseMcpUrl('/c/astrology')!)).rejects.toMatchObject({
      errorCode: McpErrorCode.MCP_URL_NOT_FOUND,
    });
  });

  it('a cursor pages on another instance with the same secret, and for nobody else', async () => {
    const one = services();
    const two = services();
    const session = sessionOf(orgA, agentA);
    await one.access.patch(orgA, agentA, { accessMode: AccessMode.ALL }, ACTOR);
    const scope = await scopeFor(one, '/', session);

    const first = await one.discovery.search(session, scope, {
      query: '',
      detail: 'names',
      limit: 2,
    });
    expect(first.total).toBe(3);
    const second = await two.discovery.search(session, await scopeFor(two, '/', session), {
      cursor: first.nextCursor as string,
    });
    expect(second.results.map((result) => result.name)).toEqual([WEATHER.name]);

    const stranger = sessionOf(orgA, agentA, randomUUID());
    await expect(
      two.discovery.search(stranger, scope, { cursor: first.nextCursor as string }),
    ).rejects.toMatchObject({ errorCode: ToolAccessErrorCode.INVALID_CURSOR });
  });

  it('the next page follows an access change at once (the epoch in Redis)', async () => {
    const one = services();
    const two = services();
    const session = sessionOf(orgA, agentA);
    await one.access.patch(orgA, agentA, { accessMode: AccessMode.ALL }, ACTOR);
    const first = await one.discovery.search(session, await scopeFor(one, '/', session), {
      query: '',
      detail: 'names',
      limit: 1,
    });

    await two.access.patch(
      orgA,
      agentA,
      { accessMode: AccessMode.RESTRICTED, allowedToolIds: [GEOCODE.id], allowedToolsets: [] },
      ACTOR,
    );
    const next = await one.discovery.search(session, await scopeFor(one, '/', session), {
      cursor: first.nextCursor as string,
    });
    expect(next).toMatchObject({ results: [], total: 1, nextCursor: null });
    await expect(
      one.discovery.getTool(session, await scopeFor(one, '/', session), { name: WEATHER.name }),
    ).rejects.toMatchObject({ errorCode: ToolAccessErrorCode.TOOL_NOT_IN_TOOLSET });
    await one.access.patch(orgA, agentA, { accessMode: AccessMode.ALL }, ACTOR);
  });

  it(`limits search_tools to ${MCP_RATE_LIMITS.searchesPerMinute} a minute per agent, across instances`, async () => {
    const one = services();
    const two = services();
    const { 0: agent } = await dataSource.query(
      `INSERT INTO agents (organization_id, privy_user_id, label) VALUES ($1, $2, 'limited')
       RETURNING id`,
      [orgA, `privy:${randomUUID()}`],
    );
    const session = sessionOf(orgA, agent.id);
    const scope = await scopeFor(one, '/', session);
    // Stay inside one UTC minute window: the limiter counts per fixed minute.
    const msIntoMinute = Date.now() % 60_000;
    if (msIntoMinute > 50_000) await new Promise((done) => setTimeout(done, 61_000 - msIntoMinute));
    for (let n = 0; n < MCP_RATE_LIMITS.searchesPerMinute; n += 1) {
      await (n % 2 === 0 ? one : two).discovery.search(session, scope, { query: 'weather' });
    }
    const refusal = await two.discovery
      .search(session, scope, { query: 'weather' })
      .catch((error: { errorCode: string; context: { retryAfterMs: number } }) => error);
    expect(refusal).toMatchObject({ errorCode: ToolAccessErrorCode.RATE_LIMITED });
    expect((refusal as { context: { retryAfterMs: number } }).context.retryAfterMs).toBeGreaterThan(
      0,
    );
    // get_tool has its own budget.
    await expect(
      one.discovery.getTool(session, scope, { name: WEATHER.name }),
    ).resolves.toMatchObject({ name: WEATHER.name });
  }, 120_000);
});
