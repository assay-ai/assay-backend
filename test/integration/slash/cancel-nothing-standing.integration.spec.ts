import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { SlaWindowCallRepository } from '@database/postgres/repositories/sla-window-call.repository';
import { SlashProposalPartRepository } from '@database/postgres/repositories/slash-proposal-part.repository';
import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';
import { SlashErrorCode } from '@modules/slash/errors/slash.errors';
import { SlashRecordSnapshot } from '@modules/slash/ports/slash-executor.port';
import { SlashPartsService } from '@modules/slash/services/slash-parts.service';

import { CHAIN } from '../../unit/chains/evm/helpers/fake-stake-chain';
import { freshMigratedDatabase } from '../helpers/slash-prorata-context';
import { seedProRataCase } from '../helpers/slash-prorata-seed';

/**
 * B11 (owner rule): the cancel of a pre-parts case with nothing standing
 * answers 409 SLASH_NOTHING_STANDING with what the chain shows, and writes
 * nothing: the row keeps its status and no timeline row is added.
 */
const DATABASE = 'x402_cancel_nothing_standing_test';
const EVM_ASSET = `${CHAIN}/erc20:0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3`;
const STAKE_AUTHORITY = `${CHAIN}:0xA271A3407D3302f4b4Fbe469b9188487cedd7d45`;
const AGENT = `${CHAIN}:0x976ea74026e726554db657fa54763abd0c3a0aa9`;
const PROPOSED_AT = new Date('2026-10-14T11:15:00Z');

describe('cancel with nothing standing, against a real database', () => {
  let dataSource: DataSource;
  let proposals: SlashProposalRepository;
  let record: SlashRecordSnapshot['status'] | null;
  let service: SlashPartsService;

  beforeAll(async () => {
    dataSource = await freshMigratedDatabase(DATABASE);
    proposals = new SlashProposalRepository(dataSource);
    const executor = {
      readRecord: async () => (record ? ({ status: record } as SlashRecordSnapshot) : null),
      buildCancel: async () => {
        throw new Error('nothing should be built');
      },
    };
    service = new SlashPartsService(
      new SlashProposalPartRepository(dataSource),
      new SlaWindowCallRepository(dataSource),
      executor as never,
      { dustReportBelowMinor: 0n, stragglerMaxAttempts: 3, stragglerDeadlineMs: 1 },
      null,
      { emit: async () => undefined } as never,
    );
  }, 240_000);

  afterAll(async () => {
    await dataSource?.destroy();
  });

  async function legacyCase(): Promise<string> {
    const seeded = await seedProRataCase(dataSource, {
      providerOrg: randomUUID(),
      stakeAuthority: STAKE_AUTHORITY,
      assetId: EVM_ASSET,
      penalty: 28_470_000n,
      agents: [{ account: AGENT, failed: [100_000n] }],
      proposedAt: PROPOSED_AT,
    });
    await dataSource.query(
      `UPDATE slash_proposals SET status = 'CANCELLED', chain_status = 'CANCEL_REQUESTED',
              chain_proposed_at = $2, chain_executable_at = $3 WHERE id = $1`,
      [seeded.proposalId, PROPOSED_AT, new Date('2026-10-17T11:15:00Z')],
    );
    return seeded.proposalId;
  }

  const load = async (id: string) =>
    (await dataSource.query(`SELECT organization_id FROM slash_proposals WHERE id = $1`, [id]))[0]
      .organization_id as string;
  const events = async (id: string) =>
    (await dataSource.query(
      `SELECT kind, detail FROM slash_proposal_events WHERE proposal_id = $1 AND kind = 'CHAIN_CANCELLED'`,
      [id],
    )) as { kind: string; detail: Record<string, unknown> }[];
  const chainStatus = async (id: string) =>
    (
      await dataSource.query(
        `SELECT chain_status, chain_last_error FROM slash_proposals WHERE id = $1`,
        [id],
      )
    )[0];

  it.each([
    ['CANCELLED', 'CANCELLED'],
    [null, 'NOT_FOUND'],
    ['EXECUTED', 'EXECUTED'],
  ] as const)('record %s: 409 naming %s, and nothing is written', async (status, named) => {
    const id = await legacyCase();
    const proposal = (await proposals.findOneScoped(await load(id), id))!;
    record = status;
    await expect(service.buildCancel(proposal, '0xprovider')).rejects.toMatchObject({
      errorCode: SlashErrorCode.SLASH_NOTHING_STANDING,
      publicContext: { chainStatus: named },
    });
    expect(await chainStatus(id)).toEqual({
      chain_status: 'CANCEL_REQUESTED',
      chain_last_error: null,
    });
    expect(await events(id)).toEqual([]);
  });
});
