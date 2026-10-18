import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import Redis from 'ioredis';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { ToolRepository } from '@database/postgres/repositories/tool.repository';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { McpErrorCode } from '@modules/mcp/errors/mcp.errors';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { NotificationEvent } from '@modules/notification/ports/notification.port';
import { ToolTier } from '@modules/tool/ports/tool.types';
import { InMemoryToolCatalogue } from '@modules/tool/services/in-memory-tool-catalogue';
import { AccessMode, accessAllows } from '@modules/toolset/domain/access';
import { parseMcpUrl } from '@modules/toolset/domain/mcp-url';
import { SHARING_GRACE_MS, ToolsetVisibility } from '@modules/toolset/domain/sharing';
import { ToolsetErrorCode } from '@modules/toolset/errors/toolset.errors';
import {
  CUTOFF_CONFIRM_WINDOW_MS,
  CutoffAction,
  CutoffRevertReason,
} from '@modules/toolset/services/toolset-moderation.service';
import { mondayOf } from '@modules/toolset/services/toolset-stats.service';

import { seedOfficialToolsets } from '../../../scripts/demo/lib/official-toolsets';
import { ensureTestDatabase, testConnectionOptions } from '../helpers/test-database';
import { toolsetTestContext } from '../helpers/toolset-test-context';

const DATABASE = 'x402_toolset_publishing_test';
const HOST = { mcpPublicUrl: 'https://mcp.example.com', webAppUrl: 'https://app.example.com' };
const CHAIN = CHAIN_IDS.SOLANA_DEVNET;
const ACTOR = { type: 'user' as const, id: 'login-integration' };
const OPERATOR_1 = randomUUID();
const OPERATOR_2 = randomUUID();

const redisOptions = () => ({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: 1,
});

const WEATHER = { id: randomUUID(), name: 'get_weather', category: 'weather' };
const GEOCODE = { id: randomUUID(), name: 'geocode_place', category: 'maps' };
const MARKET = { id: randomUUID(), name: 'get_token_market', category: 'crypto' };
const TOOLS = [WEATHER, GEOCODE, MARKET].map((tool) => ({
  ...tool,
  tags: [],
  description: `${tool.name}.`,
  inputSchema: { type: 'object' as const },
  outputSchema: { type: 'object' as const },
  verificationPolicyId: 'policy-default',
  tier: ToolTier.VERIFIED,
}));

/**
 * Publishing toolsets, end to end against a database built from every
 * migration and a real Redis (design spec T2, the publishing half): handles
 * and the claim gate, the Share dialog and versions, the shared MCP paths,
 * pinned access across organizations, copies, update notices, deletes with
 * grace, reports, moderation cutoffs, the weekly stats and the public API.
 */
describe('toolset publishing, against a real database and Redis', () => {
  let dataSource: DataSource;
  const redises: Redis[] = [];
  let now = new Date();
  const clock = () => now;
  let orgA: string; // the publisher, "acme"
  let orgB: string; // a viewer
  let orgC: string; // never verified
  let agentA: string;
  let agentB: string;
  let providerTool: string; // orgA's UNLISTED provider tool

  function services() {
    const redis = new Redis(redisOptions());
    redises.push(redis);
    return toolsetTestContext({
      dataSource,
      redis,
      host: HOST,
      catalogue: new InMemoryToolCatalogue({ tools: TOOLS, bindings: [] }),
      chainId: CHAIN,
      clock,
    });
  }

  const session = (organizationId: string, agentId: string): McpSession => ({
    credentialId: 'login',
    organizationId,
    agentId,
    agentAccount: `${CHAIN}:Wallet${agentId.slice(0, 8)}` as never,
    chainId: CHAIN,
    label: null,
    callerKind: McpCallerKind.HUMAN,
  });

  const errorOf = (work: Promise<unknown>) =>
    work.then(
      () => null,
      (error: { errorCode?: string; statusCode?: number; context?: Record<string, unknown> }) => ({
        code: error.errorCode,
        status: error.statusCode,
        context: error.context,
      }),
    );

  async function org(name: string): Promise<string> {
    const [row] = await dataSource.query(
      `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
      [name],
    );
    return row.id;
  }

  async function agent(organizationId: string, account?: string): Promise<string> {
    const [row] = await dataSource.query(
      `INSERT INTO agents (organization_id, privy_user_id, label, primary_account_id, chain_id)
       VALUES ($1, $2, 'bot', $3, $4) RETURNING id`,
      [organizationId, `privy:${randomUUID()}`, account ?? null, account ? CHAIN : null],
    );
    return row.id;
  }

  /** Funded once: an opened escrow is enough for the claim gate. */
  async function verify(organizationId: string): Promise<void> {
    await dataSource.query(
      `INSERT INTO buyer_escrows (organization_id, account_id, asset_id, escrow_account_id,
                                  escrow_asset_account_id, opened_at)
       VALUES ($1, $2, 'asset', $3, $4, now())`,
      [organizationId, `${CHAIN}:Fund${organizationId.slice(0, 8)}`, randomUUID(), randomUUID()],
    );
  }

  const toldBefore = new Map<string, number>();
  /**
   * Update notices for `toolsetId` sent since the last call: publishing sends
   * them after it commits, so wait for them to settle. The 7-day log is
   * cleared, so each publish is judged on visibility alone.
   */
  async function toldSince(s: ReturnType<typeof services>, toolsetId: string): Promise<number> {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const total = s.sent.filter((notice) => notice.subjectId === toolsetId).length;
    const fresh = total - (toldBefore.get(toolsetId) ?? 0);
    toldBefore.set(toolsetId, total);
    await dataSource.query(`DELETE FROM toolset_notice_log WHERE toolset_id = $1`, [toolsetId]);
    return fresh;
  }

  /** An agent of `organizationId` that funded from `account` (a settled deposit). */
  async function fund(organizationId: string, account: string): Promise<string> {
    const agentId = await agent(organizationId);
    await dataSource.query(
      `INSERT INTO deposit_intents (organization_id, status, agent_id, agent_account, asset_id,
                                    decimals, requested_amount, chain_id, expires_at,
                                    settled_amount, chain_tx_ref)
       VALUES ($1, 'SETTLED', $2, $3, 'asset', 6, 1000, $4, now(), 1000, $5)`,
      [organizationId, agentId, account, CHAIN, randomUUID()],
    );
    return agentId;
  }

  /** A served free call through a toolset version, as `ToolCallRecordWriter` writes it. */
  async function freeCall(
    organizationId: string,
    agentId: string,
    toolsetId: string,
    version: number,
    toolId = WEATHER.id,
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO tool_call_records (organization_id, agent_id, call_id, tool_id, pricing_mode,
                                      classification, latency_ms, expires_at, endpoint_kind,
                                      toolset_id, toolset_version)
       VALUES ($1, $2, $3, $4, 'FREE', 'DATA_RESULT', 10, now() + interval '30 days', 'TOOLSET',
               $5, $6)`,
      [organizationId, agentId, randomUUID(), toolId, toolsetId, version],
    );
  }

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

    await new ToolRepository(dataSource).upsertSeeded(
      TOOLS.map((tool) => ({ id: tool.id, name: tool.name, category: tool.category, tags: [] })),
    );
    orgA = await org('Publisher');
    orgB = await org('Viewer');
    orgC = await org('Newcomer');
    agentA = await agent(orgA, `${CHAIN}:WalletA`);
    agentB = await agent(orgB, `${CHAIN}:WalletB`);
    await verify(orgA);
    await verify(orgB);

    providerTool = randomUUID();
    await dataSource.query(
      `INSERT INTO tools (id, name, kind, owner_org_id, category, visibility, status, review_status)
       VALUES ($1, 'acme__search_posts', 'PROVIDER', $2, 'social', 'UNLISTED', 'ACTIVE', 'NONE')`,
      [providerTool, orgA],
    );
  }, 300_000);

  afterAll(async () => {
    await Promise.all(redises.map((redis) => redis.quit()));
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  describe('handles', () => {
    it('refuses an unverified organization, a reserved word and a bad format', async () => {
      const s = services();
      expect(
        await errorOf(s.handles.claim(session(orgC, randomUUID()), 'newco', ACTOR)),
      ).toMatchObject({
        code: ToolsetErrorCode.TOOLSET_HANDLE_CLAIM_REFUSED,
        status: 403,
        context: { reason: 'NOT_VERIFIED' },
      });
      expect(await errorOf(s.handles.claim(session(orgA, agentA), 'weather', ACTOR))).toMatchObject(
        {
          code: ToolsetErrorCode.TOOLSET_HANDLE_INVALID,
          context: { reason: 'RESERVED' },
        },
      );
      // A category the catalogue uses is reserved too.
      expect(await errorOf(s.handles.claim(session(orgA, agentA), 'social', ACTOR))).toMatchObject({
        code: ToolsetErrorCode.TOOLSET_HANDLE_INVALID,
      });
      expect(await errorOf(s.handles.claim(session(orgA, agentA), 'a_b', ACTOR))).toMatchObject({
        code: ToolsetErrorCode.TOOLSET_HANDLE_INVALID,
        context: { reason: 'FORMAT' },
      });
    });

    it('claims, is unique ignoring case, and may change freely before the lock', async () => {
      const s = services();
      await expect(
        s.handles.claim(session(orgA, agentA), 'acme-old', ACTOR),
      ).resolves.toMatchObject({
        handle: 'acme-old',
        canChange: true,
      });
      await expect(s.handles.claim(session(orgA, agentA), '@Acme', ACTOR)).resolves.toMatchObject({
        handle: 'acme',
      });
      // The old one was never public, so it is free again.
      expect(await errorOf(s.handles.claim(session(orgB, agentB), 'ACME', ACTOR))).toMatchObject({
        code: ToolsetErrorCode.TOOLSET_HANDLE_TAKEN,
        status: 409,
        context: { suggestions: ['acme-2', 'acme-3', 'acme-4'] },
      });
      await expect(s.handles.claim(session(orgB, agentB), 'viewer', ACTOR)).resolves.toMatchObject({
        handle: 'viewer',
      });
    });

    it('lets one Privy user claim for at most three organizations in 30 days', async () => {
      const s = services();
      const [{ privy_user_id: user }] = await dataSource.query(
        `SELECT privy_user_id FROM agents WHERE id = $1`,
        [agentB],
      );
      for (const other of [randomUUID(), randomUUID()]) {
        await dataSource.query(
          `INSERT INTO org_handle_claims (org_id, privy_user_id, handle) VALUES ($1, $2, 'x')`,
          [other, user],
        );
      }
      // orgB is already one of the three: changing its own handle is fine.
      await expect(
        s.handles.claim(session(orgB, agentB), 'viewer-co', ACTOR),
      ).resolves.toBeTruthy();
      const orgD = await org('Fourth');
      await verify(orgD);
      expect(await errorOf(s.handles.claim(session(orgD, agentB), 'fourth', ACTOR))).toMatchObject({
        code: ToolsetErrorCode.TOOLSET_HANDLE_CLAIM_REFUSED,
        context: { reason: 'CLAIM_LIMIT' },
      });
    });
  });

  describe('publishing and the shared URLs', () => {
    let kit: string;

    it('needs a handle to share, and a PUBLIC set holds only LISTED tools', async () => {
      const s = services();
      const created = await s.toolsets.create(
        orgC,
        { name: 'Nope', entries: [{ toolId: WEATHER.id }] },
        ACTOR,
      );
      expect(
        await errorOf(
          s.publishing.publish(orgC, created.id, { visibility: ToolsetVisibility.UNLISTED }, ACTOR),
        ),
      ).toMatchObject({ code: ToolsetErrorCode.TOOLSET_HANDLE_REQUIRED, status: 409 });

      const withProvider = await s.toolsets.create(orgA, { name: 'Mixed' }, ACTOR);
      await dataSource.query(
        `INSERT INTO toolset_entries (toolset_id, position, tool_id) VALUES ($1, 0, $2)`,
        [withProvider.id, providerTool],
      );
      expect(
        await errorOf(
          s.publishing.publish(
            orgA,
            withProvider.id,
            { visibility: ToolsetVisibility.PUBLIC },
            ACTOR,
          ),
        ),
      ).toMatchObject({
        code: ToolsetErrorCode.TOOLSET_NOT_PUBLISHABLE,
        context: { toolIds: [providerTool] },
      });
    });

    it('publishes v1 PUBLIC, locks the handle and serves the snapshot, not the Draft', async () => {
      const s = services();
      const created = await s.toolsets.create(
        orgA,
        { name: 'Weather Kit', slug: 'kit', entries: [{ toolId: WEATHER.id }] },
        ACTOR,
      );
      kit = created.id;
      const result = await s.publishing.publish(
        orgA,
        kit,
        { visibility: ToolsetVisibility.PUBLIC },
        ACTOR,
      );
      expect(result.version).toMatchObject({ version: 1, changelog: 'First version: 1 tools.' });
      expect(result.toolset).toMatchObject({
        visibility: 'PUBLIC',
        listingStatus: 'LISTED',
        latestVersion: 1,
        handle: 'acme',
        urls: {
          public: 'https://mcp.example.com/@acme/kit',
          publicPinned: 'https://mcp.example.com/@acme/kit@1',
        },
      });
      expect(
        await errorOf(s.handles.claim(session(orgA, agentA), 'acme-new', ACTOR)),
      ).toMatchObject({ code: ToolsetErrorCode.TOOLSET_HANDLE_LOCKED });
      // The slug is fixed from the first share.
      expect(await errorOf(s.toolsets.update(orgA, kit, { slug: 'kit-2' }, ACTOR))).toMatchObject({
        code: ToolsetErrorCode.TOOLSET_SLUG_LOCKED,
      });

      await s.toolsets.replaceEntries(
        orgA,
        kit,
        [{ toolId: WEATHER.id }, { toolId: GEOCODE.id }],
        ACTOR,
      );
      const view = await s.endpoints.resolve(orgB, parseMcpUrl('/@acme/kit')!);
      expect(view.baseToolIds).toEqual([WEATHER.id]);
      expect(view.toolset).toMatchObject({ id: kit, version: 1, latest: true });
      // The owner's /my/ still serves the live Draft.
      expect((await s.endpoints.resolve(orgA, parseMcpUrl('/my/kit')!)).baseToolIds).toEqual([
        WEATHER.id,
        GEOCODE.id,
      ]);
    });

    it('v2 moves the latest URL, keeps @1, and notifies callers of v1 once per 7 days', async () => {
      const s = services();
      await freeCall(orgB, agentB, kit, 1);
      const result = await s.publishing.publish(
        orgA,
        kit,
        { visibility: ToolsetVisibility.PUBLIC },
        ACTOR,
      );
      expect(result.diff).toMatchObject({ added: ['geocode_place'], removed: [] });
      expect(result.version?.changelog).toBe('Added geocode_place.');
      expect((await s.endpoints.resolve(orgB, parseMcpUrl('/@acme/kit')!)).toolset?.version).toBe(
        2,
      );
      expect((await s.endpoints.resolve(orgB, parseMcpUrl('/@acme/kit@1')!)).baseToolIds).toEqual([
        WEATHER.id,
      ]);
      expect(await errorOf(s.endpoints.resolve(orgB, parseMcpUrl('/@acme/kit@3')!))).toMatchObject({
        code: McpErrorCode.MCP_URL_NOT_FOUND,
      });

      // Publishing sends the notices after it commits; wait for them.
      for (let n = 0; n < 50 && s.sent.length === 0; n += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(s.sent).toHaveLength(1);
      // Sending again for the same version reaches nobody.
      expect(await s.notices.onPublished(kit, 2)).toBe(0);
      expect(s.sent[0]).toMatchObject({
        organizationId: orgB,
        event: NotificationEvent.TOOLSET_UPDATE_AVAILABLE,
        title: '@acme/kit v2 is available',
        payload: { fromVersion: 1, toVersion: 2, mcpUrl: 'https://mcp.example.com/@acme/kit@2' },
      });
      // Never the publisher's own organization; never twice within 7 days.
      await freeCall(orgA, agentA, kit, 1);
      await s.publishing.publish(orgA, kit, { visibility: ToolsetVisibility.PUBLIC }, ACTOR);
      expect(await s.notices.onPublished(kit, 3)).toBe(0);
    });

    it('caps publishing at 10 versions per toolset per UTC day', async () => {
      const s = services();
      const created = await s.toolsets.create(
        orgA,
        { name: 'Busy', entries: [{ toolId: WEATHER.id }] },
        ACTOR,
      );
      for (let n = 0; n < 10; n += 1) {
        await s.publishing.publish(
          orgA,
          created.id,
          { visibility: ToolsetVisibility.PRIVATE },
          ACTOR,
        );
      }
      expect(
        await errorOf(
          s.publishing.publish(orgA, created.id, { visibility: ToolsetVisibility.PRIVATE }, ACTOR),
        ),
      ).toMatchObject({ code: ToolsetErrorCode.TOOLSET_LIMIT_EXCEEDED, status: 429 });
      // Private versions serve on /my/{slug}@n only.
      expect(
        (await s.endpoints.resolve(orgA, parseMcpUrl(`/my/${created.slug}@10`)!)).toolset?.version,
      ).toBe(10);
      expect(
        await errorOf(s.endpoints.resolve(orgB, parseMcpUrl(`/my/${created.slug}@1`)!)),
      ).toMatchObject({
        code: McpErrorCode.MCP_URL_NOT_FOUND,
      });
    });

    it('pins another org’s toolset at a version: a new version never widens access', async () => {
      const s = services();
      expect(
        await errorOf(
          s.access.patch(
            orgB,
            agentB,
            {
              accessMode: AccessMode.RESTRICTED,
              allowedToolsets: [{ toolsetId: kit, version: null }],
            },
            ACTOR,
          ),
        ),
      ).toMatchObject({ code: ToolsetErrorCode.TOOLSET_ACCESS_INVALID });
      const patched = await s.access.patch(
        orgB,
        agentB,
        {
          accessMode: AccessMode.RESTRICTED,
          allowedToolsets: [{ toolsetId: kit, version: 1, viaUrlOnly: false }],
        },
        ACTOR,
      );
      expect(patched.allowedToolsets[0]).toMatchObject({
        toolsetId: kit,
        version: 1,
        own: false,
        handle: 'acme',
        status: 'ACTIVE',
        latestVersion: 3,
      });
      const access = await s.resolver.resolveFor(orgB, agentB, null);
      expect(accessAllows(access, WEATHER.id, null)).toBe(true);
      expect(accessAllows(access, GEOCODE.id, null)).toBe(false);
    });

    it('a delete keeps shared URLs and pinned access for 90 days when others use it, and holds the slug', async () => {
      const s = services();
      await s.toolsets.delete(orgA, kit, ACTOR);
      const view = await s.endpoints.resolve(orgB, parseMcpUrl('/@acme/kit@1')!);
      expect(view.notice?.sharingEndsAt?.getTime()).toBeGreaterThan(now.getTime());
      const access = await s.resolver.resolveFor(orgB, agentB, null);
      expect(accessAllows(access, WEATHER.id, null)).toBe(true);
      expect((await s.access.get(orgB, agentB)).allowedToolsets[0]).toMatchObject({
        deleted: true,
        status: 'DELETED',
      });
      expect(
        await errorOf(s.toolsets.create(orgA, { name: 'Kit again', slug: 'kit' }, ACTOR)),
      ).toMatchObject({ code: ToolsetErrorCode.TOOLSET_SLUG_TAKEN });
    });
  });

  describe('link-only toolsets', () => {
    let linkSet: string;
    let token: string;

    it('serves /u/{token} only, and never by slug', async () => {
      const s = services();
      const created = await s.toolsets.create(
        orgA,
        { name: 'Link Set', slug: 'link-set', entries: [{ toolId: GEOCODE.id }] },
        ACTOR,
      );
      linkSet = created.id;
      await dataSource.query(
        `INSERT INTO toolset_entries (toolset_id, position, tool_id) VALUES ($1, 1, $2)`,
        [linkSet, providerTool],
      );
      const result = await s.publishing.publish(
        orgA,
        linkSet,
        { visibility: ToolsetVisibility.UNLISTED },
        ACTOR,
      );
      token = result.toolset.unlistedToken as string;
      expect(token).toMatch(/^[a-z2-7]{26}$/);
      expect(result.toolset.urls.unlistedPinned).toBe(`https://mcp.example.com/u/${token}@1`);
      expect(
        await errorOf(s.endpoints.resolve(orgB, parseMcpUrl('/@acme/link-set')!)),
      ).toMatchObject({ code: McpErrorCode.MCP_URL_NOT_FOUND });
      expect((await s.endpoints.resolve(orgB, parseMcpUrl(`/u/${token}`)!)).baseToolIds).toEqual([
        GEOCODE.id,
        providerTool,
      ]);
    });

    it('allows pinning, copying and reporting it only with the token', async () => {
      const s = services();
      expect(
        await errorOf(
          s.access.patch(
            orgB,
            agentB,
            { allowedToolsets: [{ toolsetId: linkSet, version: 1 }] },
            ACTOR,
          ),
        ),
      ).toMatchObject({
        code: ToolsetErrorCode.TOOLSET_ACCESS_INVALID,
        context: { toolsetIds: [linkSet] },
      });
      await s.access.patch(
        orgB,
        agentB,
        { allowedToolsets: [{ toolsetId: linkSet, version: 1, unlistedToken: token }] },
        ACTOR,
      );
      expect(await errorOf(s.publishing.copy(orgB, linkSet, {}, ACTOR))).toMatchObject({
        code: ToolsetErrorCode.TOOLSET_NOT_FOUND,
      });
      const copy = await s.publishing.copy(orgB, linkSet, { unlistedToken: token }, ACTOR);
      expect(copy.toolset).toMatchObject({
        visibility: 'PRIVATE',
        forkedFrom: { toolsetId: linkSet, version: 1 },
        toolCount: 1,
      });
      // Another org's link-only provider tool is not copied.
      expect(copy.excluded).toEqual([
        { toolId: providerTool, toolName: 'acme__search_posts', reason: 'LINK_ONLY' },
      ]);
      expect(
        await errorOf(s.reports.create(orgB, { toolsetId: linkSet, reason: 'spam spam' })),
      ).toMatchObject({
        code: ToolsetErrorCode.TOOLSET_REPORT_TARGET_NOT_FOUND,
      });
      await expect(
        s.reports.create(orgB, { toolsetId: linkSet, unlistedToken: token, reason: 'spam spam' }),
      ).resolves.toHaveProperty('id');
      expect(
        await errorOf(
          s.reports.create(orgB, { toolsetId: linkSet, unlistedToken: token, reason: 'again' }),
        ),
      ).toMatchObject({ code: ToolsetErrorCode.TOOLSET_REPORT_DUPLICATE });
    });

    it('rotating the link kills the old one at once; a pin already held stays', async () => {
      const s = services();
      const rotated = await s.publishing.rotateToken(orgA, linkSet, ACTOR);
      const fresh = rotated.toolset.unlistedToken as string;
      expect(fresh).not.toBe(token);
      expect(await errorOf(s.endpoints.resolve(orgB, parseMcpUrl(`/u/${token}`)!))).toMatchObject({
        code: McpErrorCode.MCP_URL_NOT_FOUND,
      });
      expect((await s.endpoints.resolve(orgB, parseMcpUrl(`/u/${fresh}`)!)).toolset?.id).toBe(
        linkSet,
      );
      // Editing another field re-sends the held pin without the token: kept.
      await s.access.patch(
        orgB,
        agentB,
        { allowedToolsets: [{ toolsetId: linkSet, version: 1 }], pinnedTools: [] },
        ACTOR,
      );
      token = fresh;
    });

    it('stop sharing keeps the link for 90 days, then clears it', async () => {
      const s = services();
      await s.publishing.unpublish(orgA, linkSet, ACTOR);
      const view = await s.endpoints.resolve(orgB, parseMcpUrl(`/u/${token}`)!);
      expect(view.notice?.sharingEndsAt).toBeTruthy();
      const saved = now;
      now = new Date(now.getTime() + SHARING_GRACE_MS + 1000);
      try {
        expect(await s.moderation.expireGrace()).toBeGreaterThanOrEqual(1);
        const [row] = await dataSource.query(`SELECT unlisted_token FROM toolsets WHERE id = $1`, [
          linkSet,
        ]);
        expect(row.unlisted_token).toBeNull();
        expect(await errorOf(s.endpoints.resolve(orgB, parseMcpUrl(`/u/${token}`)!))).toMatchObject(
          { code: McpErrorCode.MCP_URL_NOT_FOUND },
        );
      } finally {
        now = saved;
      }
    });
  });

  describe('moderation', () => {
    let target: string;

    beforeAll(async () => {
      const s = services();
      const created = await s.toolsets.create(
        orgA,
        { name: 'Moderated', slug: 'moderated', entries: [{ toolId: MARKET.id }] },
        ACTOR,
      );
      target = created.id;
      await s.publishing.publish(orgA, target, { visibility: ToolsetVisibility.PUBLIC }, ACTOR);
    });

    it('a takedown stops every shared URL at once; /my/ keeps serving; it reverts unless confirmed', async () => {
      const s = services();
      const { cutoff } = await dataSource.transaction((manager) =>
        s.moderation.cutoffToolset(manager, {
          toolsetId: target,
          action: CutoffAction.TAKEDOWN,
          operatorId: OPERATOR_1,
          note: 'impersonation of a brand',
        }),
      );
      await s.moderation.afterCommit([orgA]);
      expect(
        await errorOf(s.endpoints.resolve(orgB, parseMcpUrl('/@acme/moderated')!)),
      ).toMatchObject({ code: McpErrorCode.MCP_URL_NOT_FOUND });
      expect(
        (await s.endpoints.resolve(orgA, parseMcpUrl('/my/moderated@1')!)).toolset?.version,
      ).toBe(1);
      expect(
        await errorOf(
          dataSource.transaction((manager) => s.moderation.confirm(manager, cutoff.id, OPERATOR_1)),
        ),
      ).toMatchObject({ code: ToolsetErrorCode.TOOLSET_CUTOFF_SELF_CONFIRM });

      const saved = now;
      now = new Date(now.getTime() + CUTOFF_CONFIRM_WINDOW_MS + 1000);
      try {
        expect(await s.moderation.revertExpired()).toBe(1);
      } finally {
        now = saved;
      }
      expect((await s.endpoints.resolve(orgB, parseMcpUrl('/@acme/moderated')!)).toolset?.id).toBe(
        target,
      );
    });

    it('a delist leaves the catalogue at once but serves until grace; a confirmed one stands', async () => {
      const s = services();
      const { cutoff } = await dataSource.transaction((manager) =>
        s.moderation.cutoffToolset(manager, {
          toolsetId: target,
          action: CutoffAction.DELIST,
          operatorId: OPERATOR_1,
          note: 'misleading description',
        }),
      );
      await s.moderation.afterCommit([orgA]);
      await dataSource.transaction((manager) =>
        s.moderation.confirm(manager, cutoff.id, OPERATOR_2),
      );
      const view = await s.endpoints.resolve(orgB, parseMcpUrl('/@acme/moderated')!);
      expect(view.notice?.sharingEndsAt).toBeTruthy();
      await s.publicToolsets.list({});
      const list = await s.publicToolsets.list({});
      expect(list.toolsets.map((t) => t.slug)).not.toContain('moderated');
      // The owner cannot relist by stopping and sharing again.
      await s.publishing.unpublish(orgA, target, ACTOR);
      const again = await s.publishing.publish(
        orgA,
        target,
        { visibility: ToolsetVisibility.PUBLIC },
        ACTOR,
      );
      expect(again.toolset).toMatchObject({ listingStatus: 'DELISTED', delisted: true });
      // A confirmed delist is lifted only explicitly.
      await dataSource.transaction((manager) =>
        s.moderation.revert(manager, cutoff.id, OPERATOR_2, CutoffRevertReason.LIFTED),
      );
      await s.moderation.afterCommit([orgA]);
      expect((await s.publicToolsets.list({})).toolsets.map((t) => t.slug)).toContain('moderated');
    });

    it('a handle takedown stops every URL under it with no alias; a reassignment moves it', async () => {
      const s = services();
      const orgE = await org('Brand owner');
      await verify(orgE);
      const { cutoff } = await dataSource.transaction((manager) =>
        s.moderation.cutoffHandle(manager, {
          handle: 'acme',
          operatorId: OPERATOR_1,
          note: 'impersonates a brand',
        }),
      );
      await s.moderation.afterCommit([orgA]);
      expect(
        await errorOf(s.endpoints.resolve(orgB, parseMcpUrl('/@acme/moderated')!)),
      ).toMatchObject({ code: McpErrorCode.MCP_URL_NOT_FOUND });
      expect(await errorOf(s.publicToolsets.profile('acme'))).toMatchObject({
        code: ToolsetErrorCode.TOOLSET_HANDLE_NOT_FOUND,
      });

      // Not before a second operator confirmed the takedown.
      expect(
        await errorOf(
          dataSource.transaction((manager) => s.moderation.reassignHandle(manager, 'acme', orgE)),
        ),
      ).toMatchObject({ code: ToolsetErrorCode.TOOLSET_HANDLE_REASSIGN_REFUSED });
      await dataSource.transaction((manager) =>
        s.moderation.confirm(manager, cutoff.id, OPERATOR_2),
      );
      await dataSource.transaction((manager) => s.moderation.reassignHandle(manager, 'acme', orgE));
      await s.moderation.afterCommit([orgA, orgE]);
      const [closed] = await dataSource.query(
        `SELECT revert_reason FROM moderation_cutoffs WHERE id = $1`,
        [cutoff.id],
      );
      expect(closed.revert_reason).toBe('REASSIGNED');
      expect(await s.handles.get(orgE)).toMatchObject({ handle: 'acme', status: 'ACTIVE' });
      expect(await s.handles.get(orgA)).toMatchObject({ handle: null });
      // The brand's handle names none of the old owner's toolsets.
      expect(
        await errorOf(s.endpoints.resolve(orgB, parseMcpUrl('/@acme/moderated')!)),
      ).toMatchObject({ code: McpErrorCode.MCP_URL_NOT_FOUND });
      // The new holder can be taken down in turn.
      await expect(
        dataSource.transaction((manager) =>
          s.moderation.cutoffHandle(manager, {
            handle: 'acme',
            operatorId: OPERATOR_2,
            note: 'second takedown of the name',
          }),
        ),
      ).resolves.toHaveProperty('organizationId', orgE);
    });

    it('an operator rename keeps the old handle as an alias for 90 days, then holds it', async () => {
      const s = services();
      const orgF = await org('Renamer');
      await verify(orgF);
      const agentF = await agent(orgF);
      await s.handles.claim(session(orgF, agentF), 'renamer', ACTOR);
      const created = await s.toolsets.create(
        orgF,
        { name: 'Thing', slug: 'thing', entries: [{ toolId: WEATHER.id }] },
        ACTOR,
      );
      await s.publishing.publish(orgF, created.id, { visibility: ToolsetVisibility.PUBLIC }, ACTOR);
      await dataSource.transaction((manager) =>
        s.moderation.renameHandle(manager, 'renamer', 'renamed-co'),
      );
      await s.moderation.afterCommit([orgF]);
      const view = await s.endpoints.resolve(orgB, parseMcpUrl('/@renamer/thing')!);
      expect(view.notice?.renamedTo).toBe('renamed-co');
      expect(
        (await s.endpoints.resolve(orgB, parseMcpUrl('/@renamed-co/thing')!)).toolset?.id,
      ).toBe(created.id);
      // Held: nobody can claim the old name.
      expect(await errorOf(s.handles.claim(session(orgB, agentB), 'renamer', ACTOR))).toMatchObject(
        {
          code: ToolsetErrorCode.TOOLSET_HANDLE_TAKEN,
        },
      );
    });
  });

  describe('weekly stats and the public catalogue', () => {
    let popular: string;

    it('publishes k-checked figures, excluding the publisher and linked orgs', async () => {
      const s = services();
      const orgP = await org('Stats publisher');
      await verify(orgP);
      const agentP = await agent(orgP, `${CHAIN}:SharedWallet`);
      await s.handles.claim(session(orgP, agentP), 'statsco', ACTOR);
      const created = await s.toolsets.create(
        orgP,
        { name: 'Popular', slug: 'popular', entries: [{ toolId: WEATHER.id }] },
        ACTOR,
      );
      popular = created.id;
      await s.publishing.publish(orgP, popular, { visibility: ToolsetVisibility.PUBLIC }, ACTOR);

      // The publisher, and an org sharing its wallet: excluded.
      await freeCall(orgP, agentP, popular, 1);
      const linked = await org('Linked');
      await freeCall(linked, await fund(linked, `${CHAIN}:SharedWallet`), popular, 1);
      // Three independent orgs and two sybils sharing a funding wallet: five
      // accounts, four parties — below k on the page and on every dashboard cell.
      for (let n = 0; n < 3; n += 1) {
        const buyer = await org(`Buyer ${n}`);
        await freeCall(buyer, await agent(buyer, `${CHAIN}:Buyer${n}`), popular, 1);
      }
      const sybil1 = await org('Sybil 1');
      const sybil2 = await org('Sybil 2');
      await freeCall(sybil1, await fund(sybil1, `${CHAIN}:SybilWallet`), popular, 1);
      await freeCall(sybil2, await fund(sybil2, `${CHAIN}:SybilWallet`), popular, 1);
      const week = mondayOf(new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000));
      const windowEnd = new Date(week.getTime() - 24 * 60 * 60 * 1000);
      const toolset = { id: popular, ownerOrgId: orgP, lastSharedVersion: 1 };
      await s.stats.publishWeek(toolset, week, windowEnd);
      let stats = await s.publishing.ownStats(orgP, popular);
      expect(stats.figures).toMatchObject({
        activeUsers: { value: null, display: 'Fewer than 5' },
        agents: null,
        calls30d: null,
      });
      const dashboard = stats.dashboard as {
        tools: { withheld: boolean }[];
        versions: { orgs: { display: string } }[];
      };
      expect(dashboard.tools[0].withheld).toBe(true);
      expect(dashboard.versions[0].orgs.display).toBe('Fewer than 5 orgs');
      const [score] = await dataSource.query(
        `SELECT popular_score FROM toolset_stats_published WHERE toolset_id = $1`,
        [popular],
      );
      expect(score.popular_score).toBe(0);

      // A fourth independent org: five parties.
      const fourth = await org('Buyer 3');
      await freeCall(fourth, await agent(fourth, `${CHAIN}:Buyer3`), popular, 1);
      await s.stats.publishWeek(toolset, week, windowEnd);
      stats = await s.publishing.ownStats(orgP, popular);
      expect(stats.figures).toMatchObject({
        activeUsers: { value: 5, display: '5' },
        agents: { value: 5 },
        calls30d: { display: '0' },
        onLatestVersionPercent: null,
      });
      expect((stats.dashboard as { tools: { withheld: boolean }[] }).tools[0].withheld).toBe(false);
      // Another organization never reads a publisher dashboard.
      expect(await errorOf(s.publishing.ownStats(orgB, popular))).toMatchObject({
        code: ToolsetErrorCode.TOOLSET_NOT_FOUND,
      });
    });

    it('lists only PUBLIC, LISTED toolsets, from the snapshot, with the seeded Official sets', async () => {
      const s = services();
      await dataSource.query(
        `INSERT INTO tools (id, name, kind, category, visibility, status)
         VALUES ($1, 'extract_page_text', 'STANDARD', 'web', 'LISTED', 'ACTIVE')`,
        [randomUUID()],
      );
      expect(await seedOfficialToolsets(dataSource)).toBe(3);
      expect(await seedOfficialToolsets(dataSource)).toBe(0);
      // A Draft rename is not published.
      await s.toolsets.update(
        (await dataSource.query(`SELECT owner_org_id FROM toolsets WHERE id = $1`, [popular]))[0]
          .owner_org_id,
        popular,
        { name: 'Secret new name' },
        ACTOR,
      );
      const list = await services().publicToolsets.list({});
      const slugs = list.toolsets.map((card) => `${card.handle}/${card.slug}`);
      expect(slugs).toEqual(
        expect.arrayContaining([
          'assay/weather-and-places',
          'assay/crypto-research',
          'statsco/popular',
        ]),
      );
      expect(slugs).not.toContain('acme/link-set');
      const card = list.toolsets.find((t) => t.slug === 'popular')!;
      expect(card.name).toBe('Popular');
      expect(card.mcpUrls.recommended).toBe('https://mcp.example.com/@statsco/popular@1');
      expect(list.toolsets.find((t) => t.slug === 'weather-and-places')).toMatchObject({
        badge: 'OFFICIAL',
        mcpUrls: { recommended: 'https://mcp.example.com/@assay/weather-and-places' },
      });
      expect((await s.publicToolsets.list({ publisher: 'official' })).toolsets).toHaveLength(3);
      const page = await s.publicToolsets.page('statsco', 'popular');
      expect(page.stats.activeUsers).toEqual({ value: 5, display: '5' });
      expect(Object.keys(page).sort()).toEqual(
        [
          'activeUsers',
          'badge',
          'category',
          'changelog',
          'description',
          'diff',
          'entries',
          'forkedFrom',
          'handle',
          'icon',
          'id',
          'mcpUrls',
          'name',
          'notReviewed',
          'publishedAt',
          'routesToPublisher',
          'sharingEndsAt',
          'slug',
          'stats',
          'tags',
          'toolCount',
          'toolIds',
          'version',
        ].sort(),
      );
      expect(await errorOf(s.publicToolsets.page('statsco', 'nope'))).toMatchObject({
        status: 404,
      });
      expect((await s.publicToolsets.categories()).categories.map((c) => c.category)).toContain(
        'weather',
      );
      // Official sets serve on the MCP host, and may be followed at their latest.
      const [official] = await dataSource.query(
        `SELECT id FROM toolsets WHERE owner_org_id IS NULL AND slug = 'weather-and-places'`,
      );
      expect(
        (await s.endpoints.resolve(orgB, parseMcpUrl('/@assay/weather-and-places')!)).toolset?.id,
      ).toBe(official.id);
      await s.access.patch(
        orgB,
        agentB,
        { allowedToolsets: [{ toolsetId: official.id, version: null, viaUrlOnly: false }] },
        ACTOR,
      );
      expect(accessAllows(await s.resolver.resolveFor(orgB, agentB, null), GEOCODE.id, null)).toBe(
        true,
      );
    });
  });

  describe('versions that were never shared', () => {
    let owner: string;
    let ownerAgent: string;
    let viewer: string;
    let viewerAgent: string;

    beforeAll(async () => {
      const s = services();
      owner = await org('Versions owner');
      await verify(owner);
      ownerAgent = await agent(owner);
      await s.handles.claim(session(owner, ownerAgent), 'versions-co', ACTOR);
      viewer = await org('Versions viewer');
      viewerAgent = await agent(viewer);
    });

    it('serves, lists, pins and copies none of the versions published PRIVATE before v3', async () => {
      const s = services();
      const created = await s.toolsets.create(
        owner,
        { name: 'Staged', slug: 'staged', entries: [{ toolId: WEATHER.id }] },
        ACTOR,
      );
      await s.publishing.publish(
        owner,
        created.id,
        { visibility: ToolsetVisibility.PRIVATE },
        ACTOR,
      );
      await s.publishing.publish(
        owner,
        created.id,
        { visibility: ToolsetVisibility.PRIVATE },
        ACTOR,
      );
      await s.publishing.publish(
        owner,
        created.id,
        { visibility: ToolsetVisibility.PUBLIC },
        ACTOR,
      );

      for (const n of [1, 2]) {
        expect(
          await errorOf(s.endpoints.resolve(viewer, parseMcpUrl(`/@versions-co/staged@${n}`)!)),
        ).toMatchObject({ code: McpErrorCode.MCP_URL_NOT_FOUND });
        expect(
          await errorOf(s.publishing.copy(viewer, created.id, { version: n }, ACTOR)),
        ).toMatchObject({ code: ToolsetErrorCode.TOOLSET_VERSION_NOT_FOUND });
        expect(
          await errorOf(
            s.access.patch(
              viewer,
              viewerAgent,
              { allowedToolsets: [{ toolsetId: created.id, version: n }] },
              ACTOR,
            ),
          ),
        ).toMatchObject({ code: ToolsetErrorCode.TOOLSET_ACCESS_INVALID });
      }
      expect(
        (await s.endpoints.resolve(viewer, parseMcpUrl('/@versions-co/staged')!)).toolset?.version,
      ).toBe(3);
      expect(
        (await s.publicToolsets.versionsOf('versions-co', 'staged')).versions.map((v) => v.version),
      ).toEqual([3]);
      // The owner keeps every version on /my/.
      expect(
        (await s.endpoints.resolve(owner, parseMcpUrl('/my/staged@1')!)).toolset?.version,
      ).toBe(1);
    });

    it('a PUBLIC grace never serves, pins or copies content published UNLISTED afterwards', async () => {
      const s = services();
      const created = await s.toolsets.create(
        owner,
        { name: 'Switched', slug: 'switched', entries: [{ toolId: WEATHER.id }] },
        ACTOR,
      );
      await s.publishing.publish(
        owner,
        created.id,
        { visibility: ToolsetVisibility.PUBLIC },
        ACTOR,
      );
      await dataSource.query(
        `INSERT INTO toolset_entries (toolset_id, position, tool_id) VALUES ($1, 1, $2)`,
        [created.id, providerTool],
      );
      // The tool's first owner lost its handle to a takedown above, which
      // removed its provider tools (T4); it serves again under this owner.
      await dataSource.query(
        `UPDATE tools SET owner_org_id = $1, status = 'ACTIVE', removed_at = NULL,
                          taken_down_at = NULL, handle_removed_at = NULL,
                          status_before_removal = NULL
          WHERE id = $2`,
        [owner, providerTool],
      );
      try {
        const v2 = await s.publishing.publish(
          owner,
          created.id,
          { visibility: ToolsetVisibility.UNLISTED },
          ACTOR,
        );
        const token = v2.toolset.unlistedToken as string;
        // `/@…` still serves v1 for the grace period, never v2.
        expect(
          (await s.endpoints.resolve(viewer, parseMcpUrl('/@versions-co/switched')!)).toolset
            ?.version,
        ).toBe(1);
        expect(
          await errorOf(s.endpoints.resolve(viewer, parseMcpUrl('/@versions-co/switched@2')!)),
        ).toMatchObject({ code: McpErrorCode.MCP_URL_NOT_FOUND });
        expect(
          await errorOf(s.publishing.copy(viewer, created.id, { version: 2 }, ACTOR)),
        ).toMatchObject({
          code: ToolsetErrorCode.TOOLSET_VERSION_NOT_FOUND,
        });
        expect((await s.publishing.copy(viewer, created.id, {}, ACTOR)).toolset.forkedFrom).toEqual(
          {
            toolsetId: created.id,
            version: 1,
          },
        );
        // With the link, v2 is there.
        expect(
          (await s.endpoints.resolve(viewer, parseMcpUrl(`/u/${token}`)!)).toolset?.version,
        ).toBe(2);
      } finally {
        await dataSource.query(`UPDATE tools SET owner_org_id = $1 WHERE id = $2`, [
          orgA,
          providerTool,
        ]);
      }
    });

    it('a handed-out URL never reveals whether a hidden toolset exists', async () => {
      const s = services();
      await s.toolsets.create(owner, { name: 'Hidden', slug: 'hidden' }, ACTOR);
      for (const url of ['/@versions-co/hidden', '/@versions-co/does-not-exist']) {
        await s.connectUrls.record(viewer, viewerAgent, {
          url: `https://mcp.example.com${url}`,
          serverName: null,
          client: null,
        });
      }
      const rows = await s.connectUrls.serversInUse(viewer, viewerAgent);
      const ids = rows
        .filter((row) => row.canonicalUrl.includes('/@versions-co/'))
        .map((row) => row.toolsetId);
      expect(ids).toEqual([null, null]);
    });

    it('a link pin is told of new link versions only while it holds the current link', async () => {
      const s = services();
      const created = await s.toolsets.create(
        owner,
        { name: 'Linked', slug: 'linked', entries: [{ toolId: WEATHER.id }] },
        ACTOR,
      );
      const v1 = await s.publishing.publish(
        owner,
        created.id,
        { visibility: ToolsetVisibility.UNLISTED },
        ACTOR,
      );
      await freeCall(viewer, viewerAgent, created.id, 1);
      // A caller with no pin is never told of a link-only version.
      await s.publishing.publish(
        owner,
        created.id,
        { visibility: ToolsetVisibility.UNLISTED },
        ACTOR,
      );
      expect(await toldSince(s, created.id)).toBe(0);

      // Pinned through the link: told of the next link version…
      await s.access.patch(
        viewer,
        viewerAgent,
        {
          allowedToolsets: [
            {
              toolsetId: created.id,
              version: 1,
              unlistedToken: v1.toolset.unlistedToken as string,
            },
          ],
        },
        ACTOR,
      );
      expect((await s.access.get(viewer, viewerAgent)).allowedToolsets[0]).toMatchObject({
        status: 'ACTIVE',
        latestVersion: 2,
      });
      await s.publishing.publish(
        owner,
        created.id,
        { visibility: ToolsetVisibility.UNLISTED },
        ACTOR,
      );
      expect(await toldSince(s, created.id)).toBe(1);

      // …until the token is rotated: that pin no longer reaches the toolset.
      const rotated = await s.publishing.rotateToken(owner, created.id, ACTOR);
      await dataSource.query(`DELETE FROM toolset_notice_log WHERE toolset_id = $1`, [created.id]);
      await s.toolsets.replaceEntries(owner, created.id, [{ toolId: GEOCODE.id }], ACTOR);
      await s.publishing.publish(
        owner,
        created.id,
        { visibility: ToolsetVisibility.UNLISTED },
        ACTOR,
      );
      expect(await toldSince(s, created.id)).toBe(0);
      expect((await s.access.get(viewer, viewerAgent)).allowedToolsets[0]).toMatchObject({
        status: 'NOT_SHARED',
        latestVersion: null,
      });

      // Pinned again with the new link: told again.
      await s.access.patch(
        viewer,
        viewerAgent,
        {
          allowedToolsets: [
            {
              toolsetId: created.id,
              version: 1,
              unlistedToken: rotated.toolset.unlistedToken as string,
            },
          ],
        },
        ACTOR,
      );
      await s.notices.onPublished(created.id, 4);
      expect(await toldSince(s, created.id)).toBe(1);
    });

    it('a pin taken through /@ learns nothing of a version published UNLISTED', async () => {
      const s = services();
      const created = await s.toolsets.create(
        owner,
        { name: 'Went private', slug: 'went-private', entries: [{ toolId: WEATHER.id }] },
        ACTOR,
      );
      await s.publishing.publish(
        owner,
        created.id,
        { visibility: ToolsetVisibility.PUBLIC },
        ACTOR,
      );
      await freeCall(viewer, viewerAgent, created.id, 1);
      await s.access.patch(
        viewer,
        viewerAgent,
        { allowedToolsets: [{ toolsetId: created.id, version: 1 }] },
        ACTOR,
      );
      await s.publishing.publish(
        owner,
        created.id,
        { visibility: ToolsetVisibility.UNLISTED },
        ACTOR,
      );
      expect(await toldSince(s, created.id)).toBe(0);
      // The "Update available" chip stays on the last PUBLIC version.
      expect(
        (await s.access.get(viewer, viewerAgent)).allowedToolsets.find(
          (ref) => ref.toolsetId === created.id,
        ),
      ).toMatchObject({ latestVersion: 1 });
      // Back to PUBLIC: told again.
      await s.publishing.publish(
        owner,
        created.id,
        { visibility: ToolsetVisibility.PUBLIC },
        ACTOR,
      );
      expect(await toldSince(s, created.id)).toBe(1);
    });

    it('a frozen handle stops copies, pins and handed-out links by id', async () => {
      const s = services();
      const frozenOrg = await org('Frozen');
      await verify(frozenOrg);
      const frozenAgent = await agent(frozenOrg);
      await s.handles.claim(session(frozenOrg, frozenAgent), 'frozen-co', ACTOR);
      const created = await s.toolsets.create(
        frozenOrg,
        { name: 'Cold', slug: 'cold', entries: [{ toolId: WEATHER.id }] },
        ACTOR,
      );
      const shared = await s.publishing.publish(
        frozenOrg,
        created.id,
        { visibility: ToolsetVisibility.UNLISTED },
        ACTOR,
      );
      const token = shared.toolset.unlistedToken as string;
      await s.publishing.publish(
        frozenOrg,
        created.id,
        { visibility: ToolsetVisibility.PUBLIC },
        ACTOR,
      );
      await dataSource.transaction((manager) =>
        s.moderation.cutoffHandle(manager, {
          handle: 'frozen-co',
          operatorId: OPERATOR_1,
          note: 'frozen for the test',
        }),
      );
      await s.moderation.afterCommit([frozenOrg]);

      expect(await errorOf(s.publishing.copy(viewer, created.id, {}, ACTOR))).toMatchObject({
        code: ToolsetErrorCode.TOOLSET_NOT_FOUND,
      });
      expect(
        await errorOf(
          s.access.patch(
            viewer,
            viewerAgent,
            { allowedToolsets: [{ toolsetId: created.id, version: 1, unlistedToken: token }] },
            ACTOR,
          ),
        ),
      ).toMatchObject({ code: ToolsetErrorCode.TOOLSET_ACCESS_INVALID });
      await s.connectUrls.record(viewer, viewerAgent, {
        url: `https://mcp.example.com/u/${token}`,
        serverName: null,
        client: null,
      });
      const row = (await s.connectUrls.serversInUse(viewer, viewerAgent)).find((r) =>
        r.canonicalUrl.endsWith(`/u/${token}`),
      );
      expect(row?.toolsetId).toBeNull();
    });

    it('refuses a handle that reads like another organization’s', async () => {
      const s = services();
      const first = await org('Look-alike 1');
      const second = await org('Look-alike 2');
      await verify(first);
      await verify(second);
      await s.handles.claim(session(first, await agent(first)), 'stripe', ACTOR);
      for (const lookAlike of ['strlpe', 'str1pe', 's-tripe']) {
        expect(
          await errorOf(s.handles.claim(session(second, await agent(second)), lookAlike, ACTOR)),
        ).toMatchObject({ code: ToolsetErrorCode.TOOLSET_HANDLE_TAKEN });
      }
    });

    it('lets concurrent claims take one name once, and keeps the gate under a race', async () => {
      const s = services();
      const first = await org('Racer 1');
      const second = await org('Racer 2');
      await verify(first);
      await verify(second);
      const outcomes = await Promise.allSettled([
        s.handles.claim(session(first, await agent(first)), 'racer', ACTOR),
        s.handles.claim(session(second, await agent(second)), 'racer', ACTOR),
      ]);
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const [{ n }] = await dataSource.query(
        `SELECT count(*)::int AS n FROM organizations WHERE handle = 'racer'`,
      );
      expect(n).toBe(1);

      // One person at two of three organizations, claiming for two more at once.
      const person = await agent(await org('Gate home'));
      const [{ privy_user_id: user }] = await dataSource.query(
        `SELECT privy_user_id FROM agents WHERE id = $1`,
        [person],
      );
      for (const other of [randomUUID(), randomUUID()]) {
        await dataSource.query(
          `INSERT INTO org_handle_claims (org_id, privy_user_id, handle) VALUES ($1, $2, 'x')`,
          [other, user],
        );
      }
      const orgsAtOnce = [await org('Gate 1'), await org('Gate 2')];
      for (const id of orgsAtOnce) await verify(id);
      const raced = await Promise.allSettled(
        orgsAtOnce.map((id, n) => s.handles.claim(session(id, person), `gate-co-${n + 2}`, ACTOR)),
      );
      expect(raced.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const [{ claims }] = await dataSource.query(
        `SELECT count(DISTINCT org_id)::int AS claims FROM org_handle_claims WHERE privy_user_id = $1`,
        [user],
      );
      expect(claims).toBe(3);
    });
  });

  describe('the public contract the catalogue pages read', () => {
    let owner: string;
    let ownerAgent: string;
    let rival: string;
    let viewer: string;
    let viewerAgent: string;
    let gapTool: string;
    let ownTool: string; // owner's UNLISTED provider tool

    async function bind(organizationId: string, toolId: string, price = 1000): Promise<void> {
      await dataSource.query(
        `INSERT INTO tool_bindings
           (organization_id, tool_id, endpoint, request_mapping, response_mapping, pricing_mode,
            price_amount, asset_id, sla_failure_rate, timeout_ms, settlement_chains, status,
            published_version, published_at)
         VALUES ($1, $2, 'https://provider.example.com', '{}'::jsonb, '{}'::jsonb, 'PAID',
                 $3, 'x', 0.02, 1000, ARRAY['solana:x']::varchar[], 'ACTIVE', 1, now())`,
        [organizationId, toolId, price],
      );
    }

    beforeAll(async () => {
      const s = services();
      owner = await org('Gaps owner');
      await verify(owner);
      ownerAgent = await agent(owner);
      await s.handles.claim(session(owner, ownerAgent), 'gaps-co', ACTOR);
      rival = await org('Gaps rival');
      viewer = await org('Gaps viewer');
      viewerAgent = await agent(viewer);
      gapTool = randomUUID();
      await dataSource.query(
        `INSERT INTO tools (id, name, kind, category, visibility, status)
         VALUES ($1, 'gaps_lookup', 'STANDARD', 'testing', 'LISTED', 'ACTIVE')`,
        [gapTool],
      );
      ownTool = randomUUID();
      await dataSource.query(
        `INSERT INTO tools (id, name, kind, owner_org_id, category, visibility, status,
                            review_status)
         VALUES ($1, 'gaps__own_api', 'PROVIDER', $2, 'testing', 'UNLISTED', 'ACTIVE', 'NONE')`,
        [ownTool, owner],
      );
      await bind(owner, gapTool);
      await bind(rival, gapTool);
    });

    it('names a listed set by id and flags self-routing by the effect of its rules', async () => {
      const s = services();
      const created = await s.toolsets.create(
        owner,
        { name: 'Routed', slug: 'routed', entries: [{ toolId: gapTool }] },
        ACTOR,
      );
      await s.publishing.publish(
        owner,
        created.id,
        { visibility: ToolsetVisibility.PUBLIC },
        ACTOR,
      );
      const before = (await services().publicToolsets.list({})).toolsets.find(
        (card) => card.slug === 'routed',
      );
      expect(before).toMatchObject({ id: created.id, routesToPublisher: false });

      // All but the rival: only the publisher is left, whatever the mode says.
      await s.toolsets.replaceEntries(
        owner,
        created.id,
        [{ toolId: gapTool, providerMode: 'EXCLUDE' as never, providerIds: [rival] }],
        ACTOR,
      );
      await s.publishing.publish(
        owner,
        created.id,
        { visibility: ToolsetVisibility.PUBLIC },
        ACTOR,
      );
      const page = await services().publicToolsets.page('gaps-co', 'routed');
      expect(page).toMatchObject({
        id: created.id,
        version: 2,
        routesToPublisher: true,
        notReviewed: false,
        diff: null,
      });
      expect(page.entries.map((entry) => entry.notReviewed)).toEqual([false]);

      // Each served version, with its snapshot and a real diff.
      const v2 = await s.publicToolsets.versionOf('gaps-co', 'routed', 2, 1);
      expect(v2).toMatchObject({
        version: 2,
        name: 'Routed',
        toolIds: [gapTool],
        routesToPublisher: true,
        notReviewed: false,
        diff: { from: 1, to: 2, added: [], removed: [], rulesChanged: ['gaps_lookup'] },
      });
      expect(v2.entries[0]).toMatchObject({ providerMode: 'EXCLUDE', providerCount: 1 });
      expect(await s.publicToolsets.versionOf('gaps-co', 'routed', 1, undefined)).toMatchObject({
        routesToPublisher: false,
        diff: null,
      });

      // Servers in use: a URL pinned to @1 is offered @2 on its own path.
      expect(await s.connectUrls.updateFor(viewer, parseMcpUrl('/@gaps-co/routed@1')!)).toEqual({
        latestVersion: 2,
        latestUrl: 'https://mcp.example.com/@gaps-co/routed@2',
      });
      for (const url of ['/@gaps-co/routed', '/@gaps-co/routed@2']) {
        expect(await s.connectUrls.updateFor(viewer, parseMcpUrl(url)!)).toBeNull();
      }
      expect(await s.connectUrls.updateFor(owner, parseMcpUrl('/my/routed@1')!)).toEqual({
        latestVersion: 2,
        latestUrl: 'https://mcp.example.com/my/routed@2',
      });
      // `/my/` names the caller's own toolsets only.
      expect(await s.connectUrls.updateFor(viewer, parseMcpUrl('/my/routed@1')!)).toBeNull();
    });

    it('gives no id, version or diff for anything /@… does not serve', async () => {
      const s = services();
      const staged = await s.toolsets.create(
        owner,
        { name: 'Gaps staged', slug: 'gaps-staged', entries: [{ toolId: gapTool }] },
        ACTOR,
      );
      for (const visibility of [
        ToolsetVisibility.PRIVATE,
        ToolsetVisibility.PRIVATE,
        ToolsetVisibility.PUBLIC,
      ]) {
        await s.publishing.publish(owner, staged.id, { visibility }, ACTOR);
      }
      const notFound = { code: ToolsetErrorCode.TOOLSET_VERSION_NOT_FOUND, status: 404 };
      for (const [v, from] of [
        [1, undefined],
        [2, undefined],
        [4, undefined],
        [3, 1],
        [3, 4],
      ] as const) {
        expect(
          await errorOf(s.publicToolsets.versionOf('gaps-co', 'gaps-staged', v, from)),
        ).toMatchObject(notFound);
      }
      expect(await s.publicToolsets.versionOf('gaps-co', 'gaps-staged', 3, 3)).toMatchObject({
        version: 3,
        diff: { from: 3, to: 3, added: [], removed: [], rulesChanged: [] },
      });
      // An update on `/@…` is only ever a version `/@…` serves.
      expect(
        (await s.connectUrls.updateFor(viewer, parseMcpUrl('/@gaps-co/gaps-staged@1')!))
          ?.latestVersion,
      ).toBe(3);

      // A private set and a link-only set: the same 404 as a missing slug, no card.
      const hidden = await s.toolsets.create(
        owner,
        { name: 'Gaps hidden', slug: 'gaps-hidden', entries: [{ toolId: gapTool }] },
        ACTOR,
      );
      await s.publishing.publish(
        owner,
        hidden.id,
        { visibility: ToolsetVisibility.PRIVATE },
        ACTOR,
      );
      const linked = await s.toolsets.create(
        owner,
        { name: 'Gaps linked', slug: 'gaps-linked', entries: [{ toolId: gapTool }] },
        ACTOR,
      );
      await s.publishing.publish(
        owner,
        linked.id,
        { visibility: ToolsetVisibility.UNLISTED },
        ACTOR,
      );
      for (const slug of ['gaps-hidden', 'gaps-linked', 'gaps-missing']) {
        expect(
          await errorOf(s.publicToolsets.versionOf('gaps-co', slug, 1, undefined)),
        ).toMatchObject({ code: ToolsetErrorCode.TOOLSET_NOT_FOUND, status: 404 });
      }
      const ids = (await services().publicToolsets.list({})).toolsets.map((card) => card.id);
      expect(ids).not.toContain(hidden.id);
      expect(ids).not.toContain(linked.id);
      expect(ids).toContain(staged.id);
    });

    it('by-token names the set to its link holder, flags unreviewed tools, and diffs served versions', async () => {
      const s = services();
      const created = await s.toolsets.create(
        owner,
        { name: 'Gaps link', slug: 'gaps-link', entries: [{ toolId: gapTool }] },
        ACTOR,
      );
      await s.publishing.publish(
        owner,
        created.id,
        { visibility: ToolsetVisibility.PRIVATE },
        ACTOR,
      );
      await dataSource.query(
        `INSERT INTO toolset_entries (toolset_id, position, tool_id) VALUES ($1, 1, $2)`,
        [created.id, ownTool],
      );
      const v2 = await s.publishing.publish(
        owner,
        created.id,
        { visibility: ToolsetVisibility.UNLISTED },
        ACTOR,
      );
      const token = v2.toolset.unlistedToken as string;
      await s.toolsets.replaceEntries(owner, created.id, [{ toolId: gapTool }], ACTOR);
      await s.publishing.publish(
        owner,
        created.id,
        { visibility: ToolsetVisibility.UNLISTED },
        ACTOR,
      );

      const page = await s.publicToolsets.byToken(token, 2, undefined);
      expect(page).toMatchObject({ id: created.id, version: 2, notReviewed: true, diff: null });
      expect(page.entries.map((entry) => [entry.toolId, entry.notReviewed])).toEqual([
        [gapTool, false],
        [ownTool, true],
      ]);
      // A BEST entry with a rival binding, and a tool with no binding: no self-routing.
      expect(page.routesToPublisher).toBe(false);
      expect(await s.publicToolsets.byToken(token, 3, 2)).toMatchObject({
        version: 3,
        notReviewed: false,
        diff: { from: 2, to: 3, removed: ['gaps__own_api'], added: [] },
      });
      // v1 was published PRIVATE: neither served nor diffable by the link.
      for (const [v, from] of [
        [1, undefined],
        [3, 1],
        [4, undefined],
      ] as const) {
        expect(await errorOf(s.publicToolsets.byToken(token, v, from))).toMatchObject({
          code: ToolsetErrorCode.TOOLSET_VERSION_NOT_FOUND,
        });
      }
      // The link's own path rules for "Update available".
      expect(await s.connectUrls.updateFor(viewer, parseMcpUrl(`/u/${token}@2`)!)).toEqual({
        latestVersion: 3,
        latestUrl: `https://mcp.example.com/u/${token}@3`,
      });
    });

    it('a frozen handle stops reports by id too', async () => {
      const s = services();
      const frozen = await org('Gaps frozen');
      await verify(frozen);
      await s.handles.claim(session(frozen, await agent(frozen)), 'gaps-frozen', ACTOR);
      const created = await s.toolsets.create(
        frozen,
        { name: 'Gaps cold', slug: 'gaps-cold', entries: [{ toolId: gapTool }] },
        ACTOR,
      );
      await s.publishing.publish(
        frozen,
        created.id,
        { visibility: ToolsetVisibility.PUBLIC },
        ACTOR,
      );
      expect(await s.connectUrls.updateFor(viewer, parseMcpUrl('/@gaps-frozen/gaps-cold@1')!)).toBe(
        null,
      );
      await dataSource.transaction((manager) =>
        s.moderation.cutoffHandle(manager, {
          handle: 'gaps-frozen',
          operatorId: OPERATOR_1,
          note: 'frozen for the test',
        }),
      );
      await s.moderation.afterCommit([frozen]);
      expect(
        await errorOf(s.reports.create(viewer, { toolsetId: created.id, reason: 'spam spam' })),
      ).toMatchObject({ code: ToolsetErrorCode.TOOLSET_REPORT_TARGET_NOT_FOUND });
      expect(await errorOf(s.publishing.copy(viewer, created.id, {}, ACTOR))).toMatchObject({
        code: ToolsetErrorCode.TOOLSET_NOT_FOUND,
      });
      expect(
        await errorOf(
          s.access.patch(
            viewer,
            viewerAgent,
            { allowedToolsets: [{ toolsetId: created.id, version: 1 }] },
            ACTOR,
          ),
        ),
      ).toMatchObject({ code: ToolsetErrorCode.TOOLSET_ACCESS_INVALID });
    });
  });
});
