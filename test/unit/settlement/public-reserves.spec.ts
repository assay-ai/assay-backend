import { ReconciliationRunEntity } from '@database/postgres/entities/reconciliation-run.entity';
import { StakeSnapshotEntity } from '@database/postgres/entities/stake-snapshot.entity';
import { AccountBalanceRepository } from '@database/postgres/repositories/account-balance.repository';
import { ReconciliationRunRepository } from '@database/postgres/repositories/reconciliation-run.repository';
import { StakeSnapshotRepository } from '@database/postgres/repositories/stake-snapshot.repository';
import { PublicReservesService } from '@modules/settlement/services/public-reserves.service';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AssetId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import {
  PublicReservesChainInput,
  PublicReservesState,
  buildPublicReservesChain,
} from '@modules/settlement/domain/public-reserves';
import {
  ReconciliationFindingCode,
  ReconciliationSeverity,
} from '@modules/settlement/ports/reconciliation.types';

/**
 * Every rule on the public proof-of-reserves page, decided here and nowhere else.
 *
 * The rules that matter on a proof-of-reserves page are all decisions about
 * what to say when the data is missing, stale or negative — so they must be
 * testable without a database, which is why the assembler takes plain rows and
 * the service does no thinking.
 */

const CHAIN = CHAIN_IDS.SOLANA_DEVNET;
const ASSET = `${CHAIN}/token:USDC`;

/**
 * One panel, on the Solana devnet chain.
 *
 * Multichain support split `buildPublicReserves` into a per-chain assembler and a collector
 * that returns `{ chains }`. Every case below was written about one panel and
 * still is; this helper supplies the two identifiers the panel now carries so
 * that the assertions themselves did not have to change.
 */
function buildChain(input: Omit<PublicReservesChainInput, 'chainId' | 'asset'>) {
  return buildPublicReservesChain({ chainId: CHAIN, asset: ASSET as AssetId, ...input });
}

function run(overrides: Partial<ReconciliationRunEntity> = {}): ReconciliationRunEntity {
  return {
    assetId: ASSET,
    decimals: 6,
    vaultAccount: '7xKX9mQ2vLpR4nT8jW1aZ6cE3bY5dF0gH2kM4pN7sV9u',
    vaultBalance: '184220410000',
    vaultSlot: '291004112',
    totalLiabilities: '184220410000',
    difference: '0',
    severity: ReconciliationSeverity.OK,
    findings: [],
    finishedAt: new Date('2026-08-11T12:38:00.000Z'),
    ...overrides,
  } as unknown as ReconciliationRunEntity;
}

function snapshot(overrides: Partial<StakeSnapshotEntity> = {}): StakeSnapshotEntity {
  return {
    readAt: new Date('2026-08-11T12:41:00.000Z'),
    stakeAsset: ASSET,
    decimals: 6,
    bondedTotal: '125000000',
    providerCount: 2,
    ...overrides,
  } as unknown as StakeSnapshotEntity;
}

describe('buildPublicReservesChain', () => {
  it('reports the four figures from the latest run', () => {
    const page = buildChain({
      run: run(),
      stake: null,
      accounts: 1204,
      history: [],
      assetSymbol: 'USDC',
    });

    expect(page.state).toBe(PublicReservesState.NORMAL);
    expect(page.vaultBalance).toBe('184220410000');
    expect(page.totalLiabilities).toBe('184220410000');
    expect(page.difference).toBe('0');
    expect(page.accounts).toBe(1204);
    expect(page.decimals).toBe(6);
    expect(page.vaultSlot).toBe('291004112');
    expect(page.reconciledAt).toEqual(new Date('2026-08-11T12:38:00.000Z'));
  });

  it('says no reconciliation has happened when there is no run', () => {
    const page = buildChain({
      run: null,
      stake: null,
      accounts: 0,
      history: [],
      assetSymbol: 'USDC',
    });

    expect(page.state).toBe(PublicReservesState.NO_RECONCILIATION);
    // `$0.00` is a claim. Silence is not.
    expect(page.vaultBalance).toBeNull();
    expect(page.totalLiabilities).toBeNull();
    expect(page.difference).toBeNull();
  });

  it('keeps the sign of a negative difference', () => {
    // A shortfall and a surplus are two different events and must read as such.
    const page = buildChain({
      run: run({ vaultBalance: '184000000000', difference: '-220410000' }),
      stake: null,
      accounts: 3,
      history: [],
      assetSymbol: 'USDC',
    });

    expect(page.state).toBe(PublicReservesState.NORMAL);
    expect(page.difference).toBe('-220410000');
  });

  it('marks the reading stale when the last run was BLIND', () => {
    // Not hypothetical: dev produced 13 consecutive BLIND runs on 2026-08-29
    // when the RPC returned 401 for an hour. A page that printed the previous
    // numbers through that window would have been asserting a reconciliation
    // that did not happen.
    const page = buildChain({
      run: run({
        severity: ReconciliationSeverity.CRITICAL,
        findings: [{ code: ReconciliationFindingCode.RECONCILIATION_BLIND }],
        vaultBalance: null,
        totalLiabilities: null,
        difference: null,
        vaultSlot: null,
      }),
      stake: null,
      accounts: 7,
      history: [],
      assetSymbol: 'USDC',
    });

    expect(page.state).toBe(PublicReservesState.LAST_CHECK_FAILED);
    expect(page.vaultBalance).toBeNull();
    expect(page.difference).toBeNull();
  });

  it('renders a missing slot as absent rather than zero', () => {
    // Every row written before the vault-slot migration was read at a slot nobody
    // recorded. Inventing one is the single thing this page exists not to do.
    const page = buildChain({
      run: run({ vaultSlot: null }),
      stake: null,
      accounts: 1,
      history: [],
      assetSymbol: 'USDC',
    });

    expect(page.vaultSlot).toBeNull();
  });

  it('carries the stake reading with its OWN timestamp, not the run’s', () => {
    // The whole reason the snapshot has its own table: two crons, two times.
    // Rendering the stake under the reconciliation's clock would silently
    // re-assert the simultaneity the separate table exists to deny.
    const page = buildChain({
      run: run(),
      stake: snapshot(),
      accounts: 4,
      history: [],
      assetSymbol: 'USDC',
    });

    expect(page.stake).toEqual({
      bondedTotal: '125000000',
      decimals: 6,
      asset: ASSET,
      providerCount: 2,
      readAt: new Date('2026-08-11T12:41:00.000Z'),
    });
    expect(page.stake?.readAt).not.toEqual(page.reconciledAt);
  });

  it('reports stake as absent when the sweep has never produced a snapshot', () => {
    const page = buildChain({
      run: run(),
      stake: null,
      accounts: 4,
      history: [],
      assetSymbol: 'USDC',
    });

    expect(page.stake).toBeNull();
  });

  it('keeps a BLIND run in the history rather than hiding it', () => {
    // "a non-zero difference is a public incident, not a private one" — and a
    // check that could not run is the same kind of fact.
    const page = buildChain({
      run: run(),
      stake: null,
      accounts: 4,
      history: [
        run(),
        run({
          severity: ReconciliationSeverity.CRITICAL,
          findings: [{ code: ReconciliationFindingCode.RECONCILIATION_BLIND }],
          vaultBalance: null,
          difference: null,
          vaultSlot: null,
          finishedAt: new Date('2026-08-11T12:33:00.000Z'),
        }),
      ],
      assetSymbol: 'USDC',
    });

    expect(page.history).toHaveLength(2);
    expect(page.history[1]).toEqual({
      checkedAt: new Date('2026-08-11T12:33:00.000Z'),
      vaultBalance: null,
      totalLiabilities: '184220410000',
      difference: null,
      vaultSlot: null,
      failed: true,
    });
    expect(page.history[0].failed).toBe(false);
  });

  it('passes the asset symbol through, and null rather than a guess', () => {
    // The page prints `USDC · <mint>`. The ticker comes from the asset
    // registry; an asset the registry has never heard of yields
    // null and the page shows the bare mint rather than inventing a name.
    const named = buildChain({
      run: run(),
      stake: null,
      accounts: 1,
      history: [],
      assetSymbol: 'USDC',
    });
    const unnamed = buildChain({
      run: run(),
      stake: null,
      accounts: 1,
      history: [],
      assetSymbol: null,
    });

    expect(named.assetSymbol).toBe('USDC');
    expect(unnamed.assetSymbol).toBeNull();
  });

  it('treats a CRITICAL run that is not BLIND as a real, publishable reading', () => {
    // A RESERVES_BREACH is the page working, not the page failing. Folding it
    // into LAST_CHECK_FAILED would hide the exact event users come here for.
    const page = buildChain({
      run: run({
        severity: ReconciliationSeverity.CRITICAL,
        findings: [{ code: ReconciliationFindingCode.RESERVES_BREACH }],
        difference: '-500000',
      }),
      stake: null,
      accounts: 9,
      history: [],
      assetSymbol: 'USDC',
    });

    expect(page.state).toBe(PublicReservesState.NORMAL);
    expect(page.difference).toBe('-500000');
  });
});

/**
 * The page, as opposed to one of its panels.
 *
 * Against the service rather than the assembler, because the per-chain rule is
 * about is a **mapping**: one panel per configured asset, no iteration reading
 * another's rows, and no field on the envelope at all. An assembler test could
 * not see a service that fetched one asset twice.
 */
describe('PublicReservesService — a list of chains, never a sum', () => {
  const SOLANA = ASSET_IDS.USDC_SOLANA_DEVNET;
  const EVM = ASSET_IDS.USDG_ROBINHOOD_TESTNET;

  const SOLANA_RUN = run({
    assetId: SOLANA,
    finishedAt: new Date('2026-08-11T12:38:00.000Z'),
  });

  function service(runsByAsset: Readonly<Record<string, ReconciliationRunEntity | null>>) {
    const runs = {
      findLatest: (asset: string) => Promise.resolve(runsByAsset[asset] ?? null),
      findRecent: (asset: string) =>
        Promise.resolve(runsByAsset[asset] ? [runsByAsset[asset]] : []),
    };
    return new PublicReservesService(
      runs as unknown as ReconciliationRunRepository,
      { findLatest: () => Promise.resolve(null) } as unknown as StakeSnapshotRepository,
      {
        countFundedCustomerAccounts: () => Promise.resolve(2),
      } as unknown as AccountBalanceRepository,
      { assets: [SOLANA, EVM] as AssetId[], historyLimit: 4 },
    );
  }

  it('renders one panel per enabled chain, each with its own state and timestamp', async () => {
    const evmRun = run({
      assetId: EVM,
      finishedAt: new Date('2026-08-11T12:44:00.000Z'),
      vaultBalance: '9000000',
    });

    const page = await service({ [SOLANA]: SOLANA_RUN, [EVM]: evmRun }).read();

    expect(page.chains.map((c) => c.chainId)).toEqual([
      CHAIN_IDS.SOLANA_DEVNET,
      CHAIN_IDS.ROBINHOOD_TESTNET,
    ]);
    // Its OWN timestamp, and the assertion is that they DIFFER: a service that
    // read one asset's row and rendered it twice would satisfy the panel count
    // above and nothing here.
    expect(page.chains[0].reconciledAt).not.toEqual(page.chains[1].reconciledAt);
    expect(page.chains[1].vaultBalance).toBe('9000000');
    // And each panel names its own asset, which is what makes a list of two
    // networks readable at all.
    expect(page.chains.map((c) => c.asset)).toEqual([SOLANA, EVM]);
    expect(page.chains.map((c) => c.assetSymbol)).toEqual(['USDC', 'USDG']);
  });

  it('shows NO_RECONCILIATION for a chain that has never run, beside a chain that has', async () => {
    // Absence is not zero. `$0.00` is an assertion; absence is not — and the
    // audience for this page has no account and no other source.
    const page = await service({ [SOLANA]: SOLANA_RUN, [EVM]: null }).read();

    expect(page.chains[1].state).toBe(PublicReservesState.NO_RECONCILIATION);
    expect(page.chains[1].vaultBalance).toBeNull();
    expect(page.chains[0].state).toBe(PublicReservesState.NORMAL);
    // The panel still says which network is unknown. A panel that went blank
    // would read as "there is no such chain" rather than "nobody has checked".
    expect(page.chains[1].chainId).toBe(CHAIN_IDS.ROBINHOOD_TESTNET);
  });

  it('exposes no field that adds the two chains together', async () => {
    const page = await service({ [SOLANA]: SOLANA_RUN, [EVM]: null }).read();

    // Deliberately about the SHAPE rather than a value: a total that is only
    // ever rendered correctly today is a total somebody will read tomorrow.
    expect(Object.keys(page)).toEqual(['chains']);
  });

  it('publishes exactly the assets it was configured with, and in that order', async () => {
    // The other half of the no-sum guard, and the one that catches the opposite
    // mistake: a page that quietly published only the first asset would pass
    // the `Object.keys` check above with a `chains` array of one.
    const page = await service({ [SOLANA]: SOLANA_RUN, [EVM]: null }).read();
    expect(page.chains).toHaveLength(2);
  });
});
