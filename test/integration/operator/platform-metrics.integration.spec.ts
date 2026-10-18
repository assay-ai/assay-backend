import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { PlatformMetricsRepository } from '@database/postgres/repositories/platform-metrics.repository';

import { CHAIN } from '../../unit/chains/evm/helpers/fake-stake-chain';
import { freshMigratedDatabase } from '../helpers/slash-prorata-context';
import { seedProRataCase } from '../helpers/slash-prorata-seed';
import { USDC_ASSET } from '../helpers/test-database';

/**
 * B11 / D15: the health tile once labelled "Open disputes · on chain" counts
 * cases in the retired in-app objection statuses only. A case disputed on
 * chain (mirrored as `chain_status = 'DISPUTED'`) belongs to the arbiter, and
 * a case waiting for its cancel is neither.
 */
const DATABASE = 'x402_platform_metrics_test';
const EVM_ASSET = `${CHAIN}/erc20:0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3`;
const STAKE_AUTHORITY = `${CHAIN}:0xA271A3407D3302f4b4Fbe469b9188487cedd7d45`;
const AGENT = `${CHAIN}:0x976ea74026e726554db657fa54763abd0c3a0aa9`;
const PROPOSED_AT = new Date('2026-10-01T00:00:00Z');
const NOW = new Date('2026-10-05T00:00:00Z');

const ROWS: readonly Readonly<Record<string, unknown>>[] = [
  // Old process (non-EVM, in-app objection): counted.
  { asset_id: USDC_ASSET, status: 'DISPUTED', disputed_at: new Date('2026-10-02T00:00:00Z') },
  { asset_id: USDC_ASSET, status: 'UNDER_REVIEW', disputed_at: new Date('2026-10-03T00:00:00Z') },
  {
    asset_id: USDC_ASSET,
    status: 'AWAITING_SECOND',
    disputed_at: new Date('2026-10-04T00:00:00Z'),
  },
  // Not counted: an EVM case left in an objection status (it disputes on
  // chain), one disputed on chain, a cancel waiting, a plain proposal.
  {
    status: 'DISPUTED',
    disputed_at: new Date('2026-10-01T00:00:00Z'),
    chain_status: 'PENDING',
    chain_proposed_at: PROPOSED_AT,
    chain_executable_at: new Date('2026-10-04T00:00:00Z'),
  },
  {
    status: 'PROPOSED',
    chain_status: 'DISPUTED',
    chain_proposed_at: PROPOSED_AT,
    chain_disputed_at: new Date('2026-10-02T00:00:00Z'),
    chain_disputed_parts: 1,
  },
  {
    status: 'CANCELLED',
    chain_status: 'CANCEL_REQUESTED',
    chain_proposed_at: PROPOSED_AT,
    chain_executable_at: new Date('2026-10-04T00:00:00Z'),
  },
  {},
];

describe('PlatformMetricsRepository.oldProcessCaseCounts, against a real database', () => {
  let dataSource: DataSource;
  let metrics: PlatformMetricsRepository;

  beforeAll(async () => {
    dataSource = await freshMigratedDatabase(DATABASE);
    metrics = new PlatformMetricsRepository(dataSource);
    for (const patch of ROWS) {
      const seeded = await seedProRataCase(dataSource, {
        providerOrg: randomUUID(),
        stakeAuthority: STAKE_AUTHORITY,
        assetId: EVM_ASSET,
        penalty: 1_000_000n,
        agents: [{ account: AGENT, failed: [100_000n] }],
        proposedAt: PROPOSED_AT,
      });
      const columns = Object.keys(patch);
      if (columns.length === 0) continue;
      await dataSource.query(
        `UPDATE slash_proposals SET ${columns.map((column, i) => `"${column}" = $${i + 2}`).join(', ')} WHERE id = $1`,
        [seeded.proposalId, ...columns.map((column) => patch[column])],
      );
    }
  }, 240_000);

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('counts the three old-process statuses only, aged from the oldest objection', async () => {
    await expect(metrics.oldProcessCaseCounts(NOW)).resolves.toEqual({
      count: 3,
      oldestAgeSeconds: 3 * 24 * 3600,
    });
  });
});
