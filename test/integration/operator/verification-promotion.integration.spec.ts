import { randomUUID } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { OperatorApprovalRepository } from '@database/postgres/repositories/operator-approval.repository';
import { OperatorRepository } from '@database/postgres/repositories/operator.repository';
import { OverrideLogEntryRepository } from '@database/postgres/repositories/override-log-entry.repository';
import { ToolRepository } from '@database/postgres/repositories/tool.repository';
import { VerificationPolicyRepository } from '@database/postgres/repositories/verification-policy.repository';
import { OperatorRole } from '@modules/operator/domain/override-register';
import { OperatorSession } from '@modules/operator/ports/operator-session.port';
import {
  isApprovalQueued,
  OperatorApprovalService,
} from '@modules/operator/services/operator-approval.service';
import { OperatorService } from '@modules/operator/services/operator.service';
import { OperatorToolVerificationService } from '@modules/operator/services/operator-tool-verification.service';
import { OverrideLogService } from '@modules/operator/services/override-log.service';
import { PolicyLifecycle } from '@modules/verification/domain/aggregation';
import {
  KillRecord,
  KillScope,
  KillTarget,
} from '@modules/verification/domain/lifecycle/kill-switch';
import { PolicyKillSwitchPort } from '@modules/verification/ports/policy-kill-switch.port';
import { DecisionPolicyService } from '@modules/verification/services/decision-policy.service';
import {
  PolicyEvidenceService,
  TrialLabel,
} from '@modules/verification/services/policy-evidence.service';

import { freshMigratedDatabase } from '../helpers/slash-prorata-context';

/**
 * A verification policy from register to ACTIVE, against a real Postgres:
 * POL registers a trial (P-2), trial calls are judged, an adjudicator labels
 * them, POL asks to switch it on (P-1, queued), POLA approves, and the row is
 * ACTIVE with evidence the server counted — the CHECK constraints hold, and
 * traffic resolves to ACTIVE.
 */
const DATABASE = 'assay_verification_promotion_test';
const NOTE = 'Trial evidence reviewed with the policy team.';
const ACTION = { reasonCode: 'POLICY_CHANGE', note: NOTE };

/** The kill switch, in memory: one process here, so no propagation to test. */
class MemoryKillSwitch implements PolicyKillSwitchPort {
  readonly kills = new Map<string, KillRecord>();
  isKilled(policyId: string, version: number): KillRecord | null {
    return this.kills.get(`${policyId}@${version}`) ?? null;
  }
  async kill(target: KillTarget, reason: string, actor: string): Promise<KillRecord> {
    const record: KillRecord = {
      key: `policy:${target.policyId}@${target.version}`,
      scope: KillScope.POLICY_VERSION,
      policyId: target.policyId ?? null,
      version: target.version ?? null,
      reason,
      actor,
      killedAt: new Date().toISOString(),
    };
    this.kills.set(`${target.policyId}@${target.version}`, record);
    return record;
  }
  async revive(target: KillTarget): Promise<boolean> {
    return this.kills.delete(`${target.policyId}@${target.version}`);
  }
  list(): readonly KillRecord[] {
    return [...this.kills.values()];
  }
  snapshotAgeMs(): number {
    return 0;
  }
  async refresh(): Promise<void> {}
}

describe('verification policy promotion, against a real database', () => {
  let dataSource: DataSource;
  let service: OperatorToolVerificationService;
  let approvals: OperatorApprovalService;
  let policies: DecisionPolicyService;
  let killSwitch: MemoryKillSwitch;
  let author: OperatorSession;
  let approver: OperatorSession;
  let labeller: OperatorSession;
  let sre: OperatorSession;
  let toolId: string;
  let changes = 0;

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
    killSwitch = new MemoryKillSwitch();
    const policyRows = new VerificationPolicyRepository(dataSource);
    policies = new DecisionPolicyService(policyRows, killSwitch);
    const tools = new ToolRepository(dataSource);
    service = new OperatorToolVerificationService(
      tools,
      policyRows,
      policies,
      new PolicyEvidenceService(dataSource),
      overrides,
      approvals,
      approvalRows,
      {
        contractsChanged: async () => {
          changes += 1;
        },
      },
    );

    author = await seedOperator('policy-author', [OperatorRole.POL]);
    approver = await seedOperator('policy-approver', [OperatorRole.POLA]);
    labeller = await seedOperator('adjudicator', [OperatorRole.ADJ]);
    sre = await seedOperator('on-call', [OperatorRole.SRE]);

    const tool = await tools.insertDraft({
      name: 'get_trial_weather',
      category: 'weather',
      tags: [],
    });
    await dataSource.query(`UPDATE tools SET status = 'ACTIVE' WHERE id = $1`, [tool.id]);
    toolId = tool.id;
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

  /** `count` judged records; the first `fails` of them FAIL. */
  async function seedRecords(input: {
    readonly policyId: string;
    readonly version: number;
    readonly lifecycle: string;
    readonly count: number;
    readonly fails: number;
  }): Promise<void> {
    await dataSource.query(
      `INSERT INTO verification_records
         (organization_id, intent_id, tool_id, state, verdict_status, decision_policy_id,
          decision_policy_version, lifecycle, evaluated_at, stages, request, response)
       SELECT gen_random_uuid(), gen_random_uuid(), $1, 'JUDGED',
              CASE WHEN g <= $5 THEN 'FAIL' ELSE 'PASS' END, $2, $3, $4, now(), '[]'::jsonb,
              jsonb_build_object('city', 'Lisbon'), jsonb_build_object('temperatureC', g)
         FROM generate_series(1, $6::int) g`,
      [toolId, input.policyId, input.version, input.lifecycle, input.fails, input.count],
    );
  }

  async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
    return work.then(
      () => undefined,
      (error: { errorCode?: string }) => error.errorCode,
    );
  }

  const POLICY_ID = 'get_trial_weather.default';
  let approvalId: string;

  it('POL registers a trial policy (P-2): SHADOW, authored by them, logged', async () => {
    const view = await service.register(author, toolId, { ...ACTION }, null);
    expect(view.versions).toHaveLength(1);
    expect(view.versions[0]).toMatchObject({
      policyId: POLICY_ID,
      version: 1,
      lifecycle: 'SHADOW',
      createdBy: author.operatorId,
      rules: [],
    });
    expect(view.checks).toBe('SHADOW');
    expect(changes).toBe(1);
    const [entry] = (await dataSource.query(
      `SELECT code, actor_operator_id FROM override_log_entries WHERE code = 'P-2'`,
    )) as { code: string; actor_operator_id: string }[];
    expect(entry.actor_operator_id).toBe(author.operatorId);
  });

  it('asking to promote on no evidence is refused at once, with every unmet bar', async () => {
    const error = (await service.promote(author, toolId, 1, ACTION, null).catch((e) => e)) as {
      errorCode: string;
      context: { failures: { code: string }[] };
    };
    expect(error.errorCode).toBe('VERIFICATION_POLICY_PROMOTION_REFUSED');
    expect(error.context.failures.map((failure) => failure.code)).toEqual([
      'INSUFFICIENT_SHADOW_CALLS',
      'INSUFFICIENT_LABELLED_SAMPLES',
    ]);
  });

  it('counts only judged trial records of this version', async () => {
    await seedRecords({
      policyId: POLICY_ID,
      version: 1,
      lifecycle: 'SHADOW',
      count: 520,
      fails: 10,
    });
    // Not counted: another version, and a live verdict of this one.
    await seedRecords({
      policyId: POLICY_ID,
      version: 99,
      lifecycle: 'SHADOW',
      count: 5,
      fails: 5,
    });
    await seedRecords({ policyId: POLICY_ID, version: 1, lifecycle: 'ACTIVE', count: 5, fails: 5 });

    const view = await service.get(toolId);
    expect(view.versions[0].evidence).toMatchObject({
      shadowCalls: 520,
      labelledSamples: 0,
      falsePositives: 0,
      falsePositiveRate: null,
      unlabelledFails: 10,
    });
    expect(view.versions[0].gate?.promotable).toBe(false);
  });

  it('the labelling queue is a fixed pseudo-random order, paged without overlap', async () => {
    const first = await service.listRecords(toolId, 1, { labelled: false });
    expect(first.records).toHaveLength(25);
    expect(first.nextCursor).toBe(first.records[24].id);
    const second = await service.listRecords(toolId, 1, {
      labelled: false,
      cursor: first.nextCursor!,
    });
    expect(second.records).toHaveLength(25);
    const ids = new Set(first.records.map((record) => record.id));
    expect(second.records.some((record) => ids.has(record.id))).toBe(false);
    // The same order for anyone, on every read.
    const again = await service.listRecords(toolId, 1, { labelled: false });
    expect(again.records.map((r) => r.id)).toEqual(first.records.map((r) => r.id));
    expect(first.records[0]).toMatchObject({ request: { city: 'Lisbon' }, label: null });
  });

  it('the policy’s author cannot label its calls; a live verdict cannot be labelled at all', async () => {
    const [record] = (await service.listRecords(toolId, 1, { labelled: false })).records;
    expect(await codeOf(service.label(author, record.id, { label: TrialLabel.POLICY_RIGHT }))).toBe(
      'VERIFICATION_LABEL_REFUSED',
    );

    const [live] = (await dataSource.query(
      `SELECT id FROM verification_records WHERE lifecycle = 'ACTIVE' LIMIT 1`,
    )) as { id: string }[];
    expect(await codeOf(service.label(labeller, live.id, { label: TrialLabel.POLICY_RIGHT }))).toBe(
      'VERIFICATION_LABEL_REFUSED',
    );
    // And the table itself refuses one, whatever the service says.
    await expect(
      dataSource.query(
        `UPDATE verification_records
            SET label = 'POLICY_RIGHT', labelled_by = 'x', labelled_at = now() WHERE id = $1`,
        [live.id],
      ),
    ).rejects.toThrow(/chk_verification_records_label_shadow_only/);
  });

  it('an adjudicator labels 110 calls, one failure wrongly struck', async () => {
    const fails = (await dataSource.query(
      `SELECT id FROM verification_records
        WHERE decision_policy_id = $1 AND decision_policy_version = 1 AND lifecycle = 'SHADOW'
          AND verdict_status = 'FAIL' ORDER BY id`,
      [POLICY_ID],
    )) as { id: string }[];
    const passes = (await dataSource.query(
      `SELECT id FROM verification_records
        WHERE decision_policy_id = $1 AND decision_policy_version = 1 AND lifecycle = 'SHADOW'
          AND verdict_status = 'PASS' ORDER BY id LIMIT 100`,
      [POLICY_ID],
    )) as { id: string }[];
    for (const [index, { id }] of fails.entries()) {
      const label = index === 0 ? TrialLabel.POLICY_WRONG : TrialLabel.POLICY_RIGHT;
      await service.label(labeller, id, { label, note: index === 0 ? 'Valid result.' : undefined });
    }
    for (const { id } of passes) {
      await service.label(labeller, id, { label: TrialLabel.POLICY_RIGHT });
    }
    // Correcting one's own label is allowed; another operator's is not.
    const labelled = await service.label(labeller, passes[0].id, {
      label: TrialLabel.POLICY_RIGHT,
    });
    expect(labelled).toMatchObject({ label: 'POLICY_RIGHT', labelledBy: labeller.operatorId });
    expect(
      await codeOf(service.label(approver, passes[0].id, { label: TrialLabel.POLICY_WRONG })),
    ).toBe('VERIFICATION_LABEL_REFUSED');

    const view = await service.get(toolId);
    expect(view.versions[0].evidence).toMatchObject({
      shadowCalls: 520,
      labelledSamples: 110,
      falsePositives: 1,
      unlabelledFails: 0,
      labellers: { [labeller.operatorId]: 110 },
    });
    expect(view.versions[0].evidence.falsePositiveRate).toBeCloseTo(1 / 110);
    expect(view.versions[0].gate).toEqual({ promotable: true, failures: [] });
  });

  it('POL asks to switch it on (P-1): queued for a second operator, nothing promoted', async () => {
    const queued = await service.promote(author, toolId, 1, ACTION, null);
    expect(isApprovalQueued(queued)).toBe(true);
    approvalId = (queued as { approvalId: string }).approvalId;
    const view = await service.get(toolId);
    expect(view.versions[0]).toMatchObject({ lifecycle: 'SHADOW', pendingApprovalId: approvalId });
  });

  it('nothing is promoted when the override-log entry cannot be written', async () => {
    // A reason code the register's column cannot hold: the entry insert fails
    // after the promotion statement ran, so both roll back together.
    const error = await service
      .promote(
        author,
        toolId,
        1,
        { reasonCode: 'X'.repeat(80), note: NOTE },
        null,
        { ...approver, approvalId },
        POLICY_ID,
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const [row] = (await dataSource.query(
      `SELECT lifecycle, promoted_at FROM verification_policies
        WHERE policy_id = $1 AND policy_version = 1`,
      [POLICY_ID],
    )) as { lifecycle: string; promoted_at: Date | null }[];
    expect(row).toEqual({ lifecycle: 'SHADOW', promoted_at: null });
    const [approval] = (await dataSource.query(
      `SELECT status FROM operator_approvals WHERE id = $1`,
      [approvalId],
    )) as { status: string }[];
    expect(approval.status).toBe('PENDING');
  });

  it('POLA approves: ACTIVE, with evidence the server counted, and traffic resolves ACTIVE', async () => {
    const decided = await approvals.approve(approvalId, approver, null);
    expect(decided.approval.status).toBe('APPROVED');

    const [row] = (await dataSource.query(
      `SELECT lifecycle, promoted_by, promoted_at, promotion_evidence
         FROM verification_policies WHERE policy_id = $1 AND policy_version = 1`,
      [POLICY_ID],
    )) as {
      lifecycle: string;
      promoted_by: string;
      promoted_at: Date | null;
      promotion_evidence: Record<string, unknown>;
    }[];
    expect(row).toMatchObject({ lifecycle: 'ACTIVE', promoted_by: approver.operatorId });
    expect(row.promoted_at).not.toBeNull();
    expect(row.promotion_evidence).toMatchObject({
      shadowCalls: 520,
      labelledSamples: 110,
      falsePositives: 1,
      unlabelledFails: 0,
      requestedBy: author.operatorId,
      approvedBy: approver.operatorId,
      note: NOTE,
      source: 'verification_records',
      labellers: { [labeller.operatorId]: 110 },
    });

    // The CHECK holds: an ACTIVE row without its promotion record cannot exist.
    await expect(
      dataSource.query(
        `UPDATE verification_policies SET promoted_at = NULL
          WHERE policy_id = $1 AND policy_version = 1`,
        [POLICY_ID],
      ),
    ).rejects.toThrow();

    const resolved = await policies.resolveForTraffic(toolId);
    expect(resolved).toMatchObject({ lifecycle: PolicyLifecycle.ACTIVE });
    expect(resolved?.decisionPolicy).toMatchObject({ id: POLICY_ID, version: 1 });

    // Labels stop once the version left SHADOW (its trial calls stay readable).
    const [anyRecord] = (await dataSource.query(
      `SELECT id FROM verification_records
        WHERE decision_policy_id = $1 AND decision_policy_version = 1 AND lifecycle = 'SHADOW'
          AND label IS NULL LIMIT 1`,
      [POLICY_ID],
    )) as { id: string }[];
    expect(
      await codeOf(service.label(labeller, anyRecord.id, { label: TrialLabel.POLICY_RIGHT })),
    ).toBe('VERIFICATION_LABEL_REFUSED');
  });

  it('an approver who wrote the policy is refused', async () => {
    // POLA registers v2; POL asks; the same POLA cannot approve it.
    await service.register(approver, toolId, { ...ACTION }, null);
    await seedRecords({
      policyId: POLICY_ID,
      version: 2,
      lifecycle: 'SHADOW',
      count: 500,
      fails: 0,
    });
    const ids = (await dataSource.query(
      `SELECT id FROM verification_records
        WHERE decision_policy_id = $1 AND decision_policy_version = 2 ORDER BY id LIMIT 100`,
      [POLICY_ID],
    )) as { id: string }[];
    for (const { id } of ids) await service.label(labeller, id, { label: TrialLabel.POLICY_RIGHT });
    const queued = await service.promote(author, toolId, 2, ACTION, null);
    expect(isApprovalQueued(queued)).toBe(true);
    expect(
      await codeOf(
        approvals.approve((queued as { approvalId: string }).approvalId, approver, null),
      ),
    ).toBe('OPERATOR_SELF_APPROVAL_REFUSED');
    await approvals.reject((queued as { approvalId: string }).approvalId, author);
  });

  it('P-3 withdraws: the kill switch is engaged and the row is WITHDRAWN, logged as break-glass', async () => {
    const view = await service.withdraw(
      sre,
      toolId,
      1,
      { ...ACTION, note: 'Strikes honest providers on empty pages.' },
      null,
    );
    expect(killSwitch.isKilled(POLICY_ID, 1)).toMatchObject({ actor: sre.operatorId });
    expect(view.versions.find((v) => v.version === 1)).toMatchObject({
      lifecycle: 'WITHDRAWN',
      withdrawnBy: sre.operatorId,
      withdrawnReason: 'Strikes honest providers on empty pages.',
    });
    const [entry] = (await dataSource.query(
      `SELECT break_glass FROM override_log_entries WHERE code = 'P-3'`,
    )) as { break_glass: boolean }[];
    expect(entry.break_glass).toBe(true);
    // The trial v2 now serves.
    expect((await policies.resolveForTraffic(toolId))?.lifecycle).toBe(PolicyLifecycle.SHADOW);
  });
});
