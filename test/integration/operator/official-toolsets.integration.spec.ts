import { randomUUID } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { OperatorApprovalRepository } from '@database/postgres/repositories/operator-approval.repository';
import { OperatorRepository } from '@database/postgres/repositories/operator.repository';
import { OverrideLogEntryRepository } from '@database/postgres/repositories/override-log-entry.repository';
import {
  ModerationCutoffRepository,
  ToolsetReportRepository,
} from '@database/postgres/repositories/toolset-sharing.repository';
import { ToolsetRepository } from '@database/postgres/repositories/toolset.repository';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { OperatorRole } from '@modules/operator/domain/override-register';
import { OperatorSession } from '@modules/operator/ports/operator-session.port';
import {
  isApprovalQueued,
  OperatorApprovalService,
} from '@modules/operator/services/operator-approval.service';
import { OperatorModerationService } from '@modules/operator/services/operator-moderation.service';
import { OperatorOfficialToolsetsService } from '@modules/operator/services/operator-official-toolsets.service';
import { OperatorService } from '@modules/operator/services/operator.service';
import { OverrideLogService } from '@modules/operator/services/override-log.service';
import { InMemoryToolCatalogue } from '@modules/tool/services/in-memory-tool-catalogue';
import { ToolsetErrorCode } from '@modules/toolset/errors/toolset.errors';
import { CutoffAction } from '@modules/toolset/services/toolset-moderation.service';
import { parseMcpUrl } from '@modules/toolset/domain/mcp-url';

import { freshMigratedDatabase } from '../helpers/slash-prorata-context';
import { toolsetTestContext } from '../helpers/toolset-test-context';

/**
 * Official tool sets end to end against a real Postgres and Redis (plan B):
 * a POL creates the Draft, asks to publish (queued, P-13), a POLA approves
 * exactly that Draft, it is served at `/@assay/{slug}` and in the public
 * catalogue, a POL delists it at once (A-15), and a second operator confirms
 * within 72 h (A-18).
 */
const DATABASE = 'assay_official_toolsets_test';
const HOST = { mcpPublicUrl: 'https://mcp.example.com', webAppUrl: 'https://app.example.com' };
const ACTION = { reasonCode: 'OFFICIAL_SET', note: 'A curated set reviewed by the policy team.' };
const WEATHER = randomUUID();
const GEOCODE = randomUUID();
const HIDDEN = randomUUID();

describe('official tool sets in the operator console, against a real database', () => {
  let dataSource: DataSource;
  let redis: Redis;
  let s: ReturnType<typeof toolsetTestContext>;
  let console_: OperatorOfficialToolsetsService;
  let moderation: OperatorModerationService;
  let approvals: OperatorApprovalService;
  let author: OperatorSession;
  let approver: OperatorSession;
  let adjudicator: OperatorSession;

  beforeAll(async () => {
    dataSource = await freshMigratedDatabase(DATABASE);
    redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: 1,
    });
    s = toolsetTestContext({
      dataSource,
      redis,
      host: HOST,
      catalogue: new InMemoryToolCatalogue({ tools: [], bindings: [] }),
      chainId: CHAIN_IDS.SOLANA_DEVNET,
    });
    const operators = new OperatorRepository(dataSource);
    const approvalRows = new OperatorApprovalRepository(dataSource);
    approvals = new OperatorApprovalService(
      approvalRows,
      operators,
      new OperatorService(operators, new ConfigService()),
    );
    const overrides = new OverrideLogService(
      dataSource,
      new OverrideLogEntryRepository(dataSource),
      approvalRows,
    );
    console_ = new OperatorOfficialToolsetsService(
      s.official,
      overrides,
      approvals,
      approvalRows,
      dataSource,
    );
    moderation = new OperatorModerationService(
      overrides,
      approvals,
      s.moderation,
      new ToolsetRepository(dataSource),
      new ModerationCutoffRepository(dataSource),
      new ToolsetReportRepository(dataSource),
    );

    for (const [id, name, category, status] of [
      [WEATHER, 'get_weather', 'weather', 'ACTIVE'],
      [GEOCODE, 'geocode_place', 'maps', 'ACTIVE'],
      [HIDDEN, 'draft_tool', 'maps', 'DRAFT'],
    ]) {
      await dataSource.query(
        `INSERT INTO tools (id, name, kind, category, visibility, status)
         VALUES ($1, $2, 'STANDARD', $3, 'LISTED', $4)`,
        [id, name, category, status],
      );
    }
    author = await seedOperator('policy-author', [OperatorRole.POL]);
    approver = await seedOperator('policy-approver', [OperatorRole.POLA]);
    adjudicator = await seedOperator('adjudicator', [OperatorRole.ADJ]);
  }, 300_000);

  afterAll(async () => {
    await redis?.quit();
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  async function seedOperator(subject: string, roles: OperatorRole[]): Promise<OperatorSession> {
    const id = randomUUID();
    await dataSource.query(
      `INSERT INTO operators (id, subject, display_name, email, roles, status)
       VALUES ($1, $2, $2, $3, $4::jsonb, 'ACTIVE')`,
      [id, subject, `${subject}@example.test`, JSON.stringify(roles)],
    );
    return {
      operatorId: id,
      subject,
      displayName: subject,
      email: `${subject}@example.test`,
      roles,
      authorityLimitMinor: null,
    };
  }

  async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
    return work.then(
      () => undefined,
      (error: { errorCode?: string }) => error.errorCode,
    );
  }

  let id: string;

  it('creates a Draft that serves nothing; a taken slug and an inactive tool are refused', async () => {
    const created = await console_.create(author, {
      slug: 'weather-and-places',
      name: 'Weather and places',
      toolIds: [WEATHER, GEOCODE],
      pinnedTools: ['get_weather'],
    });
    id = created.id;
    expect(created).toMatchObject({
      visibility: 'PRIVATE',
      latestVersion: null,
      publicUrl: null,
      pendingPublish: null,
      entries: [
        { toolName: 'get_weather', toolVersionRange: '^1', bindingCount: 0 },
        { toolName: 'geocode_place', toolVersionRange: '^1', bindingCount: 0 },
      ],
    });
    expect(
      await codeOf(
        console_.create(author, { slug: 'weather-and-places', name: 'Again', toolIds: [WEATHER] }),
      ),
    ).toBe(ToolsetErrorCode.TOOLSET_SLUG_TAKEN);
    expect(
      await codeOf(console_.create(author, { slug: 'hidden', name: 'Hidden', toolIds: [HIDDEN] })),
    ).toBe(ToolsetErrorCode.TOOLSET_INVALID);
    expect(await codeOf(s.publicToolsets.page('assay', 'weather-and-places'))).toBe(
      ToolsetErrorCode.TOOLSET_NOT_FOUND,
    );
  });

  it('publishes with a second operator, for exactly the Draft that was requested (P-13)', async () => {
    const queued = await console_.publish(author, id, ACTION, null);
    expect(isApprovalQueued(queued)).toBe(true);
    const approvalId = (queued as { approvalId: string }).approvalId;
    expect((await console_.get(id)).pendingPublish).toMatchObject({ approvalId });

    // Frozen while it waits.
    expect(await codeOf(console_.update(author, id, { name: 'Changed' }))).toBe(
      ToolsetErrorCode.TOOLSET_STATE,
    );
    // The author cannot approve their own request.
    expect(await codeOf(approvals.approve(approvalId, author, null))).toBeDefined();

    await approvals.approve(approvalId, approver, null);
    const published = await console_.get(id);
    expect(published).toMatchObject({
      visibility: 'PUBLIC',
      listingStatus: 'LISTED',
      latestVersion: 1,
      draftChanged: false,
      slugLocked: true,
      pendingPublish: null,
      publicUrl: 'https://mcp.example.com/@assay/weather-and-places',
    });
    const [entry] = await dataSource.query(
      `SELECT actor_operator_id, approver_operator_id, after FROM override_log_entries
        WHERE code = 'P-13' AND target_id = $1`,
      [id],
    );
    expect(entry).toMatchObject({
      actor_operator_id: author.operatorId,
      approver_operator_id: approver.operatorId,
    });
    expect(entry.after).toMatchObject({ latestVersion: 1 });
  });

  it('is served at /@assay/{slug} and in the public catalogue', async () => {
    const page = await s.publicToolsets.page('assay', 'weather-and-places');
    expect(page).toMatchObject({ badge: 'OFFICIAL', version: 1, toolCount: 2 });
    expect((await s.publicToolsets.list({ publisher: 'official' })).toolsets).toHaveLength(1);
    const org = (
      await dataSource.query(`INSERT INTO organizations (name) VALUES ('Buyer') RETURNING id`)
    )[0].id as string;
    expect(
      (await s.endpoints.resolve(org, parseMcpUrl('/@assay/weather-and-places')!)).toolset?.id,
    ).toBe(id);
  });

  it('refuses an approval for a Draft that changed after the request', async () => {
    await console_.update(author, id, { toolIds: [WEATHER] });
    const queued = await console_.publish(author, id, ACTION, null);
    const approvalId = (queued as { approvalId: string }).approvalId;
    // Edited behind the freeze (as by another writer): the hash no longer matches.
    await dataSource.query(`UPDATE toolsets SET name = 'Edited elsewhere' WHERE id = $1`, [id]);
    expect(await codeOf(approvals.approve(approvalId, approver, null))).toBe(
      ToolsetErrorCode.TOOLSET_STATE,
    );
    expect((await console_.get(id)).latestVersion).toBe(1);
    await approvals.reject(approvalId, author);
  });

  it('a POL delists it at once (A-15); a second operator confirms within 72 h (A-18)', async () => {
    const cutoff = await moderation.cutoffToolset(author, id, CutoffAction.DELIST, ACTION, null);
    expect(await console_.get(id)).toMatchObject({ listingStatus: 'DELISTED', delisted: true });
    expect((await s.publicToolsets.list({ publisher: 'official' })).toolsets).toHaveLength(0);

    // The operator who acted cannot confirm their own delist.
    expect(await codeOf(moderation.confirmCutoff(author, cutoff.id, ACTION, null))).toBeDefined();
    const confirmed = await moderation.confirmCutoff(adjudicator, cutoff.id, ACTION, null);
    expect(confirmed).toMatchObject({ id: cutoff.id, confirmedBy: adjudicator.operatorId });

    // Publishing again is no way back into the catalogue.
    await dataSource.query(`UPDATE toolsets SET name = 'Weather and places' WHERE id = $1`, [id]);
    const queued = await console_.publish(author, id, ACTION, null);
    await approvals.approve((queued as { approvalId: string }).approvalId, approver, null);
    expect(await console_.get(id)).toMatchObject({ latestVersion: 2, listingStatus: 'DELISTED' });
  });
});
