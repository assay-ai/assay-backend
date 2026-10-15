import { DataSource } from 'typeorm';

import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import { LedgerEntryEntity } from '@database/postgres/entities/ledger-entry.entity';
import {
  EntryTypeAssetTotal,
  LedgerEntryRepository,
  OrphanedHoldReleaseSummary,
} from '@database/postgres/repositories/ledger-entry.repository';
import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { AssetId } from '@modules/chains/ports/caip.types';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import {
  MAX_LISTED_ORPHANED_HOLD_IDS,
  WITHHELD_STATUSES,
  WithheldBucket,
} from '@modules/ledger/domain/withheld';
import { LedgerWithheldService } from '@modules/ledger/services/ledger-withheld.service';

const ORG = 'org-11111111-1111-4111-8111-111111111111';
// Registration is no longer what supplies the scale — `decimals` is a
// parameter, read off the ledger row by the caller, so that a balance in an
// unregistered (retired) token can still be reported instead of throwing
// `CHAIN_ASSET_UNKNOWN` and taking the whole of `GET /balances` with it. A
// registered asset is kept here anyway: these tests are about the folding, and
// the unregistered case has its own test in `balances.service.spec.ts`.
const USDC = ASSET_IDS.USDC_SOLANA_MAINNET;
const USDC_DECIMALS = 6;

/**
 * `LedgerWithheldService` — the two independent routes to `withheld`,
 * exercised against mocked repositories so the fold and the reconciliation are
 * proven without a database. Whether the SQL those repositories run actually
 * excludes an unheld `CREATED → EXPIRED` intent and finds a real orphaned
 * `HOLD_RELEASE` is a Postgres question, covered end to end in
 * `test/integration/ledger/withheld-invariant.integration.spec.ts`; this suite
 * covers what this service does with whatever those queries hand back,
 * including the query PaymentIntentRepository builds to get there (see the
 * last `describe` below).
 */

function fakeEntries(overrides: Partial<LedgerEntryRepository> = {}): LedgerEntryRepository {
  return {
    sumEntryTypeByAsset: jest.fn().mockResolvedValue([]),
    summarizeOrphanedHoldReleases: jest.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as LedgerEntryRepository;
}

/** One asset's pre-aggregated orphan and remainder terms, as the repository returns them. */
function orphanSummary(input: {
  settlementRemainders?: bigint;
  orphanedReleases?: bigint;
  ids?: string[];
  count?: number;
}): OrphanedHoldReleaseSummary {
  const ids = input.ids ?? [];
  return {
    asset: USDC,
    decimals: USDC_DECIMALS,
    settlementRemainders: input.settlementRemainders ?? 0n,
    orphanedReleases: input.orphanedReleases ?? 0n,
    orphanedHoldCount: input.count ?? ids.length,
    orphanedHoldIds: ids,
  };
}

function fakeIntents(overrides: Partial<PaymentIntentRepository> = {}): PaymentIntentRepository {
  return {
    sumWithheldByAssetAndStatus: jest.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as PaymentIntentRepository;
}

function build(options: {
  entries?: Partial<LedgerEntryRepository>;
  intents?: Partial<PaymentIntentRepository>;
}) {
  const entries = fakeEntries(options.entries);
  const intents = fakeIntents(options.intents);
  return { service: new LedgerWithheldService(entries, intents), entries, intents };
}

describe('LedgerWithheldService — withheldFromIntents', () => {
  it('always returns both buckets, zero-filled, when nothing withheld', async () => {
    const { service } = build({});

    const total = await service.withheldFromIntents(ORG, USDC, USDC_DECIMALS);

    expect(total.calls).toBe(0);
    expect(total.amount.amount).toBe('0');
    expect(total.buckets).toHaveLength(2);

    const byBucket = new Map(total.buckets.map((bucket) => [bucket.bucket, bucket]));
    expect(byBucket.get(WithheldBucket.FAILED_VERIFICATION)).toMatchObject({
      calls: 0,
      amount: { amount: '0' },
    });
    expect(byBucket.get(WithheldBucket.PROVIDER_OR_PLATFORM_ERROR)).toMatchObject({
      calls: 0,
      amount: { amount: '0' },
    });
  });

  it('folds REFUNDED into failed-verification and VOIDED/EXPIRED into provider-or-platform-error', async () => {
    const { service, intents } = build({
      intents: {
        sumWithheldByAssetAndStatus: jest.fn().mockResolvedValue([
          { asset: USDC, decimals: USDC_DECIMALS, status: 'REFUNDED', calls: 3, amount: 30_000n },
          { asset: USDC, decimals: USDC_DECIMALS, status: 'VOIDED', calls: 2, amount: 20_000n },
          { asset: USDC, decimals: USDC_DECIMALS, status: 'EXPIRED', calls: 1, amount: 10_000n },
        ]),
      },
    });

    const total = await service.withheldFromIntents(ORG, USDC, USDC_DECIMALS);

    expect(total.calls).toBe(6);
    expect(total.amount.amount).toBe('60000');

    const byBucket = new Map(total.buckets.map((bucket) => [bucket.bucket, bucket]));
    expect(byBucket.get(WithheldBucket.FAILED_VERIFICATION)).toMatchObject({
      calls: 3,
      amount: { amount: '30000' },
    });
    // VOIDED and EXPIRED share one bucket — two rows fold into one total.
    expect(byBucket.get(WithheldBucket.PROVIDER_OR_PLATFORM_ERROR)).toMatchObject({
      calls: 3,
      amount: { amount: '30000' },
    });
    expect(intents.sumWithheldByAssetAndStatus).toHaveBeenCalledWith(ORG, {});
  });

  it('ignores rows for a different asset', async () => {
    const OTHER = 'solana:other/token:other' as unknown as AssetId;
    const { service } = build({
      intents: {
        sumWithheldByAssetAndStatus: jest
          .fn()
          .mockResolvedValue([
            { asset: OTHER, decimals: 6, status: 'REFUNDED', calls: 5, amount: 500_000n },
          ]),
      },
    });

    const total = await service.withheldFromIntents(ORG, USDC, USDC_DECIMALS);
    expect(total.calls).toBe(0);
    expect(total.amount.amount).toBe('0');
  });
});

describe('LedgerWithheldService — withheldFromJournal', () => {
  it('is zero when the journal has no HOLD_RELEASE for this asset', async () => {
    const { service } = build({});
    const money = await service.withheldFromJournal(ORG, USDC, USDC_DECIMALS);
    expect(money.amount).toBe('0');
    expect(money.asset).toBe(USDC);
  });

  it('reads Σ HOLD_RELEASE for the requested asset off the pre-aggregated row', async () => {
    const rows: EntryTypeAssetTotal[] = [
      { asset: USDC, decimals: USDC_DECIMALS, amount: 45_000n, entries: 4 },
    ];
    const { service, entries } = build({
      entries: { sumEntryTypeByAsset: jest.fn().mockResolvedValue(rows) },
    });

    const money = await service.withheldFromJournal(ORG, USDC, USDC_DECIMALS);
    expect(money.amount).toBe('45000');
    expect(entries.sumEntryTypeByAsset).toHaveBeenCalledWith(ORG, 'HOLD_RELEASE', {});
  });
});

describe('LedgerWithheldService — reconcile', () => {
  it('balances when withheld plus orphans equals Σ HOLD_RELEASE', async () => {
    const { service } = build({
      intents: {
        sumWithheldByAssetAndStatus: jest
          .fn()
          .mockResolvedValue([
            { asset: USDC, decimals: USDC_DECIMALS, status: 'REFUNDED', calls: 1, amount: 10_000n },
          ]),
      },
      entries: {
        // Ledger side: the withheld release plus one orphaned release.
        sumEntryTypeByAsset: jest
          .fn()
          .mockResolvedValue([
            { asset: USDC, decimals: USDC_DECIMALS, amount: 12_500n, entries: 2 },
          ]),
        summarizeOrphanedHoldReleases: jest
          .fn()
          .mockResolvedValue([orphanSummary({ orphanedReleases: 2_500n, ids: ['hold-orphan-1'] })]),
      },
    });

    const reconciliation = await service.reconcile(ORG, USDC, USDC_DECIMALS);

    expect(reconciliation.ok).toBe(true);
    expect(reconciliation.difference).toBe('0');
    expect(reconciliation.withheld.amount.amount).toBe('10000');
    expect(reconciliation.holdReleaseTotal.amount).toBe('12500');
    expect(reconciliation.orphanedReleases.amount).toBe('2500');
  });

  it('reports a named orphan rather than silently dropping the delta', async () => {
    const { service } = build({
      intents: { sumWithheldByAssetAndStatus: jest.fn().mockResolvedValue([]) },
      entries: {
        sumEntryTypeByAsset: jest
          .fn()
          .mockResolvedValue([
            { asset: USDC, decimals: USDC_DECIMALS, amount: 250_000n, entries: 1 },
          ]),
        summarizeOrphanedHoldReleases: jest
          .fn()
          .mockResolvedValue([
            orphanSummary({ orphanedReleases: 250_000n, ids: ['hold-orphan-only'] }),
          ]),
      },
    });

    const reconciliation = await service.reconcile(ORG, USDC, USDC_DECIMALS);

    expect(reconciliation.orphanedHoldIds).toEqual(['hold-orphan-only']);
    expect(reconciliation.orphanedReleases.amount).toBe('250000');
    expect(reconciliation.withheld.amount.amount).toBe('0');
    // Named, not absorbed: the identity still balances because the orphan is
    // its own term, not because it vanished into `withheld`.
    expect(reconciliation.ok).toBe(true);
  });

  /**
   * Final review N-8: a rail-A call served below its quote releases the
   * remainder on a COMMITTED hold. That used to be listed as an orphan, one per
   * call, so a real orphan was lost in the list and `GET /balances` grew
   * without bound. It is its own term now, and the list is bounded.
   */
  it('counts a settlement remainder as its own term, not as an orphan', async () => {
    const { service } = build({
      intents: { sumWithheldByAssetAndStatus: jest.fn().mockResolvedValue([]) },
      entries: {
        sumEntryTypeByAsset: jest
          .fn()
          .mockResolvedValue([
            { asset: USDC, decimals: USDC_DECIMALS, amount: 3_500n, entries: 2 },
          ]),
        summarizeOrphanedHoldReleases: jest.fn().mockResolvedValue([
          orphanSummary({
            settlementRemainders: 3_000n,
            orphanedReleases: 500n,
            ids: ['hold-orphan'],
          }),
          // Another asset's terms are not this one's.
          { ...orphanSummary({ orphanedReleases: 9n, ids: ['x'] }), asset: 'other' },
        ]),
      },
    });

    const reconciliation = await service.reconcile(ORG, USDC, USDC_DECIMALS);

    expect(reconciliation.orphanedHoldIds).toEqual(['hold-orphan']);
    expect(reconciliation.orphanedHoldCount).toBe(1);
    expect(reconciliation.orphanedReleases.amount).toBe('500');
    expect(reconciliation.settlementRemainders.amount).toBe('3000');
    expect(reconciliation.ok).toBe(true);
  });

  it('bounds the listed orphan ids, and still counts every one', async () => {
    const count = MAX_LISTED_ORPHANED_HOLD_IDS + 50;
    // The repository lists at most the cap; the count is every orphan.
    const ids = Array.from({ length: MAX_LISTED_ORPHANED_HOLD_IDS }, (_, i) => `hold-${i}`);
    const { service } = build({
      entries: {
        sumEntryTypeByAsset: jest
          .fn()
          .mockResolvedValue([
            { asset: USDC, decimals: USDC_DECIMALS, amount: BigInt(count), entries: 1 },
          ]),
        summarizeOrphanedHoldReleases: jest
          .fn()
          .mockResolvedValue([orphanSummary({ orphanedReleases: BigInt(count), ids, count })]),
      },
    });

    const reconciliation = await service.reconcile(ORG, USDC, USDC_DECIMALS);

    expect(reconciliation.orphanedHoldIds).toHaveLength(MAX_LISTED_ORPHANED_HOLD_IDS);
    expect(reconciliation.orphanedHoldCount).toBe(count);
    expect(reconciliation.ok).toBe(true);
  });

  it('reports ok: false with a non-zero difference when a release truly is unaccounted for', async () => {
    const { service } = build({
      intents: { sumWithheldByAssetAndStatus: jest.fn().mockResolvedValue([]) },
      entries: {
        sumEntryTypeByAsset: jest
          .fn()
          .mockResolvedValue([
            { asset: USDC, decimals: USDC_DECIMALS, amount: 250_000n, entries: 1 },
          ]),
        // No orphan reported for a release that exists — the negative control.
        summarizeOrphanedHoldReleases: jest.fn().mockResolvedValue([]),
      },
    });

    const reconciliation = await service.reconcile(ORG, USDC, USDC_DECIMALS);

    expect(reconciliation.ok).toBe(false);
    expect(reconciliation.difference).toBe('250000');
  });
});

/**
 * `PaymentIntentRepository.sumWithheldByAssetAndStatus` — the SQL layer the
 * "a hold must have existed" rule actually lives in.
 *
 * `domain/withheld.ts` requires `holdId !== null` for an intent to withhold
 * anything, and the pre-aggregated row this repository returns has no
 * per-intent `holdId` to re-check in-process — the exclusion has to be a
 * predicate in the query itself. This asserts the predicate is there, against
 * a query builder stubbed the same way `organization-scoped.repository.spec.ts`
 * stubs TypeORM's manager: no database, but the real `Repository` /
 * `OrganizationScopedRepository` machinery in between.
 */
describe('PaymentIntentRepository.sumWithheldByAssetAndStatus — the query itself', () => {
  function buildRepository() {
    const calls: { method: string; args: unknown[] }[] = [];
    const builder: Record<string, unknown> = {};

    const chain =
      (method: string) =>
      (...args: unknown[]) => {
        calls.push({ method, args });
        return builder;
      };

    for (const method of [
      'select',
      'addSelect',
      'leftJoin',
      'where',
      'andWhere',
      'groupBy',
      'addGroupBy',
      'setParameters',
    ]) {
      builder[method] = chain(method);
    }
    builder.getRawMany = jest.fn().mockResolvedValue([]);
    // The organization-scope guard reads this on every terminal call.
    builder.getQuery = () => 'SELECT * FROM payment_intents WHERE organization_id = $1';

    const manager = {
      createQueryBuilder: jest.fn().mockReturnValue(builder),
      connection: {
        getMetadata: () => ({ target: PaymentIntentEntity, name: 'PaymentIntentEntity' }),
      },
    };
    const dataSource = { manager } as unknown as DataSource;

    class TestRepository extends PaymentIntentRepository {
      constructor() {
        super(dataSource);
      }
    }

    return { repository: new TestRepository(), calls };
  }

  it('requires hold_id IS NOT NULL — CREATED → EXPIRED with no hold never contributes', async () => {
    const { repository, calls } = buildRepository();

    await repository.sumWithheldByAssetAndStatus(ORG);

    const holdPredicate = calls.find(
      (call) => call.method === 'andWhere' && call.args[0] === 'intent.holdId IS NOT NULL',
    );
    expect(holdPredicate).toBeDefined();
  });

  it('sums the hold, not the price — a rail-A refund gives back the whole quote', async () => {
    const { repository, calls } = buildRepository();

    await repository.sumWithheldByAssetAndStatus(ORG);

    expect(calls.find((call) => call.method === 'leftJoin')?.args[0]).toBe('ledger_holds');
    const amount = calls.find((call) => call.method === 'addSelect' && call.args[1] === 'amount');
    expect(amount?.args[0]).toContain('hold.amount');
  });

  it('restricts status to WITHHELD_STATUSES, never retyping the list', async () => {
    const { repository, calls } = buildRepository();

    await repository.sumWithheldByAssetAndStatus(ORG);

    const statusPredicate = calls.find(
      (call) => call.method === 'andWhere' && call.args[0] === 'intent.status IN (:...statuses)',
    );
    expect(statusPredicate).toBeDefined();
    expect(statusPredicate?.args[1]).toEqual({ statuses: WITHHELD_STATUSES });
  });

  it('scopes to the caller organization', async () => {
    const { repository, calls } = buildRepository();

    await repository.sumWithheldByAssetAndStatus(ORG);

    const orgPredicate = calls.find(
      (call) =>
        call.method === 'where' && call.args[0] === 'intent.organizationId = :organizationId',
    );
    expect(orgPredicate?.args[1]).toEqual({ organizationId: ORG });
  });
});

/**
 * Round-two review N-8: the orphan query returned one row per remainder — a
 * row for every call served below its hold — so each `GET /balances` loaded
 * the account's whole release history. It aggregates in SQL now: one row per
 * asset, and at most {@link MAX_LISTED_ORPHANED_HOLD_IDS} ids.
 */
describe('LedgerEntryRepository.summarizeOrphanedHoldReleases — the query itself', () => {
  function buildRepository(rows: unknown[]) {
    const calls: { method: string; args: unknown[] }[] = [];
    const builder: Record<string, unknown> = {};
    for (const method of [
      'select',
      'addSelect',
      'innerJoin',
      'where',
      'andWhere',
      'groupBy',
      'addGroupBy',
      'setParameters',
    ]) {
      builder[method] = (...args: unknown[]) => {
        calls.push({ method, args });
        return builder;
      };
    }
    builder.getRawMany = jest.fn().mockResolvedValue(rows);
    builder.getQuery = () => 'SELECT * FROM ledger_entries WHERE organization_id = $1';

    const manager = {
      createQueryBuilder: jest.fn().mockReturnValue(builder),
      connection: {
        getMetadata: () => ({ target: LedgerEntryEntity, name: 'LedgerEntryEntity' }),
      },
    };
    const dataSource = { manager } as unknown as DataSource;
    return { repository: new LedgerEntryRepository(dataSource), calls };
  }

  it('aggregates per asset and selects no per-entry column', async () => {
    const { repository, calls } = buildRepository([]);

    await repository.summarizeOrphanedHoldReleases(ORG);

    const grouped = calls.filter((c) => c.method === 'groupBy' || c.method === 'addGroupBy');
    expect(grouped.map((c) => c.args[0])).toEqual(['entry.assetId', 'entry.decimals']);
    const selected = calls
      .filter((c) => c.method === 'select' || c.method === 'addSelect')
      .map((c) => [c.args[1], String(c.args[0])]);
    for (const [alias, expression] of selected) {
      if (alias === 'asset' || alias === 'decimals') continue;
      expect(expression).toMatch(/^(COALESCE\(SUM|COUNT|\(array_agg)/);
    }
    const ids = selected.find(([alias]) => alias === 'orphanedHoldIds')?.[1];
    expect(ids).toContain(`[1:${MAX_LISTED_ORPHANED_HOLD_IDS}]`);
  });

  it('maps the aggregate row', async () => {
    const { repository } = buildRepository([
      {
        asset: USDC,
        decimals: '6',
        settlementRemainders: '3000',
        orphanedReleases: '500',
        orphanedHoldCount: '2',
        orphanedHoldIds: ['hold-a', 'hold-b'],
      },
      {
        asset: 'other',
        decimals: '6',
        settlementRemainders: '1',
        orphanedReleases: '0',
        orphanedHoldCount: '0',
        orphanedHoldIds: null,
      },
    ]);

    await expect(repository.summarizeOrphanedHoldReleases(ORG)).resolves.toEqual([
      {
        asset: USDC,
        decimals: 6,
        settlementRemainders: 3_000n,
        orphanedReleases: 500n,
        orphanedHoldCount: 2,
        orphanedHoldIds: ['hold-a', 'hold-b'],
      },
      {
        asset: 'other',
        decimals: 6,
        settlementRemainders: 1n,
        orphanedReleases: 0n,
        orphanedHoldCount: 0,
        orphanedHoldIds: [],
      },
    ]);
  });
});
