import { randomBytes, randomInt, randomUUID } from 'node:crypto';

import { LedgerEntryRepository } from '@database/postgres/repositories/ledger-entry.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import {
  AccountId,
  AssetId,
  CHAIN_IDS,
  ChainId,
  toAccountId,
} from '@modules/chains/ports/caip.types';
import {
  MAX_LISTED_ORPHANED_HOLD_IDS,
  WithheldPeriod,
  WithheldReconciliation,
  reconcileWithheld,
} from '@modules/ledger/domain/withheld';
import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { LedgerWithheldService } from '@modules/ledger/services/ledger-withheld.service';
import {
  PaymentIntentCallClass,
  PaymentIntentStatus,
  PaymentRail,
} from '@modules/payment/ports/payment.types';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  USDC_ASSET,
  USDC_DECIMALS,
  WithheldTestContext,
  createWithheldTestContext,
} from '../helpers/withheld-test-context';

/**
 * B4: `GET /balances` and `GET /withheld` reconciled `withheld` once per asset,
 * and each reconciliation ran three organization-wide aggregates that already
 * group by asset. `LedgerWithheldService.reconcileAssets` runs them once and
 * folds every asset from the same rows. This proves the result is identical,
 * field for field, to the per-asset path it replaced (kept below verbatim as
 * `legacyReconcile`), over two assets with every term non-zero, an asset with
 * no rows, and windowed periods.
 */
const SECOND_ASSET = ASSET_IDS.USDC_SOLANA_DEVNET as AssetId;
const SECOND_DECIMALS = 6;
const EMPTY_ASSET =
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:Empty1111111111111111111111111111111111' as AssetId;

let context: WithheldTestContext;
let service: LedgerWithheldService;
let entries: LedgerEntryRepository;

/** `LedgerWithheldService.reconcile` before B4, one asset at a time. */
async function legacyReconcile(
  organizationId: string,
  asset: AssetId,
  decimals: number,
  period: WithheldPeriod = {},
): Promise<WithheldReconciliation> {
  const [withheld, holdReleaseTotal, summaries] = await Promise.all([
    service.withheldFromIntents(organizationId, asset, decimals, period),
    service.withheldFromJournal(organizationId, asset, decimals, period),
    entries.summarizeOrphanedHoldReleases(organizationId, period, MAX_LISTED_ORPHANED_HOLD_IDS),
  ]);

  const forAsset = summaries.filter((summary) => summary.asset === asset);
  const sum = (term: (row: (typeof forAsset)[number]) => bigint) =>
    forAsset.reduce((total, row) => total + term(row), 0n);

  return reconcileWithheld({
    withheld,
    holdReleaseTotal,
    orphanedReleases: MoneyUtil.of(
      sum((row) => row.orphanedReleases),
      asset,
      decimals,
    ),
    orphanedHoldIds: forAsset.flatMap((row) => row.orphanedHoldIds),
    orphanedHoldCount: forAsset.reduce((total, row) => total + row.orphanedHoldCount, 0),
    settlementRemainders: MoneyUtil.of(
      sum((row) => row.settlementRemainders),
      asset,
      decimals,
    ),
  });
}

beforeAll(async () => {
  context = await createWithheldTestContext();
  entries = new LedgerEntryRepository(context.dataSource);
  service = new LedgerWithheldService(entries, context.repository);
}, 120_000);

afterAll(async () => {
  await context?.close();
});

async function fund(accountId: AccountId, asset: AssetId, atomic: bigint): Promise<void> {
  await context.ledger.appendNow({
    organizationId: context.organizationId,
    accountId,
    entryType: LedgerEntryType.DEPOSIT,
    money: MoneyUtil.of(atomic, asset, SECOND_DECIMALS),
  });
}

async function intentIn(asset: AssetId, chainId: ChainId, account: AccountId, price: bigint) {
  return context.intents.create({
    organizationId: context.organizationId,
    agentId: randomUUID(),
    agentAccount: account,
    toolId: randomUUID(),
    rail: PaymentRail.RAIL_B_VOUCHER,
    callId: randomUUID(),
    callClass: PaymentIntentCallClass.PAID,
    price: MoneyUtil.of(price, asset, SECOND_DECIMALS),
    platformFee: MoneyUtil.of(price / 10n, asset, SECOND_DECIMALS),
    requestHash: `sha256:${randomBytes(16).toString('hex')}`,
    chainId,
    voucherSeq: String(randomInt(1, 2 ** 47)),
  });
}

/** One intent through FUNDS_SECURED → … → `to`, with the real service methods. */
async function drive(
  asset: AssetId,
  chainId: ChainId,
  account: AccountId,
  price: bigint,
  to: 'REFUNDED' | 'VOIDED' | 'EXPIRED' | 'SETTLED',
): Promise<void> {
  const { organizationId } = context;
  const intent = await intentIn(asset, chainId, account, price);
  await context.intents.secureFunds(organizationId, intent.id);
  if (to === 'EXPIRED') {
    await context.intents.resolve(
      organizationId,
      intent.id,
      PaymentIntentStatus.FUNDS_SECURED,
      PaymentIntentStatus.EXPIRED,
      { reason: 'expiry sweep' },
    );
    return;
  }
  await context.intents.transition(
    organizationId,
    intent.id,
    PaymentIntentStatus.FUNDS_SECURED,
    PaymentIntentStatus.PROVIDER_EXECUTING,
    { reason: 'forwarded' },
  );
  const providerId = randomUUID();
  if (to === 'VOIDED') {
    await context.intents.resolve(
      organizationId,
      intent.id,
      PaymentIntentStatus.PROVIDER_EXECUTING,
      PaymentIntentStatus.VOIDED,
      { reason: 'provider error', providerId },
    );
    return;
  }
  await context.intents.resolve(
    organizationId,
    intent.id,
    PaymentIntentStatus.PROVIDER_EXECUTING,
    PaymentIntentStatus.VERIFYING,
    {
      reason: 'data result',
      providerId,
      providerAccount: toAccountId(chainId, `provider-${providerId}`) as AccountId,
    },
  );
  await context.intents.resolve(
    organizationId,
    intent.id,
    PaymentIntentStatus.VERIFYING,
    to === 'SETTLED' ? PaymentIntentStatus.SETTLED : PaymentIntentStatus.REFUNDED,
    {
      reason: to === 'SETTLED' ? 'verification passed' : 'verification failed',
      verificationVerdict: to === 'SETTLED' ? 'PASS' : 'FAIL',
    },
  );
}

/** A release on a hold its intent never recorded: an orphan. */
async function orphan(asset: AssetId, chainId: ChainId, account: AccountId, price: bigint) {
  const intent = await intentIn(asset, chainId, account, price);
  const hold = await context.ledger.createHold({
    organizationId: context.organizationId,
    accountId: account,
    money: MoneyUtil.of(price, asset, SECOND_DECIMALS),
    intentId: intent.id,
  });
  await context.ledger.releaseHold(context.organizationId, hold.id);
}

it('reconciles every asset exactly as the per-asset reads did', async () => {
  await context.reset();
  const mainnet = CHAIN_IDS.SOLANA_MAINNET;
  const devnet = CHAIN_IDS.SOLANA_DEVNET;
  const first = toAccountId(mainnet, 'batched-agent-1') as AccountId;
  const second = toAccountId(devnet, 'batched-agent-2') as AccountId;
  await fund(first, USDC_ASSET, 1_000_000_000n);
  await fund(second, SECOND_ASSET, 1_000_000_000n);

  for (const [to, price] of [
    ['REFUNDED', 120_000n],
    ['VOIDED', 70_000n],
    ['EXPIRED', 33_000n],
    ['SETTLED', 50_000n],
    ['REFUNDED', 9_000n],
  ] as const) {
    await drive(USDC_ASSET, mainnet, first, price, to);
  }
  await orphan(USDC_ASSET, mainnet, first, 41_000n);
  for (const [to, price] of [
    ['REFUNDED', 15_000n],
    ['VOIDED', 25_000n],
    ['SETTLED', 35_000n],
  ] as const) {
    await drive(SECOND_ASSET, devnet, second, price, to);
  }
  await orphan(SECOND_ASSET, devnet, second, 11_000n);
  await orphan(SECOND_ASSET, devnet, second, 12_000n);

  const assets = [
    { asset: USDC_ASSET, decimals: USDC_DECIMALS },
    { asset: SECOND_ASSET, decimals: SECOND_DECIMALS },
    { asset: EMPTY_ASSET, decimals: 9 },
  ];
  const now = Date.now();
  const periods: WithheldPeriod[] = [
    {},
    { from: new Date(now - 3_600_000), to: new Date(now + 3_600_000) },
    { from: new Date(now + 3_600_000) },
    { to: new Date(now - 3_600_000) },
  ];

  for (const period of periods) {
    const legacy = await Promise.all(
      assets.map(({ asset, decimals }) =>
        legacyReconcile(context.organizationId, asset, decimals, period),
      ),
    );
    const batched = await service.reconcileAssets(context.organizationId, assets, period);
    expect(batched).toEqual(legacy);

    const single = await Promise.all(
      assets.map(({ asset, decimals }) =>
        service.reconcile(context.organizationId, asset, decimals, period),
      ),
    );
    expect(single).toEqual(legacy);
  }

  // The world is not trivial: both assets have withheld value and orphans.
  const [usdc, other] = await service.reconcileAssets(context.organizationId, assets);
  expect(BigInt(usdc.withheld.amount.amount)).toBeGreaterThan(0n);
  expect(usdc.orphanedHoldCount).toBe(1);
  expect(BigInt(other.withheld.amount.amount)).toBeGreaterThan(0n);
  expect(other.orphanedHoldCount).toBe(2);
}, 120_000);

it('runs no query for no asset', async () => {
  const spy = jest.spyOn(entries, 'sumEntryTypeByAsset');
  expect(await service.reconcileAssets(context.organizationId, [])).toEqual([]);
  expect(spy).not.toHaveBeenCalled();
});
