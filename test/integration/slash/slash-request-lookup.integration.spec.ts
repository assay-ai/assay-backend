import { createHash, randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { SlashProposalPartRepository } from '@database/postgres/repositories/slash-proposal-part.repository';
import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';
import { SlashRequestLookupService } from '@modules/slash/services/slash-request-lookup.service';

import { CHAIN } from '../../unit/chains/evm/helpers/fake-stake-chain';
import { freshMigratedDatabase } from '../helpers/slash-prorata-context';
import { SeededCase, seedProRataCase } from '../helpers/slash-prorata-seed';

/**
 * `POST /providers/me/slash-requests/lookup`'s service, against a real
 * Postgres built from every migration: the two tables it reads, the tenant
 * predicate on both, and the `char(64)` column it matches against.
 */
const DATABASE = 'x402_slash_request_lookup_test';
const ASSET = `${CHAIN}/erc20:0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3`;
const STAKE_AUTHORITY = `${CHAIN}:0xA271A3407D3302f4b4Fbe469b9188487cedd7d45`;
const AGENT = `${CHAIN}:0x976ea74026e726554db657fa54763abd0c3a0aa9`;

const hex = (label: string) => createHash('sha256').update(label).digest('hex');

describe('slash request lookup, against a real database', () => {
  let dataSource: DataSource;
  let service: SlashRequestLookupService;
  let mine: SeededCase;
  let theirs: SeededCase;
  let myPartId: string;
  const myPartRequestId = hex('my part');
  const theirPartRequestId = hex('their part');

  async function insertPart(seeded: SeededCase, requestId: string): Promise<string> {
    const id = randomUUID();
    await dataSource.query(
      `INSERT INTO slash_proposal_parts
         (id, organization_id, proposal_id, chain_epoch, window_id, agent_account,
          beneficiary_account, weight_amount, uncapped_share_amount, penalty_amount,
          plan_penalty_amount, plan_capped_total, cap_binding, chain_request_id)
       VALUES ($1, $2, $3, 0, $4, $5, $5, 100, 50, 50, 100, 100, 'NONE', $6)`,
      [id, seeded.organizationId, seeded.proposalId, seeded.windowId, AGENT, requestId],
    );
    return id;
  }

  beforeAll(async () => {
    dataSource = await freshMigratedDatabase(DATABASE);
    service = new SlashRequestLookupService(
      new SlashProposalRepository(dataSource),
      new SlashProposalPartRepository(dataSource),
    );

    const seed = (label: string) =>
      seedProRataCase(dataSource, {
        providerOrg: randomUUID(),
        stakeAuthority: STAKE_AUTHORITY,
        assetId: ASSET,
        penalty: 1_000_000n,
        agents: [{ account: AGENT, failed: [100_000n] }],
        proposedAt: new Date(Date.now() - 60 * 60 * 1000),
        label,
      });
    mine = await seed('mine');
    theirs = await seed('theirs');
    myPartId = await insertPart(mine, myPartRequestId);
    await insertPart(theirs, theirPartRequestId);
  }, 300_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('answers this provider’s case ids and part ids, in any case', async () => {
    const { matches } = await service.lookup(mine.organizationId, [
      `0x${mine.chainRequestId.toUpperCase()}`,
      `0x${myPartRequestId}`,
    ]);

    expect(matches).toEqual([
      { requestId: `0x${mine.chainRequestId}`, proposalId: mine.proposalId },
      { requestId: `0x${myPartRequestId}`, proposalId: mine.proposalId, partId: myPartId },
    ]);
  });

  it('answers another provider’s ids exactly like ids that never existed: absent', async () => {
    const { matches } = await service.lookup(mine.organizationId, [
      `0x${theirs.chainRequestId}`,
      `0x${theirPartRequestId}`,
      `0x${hex('nobody')}`,
    ]);

    expect(matches).toEqual([]);
  });

  it('gives the other provider its own, and only its own', async () => {
    const { matches } = await service.lookup(theirs.organizationId, [
      `0x${mine.chainRequestId}`,
      `0x${theirs.chainRequestId}`,
      `0x${theirPartRequestId}`,
    ]);

    expect(matches.map((match) => match.proposalId)).toEqual([
      theirs.proposalId,
      theirs.proposalId,
    ]);
  });
});
