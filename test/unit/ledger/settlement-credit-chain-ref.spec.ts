import { DataSource, QueryRunner } from 'typeorm';

import { LedgerHoldEntity } from '@database/postgres/entities/ledger-hold.entity';
import { LedgerHoldRepository } from '@database/postgres/repositories/ledger-hold.repository';
import { AssetId } from '@modules/chains/ports/caip.types';
import { LedgerErrorCode } from '@modules/ledger/errors/ledger.errors';
import {
  AppendEntryInput,
  LedgerEntryType,
  LedgerHoldStatus,
  SettlementCredit,
} from '@modules/ledger/ports/ledger.types';
import { LedgerHoldService } from '@modules/ledger/services/ledger-hold.service';
import { LedgerJournalService } from '@modules/ledger/services/ledger-journal.service';
import { MoneyUtil } from '@shared/utils/money.util';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { ORG, USDC, USDC_DECIMALS, testAccount } from './helpers/entries';

/**
 * `HOLD_COMMIT` names the transaction that moved the money.
 *
 * The ledger is a mirror of a chain now, not the thing that authorises
 * spending. A commit with no signature behind it is a claim about the chain
 * that nothing on the chain supports, and it is exactly how a mirror silently
 * becomes the source of truth again. So `chainTxRef` is required on
 * `SettlementCredit` at compile time **and** refused at runtime — the second
 * because the first is only as strong as the nearest `as unknown as` in a
 * caller written next year.
 */

const HOLD_ID = 'hold-77777777-7777-4777-8777-777777777777';
const INTENT_ID = 'intent-88888888-8888-4888-8888-888888888888';
const PROVIDER_ORG = 'org-99999999-9999-4999-8999-999999999999';
const SIGNATURE = '5Nx1QhbNu8Zt4qkQmYh2vP7hK9WcQx3Zk1TqXe6aM2fRbJ7d9wUvS3cLpN8y4TgH2mVzA1';

function holdRow(overrides: Partial<LedgerHoldEntity> = {}): LedgerHoldEntity {
  return {
    id: HOLD_ID,
    organizationId: ORG,
    accountId: testAccount('buyer'),
    amount: '1000000',
    assetId: USDC as string,
    decimals: USDC_DECIMALS,
    status: LedgerHoldStatus.OPEN,
    intentId: INTENT_ID,
    createEntryId: 'entry-create',
    resolveEntryId: null,
    expiresAt: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  } as LedgerHoldEntity;
}

function credit(overrides: Partial<SettlementCredit> = {}): SettlementCredit {
  return {
    providerOrganizationId: PROVIDER_ORG,
    providerAccountId: testAccount('provider'),
    providerAmount: MoneyUtil.of(800_000n, USDC, USDC_DECIMALS),
    platformFee: MoneyUtil.of(200_000n, USDC, USDC_DECIMALS),
    intentId: INTENT_ID,
    chainTxRef: SIGNATURE,
    ...overrides,
  };
}

function buildHarness() {
  const prepared: AppendEntryInput[] = [];

  const journal = {
    prepare: (input: AppendEntryInput) => {
      prepared.push(input);
      return { ...input, id: `prepared-${prepared.length}` };
    },
    applyEntries: jest.fn().mockResolvedValue([]),
  } as unknown as LedgerJournalService;

  const holds = {
    lockById: jest.fn().mockResolvedValue(holdRow()),
    resolveIfOpen: jest.fn().mockResolvedValue(1),
  } as unknown as LedgerHoldRepository;

  const queryRunner = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  } as unknown as QueryRunner;

  const dataSource = {
    createQueryRunner: () => queryRunner,
  } as unknown as DataSource;

  const service = new LedgerHoldService(holds, journal, dataSource);
  return { service, prepared, holds, journal };
}

describe('LedgerHoldService.commitHoldAndCredit — the commit names its transaction', () => {
  it('writes the signature onto all three entries, so one query reconciles the call', async () => {
    const harness = buildHarness();

    await harness.service.commitHoldAndCredit(ORG, HOLD_ID, credit());

    expect(harness.prepared.map((entry) => entry.entryType)).toEqual([
      LedgerEntryType.HOLD_COMMIT,
      LedgerEntryType.PLATFORM_FEE,
      LedgerEntryType.PROVIDER_CREDIT,
    ]);
    expect(harness.prepared.every((entry) => entry.chainTxRef === SIGNATURE)).toBe(true);
  });

  it('refuses to commit a hold without naming the transaction that moved the money', async () => {
    // The point of the change is that this no longer type-checks; the cast is
    // what a caller reaching past the type would look like, and the runtime
    // refusal is what stops it.
    const harness = buildHarness();

    await expectErrorCodeAsync(
      () =>
        harness.service.commitHoldAndCredit(ORG, HOLD_ID, {
          ...credit(),
          chainTxRef: undefined,
        } as unknown as SettlementCredit),
      LedgerErrorCode.LEDGER_SETTLEMENT_CREDIT_MISSING_CHAIN_REF,
    );
  });

  it('refuses a blank ref just as firmly — an empty string names no transaction', async () => {
    const harness = buildHarness();

    await expectErrorCodeAsync(
      () => harness.service.commitHoldAndCredit(ORG, HOLD_ID, { ...credit(), chainTxRef: '   ' }),
      LedgerErrorCode.LEDGER_SETTLEMENT_CREDIT_MISSING_CHAIN_REF,
    );
  });

  it('refuses before writing anything, so a refused commit leaves the hold open', async () => {
    const harness = buildHarness();

    await harness.service
      .commitHoldAndCredit(ORG, HOLD_ID, { ...credit(), chainTxRef: '' })
      .catch(() => undefined);

    expect(harness.prepared).toEqual([]);
    expect(harness.holds.resolveIfOpen).not.toHaveBeenCalled();
  });

  it('still asserts conservation — the ref does not replace the sum check', async () => {
    const harness = buildHarness();

    await expectErrorCodeAsync(
      () =>
        harness.service.commitHoldAndCredit(ORG, HOLD_ID, {
          ...credit(),
          providerAmount: MoneyUtil.of(900_000n, USDC as AssetId, USDC_DECIMALS),
        }),
      LedgerErrorCode.LEDGER_SETTLEMENT_CREDIT_MISMATCH,
    );
  });
});

describe('LedgerHoldService.commitHoldAndCredit — a charge below the hold', () => {
  // The hold is the quote, the dearest eligible binding; the charge is the
  // price of the binding that served. The difference goes back to the buyer.
  const charged = () =>
    credit({
      providerAmount: MoneyUtil.of(480_000n, USDC, USDC_DECIMALS),
      platformFee: MoneyUtil.of(120_000n, USDC, USDC_DECIMALS),
    });

  it('commits only the charge and releases the rest of the hold, in one transaction', async () => {
    const harness = buildHarness();

    await harness.service.commitHoldAndCredit(ORG, HOLD_ID, charged());

    expect(
      harness.prepared.map((entry) => [entry.entryType, MoneyUtil.toAtomic(entry.money)]),
    ).toEqual([
      [LedgerEntryType.HOLD_COMMIT, 600_000n],
      [LedgerEntryType.HOLD_RELEASE, 400_000n],
      [LedgerEntryType.PLATFORM_FEE, 120_000n],
      [LedgerEntryType.PROVIDER_CREDIT, 480_000n],
    ]);
    // The release belongs to the same hold, so the journal says where it came from.
    expect(harness.prepared[1]).toMatchObject({ holdId: HOLD_ID, accountId: testAccount('buyer') });
    // The hold still ends COMMITTED, resolved by the commit entry.
    expect(harness.holds.resolveIfOpen).toHaveBeenCalledWith(
      ORG,
      HOLD_ID,
      LedgerHoldStatus.COMMITTED,
      'prepared-1',
      expect.anything(),
    );
  });

  it('writes no release when the charge is the whole hold', async () => {
    const harness = buildHarness();

    await harness.service.commitHoldAndCredit(ORG, HOLD_ID, credit());

    expect(harness.prepared.map((entry) => entry.entryType)).not.toContain(
      LedgerEntryType.HOLD_RELEASE,
    );
  });
});
