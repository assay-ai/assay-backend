import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';

import { BuyerEscrowEntity } from '@database/postgres/entities/buyer-escrow.entity';
import { BuyerEscrowRepository } from '@database/postgres/repositories/buyer-escrow.repository';
import { CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';

import { USDC_ASSET, ensureTestDatabase, testConnectionOptions } from '../helpers/test-database';

loadEnv();

/**
 * `upsertOpened` across organizations, against real Postgres — the
 * `ON CONFLICT … DO UPDATE` is the thing under test, and an in-memory fake has
 * no conflict clause to get wrong.
 *
 * `uq_buyer_escrows_account` keys the row on the account alone (one on-chain
 * escrow per buyer), so a second organization depositing from the same address
 * collides with the first organization's row. The intended behaviour is to
 * refuse that. What it did instead, before the fix: the
 * UPDATE ran first — rewriting the OTHER organization's `escrow_account_id` —
 * and only then did the organization-scoped read-back fail, as a 500.
 *
 * Its own database, schema from the entity (`synchronize`): the unique index
 * this depends on is declared on `BuyerEscrowEntity`, and the shared
 * escrow-seq context does not compile on this branch.
 */
describe('BuyerEscrowRepository.upsertOpened across organizations', () => {
  let dataSource: DataSource;
  let escrows: BuyerEscrowRepository;
  let owner: string;

  beforeAll(async () => {
    const database = await ensureTestDatabase(
      `${process.env.DATABASE_NAME || 'app'}_buyer_escrow_tenancy_test`,
    );
    dataSource = new DataSource({
      type: 'postgres',
      ...testConnectionOptions(),
      database,
      entities: [BuyerEscrowEntity],
      synchronize: true,
      dropSchema: true,
    });
    await dataSource.initialize();
    escrows = new BuyerEscrowRepository(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(() => {
    owner = randomUUID();
  });

  const freshAccount = () =>
    toAccountId(CHAIN_IDS.SOLANA_MAINNET, `Tenancy${randomUUID().replace(/-/g, '').slice(0, 24)}`);

  const row = (organizationId: string, account: string, escrow: string) => ({
    organizationId,
    accountId: account,
    assetId: USDC_ASSET,
    escrowAccountId: escrow,
    escrowAssetAccountId: `${escrow}-ata`,
    openedTxRef: null,
  });

  it("never writes another organization's row, and answers null rather than throwing", async () => {
    const account = freshAccount();
    const intruder = randomUUID();

    await escrows.upsertOpened(row(owner, account, 'escrow-original'));

    await expect(
      escrows.upsertOpened(row(intruder, account, 'escrow-rewritten')),
    ).resolves.toBeNull();

    const [stored] = await dataSource.query(
      `SELECT "organization_id", "escrow_account_id", "escrow_asset_account_id"
         FROM "buyer_escrows" WHERE "account_id" = $1`,
      [account],
    );
    expect(stored).toEqual({
      organization_id: owner,
      escrow_account_id: 'escrow-original',
      escrow_asset_account_id: 'escrow-original-ata',
    });
  });

  it('still refreshes the addresses for the organization that owns the row', async () => {
    // A redeploy moves the EVM escrow contract; the owner's re-open must follow it.
    const account = freshAccount();

    await escrows.upsertOpened(row(owner, account, 'escrow-before'));
    await expect(escrows.upsertOpened(row(owner, account, 'escrow-after'))).resolves.toMatchObject({
      organizationId: owner,
      escrowAccountId: 'escrow-after',
    });
  });
});
