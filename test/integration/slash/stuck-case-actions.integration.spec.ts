import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { OperatorApprovalRepository } from '@database/postgres/repositories/operator-approval.repository';
import { OperatorRepository } from '@database/postgres/repositories/operator.repository';
import { OverrideLogEntryRepository } from '@database/postgres/repositories/override-log-entry.repository';
import { ProviderChainEnrolmentRepository } from '@database/postgres/repositories/provider-chain-enrolment.repository';
import { SlaWindowCallRepository } from '@database/postgres/repositories/sla-window-call.repository';
import { SlashProposalEventRepository } from '@database/postgres/repositories/slash-proposal-event.repository';
import { SlashProposalPartRepository } from '@database/postgres/repositories/slash-proposal-part.repository';
import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';
import { OperatorRole } from '@modules/operator/domain/override-register';
import { ApprovalQueuedDto } from '@modules/operator/dto/operator-approval.dto';
import { OperatorErrorCode } from '@modules/operator/errors/operator.errors';
import { OperatorSession } from '@modules/operator/ports/operator-session.port';
import {
  CASE_APPROVAL_ACTIONS,
  OperatorCaseService,
} from '@modules/operator/services/operator-case.service';
import {
  OperatorApprovalService,
  payloadHash,
} from '@modules/operator/services/operator-approval.service';
import { OperatorService } from '@modules/operator/services/operator.service';
import { OverrideLogService } from '@modules/operator/services/override-log.service';
import { SlashErrorCode } from '@modules/slash/errors/slash.errors';
import { SlashRecordSnapshot } from '@modules/slash/ports/slash-executor.port';
import { SlashExecutionService } from '@modules/slash/services/slash-execution.service';
import { SlashPartsService } from '@modules/slash/services/slash-parts.service';
import {
  deriveChainRequestId,
  SlashProposalService,
} from '@modules/slash/services/slash-proposal.service';
import { SlashStuckCaseService } from '@modules/slash/services/slash-stuck-case.service';

import { CHAIN } from '../../unit/chains/evm/helpers/fake-stake-chain';
import { freshMigratedDatabase, TEST_SLASH_CONFIG } from '../helpers/slash-prorata-context';
import { seedProRataCase } from '../helpers/slash-prorata-seed';

/**
 * B18: the three operator actions for a case stuck behind a requested cancel,
 * against a real Postgres built from every migration — the real override
 * register, the real approvals queue, the real slash services and the real
 * admin-cancel sweep — with only the chain read (and notifications) stubbed.
 *
 * Asserted is what is on disk afterwards: the case row, its timeline, the
 * override register and the approval rows. A refusal that still wrote is the
 * defect these guards exist for.
 */
const DATABASE = 'assay_stuck_case_actions_test';
const EVM_ASSET = `${CHAIN}/erc20:0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3`;
const AGENT = `${CHAIN}:0x976ea74026e726554db657fa54763abd0c3a0aa9`;
const DAY = 24 * 60 * 60 * 1000;
const PENALTY = 1_000_000n;
const BODY = {
  reasonCode: 'CHAIN_STATE',
  note: 'The record was read on chain and this matches it.',
};

type Read = SlashRecordSnapshot | null | Error;

describe('stuck-case actions (B18), against a real database', () => {
  let dataSource: DataSource;
  let proposals: SlashProposalRepository;
  let execution: SlashExecutionService;
  let cases: OperatorCaseService;
  let approvals: OperatorApprovalService;
  let approvalRows: OperatorApprovalRepository;
  /** What the chain says, per request id. */
  const chain = new Map<string, Read>();

  let lead: OperatorSession;
  let treasury: OperatorSession;
  let adjudicator: OperatorSession;
  let lowLimitTreasury: OperatorSession;
  /** The register repository, to fault-inject its append (review M1). */
  let entries: OverrideLogEntryRepository;
  /** Provider notices sent, by case id (review M1: only after commit). */
  const notices: string[] = [];
  /** The options of every chain read (review m3: the actions read finalized). */
  const reads: { requestId: string; options: unknown }[] = [];

  beforeAll(async () => {
    dataSource = await freshMigratedDatabase(DATABASE);
    proposals = new SlashProposalRepository(dataSource);
    const notifications = {
      notify: async (notice: { subjectId?: string }) => {
        notices.push(notice.subjectId ?? '');
        return { deliveredNow: false };
      },
    } as never;
    const lifecycle = new SlashProposalService(
      proposals,
      new SlashProposalEventRepository(dataSource),
      notifications,
      TEST_SLASH_CONFIG,
    );
    entries = new OverrideLogEntryRepository(dataSource);
    const overrides = new OverrideLogService(
      dataSource,
      entries,
      new OperatorApprovalRepository(dataSource),
    );
    const executor = {
      readRecord: async (
        requestId: string,
        _provider: string,
        _chain: string,
        options?: unknown,
      ) => {
        reads.push({ requestId, options });
        // A real RPC answers asynchronously; so does this.
        await new Promise((resolve) => setTimeout(resolve, 5));
        const read = chain.get(requestId) ?? null;
        if (read instanceof Error) throw read;
        return read;
      },
    };
    const partsRepository = new SlashProposalPartRepository(dataSource);
    const enrolments = new ProviderChainEnrolmentRepository(dataSource);
    const windowCalls = new SlaWindowCallRepository(dataSource);
    const parts = new SlashPartsService(
      partsRepository,
      windowCalls,
      executor as never,
      { dustReportBelowMinor: 0n, stragglerMaxAttempts: 3, stragglerDeadlineMs: 1 },
      null,
      null,
    );
    execution = new SlashExecutionService(
      proposals,
      enrolments,
      lifecycle,
      overrides,
      notifications,
      TEST_SLASH_CONFIG,
      executor as never,
      { distribute: async () => 0 } as never,
      null,
      parts,
    );
    const stuck = new SlashStuckCaseService(
      proposals,
      partsRepository,
      enrolments,
      lifecycle,
      overrides,
      execution,
      executor as never,
      windowCalls,
    );
    const operators = new OperatorRepository(dataSource);
    approvalRows = new OperatorApprovalRepository(dataSource);
    approvals = new OperatorApprovalService(
      approvalRows,
      operators,
      new OperatorService(operators, { get: () => undefined } as never),
    );
    cases = new OperatorCaseService(
      proposals,
      null as never,
      execution,
      approvals,
      partsRepository,
      enrolments,
      executor as never,
      null,
      stuck,
    );

    lead = await seedOperator('b18-adjl', [OperatorRole.ADJL]);
    treasury = await seedOperator('b18-tre', [OperatorRole.TRE]);
    adjudicator = await seedOperator('b18-adj', [OperatorRole.ADJ]);
    lowLimitTreasury = await seedOperator('b18-tre-low', [OperatorRole.TRE], '1');
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

  /**
   * A window case opened before the parts model (no parts), its record
   * written on chain, now waiting on a requested cancel: the shape the
   * admin-cancel sweep cannot settle.
   */
  async function stuckCase(
    status: 'CANCELLED' | 'UPHELD',
    agents: readonly string[] = [AGENT],
  ): Promise<string> {
    const proposedAt = new Date(Date.now() - 6 * DAY);
    const seeded = await seedProRataCase(dataSource, {
      providerOrg: randomUUID(),
      // One stake authority per provider: enrolments are unique by account.
      stakeAuthority: `${CHAIN}:0x${randomUUID().replace(/-/g, '')}${'0'.repeat(8)}`,
      assetId: EVM_ASSET,
      penalty: PENALTY,
      agents: agents.map((account) => ({ account, failed: [100_000n] })),
      proposedAt,
    });
    const decided =
      status === 'CANCELLED'
        ? { outcome: null, kind: null }
        : { outcome: 'UPHELD_RECALCULATED', kind: 'ADJUDICATOR' };
    await dataSource.query(
      `UPDATE slash_proposals
          SET status = $2, outcome = $3::text, resolution_kind = $4::text,
              resolved_at = CASE WHEN $4::text IS NULL THEN NULL ELSE now() END,
              decided_by_operator_id = CASE WHEN $4::text IS NULL THEN NULL ELSE $5::uuid END,
              chain_status = 'CANCEL_REQUESTED', chain_proposed_at = $6, chain_executable_at = $7,
              chain_reserved = $8
        WHERE id = $1`,
      [
        seeded.proposalId,
        status,
        decided.outcome,
        decided.kind,
        lead.operatorId,
        new Date(proposedAt.getTime() + 60_000),
        new Date(proposedAt.getTime() + 3 * DAY),
        PENALTY.toString(),
      ],
    );
    chain.delete(seeded.chainRequestId);
    return seeded.proposalId;
  }

  function onChain(
    proposalId: string,
    status: SlashRecordSnapshot['status'] | null | Error,
    extra: Partial<SlashRecordSnapshot> = {},
  ) {
    const requestId = deriveChainRequestId({ id: proposalId, chainEpoch: 0 });
    if (status === null) {
      chain.set(requestId, null);
      return;
    }
    if (status instanceof Error) {
      chain.set(requestId, status);
      return;
    }
    const proposedAt = new Date(Date.now() - 6 * DAY);
    chain.set(requestId, {
      status,
      penaltyMinor: PENALTY.toString(),
      appliedMinor: status === 'EXECUTED' ? '400000' : '0',
      agentAmountMinor: status === 'EXECUTED' ? '380000' : '0',
      platformAmountMinor: status === 'EXECUTED' ? '20000' : '0',
      reservedMinor: PENALTY.toString(),
      proposedAt,
      executableAt: new Date(proposedAt.getTime() + 3 * DAY),
      executedAt: status === 'EXECUTED' ? new Date(Date.now() - DAY) : null,
      cancelledAt: status === 'CANCELLED' ? new Date(Date.now() - DAY) : null,
      cancelReason: status === 'CANCELLED' ? 'WITHDRAWN' : null,
      disputedAt: null,
      // The window's harmed agent: the contract paid the agent share to it.
      beneficiary: AGENT.split(':')[2],
      ...extra,
    });
  }

  const orgOf = async (id: string) =>
    (
      (await dataSource.query(`SELECT organization_id FROM slash_proposals WHERE id = $1`, [
        id,
      ])) as {
        organization_id: string;
      }[]
    )[0].organization_id;
  const row = async (id: string) =>
    (
      (await dataSource.query(
        `SELECT status, chain_status, chain_epoch, chain_request_id, chain_last_error,
                executed_at, applied_amount
           FROM slash_proposals WHERE id = $1`,
        [id],
      )) as Record<string, unknown>[]
    )[0];
  const events = async (id: string) =>
    (
      (await dataSource.query(
        `SELECT kind, actor_type, actor_id FROM slash_proposal_events
          WHERE proposal_id = $1 ORDER BY occurred_at, id`,
        [id],
      )) as { kind: string; actor_type: string; actor_id: string | null }[]
    ).filter((event) => event.kind !== 'PROPOSED');
  const register = async (id: string) =>
    (await dataSource.query(
      `SELECT code, actor_operator_id, approver_operator_id, approval_mode
         FROM override_log_entries WHERE target_id = $1 ORDER BY created_at`,
      [id],
    )) as {
      code: string;
      actor_operator_id: string;
      approver_operator_id: string | null;
      approval_mode: string;
    }[];
  const approvalsFor = async (id: string) =>
    (await dataSource.query(
      `SELECT id, action, status, requested_by, approved_by, payload FROM operator_approvals
        WHERE target = $1 ORDER BY created_at`,
      [`slash_proposal:${id}`],
    )) as {
      id: string;
      action: string;
      status: string;
      requested_by: string;
      approved_by: string | null;
      payload: Record<string, unknown>;
    }[];

  const refused = (reason: string) => ({
    errorCode: SlashErrorCode.SLASH_MANUAL_ACTION_REFUSED,
    publicContext: expect.objectContaining({ reason }),
  });

  // ── 1. close a cancel with nothing standing ─────────────────────────────

  describe('S-15 close a requested cancel with nothing standing', () => {
    it.each(['CANCELLED'] as const)(
      'a %s case whose record reads cancelled is closed, with an event and an override row',
      async (status) => {
        const id = await stuckCase(status);
        onChain(id, 'CANCELLED');
        await expect(cases.closeNothingStanding(lead, id, BODY, null)).resolves.toMatchObject({
          chainStatus: 'CANCELLED',
        });
        expect(await row(id)).toMatchObject({
          status,
          chain_status: 'CANCELLED',
          chain_last_error: null,
          executed_at: null,
        });
        expect(await events(id)).toEqual([
          { kind: 'CHAIN_CANCELLED', actor_type: 'operator', actor_id: lead.subject },
        ]);
        expect(await register(id)).toEqual([
          {
            code: 'S-15',
            actor_operator_id: lead.operatorId,
            approver_operator_id: null,
            approval_mode: 'SINGLE',
          },
        ]);
        // It has left "Cancels to sign" (the admin-cancel sweep's selection).
        const waiting = await proposals.findAwaitingAdminCancel(1000);
        expect(waiting.map((r) => r.id)).not.toContain(id);
      },
    );

    it.each([
      ['STANDING (Pending)', 'PENDING' as const, 'STANDING'],
      ['STANDING (Disputed)', 'DISPUTED' as const, 'STANDING'],
      ['EXECUTED', 'EXECUTED' as const, 'EXECUTED'],
      ['UNKNOWN (written, not found)', null, 'CHAIN_UNKNOWN'],
    ])('read %s: refused (%s), nothing written', async (_name, status, reason) => {
      const id = await stuckCase('CANCELLED');
      onChain(id, status);
      await expect(cases.closeNothingStanding(lead, id, BODY, null)).rejects.toMatchObject(
        refused(reason),
      );
      expect(await row(id)).toMatchObject({ chain_status: 'CANCEL_REQUESTED' });
      expect(await events(id)).toEqual([]);
      expect(await register(id)).toEqual([]);
    });

    it('an unreadable chain refuses with 503, nothing written', async () => {
      const id = await stuckCase('CANCELLED');
      onChain(id, new Error('rpc down'));
      await expect(cases.closeNothingStanding(lead, id, BODY, null)).rejects.toMatchObject({
        errorCode: SlashErrorCode.SLASH_CHAIN_UNAVAILABLE,
      });
      expect(await row(id)).toMatchObject({ chain_status: 'CANCEL_REQUESTED' });
      expect(await register(id)).toEqual([]);
    });

    it('an upheld case is not closed (it is re-proposed instead)', async () => {
      const id = await stuckCase('UPHELD');
      onChain(id, 'CANCELLED');
      await expect(cases.closeNothingStanding(lead, id, BODY, null)).rejects.toMatchObject(
        refused('UPHELD_USE_REPROPOSE'),
      );
      expect(await row(id)).toMatchObject({ chain_status: 'CANCEL_REQUESTED' });
    });

    it('a role outside the register row is refused before anything is written', async () => {
      const id = await stuckCase('CANCELLED');
      onChain(id, 'CANCELLED');
      await expect(cases.closeNothingStanding(adjudicator, id, BODY, null)).rejects.toMatchObject({
        errorCode: OperatorErrorCode.OPERATOR_ROLE_REQUIRED,
      });
      expect(await row(id)).toMatchObject({ chain_status: 'CANCEL_REQUESTED' });
      expect(await register(id)).toEqual([]);
    });

    it('double submit: two at once close it once; both answer closed, one event and one override row', async () => {
      const id = await stuckCase('CANCELLED');
      onChain(id, 'CANCELLED');
      const results = await Promise.all([
        cases.closeNothingStanding(lead, id, BODY, null),
        cases.closeNothingStanding(treasury, id, BODY, null),
      ]);
      expect(results.map((r) => r.chainStatus)).toEqual(['CANCELLED', 'CANCELLED']);
      expect(results.filter((r) => r.alreadyDone)).toHaveLength(1);
      expect(await events(id)).toHaveLength(1);
      expect(await register(id)).toHaveLength(1);
      // A third, later, gets the same answer and writes nothing.
      await expect(cases.closeNothingStanding(lead, id, BODY, null)).resolves.toMatchObject({
        chainStatus: 'CANCELLED',
        alreadyDone: true,
      });
      expect(await register(id)).toHaveLength(1);
    });

    it('m3: the action reads the record as of the finalized block', async () => {
      const id = await stuckCase('CANCELLED');
      onChain(id, 'CANCELLED');
      reads.length = 0;
      await cases.closeNothingStanding(lead, id, BODY, null);
      expect(reads).toContainEqual({
        requestId: deriveChainRequestId({ id, chainEpoch: 0 }),
        options: { finalized: true },
      });
    });

    it('with the admin-cancel sweep running at the same time, the close wins cleanly', async () => {
      const id = await stuckCase('CANCELLED');
      onChain(id, 'CANCELLED');
      await Promise.all([
        execution.sweepAdminCancels(),
        cases.closeNothingStanding(lead, id, BODY, null),
        execution.sweepAdminCancels(),
      ]);
      await execution.sweepAdminCancels();
      // The sweep's own note never lands on the closed row.
      expect(await row(id)).toMatchObject({ chain_status: 'CANCELLED', chain_last_error: null });
      expect(await register(id)).toHaveLength(1);
    });
  });

  // ── 2. record an execution that happened while the cancel waited ────────

  describe('S-16 record an execution', () => {
    it('is queued for a second person; a double submit returns the same request', async () => {
      const id = await stuckCase('CANCELLED');
      onChain(id, 'EXECUTED');
      const first = await cases.recordExecution(lead, id, BODY, null);
      const second = await cases.recordExecution(lead, id, BODY, null);
      expect(first).toBeInstanceOf(ApprovalQueuedDto);
      expect((second as ApprovalQueuedDto).approvalId).toBe(
        (first as ApprovalQueuedDto).approvalId,
      );
      const queued = await approvalsFor(id);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        action: CASE_APPROVAL_ACTIONS.recordExecution,
        status: 'PENDING',
        payload: expect.objectContaining({
          proposalId: id,
          expected: { chainEpoch: 0, chainRequestId: deriveChainRequestId({ id, chainEpoch: 0 }) },
        }),
      });
      // Nothing happened yet.
      expect(await row(id)).toMatchObject({ chain_status: 'CANCEL_REQUESTED', executed_at: null });
      expect(await register(id)).toEqual([]);
    });

    it('approved by a second operator: recorded once through the existing path, audited', async () => {
      const id = await stuckCase('CANCELLED');
      onChain(id, 'EXECUTED');
      const queued = (await cases.recordExecution(lead, id, BODY, null)) as ApprovalQueuedDto;

      await expect(approvals.approve(queued.approvalId, lead, null)).rejects.toMatchObject({
        errorCode: OperatorErrorCode.OPERATOR_SELF_APPROVAL_REFUSED,
      });
      await approvals.approve(queued.approvalId, treasury, null);

      expect(await row(id)).toMatchObject({
        status: 'CANCELLED',
        chain_status: 'EXECUTED',
        applied_amount: '400000',
      });
      expect((await row(id)).executed_at).not.toBeNull();
      expect((await events(id)).map((e) => e.kind)).toEqual(
        expect.arrayContaining(['EXECUTION_RECORDED_BY_OPERATOR', 'EXECUTED_AFTER_CLOSURE']),
      );
      expect(await register(id)).toEqual([
        {
          code: 'S-16',
          actor_operator_id: lead.operatorId,
          approver_operator_id: treasury.operatorId,
          approval_mode: 'TWO_PERSON',
        },
      ]);
      expect((await approvalsFor(id))[0]).toMatchObject({
        status: 'APPROVED',
        approved_by: treasury.operatorId,
      });
      // The brief no longer reads it as executed while the cancel waited.
      await expect(cases.recordExecution(lead, id, BODY, null)).rejects.toMatchObject(
        refused('NOT_CANCEL_REQUESTED'),
      );
    });

    it('m1: approved on an UPHELD case, the penalty closes as executed through the existing completion', async () => {
      const id = await stuckCase('UPHELD');
      onChain(id, 'EXECUTED');
      const queued = (await cases.recordExecution(lead, id, BODY, null)) as ApprovalQueuedDto;
      notices.length = 0;
      await approvals.approve(queued.approvalId, treasury, null);
      expect(await row(id)).toMatchObject({
        status: 'EXECUTED',
        chain_status: 'EXECUTED',
        applied_amount: '400000',
      });
      const kinds = (await events(id)).map((e) => e.kind);
      expect(kinds.filter((k) => k === 'EXECUTED')).toHaveLength(1);
      expect(kinds.filter((k) => k === 'EXECUTION_RECORDED_BY_OPERATOR')).toHaveLength(1);
      expect(await register(id)).toEqual([
        expect.objectContaining({ code: 'S-16', approver_operator_id: treasury.operatorId }),
      ]);
      expect((await proposals.findAwaitingAdminCancel(1000)).map((r) => r.id)).not.toContain(id);
      // The provider is told once, after the commit.
      expect(notices.filter((n) => n === id)).toHaveLength(1);
    });

    it('M1: a register failure rolls the recorded execution back with it; nothing is half-written', async () => {
      const id = await stuckCase('UPHELD');
      onChain(id, 'EXECUTED');
      const queued = (await cases.recordExecution(lead, id, BODY, null)) as ApprovalQueuedDto;
      notices.length = 0;
      const append = jest
        .spyOn(entries, 'append')
        .mockRejectedValueOnce(new Error('register down'));
      try {
        await expect(approvals.approve(queued.approvalId, treasury, null)).rejects.toThrow(
          'register down',
        );
      } finally {
        append.mockRestore();
      }
      // Neither the execution nor its audit exists.
      expect(await row(id)).toMatchObject({
        status: 'UPHELD',
        chain_status: 'CANCEL_REQUESTED',
        executed_at: null,
        applied_amount: null,
      });
      expect(await events(id)).toEqual([]);
      expect(await register(id)).toEqual([]);
      expect((await approvalsFor(id))[0].status).toBe('PENDING');
      expect(notices).not.toContain(id);

      // Retried, both exist.
      await approvals.approve(queued.approvalId, treasury, null);
      expect(await row(id)).toMatchObject({ status: 'EXECUTED', chain_status: 'EXECUTED' });
      expect(await register(id)).toHaveLength(1);
      expect((await approvalsFor(id))[0].status).toBe('APPROVED');
      expect(notices.filter((n) => n === id)).toHaveLength(1);
    });

    it('m5: an execution whose agent share went to anyone but a harmed agent is refused', async () => {
      const id = await stuckCase('CANCELLED');
      onChain(id, 'EXECUTED', { beneficiary: '0x00000000000000000000000000000000000000f1' });
      await expect(cases.recordExecution(lead, id, BODY, null)).rejects.toMatchObject(
        refused('BENEFICIARY_NOT_AN_AGENT'),
      );
      expect(await approvalsFor(id)).toEqual([]);
    });

    it('round 2: two harmed agents, the record paid one: refused, nothing queued', async () => {
      const other = `${CHAIN}:0x1111111111111111111111111111111111111111`;
      const id = await stuckCase('CANCELLED', [AGENT, other]);
      onChain(id, 'EXECUTED');
      await expect(cases.recordExecution(lead, id, BODY, null)).rejects.toMatchObject(
        refused('SPLIT_NOT_EXPRESSIBLE'),
      );
      expect(await approvalsFor(id)).toEqual([]);
    });

    it('m6: the indexer mirroring the same execution at the same time writes nothing; one record', async () => {
      const id = await stuckCase('CANCELLED');
      onChain(id, 'EXECUTED');
      const queued = (await cases.recordExecution(lead, id, BODY, null)) as ApprovalQueuedDto;
      const entity = (await proposals.findOneScoped(await orgOf(id), id))!;
      await Promise.all([
        execution.mirrorChainExecution(entity, '0xfeed'),
        approvals.approve(queued.approvalId, treasury, null),
        execution.mirrorChainExecution(entity, '0xfeed'),
      ]);
      expect(await row(id)).toMatchObject({ chain_status: 'EXECUTED', applied_amount: '400000' });
      expect((await events(id)).filter((e) => e.kind === 'EXECUTED_AFTER_CLOSURE')).toHaveLength(1);
      expect(await register(id)).toHaveLength(1);
    });

    it('m2: a request pinned to an older epoch is superseded, and a fresh one is queued', async () => {
      const id = await stuckCase('CANCELLED');
      onChain(id, 'EXECUTED');
      const first = (await cases.recordExecution(lead, id, BODY, null)) as ApprovalQueuedDto;
      // The case moved on to epoch 1 (its record there also reads executed).
      const nextId = deriveChainRequestId({ id, chainEpoch: 1 });
      await dataSource.query(
        `UPDATE slash_proposals SET chain_epoch = 1, chain_request_id = $2 WHERE id = $1`,
        [id, nextId],
      );
      chain.set(nextId, chain.get(deriveChainRequestId({ id, chainEpoch: 0 })) ?? null);
      const second = (await cases.recordExecution(lead, id, BODY, null)) as ApprovalQueuedDto;
      expect(second.approvalId).not.toBe(first.approvalId);
      const rows = await approvalsFor(id);
      expect(rows.find((r) => r.id === first.approvalId)?.status).toBe('EXPIRED');
      expect(rows.find((r) => r.id === second.approvalId)).toMatchObject({
        status: 'PENDING',
        payload: expect.objectContaining({ expected: { chainEpoch: 1, chainRequestId: nextId } }),
      });
    });

    it('two approvals of the same case at once: one records it, the other is refused', async () => {
      const id = await stuckCase('CANCELLED');
      onChain(id, 'EXECUTED');
      const queued = (await cases.recordExecution(lead, id, BODY, null)) as ApprovalQueuedDto;
      // A second request that slipped past the double-submit check.
      const payload = (await approvalsFor(id))[0].payload;
      const [other] = (await dataSource.query(
        `INSERT INTO operator_approvals (action, target, payload, payload_hash, requested_by, expires_at)
         VALUES ($1, $2, $3::jsonb, $4, $5, now() + interval '1 hour') RETURNING id`,
        [
          CASE_APPROVAL_ACTIONS.recordExecution,
          `slash_proposal:${id}`,
          JSON.stringify(payload),
          payloadHash(payload),
          treasury.operatorId,
        ],
      )) as { id: string }[];

      const results = await Promise.allSettled([
        approvals.approve(queued.approvalId, treasury, null),
        approvals.approve(other.id, lead, null),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await register(id)).toHaveLength(1);
      expect((await events(id)).filter((e) => e.kind === 'EXECUTED_AFTER_CLOSURE')).toHaveLength(1);
      // The loser's approval was not spent.
      expect((await approvalsFor(id)).map((a) => a.status).sort()).toEqual(['APPROVED', 'PENDING']);
    });

    it('an approver whose limit does not cover what the chain took is refused; nothing is written', async () => {
      const id = await stuckCase('CANCELLED');
      onChain(id, 'EXECUTED');
      const queued = (await cases.recordExecution(lead, id, BODY, null)) as ApprovalQueuedDto;
      await expect(
        approvals.approve(queued.approvalId, lowLimitTreasury, null),
      ).rejects.toMatchObject({
        errorCode: OperatorErrorCode.OPERATOR_APPROVER_AUTHORITY_EXCEEDED,
      });
      expect(await row(id)).toMatchObject({ chain_status: 'CANCEL_REQUESTED', executed_at: null });
      expect((await approvalsFor(id))[0].status).toBe('PENDING');
    });

    it.each([
      ['STANDING', 'PENDING' as const, 'STANDING'],
      ['GONE', 'CANCELLED' as const, 'NOT_EXECUTED'],
      ['UNKNOWN', null, 'CHAIN_UNKNOWN'],
    ])('read %s: refused at request time, nothing queued', async (_name, status, reason) => {
      const id = await stuckCase('CANCELLED');
      onChain(id, status);
      await expect(cases.recordExecution(lead, id, BODY, null)).rejects.toMatchObject(
        refused(reason),
      );
      expect(await approvalsFor(id)).toEqual([]);
    });

    it('a record that stopped reading executed by approval time is refused there', async () => {
      const id = await stuckCase('CANCELLED');
      onChain(id, 'EXECUTED');
      const queued = (await cases.recordExecution(lead, id, BODY, null)) as ApprovalQueuedDto;
      onChain(id, new Error('rpc down'));
      await expect(approvals.approve(queued.approvalId, treasury, null)).rejects.toMatchObject({
        errorCode: SlashErrorCode.SLASH_CHAIN_UNAVAILABLE,
      });
      expect(await row(id)).toMatchObject({ chain_status: 'CANCEL_REQUESTED', executed_at: null });
      expect((await approvalsFor(id))[0].status).toBe('PENDING');
    });
  });

  // ── 3. re-propose an upheld case stuck behind the cancel ─────────────────

  describe('S-17 re-propose', () => {
    it('approved: a fresh epoch, unproposed, that the existing propose pass selects', async () => {
      const id = await stuckCase('UPHELD');
      onChain(id, 'CANCELLED');
      const queued = (await cases.repropose(lead, id, BODY, null)) as ApprovalQueuedDto;
      expect(queued).toBeInstanceOf(ApprovalQueuedDto);
      expect(await row(id)).toMatchObject({ chain_status: 'CANCEL_REQUESTED', chain_epoch: 0 });

      // The checker must be able to read a case: Treasury may not approve it.
      await expect(approvals.approve(queued.approvalId, treasury, null)).rejects.toMatchObject({
        errorCode: OperatorErrorCode.OPERATOR_APPROVER_ROLE_REQUIRED,
      });
      await approvals.approve(queued.approvalId, adjudicator, null);

      expect(await row(id)).toMatchObject({
        status: 'UPHELD',
        chain_status: 'NONE',
        chain_epoch: 1,
        chain_request_id: deriveChainRequestId({ id, chainEpoch: 1 }),
        chain_last_error: null,
      });
      // Written at one instant; their order on the timeline is not the point.
      expect((await events(id)).map((e) => e.kind).sort()).toEqual([
        'CHAIN_CANCELLED',
        'REPROPOSAL_REQUESTED',
      ]);
      expect(await register(id)).toEqual([
        {
          code: 'S-17',
          actor_operator_id: lead.operatorId,
          approver_operator_id: adjudicator.operatorId,
          approval_mode: 'TWO_PERSON',
        },
      ]);
      const due = await proposals.findAwaitingChainProposal(new Date(), new Date(), 1000);
      expect(due.map((r) => r.id)).toContain(id);
    });

    it.each([
      ['disputed on chain', { disputedAt: new Date(Date.now() - 2 * DAY) }],
      ['expired unruled', { cancelReason: 'DISPUTE_UNRESOLVED' }],
    ])('a record the provider %s is never re-proposed (B7)', async (_name, extra) => {
      const id = await stuckCase('UPHELD');
      onChain(id, 'CANCELLED', extra);
      await expect(cases.repropose(lead, id, BODY, null)).rejects.toMatchObject(
        refused('DISPUTED_ON_CHAIN'),
      );
      expect(await approvalsFor(id)).toEqual([]);
    });

    it.each([
      ['STANDING', 'PENDING' as const, 'STANDING'],
      ['EXECUTED', 'EXECUTED' as const, 'EXECUTED'],
      ['UNKNOWN', null, 'CHAIN_UNKNOWN'],
    ])('read %s: refused, nothing queued', async (_name, status, reason) => {
      const id = await stuckCase('UPHELD');
      onChain(id, status);
      await expect(cases.repropose(lead, id, BODY, null)).rejects.toMatchObject(refused(reason));
      expect(await approvalsFor(id)).toEqual([]);
    });

    it('a closed case is not re-proposed', async () => {
      const id = await stuckCase('CANCELLED');
      onChain(id, 'CANCELLED');
      await expect(cases.repropose(lead, id, BODY, null)).rejects.toMatchObject(
        refused('CASE_STATUS'),
      );
    });

    it('an approval of a case that moved since the request is refused', async () => {
      const id = await stuckCase('UPHELD');
      onChain(id, 'CANCELLED');
      const queued = (await cases.repropose(lead, id, BODY, null)) as ApprovalQueuedDto;
      // Another path moved it to a new epoch meanwhile.
      await dataSource.query(
        `UPDATE slash_proposals SET chain_epoch = 1, chain_request_id = $2 WHERE id = $1`,
        [id, deriveChainRequestId({ id, chainEpoch: 1 })],
      );
      await expect(approvals.approve(queued.approvalId, adjudicator, null)).rejects.toMatchObject(
        refused('CHANGED'),
      );
      expect((await approvalsFor(id))[0].status).toBe('PENDING');
      expect(await register(id)).toEqual([]);
    });

    it('m6: a close and a re-propose racing after a status change: the compare-and-set lets one through', async () => {
      const id = await stuckCase('UPHELD');
      onChain(id, 'CANCELLED');
      const queued = (await cases.repropose(lead, id, BODY, null)) as ApprovalQueuedDto;
      // It was closed meanwhile.
      await dataSource.query(`UPDATE slash_proposals SET status = 'CANCELLED' WHERE id = $1`, [id]);
      const [closed, reproposed] = await Promise.allSettled([
        cases.closeNothingStanding(treasury, id, BODY, null),
        approvals.approve(queued.approvalId, adjudicator, null),
      ]);
      expect(closed.status).toBe('fulfilled');
      expect(reproposed.status).toBe('rejected');
      expect(await row(id)).toMatchObject({ chain_status: 'CANCELLED', chain_epoch: 0 });
      expect((await register(id)).map((r) => r.code)).toEqual(['S-15']);
    });

    it('with the admin-cancel sweep running at the same time, one clean fresh epoch', async () => {
      const id = await stuckCase('UPHELD');
      onChain(id, 'CANCELLED');
      const queued = (await cases.repropose(lead, id, BODY, null)) as ApprovalQueuedDto;
      await Promise.all([
        execution.sweepAdminCancels(),
        approvals.approve(queued.approvalId, adjudicator, null),
        execution.sweepAdminCancels(),
      ]);
      await execution.sweepAdminCancels();
      expect(await row(id)).toMatchObject({
        chain_status: 'NONE',
        chain_epoch: 1,
        chain_last_error: null,
      });
      expect(await register(id)).toHaveLength(1);
    });
  });
});
