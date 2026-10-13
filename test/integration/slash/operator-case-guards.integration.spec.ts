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
import { OperatorErrorCode } from '@modules/operator/errors/operator.errors';
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

  /**
   * `S-11` — the second approver of a fleet sweep must hold `ADJ` or `ADJL`.
   * A sweep carries one conclusion to providers who never complained, so
   * authenticating as *an* operator is not enough to be its checker.
   */
  describe('the fleet sweep approver', () => {
    const SWEEP = {
      defectKey: 'mapping/no-such-defect',
      lookbackHours: 24,
      reasonCode: 'MAPPING_REGRESSION',
      note: NOTE,
    };

    /** A case two adjudicators overturned as a platform defect — a sweepable source. */
    async function overturnedAsPlatformDefect() {
      const seeded = await disputed();
      await arbitration.decide(adjudicator, seeded.organizationId, seeded.proposalId, {
        outcome: ArbitrationOutcome.OVERTURNED_PLATFORM_DEFECT,
        reasonCodes: ['MAPPING_REGRESSION'],
        note: NOTE,
      });
      await arbitration.second(lead, seeded.organizationId, seeded.proposalId, 'SIGNED', NOTE);
      expect((await proposalRow(seeded.proposalId)).status).toBe('OVERTURNED');
      return seeded;
    }

    const sweepCount = async () =>
      (await one<{ count: string }>(`SELECT count(*)::text AS count FROM fleet_sweeps`, [])).count;

    it.each([[OperatorRole.POL], [OperatorRole.SRE]])(
      'refuses a %s approver and opens no sweep',
      async (role) => {
        const seeded = await overturnedAsPlatformDefect();
        const approver = await seedOperator(`ops-${role.toLowerCase()}-${randomUUID()}`, [role]);
        const sweepsBefore = await sweepCount();
        const registerBefore = await registerEntries(seeded.proposalId);

        await expect(
          execution.openSweep(lead, approver, seeded.organizationId, seeded.proposalId, SWEEP),
        ).rejects.toMatchObject({
          errorCode: OperatorErrorCode.OPERATOR_APPROVER_ROLE_REQUIRED,
          statusCode: 403,
          message: `The second approver must hold one of: ADJ, ADJL (S-11) — held: ${role}`,
        });

        expect(await sweepCount()).toBe(sweepsBefore);
        expect(await registerEntries(seeded.proposalId)).toEqual(registerBefore);
      },
    );

    it('accepts an ADJ approver, and the register names them', async () => {
      const seeded = await overturnedAsPlatformDefect();
      const sweepsBefore = Number(await sweepCount());

      const sweep = await execution.openSweep(
        lead,
        adjudicator,
        seeded.organizationId,
        seeded.proposalId,
        SWEEP,
      );

      expect(sweep.sourceProposalId).toBe(seeded.proposalId);
      expect(Number(await sweepCount())).toBe(sweepsBefore + 1);
      expect(
        await one<{ approver_operator_id: string; approval_mode: string }>(
          `SELECT approver_operator_id, approval_mode FROM override_log_entries
            WHERE target_id = $1 AND code = 'S-11'`,
          [seeded.proposalId],
        ),
      ).toEqual({ approver_operator_id: adjudicator.operatorId, approval_mode: 'TWO_PERSON' });
    });

    it('still refuses the actor as their own approver', async () => {
      const seeded = await overturnedAsPlatformDefect();

      await expect(
        execution.openSweep(lead, lead, seeded.organizationId, seeded.proposalId, SWEEP),
      ).rejects.toMatchObject({
        errorCode: OperatorErrorCode.OPERATOR_SELF_APPROVAL_REFUSED,
      });
    });
  });

  /** Security review H-3 and L-2, against the real register and the real CHECKs. */
  describe('recalculating a material penalty', () => {
    const MATERIAL = 28_470_000n;

    async function disputedAt(penalty: bigint) {
      const seeded = await seedProRataCase(dataSource, {
        providerOrg: randomUUID(),
        stakeAuthority: STAKE_AUTHORITY,
        assetId: ASSET,
        penalty,
        agents: [{ account: AGENT, failed: [100_000n] }],
        proposedAt: new Date(Date.now() - 60 * 60 * 1000),
      });
      await arbitration.fileDispute(seeded.organizationId, seeded.proposalId, {
        claimType: DisputeClaimType.AGENT_GRIEFING,
        reason: 'one agent sent every failing call',
        evidence: [],
        openedBy: 'provider@example.test',
      });
      return seeded;
    }

    const recalculateToOne = (
      who: OperatorSession,
      seeded: { organizationId: string; proposalId: string },
    ) =>
      arbitration.decide(who, seeded.organizationId, seeded.proposalId, {
        outcome: ArbitrationOutcome.UPHELD_RECALCULATED,
        reasonCodes: ['PRICE_BASIS_WRONG'],
        note: NOTE,
        recalculatedAmount: '1',
      });

    it('refuses an adjudicator whose limit is below the original penalty', async () => {
      const seeded = await disputedAt(MATERIAL);
      const limited = {
        ...(await seedOperator(`ops-adj-limited-${randomUUID()}`, [OperatorRole.ADJ])),
        authorityLimitMinor: '5000000',
      };

      await expect(recalculateToOne(limited, seeded)).rejects.toMatchObject({
        errorCode: OperatorErrorCode.OPERATOR_AUTHORITY_EXCEEDED,
        statusCode: 403,
      });
      expect(await proposalRow(seeded.proposalId)).toEqual({
        status: 'DISPUTED',
        penalty_amount: MATERIAL.toString(),
        outcome: null,
      });
      expect(await registerEntries(seeded.proposalId)).toEqual([]);
    });

    it('holds a cut to one minor unit for a second signature, and binds it only then', async () => {
      const seeded = await disputedAt(MATERIAL);

      await recalculateToOne(adjudicator, seeded);

      expect(await proposalRow(seeded.proposalId)).toEqual({
        status: 'AWAITING_SECOND',
        penalty_amount: MATERIAL.toString(),
        outcome: null,
      });

      await arbitration.second(lead, seeded.organizationId, seeded.proposalId, 'SIGNED', NOTE);

      expect(await proposalRow(seeded.proposalId)).toEqual({
        status: 'UPHELD',
        penalty_amount: '1',
        outcome: 'UPHELD_RECALCULATED',
      });
      expect(await registerEntries(seeded.proposalId)).toEqual(['S-3', 'S-12']);
    });

    it('leaves the original penalty when the second reader objects', async () => {
      const seeded = await disputedAt(MATERIAL);
      await recalculateToOne(adjudicator, seeded);

      await arbitration.second(lead, seeded.organizationId, seeded.proposalId, 'OBJECTED', NOTE);

      expect(await proposalRow(seeded.proposalId)).toEqual({
        status: 'UNDER_REVIEW',
        penalty_amount: MATERIAL.toString(),
        outcome: null,
      });
    });
  });

  /** Security review H-4: a case two people upheld is not one person's to cancel. */
  describe('suspending an upheld case', () => {
    async function upheld() {
      const seeded = await disputed();
      await arbitration.decide(adjudicator, seeded.organizationId, seeded.proposalId, {
        outcome: ArbitrationOutcome.UPHELD,
        reasonCodes: ['RATE_GENUINELY_EXCEEDED'],
        note: NOTE,
      });
      expect((await proposalRow(seeded.proposalId)).status).toBe('UPHELD');
      return seeded;
    }

    const suspend = (
      seeded: { organizationId: string; proposalId: string },
      approver: OperatorSession | null,
    ) =>
      arbitration.suspend(
        lead,
        seeded.organizationId,
        seeded.proposalId,
        'OPERATOR_HOLD',
        'held while the mapping is checked',
        null,
        null,
        approver,
      );

    it('refuses without an approver, and with an SRE approver, writing nothing', async () => {
      const seeded = await upheld();
      const sre = await seedOperator(`ops-sre-${randomUUID()}`, [OperatorRole.SRE]);

      await expect(suspend(seeded, null)).rejects.toMatchObject({
        errorCode: OperatorErrorCode.OPERATOR_SECOND_APPROVER_REQUIRED,
      });
      await expect(suspend(seeded, sre)).rejects.toMatchObject({
        errorCode: OperatorErrorCode.OPERATOR_APPROVER_ROLE_REQUIRED,
        statusCode: 403,
      });
      expect((await proposalRow(seeded.proposalId)).status).toBe('UPHELD');
      expect(await registerEntries(seeded.proposalId)).toEqual(['S-3']);
    });

    it('suspends with an adjudicator as approver, and the register names them', async () => {
      const seeded = await upheld();

      await suspend(seeded, adjudicator);

      expect((await proposalRow(seeded.proposalId)).status).toBe('CANCELLED');
      expect(
        await one<{ approver_operator_id: string; approval_mode: string }>(
          `SELECT approver_operator_id, approval_mode FROM override_log_entries
            WHERE target_id = $1 AND code = 'S-1'`,
          [seeded.proposalId],
        ),
      ).toEqual({ approver_operator_id: adjudicator.operatorId, approval_mode: 'TWO_PERSON' });
    });

    it('still suspends a PROPOSED case alone', async () => {
      const seeded = await proposed();

      await suspend(seeded, null);

      expect((await proposalRow(seeded.proposalId)).status).toBe('CANCELLED');
    });
  });

  /** Security review L-3: the whole claim is one guarded transaction. */
  describe('claim, in one transaction', () => {
    it('re-assigns a case already UNDER_REVIEW and records it once', async () => {
      const seeded = await disputed();
      await arbitration.claim(adjudicator, seeded.organizationId, seeded.proposalId);

      await arbitration.claim(lead, seeded.organizationId, seeded.proposalId);

      expect((await proposalRow(seeded.proposalId)).status).toBe('UNDER_REVIEW');
      expect((await disputeRow(seeded.disputeId)).assigned_operator_id).toBe(lead.operatorId);
      expect(await eventKinds(seeded.proposalId)).toEqual([
        'DISPUTE_FILED',
        'ASSIGNED',
        'ASSIGNED',
      ]);
    });
  });
});
