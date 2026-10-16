/**
 * BUG-R17b-P-01 — keyset paging over `timestamptz` against real Postgres.
 *
 * `created_at` is stored to the microsecond; a JS `Date` holds the
 * millisecond. A cursor built from the `Date` sits before the row it names,
 * so the export re-read every page's last row and, with its row budget spent
 * on duplicates, never emitted the window's tail. The rows here share one
 * millisecond and differ only in microseconds — the worst case — and every
 * page is one or two rows, so each boundary is exercised.
 */
import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import {
  CallExportCursor,
  CallExportRow,
} from '@database/postgres/repositories/payment-intent.repository';
import { ListQueryDto, ListSpec, SortDirection, asInstant, paginate } from '@shared/api';

import { PaymentTestContext, createPaymentTestContext } from '../helpers/payment-test-context';

const SPEC: ListSpec = {
  alias: 'intent',
  defaultSort: 'createdAt',
  sortable: {
    createdAt: {
      column: 'intent.created_at',
      type: 'timestamptz',
      valueOf: asInstant((row: PaymentIntentEntity) => row.createdAt),
    },
  },
};

const BASE = '2026-10-14T12:58:54.786';
const COUNT = 7;

describe('keyset paging over microsecond timestamps (BUG-R17b-P-01)', () => {
  let context: PaymentTestContext;
  let providerId: string;
  let expectedAsc: string[];

  beforeAll(async () => {
    context = await createPaymentTestContext();
  });

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
    // The export reads across organizations, so the provider is per-run too.
    providerId = context.id(`keyset:provider:${context.organizationId}`);
    const ids: string[] = [];
    for (let index = 0; index < COUNT; index += 1) {
      const intent = await context.createIntent(`keyset-${index}`, {
        agentAccount: context.account('keyset-agent'),
        providerId,
        providerAccount: context.account('keyset-provider'),
      });
      ids.push(intent.id);
    }
    // Same millisecond, distinct microseconds, assigned in reverse so the
    // order is not the insertion order.
    for (const [index, id] of ids.entries()) {
      const micros = String(900 - index * 100).padStart(3, '0');
      await context.dataSource.query(
        'UPDATE payment_intents SET created_at = $1::timestamptz WHERE id = $2',
        [`${BASE}${micros}Z`, id],
      );
    }
    expectedAsc = [...ids].reverse();
  });

  it('the export pages every row exactly once, in (created_at, id) order', async () => {
    const period = {
      from: new Date('2026-10-14T12:00:00Z'),
      to: new Date('2026-10-14T14:00:00Z'),
    };
    expect(await context.repository.countCallsForExport(providerId, period)).toBe(COUNT);

    const seen: CallExportRow[] = [];
    let after: CallExportCursor | null = null;
    for (let guard = 0; guard < COUNT * 2; guard += 1) {
      const page = await context.repository.findCallsPageForExport(
        providerId,
        period,
        undefined,
        after,
        2,
      );
      if (page.length === 0) break;
      seen.push(...page);
      const last = page[page.length - 1];
      after = { createdAt: last.createdAtExact, id: last.id };
    }

    expect(seen.map((row) => row.id)).toEqual(expectedAsc);
    expect(seen[0].createdAtExact).toBe(`${BASE}300Z`);
  });

  it.each([SortDirection.ASC, SortDirection.DESC])(
    'paginate() serves every row once, sorted %s',
    async (order) => {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < COUNT * 2; guard += 1) {
        const qb = context.repository
          .createQueryBuilder('intent')
          .where('intent.organizationId = :organizationId', {
            organizationId: context.organizationId,
          })
          .andWhere('intent.providerId = :providerId', { providerId });
        const query = Object.assign(new ListQueryDto(), { limit: 2, order, cursor });
        const page = await paginate(qb, query, SPEC);
        seen.push(...page.items.map((item) => item.id));
        if (!page.pageInfo.nextCursor) break;
        cursor = page.pageInfo.nextCursor;
      }

      expect(seen).toEqual(order === SortDirection.ASC ? expectedAsc : [...expectedAsc].reverse());
    },
  );
});
