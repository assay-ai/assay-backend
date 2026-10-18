import { DataSource } from 'typeorm';

import { BuyerEscrowRepository } from '@database/postgres/repositories/buyer-escrow.repository';
import { EscrowWithdrawalEventRepository } from '@database/postgres/repositories/escrow-withdrawal-event.repository';
import {
  EscrowWithdrawalLog,
  EvmEscrowWithdrawalClient,
  EvmEscrowWithdrawalIndexer,
} from '@modules/chains/evm/evm-escrow-withdrawal.indexer';
import { EvmDeployment } from '@modules/chains/evm/evm.constants';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { WithdrawalsService } from '@modules/ledger/services/withdrawals.service';
import { AuditLogWriter } from '@shared/audit';

import { freshMigratedDatabase } from '../helpers/slash-prorata-context';

/**
 * The withdrawal history (B7) against real Postgres: the migration, the
 * indexer's rows and cursor in one transaction, a re-read range storing and
 * logging nothing twice, the claim's audit row for a known buyer only, and
 * `GET /withdrawals` folding the rows of the session's own organization.
 * Nothing here writes a ledger entry or a balance.
 */
const DATABASE = 'assay_escrow_withdrawals_test';
const CHAIN = CHAIN_IDS.ROBINHOOD_TESTNET as ChainId;
const ASSET = ASSET_IDS.USDG_ROBINHOOD_TESTNET;
const ORG = '0b7e8a52-0000-4000-8000-000000000001';
const OTHER_ORG = '0b7e8a52-0000-4000-8000-000000000002';
const BUYER = '0x66d7CA4cD09C65197B2f3239c1fe79631747dd00';
const STRANGER = '0x1111111111111111111111111111111111111111';
const ESCROW = '0x60aBdb81796322b1bA6674068a3861309a9f8D37' as const;
const T0 = 1_792_000_000n;

const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`;

function requested(
  block: bigint,
  amount: bigint,
  logIndex = 0,
  buyer = BUYER,
): EscrowWithdrawalLog {
  return {
    eventName: 'WithdrawRequested',
    args: { buyer: buyer as `0x${string}`, amount, availableAt: T0 + block + 3_600n },
    blockNumber: block,
    logIndex,
    transactionHash: tx(Number(block) * 10 + logIndex),
  };
}

function withdrawn(
  block: bigint,
  amount: bigint,
  requestedAmount: bigint,
  buyer = BUYER,
): EscrowWithdrawalLog {
  return {
    eventName: 'EscrowWithdrawn',
    args: { buyer: buyer as `0x${string}`, amount, requested: requestedAmount },
    blockNumber: block,
    logIndex: 0,
    transactionHash: tx(Number(block) * 10),
  };
}

describe('Escrow withdrawal history, against a real database', () => {
  let dataSource: DataSource;
  let events: EscrowWithdrawalEventRepository;
  let service: WithdrawalsService;
  let logs: EscrowWithdrawalLog[];
  let head: bigint;
  let indexer: EvmEscrowWithdrawalIndexer;

  beforeAll(async () => {
    dataSource = await freshMigratedDatabase(DATABASE);
    events = new EscrowWithdrawalEventRepository(dataSource);
    service = new WithdrawalsService(new BuyerEscrowRepository(dataSource), events);
    await dataSource.query(
      `INSERT INTO "buyer_escrows"
         ("organization_id", "account_id", "asset_id", "escrow_account_id", "escrow_asset_account_id", "next_seq")
       VALUES ($1, $2, $3, $4, $4, 1)`,
      [ORG, `${CHAIN}:${BUYER}`, ASSET, `${CHAIN}:${ESCROW}`],
    );
    const client: EvmEscrowWithdrawalClient = {
      getBlockNumber: async () => head,
      getContractEvents: async ({ fromBlock, toBlock }) =>
        logs.filter((log) => log.blockNumber! >= fromBlock && log.blockNumber! <= toBlock),
      getBlock: async ({ blockNumber }) => ({ timestamp: T0 + blockNumber }),
    };
    indexer = new EvmEscrowWithdrawalIndexer(
      new Map([[CHAIN, client]]),
      new Map([[CHAIN, { escrow: ESCROW, disputeUpgradeBlock: 100n } as unknown as EvmDeployment]]),
      [CHAIN],
      events,
      new AuditLogWriter(dataSource),
      { fromBlock: new Map(), confirmations: 2 },
    );
  });
  afterAll(async () => dataSource?.destroy());

  const auditRows = () =>
    dataSource.query(
      `SELECT "organization_id", "action", "actor_type", "after" FROM "audit_log_entries"
        WHERE "action" LIKE 'withdrawal.%' ORDER BY "created_at"`,
    );

  it('indexes a request, a replaced request, a cancel and a claim, stopping short of the head', async () => {
    logs = [
      requested(110n, 5_000_000n),
      requested(120n, 7_000_000n),
      requested(130n, 0n),
      requested(140n, 13_240_000n),
      withdrawn(150n, 13_000_000n, 13_240_000n),
      requested(160n, 2_000_000n, 0),
      requested(160n, 9_000_000n, 1, STRANGER),
      // Inside the confirmation depth: not read yet.
      withdrawn(171n, 2_000_000n, 2_000_000n),
    ];
    head = 172n;

    await indexer.tick();

    expect(await events.findCursor(CHAIN)).toBe(170n);
    const { items } = await service.list(ORG);
    expect(items.map((item) => item.status)).toEqual([
      'PENDING',
      'CLAIMED',
      'CANCELLED',
      'REPLACED',
    ]);
    expect(items[1]).toMatchObject({
      account: `${CHAIN}:${BUYER}`,
      requested: { amount: '13240000', asset: ASSET, decimals: 6 },
      received: { amount: '13000000', asset: ASSET, decimals: 6 },
      requestedAt: new Date(Number(T0 + 140n) * 1000).toISOString(),
      claimableAt: new Date(Number(T0 + 140n + 3_600n) * 1000).toISOString(),
      closedAt: new Date(Number(T0 + 150n) * 1000).toISOString(),
    });
    expect(items[0]).toMatchObject({ requested: { amount: '2000000' }, received: null });
    // The claim of a buyer this platform knows is logged once, as the system.
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organization_id: ORG,
      action: 'withdrawal.claimed',
      actor_type: 'system',
    });
    expect(rows[0].after).toMatchObject({
      amount: '13000000',
      requested: '13240000',
      asset: ASSET,
    });
  });

  it('stores and logs nothing twice when a range is read again', async () => {
    await dataSource.query(
      `UPDATE "evm_chain_states" SET "withdrawal_cursor_block" = 105 WHERE "chain_id" = $1`,
      [CHAIN],
    );

    await indexer.tick();

    expect(await events.count()).toBe(7);
    expect(await auditRows()).toHaveLength(1);
    expect(await events.findCursor(CHAIN)).toBe(170n);
  });

  it('closes the pending request once its claim is past the confirmation depth', async () => {
    head = 180n;

    await indexer.tick();

    const { items } = await service.list(ORG);
    expect(items[0]).toMatchObject({ status: 'CLAIMED', received: { amount: '2000000' } });
    expect(await auditRows()).toHaveLength(2);
  });

  it('shows another organization none of it, and sums only claims in the window', async () => {
    expect((await service.list(OTHER_ORG)).items).toEqual([]);

    const escrows = await service.organizationEscrows(ORG);
    const all = await events.sumWithdrawn(escrows, null, new Date(Number(T0 + 200n) * 1000));
    expect(all.get(`${CHAIN}:${BUYER.toLowerCase()}`)).toBe(15_000_000n);
    const late = await events.sumWithdrawn(
      escrows,
      new Date(Number(T0 + 160n) * 1000),
      new Date(Number(T0 + 200n) * 1000),
    );
    expect(late.get(`${CHAIN}:${BUYER.toLowerCase()}`)).toBe(2_000_000n);
  });

  it('writes no ledger entry and no balance', async () => {
    const [{ entries }] = await dataSource.query(
      `SELECT COUNT(*)::int AS entries FROM "ledger_entries"`,
    );
    const [{ balances }] = await dataSource.query(
      `SELECT COUNT(*)::int AS balances FROM "account_balances"`,
    );
    expect(entries).toBe(0);
    expect(balances).toBe(0);
  });
});
