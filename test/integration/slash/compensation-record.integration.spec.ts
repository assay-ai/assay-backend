import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { FleetSweepRepository } from '@database/postgres/repositories/fleet-sweep.repository';
import { OverrideLogEntryRepository } from '@database/postgres/repositories/override-log-entry.repository';
import { ProviderChainEnrolmentRepository } from '@database/postgres/repositories/provider-chain-enrolment.repository';
import { SlashProposalEventRepository } from '@database/postgres/repositories/slash-proposal-event.repository';
import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';
import { AccountId } from '@modules/chains/ports/caip.types';
import { OperatorRole } from '@modules/operator/domain/override-register';
import { OperatorSession } from '@modules/operator/ports/operator-session.port';
import { OverrideLogService } from '@modules/operator/services/override-log.service';
import { SlashErrorCode } from '@modules/slash/errors/slash.errors';
import { SlashExecutionService } from '@modules/slash/services/slash-execution.service';
import { SlashProposalService } from '@modules/slash/services/slash-proposal.service';
import { MoneyUtil } from '@shared/utils/money.util';

import { CHAIN } from '../../unit/chains/evm/helpers/fake-stake-chain';
import { freshMigratedDatabase, TEST_SLASH_CONFIG } from '../helpers/slash-prorata-context';
import { seedProRataCase } from '../helpers/slash-prorata-seed';

/**
 * `S-5` (record a compensation) against a real Postgres (review M-3).
 *
 * The chain read is faked: which deposits count (treasury-funded, after
 * `executed_at`) is unit-tested in the two stake intent builders. What only a
 * database can show is asserted here: one deposit cannot compensate two cases,
 * and the status change rolls back with its register entry.
 */
const DATABASE = 'x402_compensation_record_test';
const ASSET = `${CHAIN}/erc20:0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3`;
const TREASURY = `${CHAIN}:0xd75ba4a2ba90cb110e32ff4d87e1d1352434c687` as AccountId;
const AGENT = `${CHAIN}:0x976ea74026e726554db657fa54763abd0c3a0aa9`;
const PENALTY = 1_000_000n;
const NOTE = 'n'.repeat(120);
const DEPOSIT = `0x${'ab'.repeat(32)}`;

describe('recording a compensation, against a real database', () => {
  let dataSource: DataSource;
  let execution: SlashExecutionService;
  let confirmedDeposit: jest.Mock;
  let lead: OperatorSession;
  let treasurer: OperatorSession;

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
    confirmedDeposit = jest.fn(async () => MoneyUtil.of(PENALTY, ASSET as never, 6));
    execution = new SlashExecutionService(
      proposals,
      new ProviderChainEnrolmentRepository(dataSource),
      new FleetSweepRepository(dataSource),
      lifecycle,
      new OverrideLogService(dataSource, new OverrideLogEntryRepository(dataSource)),
      notifications,
      TEST_SLASH_CONFIG,
      // Only the treasury lookup is reached; nothing is signed or sent.
      { settlementTreasury: async () => TREASURY } as never,
      null,
      null,
      { confirmedDeposit } as never,
    );

    lead = await seedOperator('ops-adjl', [OperatorRole.ADJL]);
    treasurer = await seedOperator('ops-tre', [OperatorRole.TRE]);
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

  /** A case the chain executed: the state a compensation starts from. */
  /** One stake authority per provider: the enrolment is unique per authority. */
  const authorityOf = (org: string) =>
    `${CHAIN}:0x${org.replace(/-/g, '').slice(0, 40).padEnd(40, '0')}`;

  async function executed(providerOrg: string = randomUUID()) {
    const seeded = await seedProRataCase(dataSource, {
      providerOrg,
      stakeAuthority: authorityOf(providerOrg),
      assetId: ASSET,
      penalty: PENALTY,
      agents: [{ account: AGENT, failed: [100_000n] }],
      proposedAt: new Date(Date.now() - 80 * 60 * 60 * 1000),
    });
    await dataSource.query(
      `UPDATE slash_proposals
          SET status = 'EXECUTED', executed_at = earliest_execution_at,
              execution_signature = $2, applied_amount = penalty_amount
        WHERE id = $1`,
      [seeded.proposalId, `0x${randomUUID().replace(/-/g, '').padEnd(64, '0')}`],
    );
    return seeded;
  }

  const row = async (id: string) =>
    (
      (await dataSource.query(
        `SELECT status, reversal_signature, executed_at FROM slash_proposals WHERE id = $1`,
        [id],
      )) as { status: string; reversal_signature: string | null; executed_at: Date }[]
    )[0];
  const s5Entries = async (id: string) =>
    Number(
      (
        (await dataSource.query(
          `SELECT count(*)::int AS n FROM override_log_entries WHERE target_id = $1 AND code = 'S-5'`,
          [id],
        )) as { n: number }[]
      )[0].n,
    );

  it('asks the chain for a treasury deposit made after the slash executed', async () => {
    const seeded = await executed();
    const signature = `0x${'cd'.repeat(32)}`;

    await execution.markCompensated(
      lead,
      treasurer,
      seeded.organizationId,
      seeded.proposalId,
      signature.toUpperCase().replace('0X', '0x'),
      'MAPPING_REGRESSION',
      NOTE,
    );

    const after = await row(seeded.proposalId);
    expect(after.status).toBe('REVERSED');
    // Stored lower-case, so the same EVM hash in another case collides.
    expect(after.reversal_signature).toBe(signature);
    expect(confirmedDeposit).toHaveBeenLastCalledWith(
      signature,
      authorityOf(seeded.organizationId),
      {
        funder: TREASURY,
        after: after.executed_at,
      },
    );
  });

  it('refuses to record one deposit against a second case', async () => {
    // Same provider: the deposit is genuinely theirs, but it pays back one case.
    const first = await executed();
    const second = await executed(first.organizationId);

    await execution.markCompensated(
      lead,
      treasurer,
      first.organizationId,
      first.proposalId,
      DEPOSIT,
      'MAPPING_REGRESSION',
      NOTE,
    );
    await expect(
      execution.markCompensated(
        lead,
        treasurer,
        second.organizationId,
        second.proposalId,
        DEPOSIT,
        'MAPPING_REGRESSION',
        NOTE,
      ),
    ).rejects.toMatchObject({ errorCode: SlashErrorCode.SLASH_COMPENSATION_ALREADY_USED });

    expect((await row(second.proposalId)).status).toBe('EXECUTED');
    expect(await s5Entries(second.proposalId)).toBe(0);
    expect((await row(first.proposalId)).status).toBe('REVERSED');
  });

  it('rolls the status back when its register entry cannot be written', async () => {
    const seeded = await executed();

    // `request_id` is varchar(64): the entry insert fails after the status
    // update. Before the fix that update had already committed on its own
    // connection, leaving REVERSED with no S-5 entry.
    await expect(
      execution.markCompensated(
        lead,
        treasurer,
        seeded.organizationId,
        seeded.proposalId,
        `0x${'ef'.repeat(32)}`,
        'MAPPING_REGRESSION',
        NOTE,
        'r'.repeat(65),
      ),
    ).rejects.toThrow();

    expect((await row(seeded.proposalId)).status).toBe('EXECUTED');
    expect(await s5Entries(seeded.proposalId)).toBe(0);
  });
});
