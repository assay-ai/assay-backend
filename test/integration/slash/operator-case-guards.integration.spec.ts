import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { DisputeRepository } from '@database/postgres/repositories/dispute.repository';
import { FleetSweepRepository } from '@database/postgres/repositories/fleet-sweep.repository';
import { OverrideLogEntryRepository } from '@database/postgres/repositories/override-log-entry.repository';
import { ProviderChainEnrolmentRepository } from '@database/postgres/repositories/provider-chain-enrolment.repository';
import { SlaStrikeRepository } from '@database/postgres/repositories/sla-strike.repository';
import { SlashProposalEventRepository } from '@database/postgres/repositories/slash-proposal-event.repository';
import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';
import { OperatorRole } from '@modules/operator/domain/override-register';
import { OperatorSession } from '@modules/operator/ports/operator-session.port';
import { OverrideLogService } from '@modules/operator/services/override-log.service';
import { ArbitrationOutcome, DisputeClaimType } from '@modules/slash/domain/arbitration';
import { SlashProposalStatus } from '@modules/slash/domain/slash-proposal-state';
import { SlashErrorCode } from '@modules/slash/errors/slash.errors';
import { ArbitrationService } from '@modules/slash/services/arbitration.service';
import { SlashExecutionService } from '@modules/slash/services/slash-execution.service';
import { SlashProposalService } from '@modules/slash/services/slash-proposal.service';

import { CHAIN } from '../../unit/chains/evm/helpers/fake-stake-chain';
import { freshMigratedDatabase, TEST_SLASH_CONFIG } from '../helpers/slash-prorata-context';
import { seedProRataCase } from '../helpers/slash-prorata-seed';

/**
 * The operator's case actions against a real Postgres built from every
 * migration: the real arbitration service, the real override register and the
 * real dispute rows, with only the notification sink stubbed.
 *
 * What is asserted is what is on disk afterwards. A refusal that still wrote —
 * a dispute reopened on a resolved case, a penalty of `''`, an event on a
 * closed timeline — is the defect these guards exist for, and an in-memory fake
 * cannot show a row that was written before the error was thrown.
 */
const DATABASE = 'x402_operator_case_guards_test';
const ASSET = `${CHAIN}/erc20:0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3`;
const STAKE_AUTHORITY = `${CHAIN}:0xA271A3407D3302f4b4Fbe469b9188487cedd7d45`;
const AGENT = `${CHAIN}:0x976ea74026e726554db657fa54763abd0c3a0aa9`;
const PENALTY = 1_000_000n;
const NOTE = 'n'.repeat(120);

describe('operator case actions, against a real database', () => {
  let dataSource: DataSource;
  let arbitration: ArbitrationService;
  let execution: SlashExecutionService;
  let adjudicator: OperatorSession;
  let lead: OperatorSession;

  beforeAll(async () => {
    dataSource = await freshMigratedDatabase(DATABASE);

    const proposals = new SlashProposalRepository(dataSource);
    const notifications = { notify: async () => ({ deliveredNow: false }) } as never;
    const lifecycle = new SlashProposalService(
      proposals,
      new SlashProposalEventRepository(dataSource),
      notifications,
      TEST_SLASH_CONFIG,
    );
    const overrides = new OverrideLogService(
      dataSource,
      new OverrideLogEntryRepository(dataSource),
    );
    execution = new SlashExecutionService(
      proposals,
      new ProviderChainEnrolmentRepository(dataSource),
      new FleetSweepRepository(dataSource),
      lifecycle,
      overrides,
      notifications,
      TEST_SLASH_CONFIG,
      // No chain: nothing here may reach one.
      null,
    );
    arbitration = new ArbitrationService(
      proposals,
      new DisputeRepository(dataSource),
      new SlaStrikeRepository(dataSource),
      lifecycle,
      overrides,
      notifications,
      TEST_SLASH_CONFIG,
      execution,
    );

    adjudicator = await seedOperator('ops-adj', [OperatorRole.ADJ]);
    lead = await seedOperator('ops-adjl', [OperatorRole.ADJL]);
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

  /** A fresh case in `PROPOSED`, inside its response window. */
  async function proposed() {
    return seedProRataCase(dataSource, {
      providerOrg: randomUUID(),
      stakeAuthority: STAKE_AUTHORITY,
      assetId: ASSET,
      penalty: PENALTY,
      agents: [{ account: AGENT, failed: [100_000n] }],
      proposedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
  }

  /** A fresh case in `DISPUTED`, with a real objection on file. */
  async function disputed() {
    const seeded = await proposed();
    const { dispute } = await arbitration.fileDispute(seeded.organizationId, seeded.proposalId, {
      claimType: DisputeClaimType.AGENT_GRIEFING,
      reason: 'one agent sent every failing call',
      evidence: [],
      openedBy: 'provider@example.test',
    });
    return { ...seeded, disputeId: dispute.id };
  }

  const one = async <T>(sql: string, params: unknown[]): Promise<T> =>
    ((await dataSource.query(sql, params)) as T[])[0];

  const proposalRow = (id: string) =>
    one<{ status: string; penalty_amount: string; outcome: string | null }>(
      `SELECT status, penalty_amount, outcome FROM slash_proposals WHERE id = $1`,
      [id],
    );
  const disputeRow = (id: string) =>
    one<{ state: string; assigned_operator_id: string | null; outcome: string | null }>(
      `SELECT state, assigned_operator_id, outcome FROM disputes WHERE id = $1`,
      [id],
    );
  const eventKinds = async (proposalId: string): Promise<string[]> =>
    (
      (await dataSource.query(
        `SELECT kind FROM slash_proposal_events WHERE proposal_id = $1 ORDER BY occurred_at, id`,
        [proposalId],
      )) as { kind: string }[]
    ).map((row) => row.kind);
  const registerEntries = async (proposalId: string): Promise<string[]> =>
    (
      (await dataSource.query(
        `SELECT code FROM override_log_entries WHERE target_id = $1 ORDER BY created_at`,
        [proposalId],
      )) as { code: string }[]
    ).map((row) => row.code);

  describe('claim', () => {
    it('opens the review of a DISPUTED case', async () => {
      const seeded = await disputed();

      await arbitration.claim(adjudicator, seeded.organizationId, seeded.proposalId);

      expect((await proposalRow(seeded.proposalId)).status).toBe('UNDER_REVIEW');
      expect(await disputeRow(seeded.disputeId)).toMatchObject({
        state: 'UNDER_REVIEW',
        assigned_operator_id: adjudicator.operatorId,
      });
    });

    it('refuses a resolved case and leaves its objection resolved', async () => {
      const seeded = await disputed();
      await arbitration.claim(adjudicator, seeded.organizationId, seeded.proposalId);
      await arbitration.decide(adjudicator, seeded.organizationId, seeded.proposalId, {
        outcome: ArbitrationOutcome.OVERTURNED_GRIEFING,
        reasonCodes: ['SINGLE_AGENT_CONCENTRATION'],
        note: NOTE,
      });
      const proposalBefore = await proposalRow(seeded.proposalId);
      const disputeBefore = await disputeRow(seeded.disputeId);
      const eventsBefore = await eventKinds(seeded.proposalId);
      expect(proposalBefore.status).toBe('OVERTURNED');
      expect(disputeBefore.state).toBe('UPHELD');

      await expect(
        arbitration.claim(lead, seeded.organizationId, seeded.proposalId),
      ).rejects.toMatchObject({
        errorCode: SlashErrorCode.SLASH_INVALID_TRANSITION,
        statusCode: 409,
      });

      expect(await proposalRow(seeded.proposalId)).toEqual(proposalBefore);
      expect(await disputeRow(seeded.disputeId)).toEqual(disputeBefore);
      expect(await eventKinds(seeded.proposalId)).toEqual(eventsBefore);
    });

    it('refuses a PROPOSED case and a suspended one, appending no event', async () => {
      const seeded = await proposed();

      await expect(
        arbitration.claim(adjudicator, seeded.organizationId, seeded.proposalId),
      ).rejects.toMatchObject({ errorCode: SlashErrorCode.SLASH_INVALID_TRANSITION });
      expect(await eventKinds(seeded.proposalId)).toEqual([]);

      await arbitration.suspend(
        adjudicator,
        seeded.organizationId,
        seeded.proposalId,
        'OPERATOR_HOLD',
        'held while the mapping is checked',
      );
      await expect(
        arbitration.claim(adjudicator, seeded.organizationId, seeded.proposalId),
      ).rejects.toMatchObject({ errorCode: SlashErrorCode.SLASH_INVALID_TRANSITION });
      expect(await eventKinds(seeded.proposalId)).toEqual(['CANCELLED']);
    });
  });

  describe('decide UPHELD_RECALCULATED', () => {
    /**
     * From DISPUTED on purpose: DISPUTED → UPHELD is a legal edge, so this is
     * the path on which an unchecked amount was written as the penalty.
     */
    it.each(['', '0', '-5', '284.7', 'abc'])(
      'refuses the amount %p and writes nothing',
      async (recalculatedAmount) => {
        const seeded = await disputed();

        await expect(
          arbitration.decide(adjudicator, seeded.organizationId, seeded.proposalId, {
            outcome: ArbitrationOutcome.UPHELD_RECALCULATED,
            reasonCodes: ['PRICE_BASIS_WRONG'],
            note: NOTE,
            recalculatedAmount,
          }),
        ).rejects.toMatchObject({
          errorCode: SlashErrorCode.SLASH_RECALCULATED_AMOUNT_INVALID,
          statusCode: 422,
        });

        expect(await proposalRow(seeded.proposalId)).toEqual({
          status: 'DISPUTED',
          penalty_amount: PENALTY.toString(),
          outcome: null,
        });
        expect(await disputeRow(seeded.disputeId)).toMatchObject({ state: 'OPEN', outcome: null });
        expect(await registerEntries(seeded.proposalId)).toEqual([]);
        expect(await eventKinds(seeded.proposalId)).toEqual(['DISPUTE_FILED']);
      },
    );

    it('refuses an amount above the proposed penalty', async () => {
      const seeded = await disputed();

      await expect(
        arbitration.decide(adjudicator, seeded.organizationId, seeded.proposalId, {
          outcome: ArbitrationOutcome.UPHELD_RECALCULATED,
          reasonCodes: ['PRICE_BASIS_WRONG'],
          note: NOTE,
          recalculatedAmount: (PENALTY + 1n).toString(),
        }),
      ).rejects.toMatchObject({
        errorCode: SlashErrorCode.SLASH_RECALCULATION_EXCEEDS_ORIGINAL,
      });
      expect((await proposalRow(seeded.proposalId)).penalty_amount).toBe(PENALTY.toString());
    });

    it('records a lower amount as the penalty', async () => {
      const seeded = await disputed();

      await arbitration.decide(adjudicator, seeded.organizationId, seeded.proposalId, {
        outcome: ArbitrationOutcome.UPHELD_RECALCULATED,
        reasonCodes: ['PRICE_BASIS_WRONG'],
        note: NOTE,
        recalculatedAmount: '400000',
      });

      expect(await proposalRow(seeded.proposalId)).toEqual({
        status: 'UPHELD',
        penalty_amount: '400000',
        outcome: 'UPHELD_RECALCULATED',
      });
      expect(await registerEntries(seeded.proposalId)).toEqual(['S-3']);
    });
  });

  describe('wrong status', () => {
    it('refuses to extend the deadline of a case that has left PROPOSED', async () => {
      const seeded = await disputed();

      await expect(
        arbitration.extendDeadline(
          lead,
          seeded.organizationId,
          seeded.proposalId,
          2,
          'PROVIDER_REQUEST',
          'the provider asked for two more hours',
        ),
      ).rejects.toMatchObject({
        errorCode: SlashErrorCode.SLASH_INVALID_TRANSITION,
        statusCode: 409,
        message: 'Cannot extend the deadline while the case is DISPUTED; only while it is PROPOSED',
      });
      expect(await registerEntries(seeded.proposalId)).toEqual([]);
    });

    it('refuses to open a sweep from an undecided case', async () => {
      const seeded = await proposed();

      await expect(
        execution.openSweep(lead, adjudicator, seeded.organizationId, seeded.proposalId, {
          defectKey: 'mapping/v3',
          lookbackHours: 24,
          reasonCode: 'MAPPING_REGRESSION',
          note: NOTE,
        }),
      ).rejects.toMatchObject({
        errorCode: SlashErrorCode.SLASH_INVALID_TRANSITION,
        statusCode: 409,
      });
      expect(await registerEntries(seeded.proposalId)).toEqual([]);
      expect(
        await one<{ count: string }>(`SELECT count(*)::text AS count FROM fleet_sweeps`, []),
      ).toEqual({ count: '0' });
    });

    it('refuses to build a cancel for a case nobody decided to withdraw', async () => {
      const seeded = await proposed();
      const withExecutor = new SlashExecutionService(
        new SlashProposalRepository(dataSource),
        new ProviderChainEnrolmentRepository(dataSource),
        new FleetSweepRepository(dataSource),
        {} as never,
        {} as never,
        {} as never,
        TEST_SLASH_CONFIG,
        {
          buildCancel: async () => {
            throw new Error('a cancel must not be built for this case');
          },
        } as never,
      );

      await expect(
        withExecutor.buildCancelIntent(seeded.organizationId, seeded.proposalId),
      ).rejects.toMatchObject({
        errorCode: SlashErrorCode.SLASH_INVALID_TRANSITION,
        statusCode: 409,
      });
      expect((await proposalRow(seeded.proposalId)).status).toBe(SlashProposalStatus.PROPOSED);
    });
  });
});
