import { DataSource } from 'typeorm';

import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import {
  DEBT_REFUSING_SQL,
  DuePaymentIntent,
  PaymentIntentRepository,
} from '@database/postgres/repositories/payment-intent.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { BlockSubjectKind } from '@modules/blocklist/domain/account-block';
import { LedgerHoldService } from '@modules/ledger/services/ledger-hold.service';
import {
  CollectionState,
  collectionStateOf,
  debtStateOf,
  isChargedWhenSettled,
} from '@modules/payment/domain/collection';
import { PaymentIntentStatus, PaymentRail } from '@modules/payment/ports/payment.types';
import { PaymentIntentExpiryService } from '@modules/payment/services/payment-intent-expiry.service';
import { PaymentIntentService } from '@modules/payment/services/payment-intent.service';
import { MoneyUtil } from '@shared/utils/money.util';

/**
 * Writing off buyer debt (review-buyer-debt M1, L1, L2) and voiding it (M2).
 *
 * REGRESSION M1: the write-off ignored `markWrittenOff`'s answer and released
 * the hold of a debt the buyer had just settled with a replacement voucher —
 * the replacement was then never collected (or collected with no credit),
 * and the reports said "credited". The mark and the release now commit in
 * one ledger transaction under the payer's lock, and a row that changed is
 * skipped.
 */

const NOW = new Date('2026-11-20T12:00:00Z');
const BEFORE = new Date(NOW.getTime() - 30 * 24 * 3_600_000);
const PRICE = MoneyUtil.of(50_000n, ASSET_IDS.USDG_ROBINHOOD_TESTNET, 6);
const PAYER = 'eip155:46630:0x1111111111111111111111111111111111111111';

function debt(id: string): DuePaymentIntent {
  return {
    organizationId: 'org-1',
    id,
    status: PaymentIntentStatus.SETTLED,
    holdId: `hold-${id}`,
    agentAccount: PAYER,
  };
}

function sweepBuild(
  candidates: DuePaymentIntent[],
  lastError: string | null = 'DelegateIsRevoked',
) {
  const repo = {
    findDueForExpiry: jest.fn().mockResolvedValue([]),
    findDueForHoldBackstop: jest.fn().mockResolvedValue([]),
    findTerminalWithUnreleasedHold: jest.fn().mockResolvedValue([]),
    findDueForVerdictDeadline: jest.fn().mockResolvedValue([]),
    findDueForWriteOff: jest.fn().mockResolvedValue(candidates),
    findClosedWithOpenHold: jest.fn().mockResolvedValue([]),
    findOneBy: jest.fn().mockResolvedValue({ redemptionLastError: lastError }),
  };
  const intents = {
    findById: jest.fn(async (_org: string, id: string) => ({
      id,
      agentAccount: PAYER,
      providerId: 'provider-1',
      price: PRICE,
    })),
    writeOffDebt: jest.fn(async () => true),
    releaseHold: jest.fn(async () => true),
  };
  const alerts = { emit: jest.fn().mockResolvedValue(undefined) };
  const blocks: Array<{ subjectKind: BlockSubjectKind; subject: string }> = [];
  const blocklist = { list: () => blocks };
  const service = new PaymentIntentExpiryService(
    repo as never,
    intents as never,
    alerts,
    blocklist as never,
  );
  return { service, repo, intents, alerts, blocks };
}

describe('PaymentIntentExpiryService — buyer debt write-off', () => {
  it('asks for debts lapsed more than 30 days ago, leaving blocked payers out (L1)', async () => {
    const { service, repo, blocks } = sweepBuild([]);
    blocks.push(
      { subjectKind: BlockSubjectKind.WALLET, subject: PAYER },
      {
        subjectKind: BlockSubjectKind.ORGANIZATION,
        subject: '22222222-2222-4222-8222-222222222222',
      },
    );

    await service.sweep(NOW);

    expect(repo.findDueForWriteOff).toHaveBeenCalledWith(BEFORE, expect.any(Number), {
      organizationIds: ['22222222-2222-4222-8222-222222222222'],
      walletKeys: ['eip155:0x1111111111111111111111111111111111111111'],
      chainAccounts: [],
    });
  });

  it('writes off through the one guarded call: uncollected:<cause>, credits nobody, warns', async () => {
    const { service, intents, alerts } = sweepBuild([debt('debt-1')]);

    const report = await service.sweep(NOW);

    expect(intents.writeOffDebt).toHaveBeenCalledWith(
      { organizationId: 'org-1', id: 'debt-1', payer: PAYER, holdId: 'hold-debt-1' },
      'uncollected:DelegateIsRevoked',
      BEFORE,
    );
    // Never a separate release: the release is inside the write-off's transaction.
    expect(intents.releaseHold).not.toHaveBeenCalled();
    expect(report).toMatchObject({ debtsWrittenOff: 1, failed: 0 });
    expect(alerts.emit).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'voucher_debt_written_off' }),
    );
  });

  it('M1: a debt settled between the read and the write is skipped — its hold is not released', async () => {
    // The scenario of the review's proof: the buyer's replacement committed
    // after `findDueForWriteOff` read the row, so the guarded mark matches
    // nothing and nothing may be released.
    const { service, intents, alerts } = sweepBuild([debt('debt-1')]);
    intents.writeOffDebt.mockResolvedValueOnce(false);

    const report = await service.sweep(NOW);

    expect(intents.releaseHold).not.toHaveBeenCalled();
    expect(report).toMatchObject({ debtsWrittenOff: 0, failed: 0 });
    expect(alerts.emit).not.toHaveBeenCalled();
  });

  it('a write-off retried after a crash keeps a single uncollected: prefix', async () => {
    const { service, intents } = sweepBuild([debt('debt-1')], 'uncollected:VoucherExpired');
    await service.sweep(NOW);
    expect(intents.writeOffDebt).toHaveBeenCalledWith(
      expect.anything(),
      'uncollected:VoucherExpired',
      BEFORE,
    );
  });

  it('L2: releases the hold of a row closed for good whose release never landed', async () => {
    const { service, repo, intents } = sweepBuild([]);
    repo.findClosedWithOpenHold.mockResolvedValue([debt('forfeit-1')]);

    const report = await service.sweep(NOW);

    expect(intents.releaseHold).toHaveBeenCalledWith({
      organizationId: 'org-1',
      id: 'forfeit-1',
      holdId: 'hold-forfeit-1',
    });
    expect(report).toMatchObject({ closedReleased: 1, repaired: 1, failed: 0 });
  });
});

describe('PaymentIntentService — the guarded write-off and void', () => {
  function serviceBuild(marked: boolean) {
    const runner = { query: jest.fn() };
    const ledger = {
      releaseHoldIf: jest.fn(
        async (_org: string, _hold: string, guard: (r: unknown) => Promise<boolean>) =>
          (await guard(runner)) ? { applied: true } : null,
      ),
      releaseHold: jest.fn(),
    };
    const repo = {
      markWrittenOff: jest.fn(async () => marked),
      markDebtVoided: jest.fn(async () => marked),
      findOneBy: jest.fn(async () => ({
        id: 'debt-1',
        organizationId: 'org-1',
        status: PaymentIntentStatus.SETTLED,
        rail: PaymentRail.RAIL_B_VOUCHER,
        agentAccount: PAYER,
        assetId: PRICE.asset,
        decimals: 6,
        priceAmount: '50000',
        providerAmount: '45000',
        platformFee: '5000',
        settledAmount: null,
        holdId: 'hold-debt-1',
        holdReleasedAt: null,
        expiresAt: NOW,
        voucherIssuedAt: null,
      })),
    };
    const service = new PaymentIntentService(
      repo as never,
      ledger as never,
      {} as never,
      {} as never,
    );
    return { service, ledger, repo, runner };
  }

  const target = { organizationId: 'org-1', id: 'debt-1', payer: PAYER, holdId: 'hold-debt-1' };

  it('M1: marks and releases in ONE ledger transaction, the mark deciding the release', async () => {
    const { service, ledger, repo, runner } = serviceBuild(true);

    await expect(service.writeOffDebt(target, 'uncollected:X', BEFORE)).resolves.toBe(true);

    expect(ledger.releaseHoldIf).toHaveBeenCalledWith('org-1', 'hold-debt-1', expect.any(Function));
    expect(repo.markWrittenOff).toHaveBeenCalledWith(runner, target, 'uncollected:X', BEFORE);
    expect(ledger.releaseHold).not.toHaveBeenCalled();
  });

  it('M1: a row that changed is not written off, and nothing is released', async () => {
    const { service, ledger } = serviceBuild(false);
    await expect(service.writeOffDebt(target, 'uncollected:X', BEFORE)).resolves.toBe(false);
    expect(ledger.releaseHold).not.toHaveBeenCalled();
  });

  it('M2: a late rejecting verdict voids the debt in the same guarded release', async () => {
    const { service, repo, runner } = serviceBuild(true);
    await expect(service.voidDebt('org-1', 'debt-1', 'REFUND')).resolves.toBe(true);
    expect(repo.markDebtVoided).toHaveBeenCalledWith(runner, target, 'voided:REFUND');
  });
});

describe('LedgerHoldService.releaseHoldIf', () => {
  function ledgerBuild() {
    const queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
    };
    const dataSource = { createQueryRunner: () => queryRunner };
    const row = {
      id: 'hold-1',
      organizationId: 'org-1',
      accountId: PAYER,
      amount: '50000',
      assetId: PRICE.asset,
      decimals: 6,
      status: 'OPEN',
      intentId: 'debt-1',
      createEntryId: 'e0',
      resolveEntryId: null,
      expiresAt: null,
      createdAt: NOW,
    };
    const holds = {
      lockById: jest.fn(async () => row),
      resolveIfOpen: jest.fn(async () => 1),
    };
    const journal = {
      prepare: jest.fn((entry: object) => ({ ...entry, id: 'e1' })),
      applyEntries: jest.fn(async () => undefined),
    };
    const service = new LedgerHoldService(holds as never, journal as never, dataSource as never);
    return { service, holds, journal, queryRunner };
  }

  it('runs the guard first, in the transaction, and releases nothing when it says no', async () => {
    const { service, holds, journal, queryRunner } = ledgerBuild();
    const guard = jest.fn(async () => false);

    await expect(service.releaseHoldIf('org-1', 'hold-1', guard)).resolves.toBeNull();

    expect(guard).toHaveBeenCalledWith(queryRunner);
    expect(holds.lockById).not.toHaveBeenCalled();
    expect(journal.applyEntries).not.toHaveBeenCalled();
  });

  it('releases in the same transaction when the guard says yes', async () => {
    const { service, holds, journal, queryRunner } = ledgerBuild();
    const guard = jest.fn(async () => true);

    const resolution = await service.releaseHoldIf('org-1', 'hold-1', guard);

    expect(resolution?.applied).toBe(true);
    expect(journal.applyEntries).toHaveBeenCalledWith(queryRunner, 'org-1', [
      expect.objectContaining({ entryType: 'HOLD_RELEASE' }),
    ]);
    expect(holds.resolveIfOpen).toHaveBeenCalledTimes(1);
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
  });
});

describe('PaymentIntentRepository — the debt SQL', () => {
  async function repository(): Promise<{ repo: PaymentIntentRepository; dataSource: DataSource }> {
    const dataSource = new DataSource({ type: 'postgres', entities: [PaymentIntentEntity] });
    await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
    return { repo: new PaymentIntentRepository(dataSource), dataSource };
  }

  function recordingRunner(result: unknown[] = [{ id: 'debt-1' }]) {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const runner = {
      query: jest.fn(async (sql: string, params: unknown[]) => {
        queries.push({ sql: sql.replace(/\s+/g, ' '), params });
        return sql.startsWith('UPDATE') ? result : [];
      }),
    };
    return { runner, queries };
  }

  const target = { organizationId: 'org-1', id: 'debt-1', payer: PAYER, holdId: 'hold-debt-1' };

  it('M1: the write-off takes the payer lock, then marks AND releases only the unchanged debt', async () => {
    const { repo } = await repository();
    const { runner, queries } = recordingRunner();

    await expect(
      repo.markWrittenOff(runner as never, target, 'uncollected:X', BEFORE),
    ).resolves.toBe(true);

    expect(queries[0]).toEqual({
      sql: 'SELECT pg_advisory_xact_lock(hashtext($1))',
      params: [`voucher-admission:${PAYER}`],
    });
    const update = queries[1].sql;
    expect(update).toMatch(/SET "redemption_last_error" = \$5, "hold_released_at" = now\(\)/);
    expect(update).toMatch(/"hold_id" = \$4/);
    expect(update).toMatch(/"redemption_lapsed_at" < \$6/);
    expect(update).toMatch(/"redemption_replaced_at" IS NULL/);
    expect(update).toMatch(/"hold_released_at" IS NULL/);
    expect(queries[1].params).toEqual([
      'org-1',
      'debt-1',
      PAYER,
      'hold-debt-1',
      'uncollected:X',
      BEFORE,
    ]);
  });

  it('M1: answers false when the row changed', async () => {
    const { repo } = await repository();
    const { runner } = recordingRunner([]);
    await expect(
      repo.markWrittenOff(runner as never, target, 'uncollected:X', BEFORE),
    ).resolves.toBe(false);
  });

  it('M2: a void never touches a debt whose replacement is in flight', async () => {
    const { repo } = await repository();
    const { runner, queries } = recordingRunner();
    await repo.markDebtVoided(runner as never, target, 'voided:REFUND');
    expect(queries[0].params).toEqual([`voucher-admission:${PAYER}`]);
    expect(queries[1].sql).toMatch(/"redemption_replaced_at" IS NULL/);
    expect(queries[1].sql).toMatch(
      /\("hold_released_at" IS NULL OR "redemption_last_error" LIKE 'uncollected:%'\)/,
    );
  });

  it('H1: a written-off debt keeps refusing paid calls; a voided or collected one does not', () => {
    expect(DEBT_REFUSING_SQL).toBe(
      `("redemption_lapsed_at" IS NOT NULL ` +
        `AND ("hold_released_at" IS NULL OR "redemption_last_error" LIKE 'uncollected:%'))`,
    );
  });

  it('L1: the write-off candidates leave out blocked payers and debts being replaced', async () => {
    const { repo, dataSource } = await repository();
    let captured = '';
    const original = dataSource.createQueryBuilder.bind(dataSource);
    jest.spyOn(dataSource, 'createQueryBuilder').mockImplementation(((...args: unknown[]) => {
      const qb = (original as (...a: unknown[]) => any)(...args);
      qb.getRawMany = async function () {
        captured = this.getQuery();
        return [];
      };
      return qb;
    }) as never);
    jest
      .spyOn(repo, 'createQueryBuilder')
      .mockImplementation(((alias: string) =>
        dataSource.createQueryBuilder(PaymentIntentEntity, alias)) as never);

    await repo.findDueForWriteOff(BEFORE, 50, {
      organizationIds: ['org-blocked'],
      walletKeys: ['eip155:0xabc'],
      chainAccounts: [],
    });
    const flat = captured.replace(/\s+/g, ' ');
    expect(flat).toMatch(/"intent"\."redemption_replaced_at" IS NULL/);
    expect(flat).toMatch(
      /NOT \(COALESCE\(intent\.organization_id::text = ANY\(:blockedOrgs\), false\)/,
    );
    // Never NULL for a row without a delegate (NULL poisoning).
    expect(flat).toMatch(
      /COALESCE\(lower\("intent"\."voucher_delegate"\) = ANY\(:blockedChainAccounts\), false\)/,
    );
    expect(flat).toMatch(/lower\("intent"\."agent_account"\) = ANY\(:blockedChainAccounts\)/);
    expect(flat).toMatch(/lower\("intent"\."voucher_delegate"\) = ANY\(:blockedChainAccounts\)/);
  });

  it('M4: a replacement keeps the first lapse, marks REPLACING, and is admitted under the lock', async () => {
    const { repo } = await repository();
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const manager = {
      query: jest.fn(async (sql: string, params: unknown[]) => {
        queries.push({ sql: sql.replace(/\s+/g, ' '), params });
        if (sql.startsWith('UPDATE')) return [{ id: 'debt-1' }];
        if (sql.includes('"escrow"')) return [{ escrow: '0', delegate: '0' }];
        if (sql.includes('next_seq')) return [{ next_seq: '100' }];
        if (sql.includes('max_seq')) return [{ max_seq: '4' }];
        return [];
      }),
    };
    Object.defineProperty(repo, 'manager', {
      value: { transaction: (work: (m: unknown) => Promise<unknown>) => work(manager) },
    });
    const admit = jest.fn();

    await repo.replaceLapsedVoucher(
      'org-1',
      '33333333-3333-4333-8333-333333333333',
      PAYER,
      {
        seq: '5',
        signature: '0xsig',
        issuedAt: 1,
        delegate: null,
        expiresAt: NOW,
        resource: '/mcp/tools/x',
        resourceHash: 'ab',
      },
      {
        scope: { payer: PAYER, assetId: PRICE.asset, delegate: null, escrowSince: NOW },
        admit,
      },
    );

    expect(queries[0].params).toEqual([`voucher-admission:${PAYER}`]);
    expect(admit).toHaveBeenCalledWith(
      expect.objectContaining({ escrow: 0n, nextSeq: 100n, maxSeq: 4n, pausedFor: null }),
    );
    // The debt's own row is left out of the window totals and the max seq.
    const totals = queries.find((q) => q.sql.includes('"escrow"'));
    expect(totals?.sql).toMatch(/"id" <> \$6::uuid/);
    expect(totals?.params[5]).toBe('33333333-3333-4333-8333-333333333333');
    const update = queries.find((q) => q.sql.startsWith('UPDATE'));
    expect(update?.sql).toMatch(/"redemption_replaced_at" = now\(\)/);
    expect(update?.sql).not.toMatch(/"redemption_lapsed_at" = NULL/);
    expect(update?.sql).toMatch(/"voucher_resource" = \$10/);
  });
});

describe('H2: the boot refuses a schema without the buyer-debt migrations', () => {
  async function withColumns(columns: number): Promise<PaymentIntentRepository> {
    const dataSource = new DataSource({ type: 'postgres', entities: [PaymentIntentEntity] });
    await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
    const repo = new PaymentIntentRepository(dataSource);
    Object.defineProperty(repo, 'manager', {
      value: { query: jest.fn(async () => [{ intents: true, columns }]) },
    });
    return repo;
  }

  it('throws, naming the migrations, when a debt column is missing', async () => {
    const repo = await withColumns(2);
    await expect(repo.assertBuyerDebtSchema()).rejects.toThrow(
      /PaymentIntentRedemptionLastError1760600000000.*PaymentIntentRedemptionLapsed1760700000000/,
    );
  });

  it('boots when every debt column is there', async () => {
    const repo = await withColumns(4);
    await expect(repo.assertBuyerDebtSchema()).resolves.toBeUndefined();
  });
});

describe('M2: a voided debt is not charged to anyone', () => {
  it('reads VOIDED, not charged', () => {
    const voided = {
      redemptionLastError: 'voided:REFUND',
      redemptionLapsedAt: NOW,
      holdReleasedAt: NOW,
    };
    expect(collectionStateOf(voided)).toBe(CollectionState.VOIDED);
    expect(isChargedWhenSettled(voided)).toBe(false);
    expect(debtStateOf(voided)).toBe('VOIDED');
  });

  it('a debt being collected is still owed; a collected one is normal', () => {
    expect(
      collectionStateOf({
        redemptionLastError: null,
        redemptionLapsedAt: NOW,
        holdReleasedAt: null,
      }),
    ).toBe(CollectionState.DEBT_OUTSTANDING);
    expect(
      collectionStateOf({
        redemptionLastError: null,
        redemptionLapsedAt: NOW,
        holdReleasedAt: NOW,
      }),
    ).toBe(CollectionState.NORMAL);
  });
});
