import { DataSource } from 'typeorm';

import { EvmChainStateRepository } from '@database/postgres/repositories/evm-chain-state.repository';
import { EvmChainStateService } from '@modules/chains/evm/chain-state/evm-chain-state.service';
import { ChainDoor } from '@modules/chains/ports/chain-state-gate.port';

import { freshMigratedDatabase } from '../helpers/slash-prorata-context';

/**
 * The chain-state cache (assay-evm D-19) against real Postgres: the migration,
 * the cursor written with its events in one transaction, newest-wins on the
 * blocklist, the reconcile correction, and the in-memory copy every process
 * reads from it.
 */
const DATABASE = 'x402_evm_chain_state_test';
const CHAIN = 'eip155:46630';
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const NOW = new Date('2026-10-14T00:00:00Z');

const row = (address: string, blocked: boolean, blockNumber: bigint, logIndex = 0) => ({
  address,
  blocked,
  setBy: '0x5555555555555555555555555555555555555555',
  blockNumber,
  logIndex,
  transactionHash: `0x${'1'.repeat(64)}`,
});

describe('EvmChainStateRepository, against a real database', () => {
  let dataSource: DataSource;
  let repository: EvmChainStateRepository;

  beforeAll(async () => {
    dataSource = await freshMigratedDatabase(DATABASE);
    repository = new EvmChainStateRepository(dataSource);
  });
  afterAll(async () => dataSource?.destroy());

  it('creates the chain row on first write and keeps the cursor with its events', async () => {
    await repository.applyIndexedRange({
      chainId: CHAIN,
      cursorBlock: 100n,
      headBlock: 100n,
      caughtUp: true,
      now: NOW,
      paused: true,
      blocked: [row(A, true, 90n), row(B, true, 95n)],
    });
    const state = await repository.findState(CHAIN);
    expect(state).toMatchObject({ paused: true, cursorBlock: '100', caughtUpAt: NOW });
    expect((await repository.findBlocked()).map((entry) => entry.address).sort()).toEqual([A, B]);
  });

  it('never lets an older event overwrite a newer one (a re-read range)', async () => {
    await repository.applyIndexedRange({
      chainId: CHAIN,
      cursorBlock: 120n,
      headBlock: 130n,
      caughtUp: false,
      now: NOW,
      blocked: [row(A, false, 110n), row(B, false, 80n)],
    });
    const blocked = (await repository.findBlocked()).map((entry) => entry.address);
    expect(blocked).toEqual([B]);
  });

  it('applies a reconcile correction and the Config terms whatever the event order', async () => {
    await repository.applyReconcile(
      CHAIN,
      {
        paused: false,
        arbiter: '0x5555555555555555555555555555555555555555',
        slashDelaySeconds: 600,
      },
      [
        {
          address: B,
          blocked: false,
          setBy: null,
          blockNumber: null,
          logIndex: null,
          transactionHash: null,
        },
      ],
      NOW,
    );
    expect(await repository.findBlocked()).toEqual([]);
    expect(await repository.findState(CHAIN)).toMatchObject({
      paused: false,
      slashDelaySeconds: 600,
      reconciledAt: NOW,
    });
  });

  it('feeds the in-memory gate every process reads', async () => {
    await repository.applyIndexedRange({
      chainId: CHAIN,
      cursorBlock: 140n,
      headBlock: 140n,
      caughtUp: true,
      now: NOW,
      blocked: [row(A, true, 140n)],
    });
    const gate = new EvmChainStateService(
      repository,
      new Map([[CHAIN, { readContract: async () => true }]]) as never,
      new Map([[CHAIN, { config: A }]]) as never,
      { pollMs: 60_000 },
    );
    await gate.refresh();
    await expect(
      gate.assertActive(ChainDoor.DELEGATE, [{ role: 'DELEGATE', account: `${CHAIN}:${A}` }]),
    ).rejects.toMatchObject({ errorCode: 'CHAIN_ADDRESS_BLOCKED' });
    await expect(
      gate.assertActive(ChainDoor.DELEGATE, [{ role: 'DELEGATE', account: `${CHAIN}:${B}` }]),
    ).resolves.toBeUndefined();
  });

  it('accepts DISPUTED on cases and parts, and nothing unknown', async () => {
    const constraint = await dataSource.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conname IN ('chk_slash_proposals_chain_status', 'chk_slash_proposal_parts_chain_status')`,
    );
    for (const { def } of constraint) expect(def).toContain('DISPUTED');
  });
});
