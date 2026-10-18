/**
 * `GET /providers/me/payouts` against real Postgres: payout-run entries and
 * rail-B redemptions in one keyset-paged list (D18).
 *
 * The unit spec proves what SQL the service asks for; this one proves the SQL
 * groups, filters and pages the way the list promises — a redemption
 * transaction is one payment, a legacy absorb is no payment, and a cursor
 * walks both kinds without repeating or skipping a row.
 */
import { randomUUID } from 'node:crypto';

import { LedgerEntryRepository } from '@database/postgres/repositories/ledger-entry.repository';
import { LEGACY_POOLED_VAULT_TX_REF, LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { PLATFORM_ABSORBED_TX_REF_PREFIX } from '@modules/payment/services/voucher-redemption.service';
import { ProviderPaymentKind } from '@modules/provider/dto/get-provider-payouts.dto';
import { ProviderPayoutsService } from '@modules/provider/services/provider-payouts.service';
import { SortDirection } from '@shared/api';

import { PaymentTestContext, createPaymentTestContext } from '../helpers/payment-test-context';

const USDC =
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('ProviderPayoutsService — batches and redemptions (integration)', () => {
  let context: PaymentTestContext;
  let service: ProviderPayoutsService;

  beforeAll(async () => {
    context = await createPaymentTestContext();
    service = new ProviderPayoutsService(new LedgerEntryRepository(context.dataSource));
  });

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
  });

  async function entry(input: {
    type: LedgerEntryType;
    amount: number;
    at: string;
    chainTxRef?: string | null;
    batchId?: string | null;
    organizationId?: string;
  }): Promise<string> {
    const [row] = (await context.dataSource.query(
      `INSERT INTO ledger_entries
         (organization_id, account_id, entry_type, amount, asset_id, decimals, intent_id,
          batch_id, chain_tx_ref, created_at)
       VALUES ($1, 'provider-account', $2, $3, $4, 6, $5, $6, $7, $8)
       RETURNING id`,
      [
        input.organizationId ?? context.organizationId,
        input.type,
        input.amount,
        USDC,
        randomUUID(),
        input.batchId ?? null,
        input.chainTxRef ?? null,
        input.at,
      ],
    )) as Array<{ id: string }>;
    return row.id;
  }

  const credit = (amount: number, at: string, chainTxRef: string | null) =>
    entry({ type: LedgerEntryType.PROVIDER_CREDIT, amount, at, chainTxRef });

  it('lists each redemption transaction once, with its calls, beside the payout runs', async () => {
    const batchId = randomUUID();
    const payoutEntry = await entry({
      type: LedgerEntryType.PAYOUT,
      amount: 500_000,
      at: '2026-10-10T00:00:00.000Z',
      batchId,
      chainTxRef: '0xbatch',
    });
    await context.dataSource.query(
      `INSERT INTO provider_payouts
         (organization_id, asset_id, decimals, period_start, period_end, amount, to_seq,
          call_count, status, batch_id, source_account_id, payout_account_id, ledger_entry_id)
       VALUES ($1, $2, 6, '2026-10-09', '2026-10-10', 500000, 1, 12, 'RECORDED', $3, 'src', 'dst', $4)`,
      [context.organizationId, USDC, batchId, payoutEntry],
    );
    // One transaction that redeemed two calls, and one that redeemed one.
    await credit(90_000, '2026-10-12T10:00:00.000Z', '0xaaa');
    await credit(90_000, '2026-10-12T10:00:00.000Z', '0xaaa');
    await credit(18_000, '2026-10-13T10:00:00.000Z', '0xbbb');
    // Not payments: a legacy platform absorb (nobody paid it) and a rail-A
    // book credit (paid later, by a payout run).
    await credit(
      90_000,
      '2026-10-14T10:00:00.000Z',
      `${PLATFORM_ABSORBED_TX_REF_PREFIX}DelegateIsRevoked`,
    );
    await credit(90_000, '2026-10-14T11:00:00.000Z', LEGACY_POOLED_VAULT_TX_REF);
    // Another organization's redemption never shows.
    await entry({
      type: LedgerEntryType.PROVIDER_CREDIT,
      amount: 1,
      at: '2026-10-15T00:00:00.000Z',
      chainTxRef: '0xother',
      organizationId: randomUUID(),
    });

    const page = await service.listPayouts(context.organizationId, {
      limit: 25,
      order: SortDirection.DESC,
    } as any);

    expect(
      page.items.map((item) => [item.kind, item.chainTxRef, item.amount.amount, item.calls]),
    ).toEqual([
      [ProviderPaymentKind.REDEMPTION, '0xbbb', '18000', 1],
      [ProviderPaymentKind.REDEMPTION, '0xaaa', '180000', 2],
      [ProviderPaymentKind.BATCH, '0xbatch', '500000', 12],
    ]);
    expect(page.items[2].batchId).toBe(batchId);
    expect(page.items[0].batchId).toBeNull();
    expect(page.items[0].amount).toEqual({ amount: '18000', asset: USDC, decimals: 6 });
    expect(page.pageInfo.hasMore).toBe(false);
  });

  it('pages through both kinds by cursor without repeating or skipping one', async () => {
    const at = (minute: number) => `2026-10-12T10:${String(minute).padStart(2, '0')}:00.000Z`;
    for (let i = 0; i < 5; i += 1) {
      await credit(1_000 + i, at(i * 2), `0xtx${i}`);
      await entry({
        type: LedgerEntryType.PAYOUT,
        amount: 2_000 + i,
        at: at(i * 2 + 1),
        batchId: randomUUID(),
      });
    }

    for (const order of [SortDirection.DESC, SortDirection.ASC]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await service.listPayouts(context.organizationId, {
          limit: 3,
          order,
          cursor,
        } as any);
        seen.push(...page.items.map((item) => item.amount.amount));
        cursor = page.pageInfo.nextCursor ?? undefined;
      } while (cursor);

      const expected = [
        '1000',
        '2000',
        '1001',
        '2001',
        '1002',
        '2002',
        '1003',
        '2003',
        '1004',
        '2004',
      ];
      expect(seen).toEqual(order === SortDirection.ASC ? expected : [...expected].reverse());
    }
  });
});
