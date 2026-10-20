import { BuyerEscrowEntity } from '@database/postgres/entities/buyer-escrow.entity';
import { ReconciliationRunEntity } from '@database/postgres/entities/reconciliation-run.entity';
import { AccountBalanceRepository } from '@database/postgres/repositories/account-balance.repository';
import { BuyerEscrowRepository } from '@database/postgres/repositories/buyer-escrow.repository';
import { LedgerEntryRepository } from '@database/postgres/repositories/ledger-entry.repository';
import { ReconciliationRunRepository } from '@database/postgres/repositories/reconciliation-run.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, AssetId, CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import { VaultPort } from '@modules/chains/ports/vault.port';
import {
  EscrowBalanceReaderPort,
  EscrowChainBalance,
} from '@modules/ledger/ports/escrow-balance-reader.port';
import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import {
  RECONCILIATION_ESCROW_PAGE,
  RECONCILIATION_MAX_CONSECUTIVE_FAILURES,
  RECONCILIATION_WARN_ALERT_WINDOW_SECONDS,
} from '@modules/settlement/constants/reconciliation.constants';
import {
  ReconciliationFindingCode,
  ReconciliationSeverity,
} from '@modules/settlement/ports/reconciliation.types';
import { ReconciliationService } from '@modules/settlement/services/reconciliation.service';
import { Alert, AlertPort, AlertSeverity } from '@shared/alerting';
import { MoneyUtil } from '@shared/utils/money.util';

const USDC = ASSET_IDS.USDC_SOLANA_MAINNET;
const VAULT: AccountId = toAccountId(
  CHAIN_IDS.SOLANA_MAINNET,
  'Vau1t1111111111111111111111111111111111111',
);

/** Records everything emitted, so a test can assert on the alert a human sees. */
class RecordingAlertSink implements AlertPort {
  readonly emitted: Alert[] = [];

  emit(alert: Alert): Promise<void> {
    this.emitted.push(alert);
    return Promise.resolve();
  }
}

function fakeVault(balanceAtomic: bigint, overrides: Partial<VaultPort> = {}): VaultPort {
  return {
    getVaultOwner: jest.fn().mockResolvedValue(VAULT),
    getVaultAccount: jest.fn().mockResolvedValue(VAULT),
    getVaultBalance: jest.fn().mockResolvedValue(MoneyUtil.of(balanceAtomic, USDC, 6)),
    getVaultBalanceAt: jest
      .fn()
      .mockResolvedValue({ balance: MoneyUtil.of(balanceAtomic, USDC, 6), slot: 1n }),
    assertVaultControl: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function fakeEntries(
  totals: Partial<Record<LedgerEntryType, bigint>>,
  paidAtRedemption: { providerCredits: bigint; platformFees: bigint } = {
    providerCredits: 0n,
    platformFees: 0n,
  },
) {
  return {
    sumByEntryType: jest.fn().mockResolvedValue({
      totals: new Map(Object.entries(totals)),
      entries: Object.keys(totals).length,
      organizationsAtLeast: 1,
    }),
    sumPaidAtRedemption: jest.fn().mockResolvedValue(paidAtRedemption),
  } as unknown as LedgerEntryRepository;
}

/** One buyer's escrow, as a test states it: what the chain holds, what the mirror thinks. */
interface EscrowFixture {
  readonly account: AccountId;
  readonly chain: bigint;
  readonly openHolds?: bigint;
  /** The mirror's `available + held`. Defaults to `openHolds`, i.e. no drift. */
  readonly mirror?: bigint;
  /** A deposit observed on chain and not yet final (`account_balances.pending`). */
  readonly pending?: bigint;
  readonly seqHigh?: bigint;
  readonly nextSeq?: bigint;
  /** `true` when the chain read failed — unknown, not zero. */
  readonly unreadable?: boolean;
  /** `true` when the chain read finds no escrow at all (never funded) — a zero. */
  readonly absent?: boolean;
}

function fakeBalances(
  available: bigint,
  held = 0n,
  pending = 0n,
  escrows: readonly EscrowFixture[] = [],
) {
  return {
    sumLiabilities: jest.fn().mockResolvedValue({ available, held, pending, organizations: 1 }),
    sumByAccounts: jest.fn((_asset: string, accounts: readonly string[]) => {
      const totals = new Map<string, { available: bigint; held: bigint; pending: bigint }>();
      for (const escrow of escrows) {
        if (!accounts.includes(escrow.account)) {
          continue;
        }
        const openHolds = escrow.openHolds ?? 0n;
        const mirror = escrow.mirror ?? openHolds;
        totals.set(escrow.account, {
          available: mirror - openHolds,
          held: openHolds,
          pending: escrow.pending ?? 0n,
        });
      }
      return Promise.resolve(totals);
    }),
  } as unknown as AccountBalanceRepository;
}

/**
 * `buyer_escrows` in memory, keyset-paginated exactly as the real repository
 * is, so the walk's paging is exercised rather than assumed.
 */
function fakeEscrowRepository(escrows: readonly EscrowFixture[], asset: AssetId = USDC) {
  const rows = escrows.map(
    (escrow, index) =>
      ({
        id: `escrow-${String(index).padStart(4, '0')}`,
        organizationId: 'org-1',
        accountId: escrow.account,
        assetId: asset,
        escrowAccountId: `Escrow${index}`,
        escrowAssetAccountId: `Ata${index}`,
        nextSeq: (escrow.nextSeq ?? 1n).toString(),
      }) as unknown as BuyerEscrowEntity,
  );

  return {
    rows,
    bumpNextSeqTo: jest.fn().mockResolvedValue(1),
    listAll: jest.fn((assetId: string, limit: number, afterId: string | null) => {
      const matching = rows.filter((row) => row.assetId === assetId);
      const start = afterId ? matching.findIndex((row) => row.id === afterId) + 1 : 0;
      return Promise.resolve(matching.slice(start, start + limit));
    }),
  } as unknown as BuyerEscrowRepository & { rows: BuyerEscrowEntity[]; bumpNextSeqTo: jest.Mock };
}

/**
 * The chain side of the escrow walk, batched the way the real reader batches:
 * `readMany` is handed the whole page and answers in one call, so a test can
 * count calls and see the batching rather than the fan-out.
 */
function fakeEscrowReader(escrows: readonly EscrowFixture[]) {
  const readMany = jest.fn((accounts: readonly AccountId[]) => {
    const found = new Map<AccountId, EscrowChainBalance | null>();
    for (const escrow of escrows) {
      if (escrow.unreadable || !accounts.includes(escrow.account)) {
        continue;
      }
      if (escrow.absent) {
        found.set(escrow.account, null);
        continue;
      }
      found.set(escrow.account, {
        balance: MoneyUtil.of(escrow.chain, USDC, 6),
        seqHigh: escrow.seqHigh ?? 0n,
        withdrawRequested: 0n,
        withdrawAvailableAt: 0,
        maxVoucherAmount: 1_000_000_000n,
        maxPerWindow: 1_000_000_000n,
        spentInWindow: 0n,
        windowStartedAt: 0,
        observedAt: new Date(),
      });
    }
    return Promise.resolve(found as ReadonlyMap<AccountId, EscrowChainBalance | null>);
  });

  return {
    read: jest.fn(),
    readMany,
    escrowAddresses: jest.fn(),
  } as unknown as EscrowBalanceReaderPort & { readMany: jest.Mock };
}

/** An in-memory `reconciliation_runs`, so a test can read the history back. */
function fakeRuns(seed: Partial<ReconciliationRunEntity>[] = []) {
  const rows: Partial<ReconciliationRunEntity>[] = [...seed];
  let nextId = 1;

  const repository = {
    rows,
    create: jest.fn((values: Partial<ReconciliationRunEntity>) => ({ ...values })),
    save: jest.fn((row: Partial<ReconciliationRunEntity>) => {
      const saved = { ...row, id: `run-${nextId++}` };
      rows.unshift(saved);
      return Promise.resolve(saved);
    }),
    update: jest.fn((criteria: { id: string }, patch: Partial<ReconciliationRunEntity>) => {
      const row = rows.find((candidate) => candidate.id === criteria.id);
      Object.assign(row ?? {}, patch);
      return Promise.resolve({ affected: 1 });
    }),
    findLatest: jest.fn(() => Promise.resolve(rows[0] ?? null)),
    findRecent: jest.fn((_asset: string, limit: number) => Promise.resolve(rows.slice(0, limit))),
  };

  return repository as unknown as ReconciliationRunRepository & typeof repository;
}

function build(options: {
  vaultBalance?: bigint;
  vault?: VaultPort;
  journal?: Partial<Record<LedgerEntryType, bigint>>;
  snapshot?: { available: bigint; held?: bigint; pending?: bigint };
  runs?: ReturnType<typeof fakeRuns>;
  escrows?: readonly EscrowFixture[];
  paidAtRedemption?: { providerCredits: bigint; platformFees: bigint };
  asset?: AssetId;
  /** "Redeem into hold" (G3.B1): what the mirror holds per payer, and `totalHeld()`. */
  held?: { perAccount: ReadonlyMap<string, bigint>; chainTotal: bigint | null };
}) {
  const alerts = new RecordingAlertSink();
  const runs = options.runs ?? fakeRuns();
  const journal = options.journal ?? {};
  const snapshot = options.snapshot ?? { available: 0n };
  const escrows = options.escrows ?? [];
  const escrowReader = fakeEscrowReader(escrows);
  const escrowRepository = fakeEscrowRepository(escrows, options.asset);

  const service = new ReconciliationService(
    options.vault ?? fakeVault(options.vaultBalance ?? 0n),
    alerts,
    fakeEntries(journal, options.paidAtRedemption),
    fakeBalances(snapshot.available, snapshot.held ?? 0n, snapshot.pending ?? 0n, escrows),
    runs,
    escrowReader,
    escrowRepository,
    options.held
      ? ({
          sumHeldOnChainByAccounts: jest.fn(() =>
            Promise.resolve(new Map(options.held!.perAccount)),
          ),
          sumHeldOnChain: jest.fn(() =>
            Promise.resolve([...options.held!.perAccount.values()].reduce((a, b) => a + b, 0n)),
          ),
        } as never)
      : null,
    options.held
      ? ({ totalHeld: jest.fn(() => Promise.resolve(options.held!.chainTotal)) } as never)
      : null,
  );

  return { service, alerts, runs, escrowReader, escrowRepository };
}

const BUYER_A: AccountId = toAccountId(
  CHAIN_IDS.SOLANA_MAINNET,
  'Buyer1111111111111111111111111111111111111',
);
const BUYER_B: AccountId = toAccountId(
  CHAIN_IDS.SOLANA_MAINNET,
  'Buyer2222222222222222222222222222222222222',
);

describe('ReconciliationService — a rail-B redemption pays out of the vault', () => {
  // The buyer deposited 20.00 into the escrow, one 0.10 voucher was redeemed:
  // the escrow sent 0.09 to the provider and 0.01 to the treasury, so it holds
  // 19.90. The journal still books the 0.09 and 0.01 — as earnings.
  const journal = {
    [LedgerEntryType.DEPOSIT]: 20_000_000n,
    [LedgerEntryType.HOLD_CREATE]: 100_000n,
    [LedgerEntryType.HOLD_COMMIT]: 100_000n,
    [LedgerEntryType.PROVIDER_CREDIT]: 90_000n,
    [LedgerEntryType.PLATFORM_FEE]: 10_000n,
  };

  it('does not count redeemed credits and fees against the vault', async () => {
    const { service, alerts } = build({
      vaultBalance: 19_900_000n,
      journal,
      snapshot: { available: 20_000_000n },
      paidAtRedemption: { providerCredits: 90_000n, platformFees: 10_000n },
    });

    const report = await service.reconcile(USDC);

    expect(report.findings).toEqual([]);
    expect(alerts.emitted).toHaveLength(0);
    expect(report.providerPayableAtomic).toBe(0n);
    expect(report.platformFeesAtomic).toBe(0n);
    expect(report.totalLiabilitiesAtomic).toBe(19_900_000n);
    // The snapshot is still compared against the journal's own total, which
    // carries the credits as the provider's and the platform's balances.
    expect(report.snapshotLiabilitiesAtomic).toBe(20_000_000n);
  });

  it('still owes a platform-absorbed credit, which no redemption paid', async () => {
    // A second 0.10 call whose voucher died: buyer released, provider credited
    // 0.09 from platform funds. The escrow paid nothing for it.
    const { service } = build({
      vaultBalance: 19_900_000n,
      journal: {
        ...journal,
        [LedgerEntryType.HOLD_CREATE]: 200_000n,
        [LedgerEntryType.HOLD_RELEASE]: 100_000n,
        [LedgerEntryType.PROVIDER_CREDIT]: 180_000n,
      },
      snapshot: { available: 20_090_000n },
      paidAtRedemption: { providerCredits: 90_000n, platformFees: 10_000n },
    });

    const report = await service.reconcile(USDC);

    expect(report.providerPayableAtomic).toBe(90_000n);
    expect(report.differenceAtomic).toBe(-90_000n);
    expect(report.findings.map((f) => f.code)).toEqual([ReconciliationFindingCode.RESERVES_BREACH]);
  });
});

describe('ReconciliationService — a matched vault is silent', () => {
  it('reports OK, emits nothing, and still records the run', async () => {
    const { service, alerts, runs } = build({
      vaultBalance: 10_000_000n,
      journal: {
        [LedgerEntryType.DEPOSIT]: 10_000_000n,
        [LedgerEntryType.HOLD_CREATE]: 25_000n,
      },
      snapshot: { available: 9_975_000n, held: 25_000n },
    });

    const report = await service.reconcile(USDC);

    expect(report.severity).toBe(ReconciliationSeverity.OK);
    expect(report.findings).toEqual([]);
    expect(report.alerted).toBe(false);
    expect(alerts.emitted).toHaveLength(0);

    // Silent is not the same as absent: the run is on the record either way.
    expect(runs.save).toHaveBeenCalledTimes(1);
    expect(runs.rows[0]).toMatchObject({
      severity: ReconciliationSeverity.OK,
      vaultBalance: '10000000',
      totalLiabilities: '10000000',
      difference: '0',
      alerted: false,
    });
  });

  it('splits the total into the three figures the alert would name', async () => {
    const { service } = build({
      vaultBalance: 10_000_000n,
      journal: {
        [LedgerEntryType.DEPOSIT]: 10_000_000n,
        [LedgerEntryType.HOLD_CREATE]: 10_000n,
        [LedgerEntryType.HOLD_COMMIT]: 10_000n,
        [LedgerEntryType.PROVIDER_CREDIT]: 9_000n,
        [LedgerEntryType.PLATFORM_FEE]: 1_000n,
      },
      snapshot: { available: 10_000_000n },
    });

    const report = await service.reconcile(USDC);

    expect(report.agentLiabilitiesAtomic).toBe(9_990_000n);
    expect(report.providerPayableAtomic).toBe(9_000n);
    expect(report.platformFeesAtomic).toBe(1_000n);
    expect(report.totalLiabilitiesAtomic).toBe(10_000_000n);
    expect(report.severity).toBe(ReconciliationSeverity.OK);
  });

  it('tolerates a surplus below the threshold without a word', async () => {
    const { service, alerts } = build({
      // $0.50 more than the ledger accounts for — under the $1 tolerance.
      vaultBalance: 10_500_000n,
      journal: { [LedgerEntryType.DEPOSIT]: 10_000_000n },
      snapshot: { available: 10_000_000n },
    });

    const report = await service.reconcile(USDC);

    expect(report.severity).toBe(ReconciliationSeverity.OK);
    expect(alerts.emitted).toHaveLength(0);
  });
});

describe('ReconciliationService — a planted discrepancy is caught', () => {
  /**
   * Forge a journal entry the vault never
   * received, and prove the reconciler notices and shouts with real numbers.
   */
  it('pages CRITICAL with every figure when a forged credit exceeds the vault', async () => {
    const { service, alerts, runs } = build({
      vaultBalance: 10_000_000n,
      journal: {
        [LedgerEntryType.DEPOSIT]: 10_000_000n,
        // $2.50 credited to somebody with nothing behind it on chain.
        [LedgerEntryType.PROMOTIONAL_CREDIT]: 2_500_000n,
      },
      snapshot: { available: 12_500_000n },
    });

    const report = await service.reconcile(USDC);

    expect(report.severity).toBe(ReconciliationSeverity.CRITICAL);
    expect(report.differenceAtomic).toBe(-2_500_000n);
    expect(report.findings.map((f) => f.code)).toContain(ReconciliationFindingCode.RESERVES_BREACH);
    expect(report.alerted).toBe(true);

    const alert = alerts.emitted.find((a) => a.name === 'reserves_breach');
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe(AlertSeverity.CRITICAL);
    // The numbers must be in the alert, not only in a dashboard.
    expect(alert?.summary).toContain('10.000000');
    expect(alert?.summary).toContain('12.500000');
    expect(alert?.summary).toContain('short by 2.500000');
    expect(alert?.details).toMatchObject({
      vaultBalance: '10000000',
      totalLiabilities: '12500000',
      shortfall: '2500000',
      difference: '-2500000',
    });

    expect(runs.rows[0]).toMatchObject({
      severity: ReconciliationSeverity.CRITICAL,
      difference: '-2500000',
      alerted: true,
    });
  });

  it('catches a snapshot that disagrees with the journal even when reserves are fine', async () => {
    const { service, alerts } = build({
      vaultBalance: 10_000_000n,
      journal: { [LedgerEntryType.DEPOSIT]: 10_000_000n },
      // The snapshot says an account holds $1 the journal never credited.
      snapshot: { available: 11_000_000n },
    });

    const report = await service.reconcile(USDC);

    expect(report.severity).toBe(ReconciliationSeverity.CRITICAL);
    expect(report.findings.map((f) => f.code)).toEqual([ReconciliationFindingCode.SNAPSHOT_DRIFT]);

    const alert = alerts.emitted[0];
    expect(alert.name).toBe('ledger_snapshot_drift');
    expect(alert.details).toMatchObject({
      journalTotal: '10000000',
      snapshotTotal: '11000000',
      drift: '1000000',
    });
  });

  it('warns on an unexplained surplus above the threshold', async () => {
    const { service, alerts } = build({
      vaultBalance: 15_000_000n,
      journal: { [LedgerEntryType.DEPOSIT]: 10_000_000n },
      snapshot: { available: 10_000_000n },
    });

    const report = await service.reconcile(USDC);

    expect(report.severity).toBe(ReconciliationSeverity.WARN);
    expect(alerts.emitted[0]).toMatchObject({
      name: 'reserves_unexplained_surplus',
      severity: AlertSeverity.WARN,
    });
    expect(alerts.emitted[0].details).toMatchObject({ surplus: '5000000' });
  });

  it('holds a WARN finding for a day, so a standing surplus pages once not hourly', async () => {
    const { service, alerts } = build({
      vaultBalance: 15_000_000n,
      journal: { [LedgerEntryType.DEPOSIT]: 10_000_000n },
      snapshot: { available: 10_000_000n },
    });

    await service.reconcile(USDC);

    // An unexplained surplus is money nobody can spend: worth a look during
    // working hours, not worth an hourly repeat until someone backfills it.
    expect(alerts.emitted[0].suppressionWindowSeconds).toBe(
      RECONCILIATION_WARN_ALERT_WINDOW_SECONDS,
    );
  });

  it('leaves a CRITICAL finding on the default hourly window', async () => {
    const { service, alerts } = build({
      vaultBalance: 10_000_000n,
      journal: {
        [LedgerEntryType.DEPOSIT]: 10_500_000n,
        [LedgerEntryType.PAYOUT]: 500_000n,
      },
      snapshot: { available: 10_000_000n },
    });

    await service.reconcile(USDC);

    expect(alerts.emitted[0].severity).toBe(AlertSeverity.CRITICAL);
    expect(alerts.emitted[0].suppressionWindowSeconds).toBeUndefined();
  });

  it('catches a negative book that a healthy total would have hidden', async () => {
    const { service, alerts } = build({
      vaultBalance: 10_000_000n,
      journal: {
        [LedgerEntryType.DEPOSIT]: 10_500_000n,
        // More paid out to providers than was ever credited to them.
        [LedgerEntryType.PAYOUT]: 500_000n,
      },
      snapshot: { available: 10_000_000n },
    });

    const report = await service.reconcile(USDC);

    // The inequality holds — 10,000,000 covers 10,000,000 — and the books are
    // still wrong.
    expect(report.differenceAtomic).toBe(0n);
    expect(report.severity).toBe(ReconciliationSeverity.CRITICAL);
    expect(alerts.emitted[0]).toMatchObject({ name: 'ledger_negative_book' });
    expect(alerts.emitted[0].details).toMatchObject({
      book: 'providerPayable',
      total: '-500000',
    });
  });
});

describe('ReconciliationService — when it cannot run', () => {
  it('records a WARN run instead of throwing when the chain read fails', async () => {
    const { service, alerts, runs } = build({
      vault: fakeVault(0n, {
        // `getVaultBalanceAt` is the read now. Rejecting `getVaultBalance`
        // instead would leave this test green while exercising nothing — the
        // service would never call it.
        getVaultBalanceAt: jest.fn().mockRejectedValue(new Error('RPC timeout')),
      }),
    });

    const report = await service.reconcile(USDC);

    expect(report.severity).toBe(ReconciliationSeverity.WARN);
    expect(report.findings[0].code).toBe(ReconciliationFindingCode.RECONCILIATION_FAILED);
    expect(report.vaultBalance).toBeNull();
    expect(runs.rows[0]).toMatchObject({ severity: 'WARN', vaultBalance: null });
    expect(alerts.emitted[0].summary).toContain('RPC timeout');
  });

  it('escalates to CRITICAL once nobody has checked the money for long enough', async () => {
    const failed = () =>
      ({
        id: 'old',
        severity: 'WARN',
        vaultBalance: null,
        totalLiabilities: null,
      }) as Partial<ReconciliationRunEntity>;

    const runs = fakeRuns(
      Array.from({ length: RECONCILIATION_MAX_CONSECUTIVE_FAILURES - 1 }, failed),
    );
    const { service, alerts } = build({
      runs,
      vault: fakeVault(0n, {
        // `getVaultBalanceAt` is the read now. Rejecting `getVaultBalance`
        // instead would leave this test green while exercising nothing — the
        // service would never call it.
        getVaultBalanceAt: jest.fn().mockRejectedValue(new Error('RPC timeout')),
      }),
    });

    const report = await service.reconcile(USDC);

    expect(report.severity).toBe(ReconciliationSeverity.CRITICAL);
    expect(report.findings[0].code).toBe(ReconciliationFindingCode.RECONCILIATION_BLIND);
    expect(alerts.emitted[0]).toMatchObject({
      name: 'reconciliation_blind',
      severity: AlertSeverity.CRITICAL,
    });
  });

  it('does not read the vault balance before control is proven', async () => {
    const vault = fakeVault(10_000_000n, {
      assertVaultControl: jest.fn().mockRejectedValue(new Error('control not proven')),
    });
    const { service } = build({ vault });

    const report = await service.reconcile(USDC);

    expect(vault.getVaultBalance).not.toHaveBeenCalled();
    expect(report.severity).toBe(ReconciliationSeverity.WARN);
  });
});

describe('ReconciliationService — isFrozen', () => {
  it('is frozen after a CRITICAL run', async () => {
    const runs = fakeRuns([{ id: 'r', severity: 'CRITICAL' }]);
    const { service } = build({ runs });

    await expect(service.isFrozen(USDC)).resolves.toBe(true);
  });

  it('is not frozen after a clean run', async () => {
    const runs = fakeRuns([{ id: 'r', severity: 'OK' }]);
    const { service } = build({ runs });

    await expect(service.isFrozen(USDC)).resolves.toBe(false);
  });

  it('is not frozen when the reconciler has never run — no evidence is not evidence', async () => {
    const { service } = build({ runs: fakeRuns() });

    await expect(service.isFrozen(USDC)).resolves.toBe(false);
  });
});

describe('ReconciliationService — every buyer’s own escrow', () => {
  it('pages when a buyer’s escrow holds less than the platform has reserved against it', async () => {
    const { service } = build({
      vaultBalance: 0n,
      escrows: [{ account: BUYER_A, chain: 1_000_000n, openHolds: 4_000_000n }],
    });

    const report = await service.reconcile(USDC);

    expect(report.severity).toBe(ReconciliationSeverity.CRITICAL);
    expect(report.findings.map((finding) => finding.code)).toContain(
      ReconciliationFindingCode.ESCROW_SHORTFALL,
    );
  });

  it('names the buyer in the finding, because "some escrow is short" is not actionable', async () => {
    const { service, alerts } = build({
      vaultBalance: 0n,
      escrows: [{ account: BUYER_A, chain: 0n, openHolds: 1n }],
    });

    const report = await service.reconcile(USDC);

    const finding = report.findings.find(
      (candidate) => candidate.code === ReconciliationFindingCode.ESCROW_SHORTFALL,
    );
    expect(finding?.details).toMatchObject({ account: BUYER_A, shortfall: '1' });
    expect(alerts.emitted[0]).toMatchObject({ name: 'escrow_shortfall' });
    // One buyer's incident must not suppress another's.
    expect(alerts.emitted[0].dedupeKey).toBe(`${USDC}:${BUYER_A}`);
  });

  it('warns rather than pages when the mirror merely lags the chain', async () => {
    // A redemption that landed before its HOLD_COMMIT was written produces
    // exactly this, on every pass, for as long as the gap lasts. Paging on it
    // would page on ordinary operation.
    const { service } = build({
      vaultBalance: 0n,
      escrows: [{ account: BUYER_A, chain: 3_000_000n, mirror: 4_000_000n, openHolds: 0n }],
    });

    const report = await service.reconcile(USDC);

    expect(report.severity).toBe(ReconciliationSeverity.WARN);
    expect(report.findings.map((finding) => finding.code)).toEqual([
      ReconciliationFindingCode.ESCROW_MIRROR_DRIFT,
    ]);
  });

  it('does not call a deposit waiting for finality drift — its money is already in the escrow', async () => {
    // Measured against a deployed environment: every eip155:46630 deposit paged
    // `escrow_mirror_drift` "the chain holds 10, the mirror says 0" for the ~20
    // minutes between settle (DEPOSIT_PENDING, which fills `pending`) and
    // finality (DEPOSIT_CONFIRM). The transfer is ON CHAIN in that window; the
    // mirror simply has it in the bucket this check did not add up.
    const { service, alerts } = build({
      vaultBalance: 0n,
      escrows: [{ account: BUYER_A, chain: 10_000_000n, mirror: 0n, pending: 10_000_000n }],
    });

    const report = await service.reconcile(USDC);

    expect(report.findings.map((finding) => finding.code)).not.toContain(
      ReconciliationFindingCode.ESCROW_MIRROR_DRIFT,
    );
    expect(alerts.emitted).toHaveLength(0);
  });

  it('holds escrow drift quiet for a day — it is expected, not news', async () => {
    const { service, alerts } = build({
      vaultBalance: 0n,
      escrows: [{ account: BUYER_A, chain: 3_000_000n, mirror: 4_000_000n, openHolds: 0n }],
    });

    await service.reconcile(USDC);

    expect(alerts.emitted[0]).toMatchObject({ name: 'escrow_mirror_drift' });
    expect(alerts.emitted[0].suppressionWindowSeconds).toBe(
      RECONCILIATION_WARN_ALERT_WINDOW_SECONDS,
    );
  });

  it('is silent when the chain and the mirror agree', async () => {
    const { service, alerts } = build({
      vaultBalance: 0n,
      escrows: [
        { account: BUYER_A, chain: 4_000_000n, openHolds: 1_000_000n, mirror: 4_000_000n },
        { account: BUYER_B, chain: 0n, openHolds: 0n, mirror: 0n },
      ],
    });

    const report = await service.reconcile(USDC);

    expect(report.severity).toBe(ReconciliationSeverity.OK);
    expect(alerts.emitted).toHaveLength(0);
    expect(report.escrowAccounts).toBe(2);
    expect(report.escrowTotalAtomic).toBe(4_000_000n);
    expect(report.escrowShortfallAccounts).toBe(0);
  });

  it('reports an unreadable escrow as unknown rather than as clean or as a shortfall', async () => {
    // A check that skipped unreadable accounts would report clean while blind —
    // the same argument RECONCILIATION_BLIND makes about the whole run.
    const { service } = build({
      vaultBalance: 0n,
      escrows: [{ account: BUYER_A, chain: 0n, unreadable: true }],
    });

    const report = await service.reconcile(USDC);

    expect(report.severity).toBe(ReconciliationSeverity.WARN);
    expect(report.findings.map((finding) => finding.code)).toContain(
      ReconciliationFindingCode.RECONCILIATION_FAILED,
    );
    expect(report.escrowAccounts).toBe(0);
    expect(report.findings[0].details).toMatchObject({ unreadableEscrows: 1 });
  });

  it('reads a never-funded mirror row (no escrow on chain) as a zero, not as unreadable', async () => {
    // BUG-A-05 option a records a mirror row on the first rail-B offer for a
    // buyer who never deposited. The chain has nothing there: a zero balance.
    const { service } = build({
      vaultBalance: 4_000_000n,
      journal: { DEPOSIT: 4_000_000n },
      snapshot: { available: 4_000_000n },
      escrows: [
        { account: BUYER_A, chain: 4_000_000n, mirror: 4_000_000n },
        { account: BUYER_B, chain: 0n, mirror: 0n, absent: true },
      ],
    });

    const report = await service.reconcile(USDC);

    expect(report.findings.map((finding) => finding.code)).not.toContain(
      ReconciliationFindingCode.RECONCILIATION_FAILED,
    );
    expect(report.severity).toBe(ReconciliationSeverity.OK);
    expect(report.escrowAccounts).toBe(2);
    expect(report.escrowTotalAtomic).toBe(4_000_000n);
  });

  it('still flags a shortfall when the mirror holds money for a buyer with no escrow on chain', async () => {
    const { service } = build({
      vaultBalance: 0n,
      escrows: [{ account: BUYER_A, chain: 0n, openHolds: 1_000_000n, absent: true }],
    });

    const report = await service.reconcile(USDC);

    expect(report.escrowShortfallAccounts).toBe(1);
    expect(report.findings.map((finding) => finding.code)).not.toContain(
      ReconciliationFindingCode.RECONCILIATION_FAILED,
    );
  });

  it('reads escrows a page at a time, not one chain call per buyer', async () => {
    // Batching is the mitigation that keeps failing closed affordable.
    // 250 escrows is three pages of RECONCILIATION_ESCROW_PAGE, so three calls
    // into `readMany` — which batches the chain read underneath by its own
    // 100-ADDRESS limit (two addresses per escrow).
    const escrows = Array.from({ length: 250 }, (_unused, index) => ({
      account: toAccountId(
        CHAIN_IDS.SOLANA_MAINNET,
        `Buyer${String(index).padStart(38, '0')}`,
      ) as AccountId,
      chain: 1n,
      openHolds: 0n,
      mirror: 1n,
    }));

    const { service, escrowReader } = build({ vaultBalance: 0n, escrows });

    await service.reconcile(USDC);

    expect(escrowReader.readMany).toHaveBeenCalledTimes(
      Math.ceil(escrows.length / RECONCILIATION_ESCROW_PAGE),
    );
    expect(escrowReader.readMany.mock.calls[0][0]).toHaveLength(RECONCILIATION_ESCROW_PAGE);
  });

  it('realigns next_seq when the chain has already redeemed past it (self-heal)', async () => {
    // The recovery path for a database restored from a backup taken before some
    // of its vouchers were redeemed. Without it the allocator re-issues numbers
    // the chain has already spent, and every one of those redemptions dies with
    // VoucherAlreadyRedeemed after the call was served.
    const { service, escrowRepository } = build({
      vaultBalance: 0n,
      escrows: [
        { account: BUYER_A, chain: 1n, openHolds: 0n, mirror: 1n, seqHigh: 40n, nextSeq: 12n },
      ],
    });

    await service.reconcile(USDC);

    expect(escrowRepository.bumpNextSeqTo).toHaveBeenCalledWith('org-1', BUYER_A, 41n);
  });

  it('leaves next_seq alone when the chain is behind it, which is the normal case', async () => {
    const { service, escrowRepository } = build({
      vaultBalance: 0n,
      escrows: [
        { account: BUYER_A, chain: 1n, openHolds: 0n, mirror: 1n, seqHigh: 10n, nextSeq: 11n },
      ],
    });

    await service.reconcile(USDC);

    expect(escrowRepository.bumpNextSeqTo).not.toHaveBeenCalled();
  });
});

describe('ReconciliationService — the freeze flag', () => {
  it('keeps the freeze semantics exactly: the newest run’s severity is the whole flag', async () => {
    const runs = fakeRuns();
    const short = build({
      runs,
      vaultBalance: 0n,
      escrows: [{ account: BUYER_A, chain: 0n, openHolds: 1n }],
    });
    await short.service.reconcile(USDC);
    await expect(short.service.isFrozen(USDC)).resolves.toBe(true);

    const repaired = build({
      runs,
      vaultBalance: 0n,
      escrows: [{ account: BUYER_A, chain: 1n, openHolds: 1n, mirror: 1n }],
    });
    await repaired.service.reconcile(USDC);
    await expect(repaired.service.isFrozen(USDC)).resolves.toBe(false);
  });
});

describe('ReconciliationService — the slot the vault was read at', () => {
  /**
   * The proof-of-reserves page prints this next to the balance so a visitor can check the vault
   * themselves at the same slot. Reading the balance and then forgetting where
   * it came from turns a proof back into a claim.
   */
  it('records the slot reported by the vault read', async () => {
    const runs = fakeRuns();
    const vault = fakeVault(1_000_000n, {
      getVaultBalanceAt: jest
        .fn()
        .mockResolvedValue({ balance: MoneyUtil.of(1_000_000n, USDC, 6), slot: 291_004_112n }),
    });
    const { service } = build({ runs, vault });

    await service.reconcile(USDC);

    expect(runs.create).toHaveBeenCalledWith(expect.objectContaining({ vaultSlot: '291004112' }));
  });

  /**
   * One read, not two. Calling `getVaultBalance` as well would put the balance
   * and the slot a round trip apart — two moments printed as one.
   */
  it('reads the vault exactly once, through the slot-bearing method', async () => {
    const vault = fakeVault(1_000_000n);
    const { service } = build({ vault });

    await service.reconcile(USDC);

    expect(vault.getVaultBalanceAt).toHaveBeenCalledTimes(1);
    expect(vault.getVaultBalance).not.toHaveBeenCalled();
  });
});

/**
 * A `buyer_escrows` table holds every chain's escrows in one table, and the
 * walk used to read all of them whatever asset it was reconciling.
 *
 * What that costs, measured on a local stack running `eip155:46630` beside four
 * leftover Solana rows: `NamespaceEscrowBalanceReader` dispatches on the
 * **account's** namespace and passes the asset through untouched, so the Solana
 * reader was handed an `eip155` asset and threw
 *
 *   SolanaError: Invalid value 0x915Ef7… for base 58
 *
 * every pass. The reconciler then recorded `RECONCILIATION_BLIND`, which froze
 * withdrawals and — because the five-minute sweep is the only crediting route
 * since the finality watcher was retired — left real deposits sitting
 * in the escrow contract, uncredited, with nothing anywhere saying so.
 *
 * The base58 alphabet is what made it loud. A `0x` address that happened to be
 * valid base58 would have decoded into somebody else's account instead.
 */
describe('ReconciliationService — the escrow walk is scoped to the asset', () => {
  it('never hands another chain’s escrow accounts to the reader', async () => {
    const EVM = 'eip155:46630/erc20:0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac' as AssetId;
    const solanaAccount =
      'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:8ZaUV8QFrwR8SHoMSjXyVBuVsv7i2Aabk4eV9Ucj9KmP' as AccountId;

    const rows = [
      {
        id: 'escrow-0000',
        organizationId: 'org-1',
        accountId: solanaAccount,
        assetId: USDC,
        escrowAccountId: 'Escrow0',
        escrowAssetAccountId: 'Ata0',
        nextSeq: '1',
      },
    ] as unknown as BuyerEscrowEntity[];

    const listAll = jest.fn((assetId: AssetId, limit: number, afterId: string | null) => {
      const matching = rows.filter((row) => row.assetId === assetId);
      const start = afterId ? matching.findIndex((row) => row.id === afterId) + 1 : 0;
      return Promise.resolve(matching.slice(start, start + limit));
    });

    const readMany = jest.fn().mockResolvedValue(new Map());

    const service = new ReconciliationService(
      fakeVault(0n),
      new RecordingAlertSink(),
      fakeEntries({}),
      fakeBalances(0n, 0n, 0n, []),
      fakeRuns(),
      { read: jest.fn(), readMany } as never,
      { listAll, bumpNextSeqTo: jest.fn() } as never,
    );

    await service.reconcile(EVM);

    // The walk asked for THIS asset's rows...
    expect(listAll).toHaveBeenCalledWith(EVM, expect.any(Number), null);
    // ...and the Solana account never reached the reader.
    for (const [accounts] of readMany.mock.calls) {
      expect(accounts).not.toContain(solanaAccount);
    }
  });
});

describe('ReconciliationService — where an EVM surplus sits', () => {
  const EVM = 'eip155:46630/erc20:0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac' as AssetId;
  const BUYER = toAccountId(
    CHAIN_IDS.ROBINHOOD_TESTNET,
    '0x18103e0000000000000000000000000000000001',
  ) as AccountId;
  // One known buyer escrow of 19.90, plus 10.00 a payer with no buyer_escrows
  // row deposited straight into the contract.
  const options = {
    asset: EVM,
    vaultBalance: 29_900_000n,
    journal: { [LedgerEntryType.DEPOSIT]: 19_900_000n },
    snapshot: { available: 19_900_000n },
  };

  it('names the part of the vault no mirrored buyer escrow holds, severity unchanged', async () => {
    const { service } = build({
      ...options,
      escrows: [{ account: BUYER, chain: 19_900_000n, mirror: 19_900_000n }],
    });

    const report = await service.reconcile(EVM);
    const surplus = report.findings.find(
      (f) => f.code === ReconciliationFindingCode.UNEXPLAINED_SURPLUS,
    );

    expect(surplus?.severity).toBe(ReconciliationSeverity.WARN);
    expect(surplus?.details).toMatchObject({
      surplus: '10000000',
      outsideBuyerEscrows: '10000000',
    });
    expect(surplus?.summary).toMatch(/outside every buyer escrow/);
  });

  it('says nothing about where it sits when an escrow could not be read', async () => {
    const { service } = build({
      ...options,
      escrows: [{ account: BUYER, chain: 19_900_000n, unreadable: true }],
    });

    const report = await service.reconcile(EVM);
    const surplus = report.findings.find(
      (f) => f.code === ReconciliationFindingCode.UNEXPLAINED_SURPLUS,
    );

    expect(surplus?.details).not.toHaveProperty('outsideBuyerEscrows');
  });
});

describe('ReconciliationService — held payments (G3.B1, redeem into hold)', () => {
  it('takes a held payment off both sides: out of the escrow balance, still in the ledger hold', async () => {
    // Redeemed into the hold: the chain balance dropped by 1, the buyer's ledger
    // hold still carries it, the escrow contract holds it as `totalHeld`.
    const { service } = build({
      vaultBalance: 1_000_000n,
      journal: { DEPOSIT: 4_000_000n },
      snapshot: { available: 3_000_000n, held: 1_000_000n },
      escrows: [{ account: BUYER_A, chain: 3_000_000n, mirror: 4_000_000n, openHolds: 1_000_000n }],
      held: { perAccount: new Map([[BUYER_A, 1_000_000n]]), chainTotal: 1_000_000n },
    });

    const report = await service.reconcile(USDC);

    const codes = report.findings.map((finding) => finding.code);
    expect(codes).not.toContain(ReconciliationFindingCode.ESCROW_SHORTFALL);
    expect(codes).not.toContain(ReconciliationFindingCode.ESCROW_MIRROR_DRIFT);
    expect(codes).not.toContain(ReconciliationFindingCode.HELD_MIRROR_DRIFT);
  });

  it('warns when totalHeld() and the mirrored held payments disagree', async () => {
    const { service } = build({
      vaultBalance: 0n,
      held: { perAccount: new Map([[BUYER_A, 1_000_000n]]), chainTotal: 3_000_000n },
    });

    const report = await service.reconcile(USDC);

    const drift = report.findings.find(
      (finding) => finding.code === ReconciliationFindingCode.HELD_MIRROR_DRIFT,
    );
    expect(drift?.details).toMatchObject({ totalHeld: '3000000', mirroredHeld: '1000000' });
  });
});
