import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { OperatorApprovalRepository } from '@database/postgres/repositories/operator-approval.repository';
import { OperatorRepository } from '@database/postgres/repositories/operator.repository';
import { OverrideLogEntryRepository } from '@database/postgres/repositories/override-log-entry.repository';
import { OperatorRole } from '@modules/operator/domain/override-register';
import { ApprovalQueuedDto } from '@modules/operator/dto/operator-approval.dto';
import { OperatorErrorCode } from '@modules/operator/errors/operator.errors';
import { OperatorApprover, OperatorSession } from '@modules/operator/ports/operator-session.port';
import { OperatorApprovalService } from '@modules/operator/services/operator-approval.service';
import { OperatorService } from '@modules/operator/services/operator.service';
import { OverrideLogService } from '@modules/operator/services/override-log.service';
import { SlashErrorCode, SlashErrors } from '@modules/slash/errors/slash.errors';

import { freshMigratedDatabase } from '../helpers/slash-prorata-context';

/**
 * The two-person approvals queue against a real Postgres: the real register,
 * the real `operator_approvals` rows and the real override log.
 *
 * The action under test is a stand-in registered for this suite under `S-5`
 * (two-person, approved by `ADJL` or `TRE`). It writes nothing but its
 * register entry, and it refuses while its target is marked as moved on, so
 * the queue's own behaviour — queue, approve, refuse, expire, reject, race —
 * is what is asserted, not any one domain action.
 */
const DATABASE = 'assay_operator_approvals_test';
const ACTION = 'test.compensate';
const AMOUNT = '1000000';
const NOTE = 'n'.repeat(120);

describe('the approvals queue, against a real database', () => {
  let dataSource: DataSource;
  let approvals: OperatorApprovalService;
  let lead: OperatorSession;
  let treasurer: OperatorSession;
  let queue: (requester: OperatorSession, target: string) => Promise<string | ApprovalQueuedDto>;
  /** Targets the action refuses, as a case that moved on would be refused. */
  const movedOn = new Set<string>();

  beforeAll(async () => {
    dataSource = await freshMigratedDatabase(DATABASE);
    const overrides = new OverrideLogService(
      dataSource,
      new OverrideLogEntryRepository(dataSource),
      new OperatorApprovalRepository(dataSource),
    );
    const operators = new OperatorRepository(dataSource);
    approvals = new OperatorApprovalService(
      new OperatorApprovalRepository(dataSource),
      operators,
      new OperatorService(operators, { get: () => undefined } as never),
    );

    const act = (
      actor: OperatorSession,
      target: string,
      requestId: string | null,
      approver: OperatorApprover | null,
    ) =>
      overrides.perform<string>(
        {
          code: 'S-5',
          actor,
          approver,
          targetType: 'slash_proposal',
          targetId: target,
          organizationId: null,
          reasonCode: 'TEST_COMPENSATION',
          reason: NOTE,
          requestId,
          amountMinor: AMOUNT,
        },
        async () => {
          if (movedOn.has(target)) throw SlashErrors.invalidTransition({ from: 'moved', to: 'on' });
          return { value: target, before: {}, after: { done: true } };
        },
      );
    approvals.register(ACTION, {
      code: 'S-5',
      run: (requester, approver, payload, requestId) =>
        act(requester, payload.target as string, requestId, approver),
    });
    queue = (requester: OperatorSession, target: string) =>
      approvals.orQueue(
        { action: ACTION, target: `test:${target}`, payload: { target }, requester },
        () => act(requester, target, null, null),
      );

    lead = await seedOperator('ops-adjl', [OperatorRole.ADJL]);
    treasurer = await seedOperator('ops-tre', [OperatorRole.TRE]);
  }, 300_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  async function seedOperator(
    subject: string,
    roles: OperatorRole[],
    authorityLimitMinor: string | null = null,
  ): Promise<OperatorSession> {
    const id = randomUUID();
    await dataSource.query(
      `INSERT INTO operators (id, subject, display_name, email, roles, status, authority_limit_minor)
       VALUES ($1, $2, $2, $3, $4::jsonb, 'ACTIVE', $5)`,
      [id, subject, `${subject}@example.test`, JSON.stringify(roles), authorityLimitMinor],
    );
    return {
      operatorId: id,
      subject,
      displayName: subject,
      email: `${subject}@example.test`,
      roles,
      authorityLimitMinor,
    };
  }

  const one = async <T>(sql: string, params: unknown[]): Promise<T> =>
    ((await dataSource.query(sql, params)) as T[])[0];
  const approval = (id: string) =>
    one<{ status: string }>(`SELECT status FROM operator_approvals WHERE id = $1`, [id]);
  const entries = async (target: string): Promise<string[]> =>
    (
      (await dataSource.query(
        `SELECT code FROM override_log_entries WHERE target_id = $1 ORDER BY created_at`,
        [target],
      )) as { code: string }[]
    ).map((row) => row.code);

  async function queued(requester: OperatorSession = lead) {
    const target = randomUUID();
    const result = await queue(requester, target);
    expect(result).toBeInstanceOf(ApprovalQueuedDto);
    return { target, approvalId: (result as ApprovalQueuedDto).approvalId };
  }

  it('queues a two-person action, and a second operator’s approval runs it', async () => {
    const { target, approvalId } = await queued();
    expect(await entries(target)).toEqual([]);

    const decided = await approvals.approve(approvalId, treasurer, null);

    expect(decided.approval).toMatchObject({ status: 'APPROVED', approvedBy: 'ops-tre' });
    expect(
      await one(
        `SELECT actor_operator_id, approver_operator_id, approval_mode FROM override_log_entries
          WHERE target_id = $1 AND code = 'S-5'`,
        [target],
      ),
    ).toEqual({
      actor_operator_id: lead.operatorId,
      approver_operator_id: treasurer.operatorId,
      approval_mode: 'TWO_PERSON',
    });
  });

  it('refuses the requester approving their own request', async () => {
    const { approvalId } = await queued();
    await expect(approvals.approve(approvalId, lead, null)).rejects.toMatchObject({
      errorCode: OperatorErrorCode.OPERATOR_SELF_APPROVAL_REFUSED,
    });
    expect((await approval(approvalId)).status).toBe('PENDING');
  });

  it('refuses an approver without the role, or without the limit, and stays pending', async () => {
    const { target, approvalId } = await queued();
    const sre = await seedOperator(`ops-sre-${randomUUID()}`, [OperatorRole.SRE]);
    const capped = await seedOperator(`ops-tre-${randomUUID()}`, [OperatorRole.TRE], '1');

    await expect(approvals.approve(approvalId, sre, null)).rejects.toMatchObject({
      errorCode: OperatorErrorCode.OPERATOR_APPROVER_ROLE_REQUIRED,
    });
    await expect(approvals.approve(approvalId, capped, null)).rejects.toMatchObject({
      errorCode: OperatorErrorCode.OPERATOR_APPROVER_AUTHORITY_EXCEEDED,
    });
    expect((await approval(approvalId)).status).toBe('PENDING');
    expect(await entries(target)).toEqual([]);
  });

  it('re-validates at approval time: a target that moved on is refused, and stays pending', async () => {
    const { target, approvalId } = await queued();
    movedOn.add(target);

    await expect(approvals.approve(approvalId, treasurer, null)).rejects.toMatchObject({
      errorCode: SlashErrorCode.SLASH_INVALID_TRANSITION,
    });
    expect((await approval(approvalId)).status).toBe('PENDING');
    expect(await entries(target)).toEqual([]);
  });

  it('refuses an approval whose requester has since been removed', async () => {
    const requester = await seedOperator(`ops-adjl-${randomUUID()}`, [OperatorRole.ADJL]);
    const { target, approvalId } = await queued(requester);
    await dataSource.query(
      `UPDATE operators SET status = 'REMOVED', removed_at = now() WHERE id = $1`,
      [requester.operatorId],
    );

    await expect(approvals.approve(approvalId, treasurer, null)).rejects.toMatchObject({
      errorCode: OperatorErrorCode.OPERATOR_NOT_AUTHORIZED,
    });
    expect(await entries(target)).toEqual([]);
  });

  it('expires after its window, and cannot then be approved', async () => {
    const { target, approvalId } = await queued();
    await dataSource.query(
      `UPDATE operator_approvals SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [approvalId],
    );

    await expect(approvals.approve(approvalId, treasurer, null)).rejects.toMatchObject({
      errorCode: OperatorErrorCode.OPERATOR_APPROVAL_NOT_PENDING,
    });
    expect((await approval(approvalId)).status).toBe('EXPIRED');
    expect(await entries(target)).toEqual([]);
  });

  it('reads a lapsed request as EXPIRED without writing, exactly as the swept row reads', async () => {
    const { approvalId } = await queued();
    await dataSource.query(
      `UPDATE operator_approvals SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [approvalId],
    );
    const ids = async (status?: 'PENDING' | 'EXPIRED') =>
      (await approvals.list({ status, action: ACTION, limit: 100 } as never)).items.map(
        (item) => item.id,
      );

    const read = await approvals.get(approvalId);
    const listedPending = await ids('PENDING');
    const listedExpired = await ids('EXPIRED');
    const listedAll = await ids();
    // A read writes nothing now.
    expect((await approval(approvalId)).status).toBe('PENDING');

    // What the old read path did first: sweep, then read.
    await new OperatorApprovalRepository(dataSource).expireStale();
    expect((await approval(approvalId)).status).toBe('EXPIRED');
    const swept = await approvals.get(approvalId);

    expect({ ...read, decidedAt: null }).toEqual({ ...swept, decidedAt: null });
    expect(read.status).toBe('EXPIRED');
    expect(read.decidedAt).toBeInstanceOf(Date);
    expect(listedPending).not.toContain(approvalId);
    expect(listedExpired).toContain(approvalId);
    expect(await ids('PENDING')).toEqual(listedPending);
    expect(await ids('EXPIRED')).toEqual(listedExpired);
    expect(await ids()).toEqual(listedAll);
  });

  it('still lists a live request as PENDING', async () => {
    const { approvalId } = await queued();
    const listed = await approvals.list({ status: 'PENDING', limit: 100 } as never);
    expect(listed.items.find((item) => item.id === approvalId)?.status).toBe('PENDING');
    expect((await approvals.get(approvalId)).decidedAt).toBeNull();
  });

  it('is closed by a rejection, and cannot then be approved', async () => {
    const { target, approvalId } = await queued();

    const rejected = await approvals.reject(approvalId, treasurer);

    expect(rejected.approval).toMatchObject({ status: 'REJECTED', rejectedBy: 'ops-tre' });
    await expect(approvals.approve(approvalId, treasurer, null)).rejects.toMatchObject({
      errorCode: OperatorErrorCode.OPERATOR_APPROVAL_NOT_PENDING,
    });
    expect(await entries(target)).toEqual([]);
  });

  it('runs once when two operators approve at the same moment', async () => {
    const { target, approvalId } = await queued();
    const other = await seedOperator(`ops-tre-${randomUUID()}`, [OperatorRole.TRE]);

    const results = await Promise.allSettled([
      approvals.approve(approvalId, treasurer, null),
      approvals.approve(approvalId, other, null),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await entries(target)).toEqual(['S-5']);
  });
});
