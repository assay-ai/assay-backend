/**
 * B6: `GET /providers/me/payouts` pushes its lower bounds (`from`, an
 * ascending cursor) into `WHERE` as whole-transaction pre-filters. This
 * proves every page, and every cursor, is identical to the old query that
 * filtered in `HAVING` only (`legacy/provider-payouts.legacy.ts`, verbatim),
 * over a ledger built to break a naive row filter: transactions whose credits
 * straddle every bound used, credits at the exact bound instant, synthetic
 * refs, two assets, rail-A credits and another organization.
 */
import { randomUUID } from 'node:crypto';

import { LedgerEntryRepository } from '@database/postgres/repositories/ledger-entry.repository';
import { RAIL_A_BOOK_CREDIT_TX_REF, LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { ProviderPayoutsService } from '@modules/provider/services/provider-payouts.service';
import { SortDirection } from '@shared/api';

import { PaymentTestContext, createPaymentTestContext } from '../helpers/payment-test-context';
import { LegacyProviderPayoutsService } from './legacy/provider-payouts.legacy';

const USDC =
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDG = 'eip155:46630/erc20:0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac';

/** Minute `m` of a fixed day, with optional microseconds. */
const at = (minute: number, micros = 0) =>
  `2026-10-12T${String(10 + Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00.${String(micros).padStart(6, '0')}Z`;

describe('ProviderPayoutsService — lower bounds in WHERE match HAVING (B6)', () => {
  let context: PaymentTestContext;
  let current: ProviderPayoutsService;
  let legacy: LegacyProviderPayoutsService;

  beforeAll(async () => {
    context = await createPaymentTestContext();
    const repository = new LedgerEntryRepository(context.dataSource);
    current = new ProviderPayoutsService(repository);
    legacy = new LegacyProviderPayoutsService(repository);
  });

  afterAll(async () => {
    await context.close();
  });

  async function credit(
    amount: number,
    createdAt: string,
    chainTxRef: string | null,
    options: { asset?: string; organizationId?: string; type?: LedgerEntryType } = {},
  ): Promise<void> {
    await context.dataSource.query(
      `INSERT INTO ledger_entries
         (organization_id, account_id, entry_type, amount, asset_id, decimals, intent_id,
          chain_tx_ref, created_at)
       VALUES ($1, 'provider-account', $2, $3, $4, 6, $5, $6, $7)`,
      [
        options.organizationId ?? context.organizationId,
        options.type ?? LedgerEntryType.PROVIDER_CREDIT,
        amount,
        options.asset ?? USDC,
        randomUUID(),
        chainTxRef,
        createdAt,
      ],
    );
  }

  async function seed(): Promise<void> {
    let amount = 1_000;
    const next = () => (amount += 7);
    for (let tx = 0; tx < 30; tx += 1) {
      const first = tx * 4;
      await credit(next(), at(first), `0xtx${tx}`);
      // Every third transaction has later credits that straddle the bounds
      // below, some far after its first credit.
      if (tx % 3 === 0) {
        await credit(next(), at(first + 3), `0xtx${tx}`);
        await credit(next(), at(first + 41), `0xtx${tx}`);
      }
      if (tx % 5 === 0) await credit(next(), at(first + 1), `unobserved:seq=${tx % 2}`);
      if (tx % 7 === 0) await credit(next(), at(first + 2), `held_collected:seq=1`);
      if (tx % 4 === 0) await credit(next(), at(first + 2), `0xusdg${tx}`, { asset: USDG });
      // Same ref in another asset: a different payment.
      if (tx % 6 === 0) await credit(next(), at(first + 5), `0xtx${tx}`, { asset: USDG });
    }
    // Two credits at the exact same instant, in one transaction and in two.
    await credit(next(), at(50, 123456), '0xsame');
    await credit(next(), at(50, 123456), '0xsame');
    await credit(next(), at(50, 123456), '0xsame-other');
    // Never payments, and never this organization's.
    await credit(next(), at(30), RAIL_A_BOOK_CREDIT_TX_REF);
    await credit(next(), at(31), null);
    await credit(next(), at(32), '0xtx1', { type: LedgerEntryType.PLATFORM_FEE });
    await credit(next(), at(33), '0xtx1', { organizationId: randomUUID() });
  }

  type Query = Parameters<ProviderPayoutsService['listPayouts']>[1];

  async function walk(
    service: { listPayouts: ProviderPayoutsService['listPayouts'] },
    query: Query,
  ) {
    const pages: unknown[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.listPayouts(context.organizationId, { ...query, cursor });
      pages.push(JSON.parse(JSON.stringify(page)));
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor && pages.length < 200);
    return pages;
  }

  it('answers every window, order and page size exactly as before', async () => {
    await context.reset();
    await seed();

    const bounds = [
      undefined,
      new Date(at(0)),
      new Date(at(13)),
      new Date(at(24)),
      new Date(at(50, 123456)),
      new Date(at(50, 123457)),
      new Date(at(97)),
      new Date(at(500)),
    ];
    let compared = 0;
    for (const order of [SortDirection.DESC, SortDirection.ASC]) {
      for (const limit of [1, 3, 7, 100]) {
        for (const from of bounds) {
          for (const to of [undefined, new Date(at(60)), new Date(at(200))]) {
            if (from && to && from >= to) continue;
            const query = { limit, order, from, to } as unknown as Query;
            const [before, after] = [await walk(legacy, query), await walk(current, query)];
            expect(after).toEqual(before);
            compared += before.length;
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(500);

    // Not vacuous: the straddling transactions are in the list, whole.
    const [all] = (await walk(current, {
      limit: 100,
      order: SortDirection.ASC,
    } as unknown as Query)) as Array<{
      items: Array<{ chainTxRef: string | null; calls: number }>;
    }>;
    expect(all.items.find((item) => item.chainTxRef === '0xtx3')?.calls).toBe(3);
    const fromMid = (await walk(current, {
      limit: 100,
      order: SortDirection.ASC,
      from: new Date(at(13)),
    } as unknown as Query)) as Array<{ items: Array<{ chainTxRef: string | null }> }>;
    // tx3 starts at minute 12, so it is out of a window that starts at 13
    // even though two of its credits are inside it.
    expect(fromMid[0].items.some((item) => item.chainTxRef === '0xtx3')).toBe(false);
  });
});
