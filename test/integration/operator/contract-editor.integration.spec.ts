import { randomUUID } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { OperatorApprovalRepository } from '@database/postgres/repositories/operator-approval.repository';
import { OperatorRepository } from '@database/postgres/repositories/operator.repository';
import { OverrideLogEntryRepository } from '@database/postgres/repositories/override-log-entry.repository';
import { ToolRequestRepository } from '@database/postgres/repositories/tool-request.repository';
import { ToolRepository } from '@database/postgres/repositories/tool.repository';
import { ToolVersionRepository } from '@database/postgres/repositories/tool-version.repository';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { NotificationEvent } from '@modules/notification/ports/notification.port';
import { OperatorRole } from '@modules/operator/domain/override-register';
import {
  isApprovalQueued,
  OperatorApprovalService,
} from '@modules/operator/services/operator-approval.service';
import { OperatorContractsService } from '@modules/operator/services/operator-contracts.service';
import { OperatorService } from '@modules/operator/services/operator.service';
import { OverrideLogService } from '@modules/operator/services/override-log.service';
import { OperatorSession } from '@modules/operator/ports/operator-session.port';
import { ToolRequestStatus } from '@modules/tool-request/domain/tool-request-state';
import { ToolRequestQueueService } from '@modules/tool-request/services/operator-tool-request-queue.service';
import { VersionBump } from '@modules/tool/domain/contract';
import { ToolErrorCode } from '@modules/tool/errors/tool.errors';
import { DatabaseToolContracts } from '@modules/tool/services/database-tool-contracts';
import { ProviderRouterService } from '@modules/tool/services/provider-router.service';
import { ContractLifecycleService } from '@modules/toolset/services/contract-lifecycle.service';

import { freshMigratedDatabase } from '../helpers/slash-prorata-context';

/**
 * The standard contract editor against a real Postgres (design spec §7.5):
 * drafts, the diff and the bump, the two-person publish and current-version
 * move, deprecation with its 90-day floor, retirement at the sunset, the
 * notices, and the DRAFT tool an accepted request creates.
 */
const DATABASE = 'x402_contract_editor_test';
const NOTE = 'A contract change reviewed by the policy team.';
const ACTION = { reasonCode: 'CONTRACT_CHANGE', note: NOTE };
const DAY = 24 * 60 * 60 * 1000;

const INPUT = {
  type: 'object',
  properties: { latitude: { type: 'number' }, longitude: { type: 'number' } },
  required: ['latitude', 'longitude'],
};
const OUTPUT = {
  type: 'object',
  properties: { temperatureC: { type: 'number' } },
  required: ['temperatureC'],
};
const DRAFT = {
  summary: 'Current temperature at a point.',
  description: 'Current temperature at a latitude and longitude.',
  inputSchema: INPUT,
  outputSchema: OUTPUT,
};

describe('the operator contract editor, against a real database', () => {
  let dataSource: DataSource;
  let editor: OperatorContractsService;
  let approvals: OperatorApprovalService;
  let contracts: DatabaseToolContracts;
  let lifecycle: ContractLifecycleService;
  let author: OperatorSession;
  let approver: OperatorSession;
  const notices: Array<{ organizationId: string; event: string; dedupeKey?: string }> = [];
  let changes = 0;
  let now = new Date();

  beforeAll(async () => {
    dataSource = await freshMigratedDatabase(DATABASE);
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
    const tools = new ToolRepository(dataSource);
    const versions = new ToolVersionRepository(dataSource);
    contracts = new DatabaseToolContracts(tools, versions);
    const changeSignal = {
      contractsChanged: async () => {
        changes += 1;
        contracts.invalidate();
      },
    };
    lifecycle = new ContractLifecycleService(
      dataSource,
      {
        notify: async (request: { organizationId: string; event: string; dedupeKey?: string }) => {
          notices.push(request);
          return { deliveredNow: true };
        },
      } as never,
      changeSignal,
      () => now,
    );
    const router = {
      quote: async () => ({ routableBindings: 0 }),
    } as unknown as ProviderRouterService;
    editor = new OperatorContractsService(
      tools,
      versions,
      overrides,
      approvals,
      approvalRows,
      router,
      lifecycle,
      changeSignal,
      [CHAIN_IDS.SOLANA_MAINNET],
      dataSource,
    );

    author = await seedOperator('policy-author', [OperatorRole.POL]);
    approver = await seedOperator('policy-approver', [OperatorRole.POLA]);
  }, 300_000);

  afterAll(async () => {
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

  /** Publish the draft: queued by the author, approved by the approver. */
  async function publish(toolId: string, version: number) {
    const queued = await editor.publish(author, toolId, version, ACTION, null);
    expect(isApprovalQueued(queued)).toBe(true);
    const decided = await approvals.approve(
      (queued as { approvalId: string }).approvalId,
      approver,
      null,
    );
    return decided.result as Awaited<ReturnType<OperatorContractsService['get']>>;
  }

  async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
    return work.then(
      () => undefined,
      (error: { errorCode?: string }) => error.errorCode,
    );
  }

  let toolId: string;

  it('a new tool is a DRAFT in no catalogue; a bad draft is refused with every problem', async () => {
    const created = await editor.createTool({ name: 'get_example_weather', category: 'weather' });
    toolId = created.id;
    expect(created).toMatchObject({
      status: 'DRAFT',
      currentVersion: null,
      versions: [],
      draft: null,
    });
    expect(await contracts.findContract(toolId)).toBeNull();
    expect(
      await codeOf(editor.createTool({ name: 'get_example_weather', category: 'weather' })),
    ).toBe(ToolErrorCode.TOOL_CONTRACT_NAME_TAKEN);

    expect(
      await codeOf(
        editor.saveDraft(author, toolId, {
          ...DRAFT,
          optionalOutputFields: ['temperatureC'],
        }),
      ),
    ).toBe(ToolErrorCode.TOOL_CONTRACT_INVALID);
  });

  it('the first version publishes as 1.0.0 with a second operator, and becomes current', async () => {
    const saved = await editor.saveDraft(author, toolId, DRAFT);
    expect(saved.draft).toMatchObject({ nextSemver: '1.0.0', baseSemver: null, problems: [] });

    // The author cannot approve their own publish.
    const queued = await editor.publish(author, toolId, saved.draft!.version, ACTION, null);
    expect(isApprovalQueued(queued)).toBe(true);
    expect(
      await codeOf(approvals.approve((queued as { approvalId: string }).approvalId, author, null)),
    ).toBe('OPERATOR_SELF_APPROVAL_REFUSED');
    const published = (
      await approvals.approve((queued as { approvalId: string }).approvalId, approver, null)
    ).result as Awaited<ReturnType<OperatorContractsService['get']>>;

    expect(published).toMatchObject({ status: 'ACTIVE', currentSemver: '1.0.0', draft: null });
    expect(changes).toBeGreaterThan(0);
    const served = await contracts.findContract(toolId);
    expect(served?.version?.semver).toBe('1.0.0');
    expect(served?.version?.summary).toBe(DRAFT.summary);

    const [entry] = (await dataSource.query(
      `SELECT code, actor_operator_id, approver_operator_id FROM override_log_entries
        WHERE code = 'P-10' AND target_id = $1`,
      [toolId],
    )) as { code: string; actor_operator_id: string; approver_operator_id: string }[];
    expect(entry).toMatchObject({
      actor_operator_id: author.operatorId,
      approver_operator_id: approver.operatorId,
    });
  });

  it('an optional field added is a MINOR that moves current with it', async () => {
    const saved = await editor.saveDraft(author, toolId, {
      ...DRAFT,
      outputSchema: {
        ...OUTPUT,
        properties: { ...OUTPUT.properties, uvIndex: { type: 'number' } },
      },
      optionalOutputFields: ['uvIndex'],
      changelog: 'Adds the optional uvIndex output.',
    });
    expect(saved.draft).toMatchObject({
      baseSemver: '1.0.0',
      nextSemver: '1.1.0',
      bump: VersionBump.MINOR,
      changes: [expect.objectContaining({ kind: 'FIELD_ADDED_OPTIONAL', field: 'uvIndex' })],
    });
    const published = await publish(toolId, saved.draft!.version);
    expect(published.currentSemver).toBe('1.1.0');
  });

  it('a promoted field is a MAJOR that does not move unpinned URLs', async () => {
    const saved = await editor.saveDraft(author, toolId, {
      ...DRAFT,
      outputSchema: {
        ...OUTPUT,
        properties: { ...OUTPUT.properties, uvIndex: { type: 'number' } },
        required: ['temperatureC', 'uvIndex'],
      },
    });
    expect(saved.draft).toMatchObject({ nextSemver: '2.0.0', bump: VersionBump.MAJOR });
    const published = await publish(toolId, saved.draft!.version);
    expect(published.currentSemver).toBe('1.1.0');
    expect(published.versions.map((version) => version.semver)).toEqual([
      '2.0.0',
      '1.1.0',
      '1.0.0',
    ]);
    expect(published.majors.map((major) => major.major)).toEqual([2, 1]);
  });

  it('a draft identical to its base cannot be published', async () => {
    const tool = await editor.get(toolId);
    const latest = tool.versions[0];
    const saved = await editor.saveDraft(author, toolId, {
      summary: latest.summary,
      description: latest.description,
      inputSchema: latest.inputSchema as Record<string, unknown>,
      outputSchema: latest.outputSchema as Record<string, unknown>,
      optionalInputFields: latest.optionalInputFields,
      optionalOutputFields: latest.optionalOutputFields,
      verificationPolicyId: 'policy-default',
      tier: latest.tier,
    });
    expect(saved.draft?.problems).toContain('identical to v2.0.0');
    const queued = await editor.publish(author, toolId, saved.draft!.version, ACTION, null);
    expect(
      await codeOf(
        approvals.approve((queued as { approvalId: string }).approvalId, approver, null),
      ),
    ).toBe(ToolErrorCode.TOOL_CONTRACT_NO_CHANGES);
    await approvals.reject((queued as { approvalId: string }).approvalId, author);
    await editor.discardDraft(author, toolId);
  });

  it('moving current_version is two-person; then the old major can be deprecated, not the current one', async () => {
    const tool = await editor.get(toolId);
    const v2 = tool.versions.find((version) => version.semver === '2.0.0')!;
    const v1 = tool.versions.find((version) => version.semver === '1.1.0')!;

    // Not while v1 is current.
    expect(
      await codeOf(
        editor.deprecate(
          author,
          toolId,
          v1.version,
          {
            ...ACTION,
            sunsetAt: new Date(Date.now() + 120 * DAY).toISOString(),
          },
          null,
        ),
      ),
    ).toBe(ToolErrorCode.TOOL_CONTRACT_STATE);

    const queued = await editor.moveCurrentVersion(
      author,
      toolId,
      { ...ACTION, version: v2.version },
      null,
    );
    expect(isApprovalQueued(queued)).toBe(true);
    const moved = (
      await approvals.approve((queued as { approvalId: string }).approvalId, approver, null)
    ).result as Awaited<ReturnType<OperatorContractsService['get']>>;
    expect(moved.currentSemver).toBe('2.0.0');

    // A sunset under 90 days is refused.
    expect(
      await codeOf(
        editor.deprecate(
          author,
          toolId,
          v1.version,
          {
            ...ACTION,
            sunsetAt: new Date(Date.now() + 30 * DAY).toISOString(),
          },
          null,
        ),
      ),
    ).toBe(ToolErrorCode.TOOL_CONTRACT_STATE);
  });

  it('a deprecation notifies the affected organizations, and the sunset retires the major', async () => {
    // An organization whose toolset routes this tool to v1.
    const [org] = await dataSource.query(
      `INSERT INTO organizations (name, created_via) VALUES ('Example buyer', 'TEST') RETURNING id`,
    );
    const [toolset] = await dataSource.query(
      `INSERT INTO toolsets (owner_org_id, publisher_kind, slug, name)
       VALUES ($1, 'USER', 'weather-kit', 'Weather kit') RETURNING id`,
      [org.id],
    );
    await dataSource.query(
      `INSERT INTO toolset_entries (toolset_id, position, tool_id, tool_version_range)
       VALUES ($1, 0, $2, '^1')`,
      [toolset.id, toolId],
    );

    const tool = await editor.get(toolId);
    const v1 = tool.versions.find((version) => version.semver === '1.1.0')!;
    const sunsetAt = new Date(Date.now() + 91 * DAY);
    const deprecated = await editor.deprecate(
      author,
      toolId,
      v1.version,
      { ...ACTION, sunsetAt: sunsetAt.toISOString() },
      null,
    );
    expect(
      deprecated.versions.filter((version) => version.major === 1).map((version) => version.status),
    ).toEqual(['DEPRECATED', 'DEPRECATED']);
    expect(notices).toEqual([
      expect.objectContaining({
        organizationId: org.id,
        event: NotificationEvent.TOOL_VERSION_DEPRECATED,
        dedupeKey: `${toolId}:v1:deprecated`,
      }),
    ]);

    // Still serving until the sunset.
    now = new Date(sunsetAt.getTime() - DAY);
    expect(await lifecycle.retireDue()).toBe(0);

    now = new Date(sunsetAt.getTime() + 1000);
    expect(await lifecycle.retireDue()).toBe(2);
    const served = await contracts.findContract(toolId);
    expect(served?.versions?.filter((version) => version.major === 1).map((v) => v.status)).toEqual(
      ['RETIRED', 'RETIRED'],
    );
    expect(notices.map((notice) => notice.event)).toContain(NotificationEvent.TOOL_VERSION_RETIRED);

    // A retired (or deprecated) major takes no new minor: it would escape its sunset.
    expect(
      await codeOf(
        editor.saveDraft(author, toolId, {
          ...DRAFT,
          description: 'A late fix to v1.',
          baseVersion: v1.version,
        }),
      ),
    ).toBe(ToolErrorCode.TOOL_CONTRACT_STATE);
  });

  it('an accepted tool request creates a DRAFT tool, named from the title', async () => {
    const [org] = await dataSource.query(
      `INSERT INTO organizations (name, created_via) VALUES ('Example requester', 'TEST') RETURNING id`,
    );
    const [request] = await dataSource.query(
      `INSERT INTO tool_requests (organization_id, title, description, first_response_due_at)
       VALUES ($1, 'Tide times for a harbour', 'High and low tides.', now() + interval '2 days')
       RETURNING id`,
      [org.id],
    );
    const queue = new ToolRequestQueueService(
      new ToolRequestRepository(dataSource),
      new ToolRepository(dataSource),
    );
    const answered = await queue.answer(author.operatorId, request.id, {
      status: ToolRequestStatus.ACCEPTED,
      resolutionNote: 'Accepted: drafting a standard contract.',
    });
    expect(answered.toolId).toBeTruthy();
    const [tool] = (await dataSource.query(`SELECT name, status FROM tools WHERE id = $1`, [
      answered.toolId,
    ])) as { name: string; status: string }[];
    expect(tool).toEqual({ name: 'tide_times_for_a_harbour', status: 'DRAFT' });
  });

  it('the local and test seed owns version 1.0.0 of a seeded tool and points current at it', async () => {
    const id = randomUUID();
    const tools = new ToolRepository(dataSource);
    const seed = {
      id,
      name: 'get_seeded_example',
      category: 'misc',
      tags: ['example'],
      version: {
        summary: 'A seeded example.',
        description: 'A seeded example tool.',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: OUTPUT,
        optionalInputFields: [],
        optionalOutputFields: [],
        examples: [{ arguments: {} }],
        verificationPolicyId: 'policy-default',
        tier: 'VERIFIED',
      },
    };
    await tools.upsertSeeded([seed]);
    // A second boot refreshes version 1 from the seed and changes nothing else.
    await tools.upsertSeeded([{ ...seed, version: { ...seed.version, summary: 'Refreshed.' } }]);
    contracts.invalidate();

    const served = await contracts.findContract(id);
    expect(served).toMatchObject({ name: 'get_seeded_example', currentVersion: 1 });
    expect(served?.version).toMatchObject({
      semver: '1.0.0',
      summary: 'Refreshed.',
      status: 'ACTIVE',
    });
    expect(served?.version?.examples).toEqual([{ arguments: {} }]);
  });

  it('a queued publish approves the queued content: no edit, no discard, no reuse, no editor as approver (P1-1)', async () => {
    const created = await editor.createTool({ name: 'get_guarded_example', category: 'misc' });
    const id = created.id;
    const saved = await editor.saveDraft(author, id, DRAFT);
    const draftVersion = saved.draft!.version;
    const queued = (await editor.publish(author, id, draftVersion, ACTION, null)) as {
      approvalId: string;
    };
    expect(isApprovalQueued(queued)).toBe(true);

    // Frozen while pending.
    expect(await codeOf(editor.saveDraft(author, id, { ...DRAFT, summary: 'Breaking.' }))).toBe(
      ToolErrorCode.TOOL_CONTRACT_STATE,
    );
    expect(await codeOf(editor.discardDraft(author, id))).toBe(ToolErrorCode.TOOL_CONTRACT_STATE);

    // A change that slipped past the API is caught by the content hash.
    await dataSource.query(
      `UPDATE tool_versions SET summary = 'Changed behind the queue.' WHERE tool_id = $1 AND version = $2`,
      [id, draftVersion],
    );
    expect(await codeOf(approvals.approve(queued.approvalId, approver, null))).toBe(
      ToolErrorCode.TOOL_CONTRACT_STATE,
    );
    const [still] = (await dataSource.query(
      `SELECT status FROM tool_versions WHERE tool_id = $1 AND version = $2`,
      [id, draftVersion],
    )) as { status: string }[];
    expect(still.status).toBe('DRAFT');

    // Discard and replace: never the same number again.
    await approvals.reject(queued.approvalId, author);
    await editor.discardDraft(author, id);
    const replaced = await editor.saveDraft(approver, id, DRAFT);
    expect(replaced.draft!.version).toBeGreaterThan(draftVersion);

    // The operator who last edited the draft is not its second person.
    const again = (await editor.publish(author, id, replaced.draft!.version, ACTION, null)) as {
      approvalId: string;
    };
    expect(await codeOf(approvals.approve(again.approvalId, approver, null))).toBe(
      'OPERATOR_SELF_APPROVAL_REFUSED',
    );
  });
});
