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
import { SlashErrorCode } from '@modules/slash/errors/slash.errors';
import { ArbitrationService } from '@modules/slash/services/arbitration.service';
import { SlashExecutionService } from '@modules/slash/services/slash-execution.service';
import { SlashProposalService } from '@modules/slash/services/slash-proposal.service';

import { CHAIN } from '../../unit/chains/evm/helpers/fake-stake-chain';
import { freshMigratedDatabase, TEST_SLASH_CONFIG } from '../helpers/slash-prorata-context';
import { seedProRataCase } from '../helpers/slash-prorata-seed';

/**
 * Fleet sweep (`S-11`) against a real Postgres (review M-2).
 *
 * Based on the operator's case actions harness: the operator's case actions against a real Postgres built from every
 * migration: the real arbitration service, the real override register and the
 * real dispute rows, with only the notification sink stubbed.
 *
 * What is asserted is what is on disk afterwards. A refusal that still wrote —
 * a dispute reopened on a resolved case, a penalty of `''`, an event on a
 * closed timeline — is the defect these guards exist for, and an in-memory fake
 * cannot show a row that was written before the error was thrown.
 */
const DATABASE = 'x402_fleet_sweep_test';
const ASSET = `${CHAIN}/erc20:0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3`;
const STAKE_AUTHORITY = `${CHAIN}:0xA271A3407D3302f4b4Fbe469b9188487cedd7d45`;
const AGENT = `${CHAIN}:0x976ea74026e726554db657fa54763abd0c3a0aa9`;
const PENALTY = 1_000_000n;
const NOTE = 'n'.repeat(120);

describe('fleet sweep, against a real database', () => {
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
  let rootCause = 0;
  /** A fresh root cause per test: the sweep matches across every tenant. */
  const freshDefect = () => `mapping/defect-${(rootCause += 1)}-${randomUUID().slice(0, 8)}`;

  const setRootCause = (proposalId: string, key: string) =>
    dataSource.query(`UPDATE slash_proposals SET root_cause_key = $2 WHERE id = $1`, [
      proposalId,
      key,
    ]);

  /** A case two adjudicators overturned as a platform defect — a sweepable source. */
  async function source(defect: string) {
    const seeded = await disputed();
    await arbitration.decide(adjudicator, seeded.organizationId, seeded.proposalId, {
      outcome: ArbitrationOutcome.OVERTURNED_PLATFORM_DEFECT,
      reasonCodes: ['MAPPING_REGRESSION'],
      note: NOTE,
    });
    await arbitration.second(lead, seeded.organizationId, seeded.proposalId, 'SIGNED', NOTE);
    await setRootCause(seeded.proposalId, defect);
    return seeded;
  }

  /** A case upheld by an adjudicator and countersigned by the lead. */
  async function upheld(defect: string) {
    const seeded = await disputed();
    await arbitration.decide(adjudicator, seeded.organizationId, seeded.proposalId, {
      outcome: ArbitrationOutcome.UPHELD,
      reasonCodes: ['RATE_GENUINELY_EXCEEDED'],
      note: NOTE,
    });
    const status = (await proposalRow(seeded.proposalId)).status;
    if (status === 'AWAITING_SECOND') {
      await arbitration.second(lead, seeded.organizationId, seeded.proposalId, 'SIGNED', NOTE);
    }
    expect((await proposalRow(seeded.proposalId)).status).toBe('UPHELD');
    await setRootCause(seeded.proposalId, defect);
    return seeded;
  }

  /** A case nobody decided: `decided_by_operator_id` is NULL. */
  async function undecided(defect: string) {
    const seeded = await proposed();
    await setRootCause(seeded.proposalId, defect);
    return seeded;
  }

  const sweepInput = (defectKey: string) => ({
    defectKey,
    lookbackHours: 24,
    reasonCode: 'MAPPING_REGRESSION',
    note: NOTE,
  });

  const caseRow = (id: string) =>
    one<{
      status: string;
      decided_by_operator_id: string | null;
      seconded_by_operator_id: string | null;
      sweep_id: string | null;
    }>(
      `SELECT status, decided_by_operator_id, seconded_by_operator_id, sweep_id
         FROM slash_proposals WHERE id = $1`,
      [id],
    );
  const sweepEntry = (sourceId: string) =>
    one<{ after: Record<string, unknown> } | undefined>(
      `SELECT "after" FROM override_log_entries WHERE target_id = $1 AND code = 'S-11'`,
      [sourceId],
    );

  it("refuses a defect key that is not the source case's root cause, and opens nothing", async () => {
    const defect = freshDefect();
    const seeded = await source(defect);
    const victim = await upheld(defect);

    await expect(
      execution.openSweep(
        lead,
        adjudicator,
        seeded.organizationId,
        seeded.proposalId,
        sweepInput(freshDefect()),
      ),
    ).rejects.toMatchObject({ errorCode: SlashErrorCode.SLASH_SWEEP_DEFECT_KEY_MISMATCH });

    expect(await sweepEntry(seeded.proposalId)).toBeUndefined();
    expect((await caseRow(victim.proposalId)).status).toBe('UPHELD');
  });

  it('applies to an upheld and an undecided case, all or nothing, naming the sweep as resolver', async () => {
    const defect = freshDefect();
    const seeded = await source(defect);
    // Upheld first: the sweep reaches it before the undecided one (proposed_at order).
    const first = await upheld(defect);
    const second = await undecided(defect);

    const sweep = await execution.openSweep(
      lead,
      adjudicator,
      seeded.organizationId,
      seeded.proposalId,
      sweepInput(defect),
    );

    for (const swept of [first, second]) {
      const row = await caseRow(swept.proposalId);
      expect(row.status).toBe('OVERTURNED');
      expect(row.sweep_id).toBe(sweep.id);
      // The sweep's actor resolved it, not the adjudicator who upheld it.
      expect(row.decided_by_operator_id).toBe(lead.operatorId);
      expect(row.seconded_by_operator_id).toBeNull();
    }
    const entry = await sweepEntry(seeded.proposalId);
    expect(entry?.after).toMatchObject({
      sweepId: sweep.id,
      appliedProposalIds: expect.arrayContaining([first.proposalId, second.proposalId]),
    });
    expect((entry?.after.appliedProposalIds as string[]).length).toBe(2);
  });

  // BUG-R11-O1-02: the route answered with the row as first saved (OPEN, 0/0)
  // while the stored row was already COMPLETED.
  it('returns the sweep as it is stored: completed, with both counts', async () => {
    const defect = freshDefect();
    const seeded = await source(defect);
    await upheld(defect);
    await undecided(defect);

    const sweep = await execution.openSweep(
      lead,
      adjudicator,
      seeded.organizationId,
      seeded.proposalId,
      sweepInput(defect),
    );

    const stored = await one<{
      status: string;
      matched_count: number;
      applied_count: number;
      completed_at: Date | null;
    }>(
      `SELECT status, matched_count, applied_count, completed_at FROM fleet_sweeps WHERE id = $1`,
      [sweep.id],
    );
    expect(stored).toMatchObject({ status: 'COMPLETED', matched_count: 2, applied_count: 2 });
    expect(sweep).toMatchObject({
      status: stored.status,
      matchedCount: stored.matched_count,
      appliedCount: stored.applied_count,
      completedAt: stored.completed_at,
    });
  });

  it('checks the authority limit against the summed penalties of the matched cases', async () => {
    const defect = freshDefect();
    const seeded = await source(defect);
    await upheld(defect);
    await undecided(defect);
    const capped = await seedOperator(`ops-adjl-capped-${randomUUID()}`, [OperatorRole.ADJL]);
    await dataSource.query(`UPDATE operators SET authority_limit_minor = $2 WHERE id = $1`, [
      capped.operatorId,
      (PENALTY * 2n - 1n).toString(),
    ]);

    await expect(
      execution.openSweep(
        { ...capped, authorityLimitMinor: (PENALTY * 2n - 1n).toString() },
        adjudicator,
        seeded.organizationId,
        seeded.proposalId,
        sweepInput(defect),
      ),
    ).rejects.toMatchObject({ errorCode: 'OPERATOR_AUTHORITY_EXCEEDED' });
    expect(await sweepEntry(seeded.proposalId)).toBeUndefined();
  });

  it('changes nothing at all when one matched case cannot be written', async () => {
    const defect = freshDefect();
    const seeded = await source(defect);
    const first = await upheld(defect);
    const second = await undecided(defect);
    // Any refusal on the second row; a trigger stands in for whatever a
    // future constraint or a lock timeout would do.
    await dataSource.query(`
      CREATE OR REPLACE FUNCTION test_refuse_one_sweep() RETURNS trigger AS $$
      BEGIN
        IF NEW.id = '${second.proposalId}' AND NEW.status = 'OVERTURNED' THEN
          RAISE EXCEPTION 'refused for the test';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await dataSource.query(`
      CREATE TRIGGER test_refuse_one_sweep BEFORE UPDATE ON slash_proposals
      FOR EACH ROW EXECUTE FUNCTION test_refuse_one_sweep()`);
    try {
      await expect(
        execution.openSweep(
          lead,
          adjudicator,
          seeded.organizationId,
          seeded.proposalId,
          sweepInput(defect),
        ),
      ).rejects.toThrow(/refused for the test/);
    } finally {
      await dataSource.query(`DROP TRIGGER test_refuse_one_sweep ON slash_proposals`);
      await dataSource.query(`DROP FUNCTION test_refuse_one_sweep()`);
    }

    expect((await caseRow(first.proposalId)).status).toBe('UPHELD');
    expect((await caseRow(second.proposalId)).status).toBe('PROPOSED');
    expect(await sweepEntry(seeded.proposalId)).toBeUndefined();
    expect(
      await dataSource.query(`SELECT id FROM fleet_sweeps WHERE source_proposal_id = $1`, [
        seeded.proposalId,
      ]),
    ).toEqual([]);
  });
});
