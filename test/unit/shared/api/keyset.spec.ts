import { SelectQueryBuilder } from 'typeorm';

import { encodeCursor, decodeCursor } from '@shared/api/cursor';
import { ListQueryDto, SortDirection } from '@shared/api/dto/list-query.dto';
import { ApiErrorCode } from '@shared/api/errors/api.errors';
import {
  ListSpec,
  applyTimeWindow,
  asInstant,
  exactInstantSql,
  paginate,
  resolveSort,
  mergeKeysetPages,
} from '@shared/api/keyset';
import { BaseError } from '@shared/errors/base.error';

interface Row {
  id: string;
  createdAt: Date;
  amount: string;
}

const SPEC: ListSpec = {
  alias: 'intent',
  defaultSort: 'createdAt',
  sortable: {
    createdAt: {
      column: 'intent.created_at',
      type: 'timestamptz',
      valueOf: asInstant((row: Row) => row.createdAt),
    },
    amount: {
      column: 'intent.price_amount',
      type: 'numeric',
      valueOf: (row: Row) => row.amount,
    },
  },
};

/**
 * A query builder that records what was asked of it and replays a fixed result.
 *
 * The point of these tests is the SQL the shared machinery *generates* — the
 * comparator, the cast, the tiebreak, the `limit + 1`. A real database would
 * confirm the rows come back in order but would not show a `>=` that repeats
 * one row per page, which is the failure this code is most likely to have.
 */
function fakeQueryBuilder(rows: Row[], raw: Array<Record<string, unknown>> = []) {
  const wheres: Array<{ sql: string; params: Record<string, unknown> }> = [];
  const orders: Array<[string, string]> = [];
  const selects: Array<{ expr: string; alias?: string }> = [];
  const executed: string[] = [];
  let taken = 0;

  const qb = {
    andWhere(sql: string, params: Record<string, unknown> = {}) {
      wheres.push({ sql, params });
      return qb;
    },
    orderBy(column: string, direction: string) {
      orders.push([column, direction]);
      return qb;
    },
    addOrderBy(column: string, direction: string) {
      orders.push([column, direction]);
      return qb;
    },
    limit(n: number) {
      taken = n;
      return qb;
    },
    addSelect(expr: string, alias?: string) {
      selects.push({ expr, alias });
      return qb;
    },
    async getMany() {
      executed.push('getMany');
      return rows;
    },
    async getRawAndEntities() {
      executed.push('getRawAndEntities');
      return { entities: rows, raw };
    },
  };

  return {
    qb: qb as unknown as SelectQueryBuilder<Row>,
    wheres,
    orders,
    selects,
    executed,
    get taken() {
      return taken;
    },
  };
}

function rowsAt(count: number, offset = 0): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `row-${offset + index}`,
    createdAt: new Date(Date.UTC(2026, 7, 15, 10, 0, offset + index)),
    amount: String(1000 + offset + index),
  }));
}

function query(overrides: Partial<ListQueryDto> = {}): ListQueryDto {
  return Object.assign(new ListQueryDto(), { limit: 10, order: SortDirection.DESC }, overrides);
}

function raisedCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as BaseError).errorCode;
  }
  throw new Error('expected a throw, got none');
}

describe('resolveSort', () => {
  it('falls back to the resource default when `sort` is omitted', () => {
    expect(resolveSort(query(), SPEC).key).toBe('createdAt');
  });

  it('defaults to newest-first', () => {
    expect(resolveSort(query(), SPEC).direction).toBe(SortDirection.DESC);
  });

  // A silent fallback would serve a `createdAt`-ordered page with a 200 to a
  // client that asked for `amount`, which then renders it under an "Amount ↓"
  // header. A wrong answer is worse than a refused one.
  it('refuses an unknown field rather than quietly substituting the default', () => {
    expect(raisedCode(() => resolveSort(query({ sort: 'provider' }), SPEC))).toBe(
      ApiErrorCode.API_UNKNOWN_SORT_FIELD,
    );
  });

  it('names the sortable fields in the error, so discovery needs no source reading', () => {
    let message = '';
    try {
      resolveSort(query({ sort: 'nope' }), SPEC);
    } catch (error) {
      message = (error as BaseError).message;
    }

    expect(message).toContain('createdAt');
    expect(message).toContain('amount');
  });

  it('never lets a caller-supplied string reach the SQL', () => {
    // The allowlist is a lookup, not a validation — the request chooses an
    // entry, and the expression comes from the map.
    expect(raisedCode(() => resolveSort(query({ sort: 'created_at; DROP TABLE' }), SPEC))).toBe(
      ApiErrorCode.API_UNKNOWN_SORT_FIELD,
    );
  });

  // `sortable` is a plain object, so a bare index also finds what it inherits
  // from `Object.prototype`. `sort=constructor` used to pass the allowlist and
  // then fail as a 500 on an `undefined` column.
  it.each(['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty'])(
    'refuses the inherited property %s',
    (sort) => {
      expect(raisedCode(() => resolveSort(query({ sort }), SPEC))).toBe(
        ApiErrorCode.API_UNKNOWN_SORT_FIELD,
      );
    },
  );
});

describe('applyTimeWindow', () => {
  it('is half-open — `from` inclusive, `to` exclusive', () => {
    const { qb, wheres } = fakeQueryBuilder([]);
    applyTimeWindow(qb, query({ from: new Date('2026-08-01'), to: new Date('2026-09-01') }), SPEC);

    expect(wheres.map((w) => w.sql)).toEqual([
      'intent.created_at >= :__from',
      'intent.created_at < :__to',
    ]);
  });

  it('rejects a reversed window instead of silently returning nothing', () => {
    const { qb } = fakeQueryBuilder([]);

    expect(
      raisedCode(() =>
        applyTimeWindow(
          qb,
          query({ from: new Date('2026-09-01'), to: new Date('2026-08-01') }),
          SPEC,
        ),
      ),
    ).toBe(ApiErrorCode.API_INVALID_TIME_RANGE);
  });

  it('rejects an empty window (`from` equal to `to`)', () => {
    const { qb } = fakeQueryBuilder([]);
    const instant = new Date('2026-08-01');

    expect(raisedCode(() => applyTimeWindow(qb, query({ from: instant, to: instant }), SPEC))).toBe(
      ApiErrorCode.API_INVALID_TIME_RANGE,
    );
  });

  it('allows an open bound on either edge', () => {
    const { qb, wheres } = fakeQueryBuilder([]);
    applyTimeWindow(qb, query({ from: new Date('2026-08-01') }), SPEC);

    expect(wheres).toHaveLength(1);
  });
});

describe('paginate', () => {
  it('fetches one row beyond the page so `hasMore` is never a guess', async () => {
    const fake = fakeQueryBuilder(rowsAt(11));
    await paginate(fake.qb, query({ limit: 10 }), SPEC);

    expect(fake.taken).toBe(11);
  });

  it('trims the probe row off the page it returns', async () => {
    const fake = fakeQueryBuilder(rowsAt(11));
    const page = await paginate(fake.qb, query({ limit: 10 }), SPEC);

    expect(page.items).toHaveLength(10);
    expect(page.pageInfo.hasMore).toBe(true);
    expect(page.pageInfo.nextCursor).not.toBeNull();
  });

  it('orders by the sort column and then the tiebreak, in the same direction', async () => {
    const fake = fakeQueryBuilder(rowsAt(3));
    await paginate(fake.qb, query({ limit: 10 }), SPEC);

    expect(fake.orders).toEqual([
      ['intent.created_at', 'DESC'],
      ['intent.id', 'DESC'],
    ]);
  });

  describe('the keyset predicate', () => {
    it('is a row-value comparison against the sort column and the tiebreak', async () => {
      const cursor = encodeCursor(
        { sortValue: '2026-08-15T10:00:00.000Z', id: 'row-9' },
        'createdAt:desc',
      );
      const fake = fakeQueryBuilder(rowsAt(3));
      await paginate(fake.qb, query({ limit: 10, cursor }), SPEC);

      expect(fake.wheres[0].sql).toBe(
        '(intent.created_at, intent.id) < (:__cursorValue::timestamptz, :__cursorId::uuid)',
      );
    });

    // `>=` on the tiebreak repeats exactly one row per page boundary, which
    // survives casual testing and shows up as a duplicated charge in a receipt list.
    it('uses a strict comparator, so the boundary row is not repeated', async () => {
      const cursor = encodeCursor({ sortValue: 'x', id: 'row-9' }, 'createdAt:desc');
      const fake = fakeQueryBuilder(rowsAt(3));
      await paginate(fake.qb, query({ limit: 10, cursor }), SPEC);

      expect(fake.wheres[0].sql).toContain(') < (');
      expect(fake.wheres[0].sql).not.toContain('<=');
    });

    it('flips the comparator with the sort direction', async () => {
      const cursor = encodeCursor({ sortValue: 'x', id: 'row-9' }, 'createdAt:asc');
      const fake = fakeQueryBuilder(rowsAt(3));
      await paginate(fake.qb, query({ limit: 10, cursor, order: SortDirection.ASC }), SPEC);

      expect(fake.wheres[0].sql).toContain(') > (');
    });

    it('casts the cursor value to the column’s type rather than letting Postgres guess', async () => {
      const cursor = encodeCursor({ sortValue: '5000', id: 'row-9' }, 'amount:desc');
      const fake = fakeQueryBuilder(rowsAt(3));
      await paginate(fake.qb, query({ limit: 10, cursor, sort: 'amount' }), SPEC);

      expect(fake.wheres[0].sql).toContain('::numeric');
    });

    it('binds the position as a parameter, never as literal SQL', async () => {
      const cursor = encodeCursor(
        { sortValue: "'; DROP TABLE payment_intents; --", id: 'x' },
        'createdAt:desc',
      );
      const fake = fakeQueryBuilder(rowsAt(3));
      await paginate(fake.qb, query({ limit: 10, cursor }), SPEC);

      expect(fake.wheres[0].sql).not.toContain('DROP');
      expect(fake.wheres[0].params.__cursorValue).toBe("'; DROP TABLE payment_intents; --");
    });
  });

  describe('page boundaries', () => {
    it('an empty collection is `[]` with no cursor, not a null items array', async () => {
      const fake = fakeQueryBuilder([]);
      const page = await paginate(fake.qb, query({ limit: 10 }), SPEC);

      expect(page.items).toEqual([]);
      expect(page.pageInfo).toEqual({ nextCursor: null, hasMore: false });
    });

    it('a partial last page ends the list', async () => {
      const fake = fakeQueryBuilder(rowsAt(4));
      const page = await paginate(fake.qb, query({ limit: 10 }), SPEC);

      expect(page.items).toHaveLength(4);
      expect(page.pageInfo).toEqual({ nextCursor: null, hasMore: false });
    });

    // The subtle one: exactly `limit` rows remain. There is no probe row, so
    // this is the last page — an implementation that emitted a cursor here
    // would hand the client one more request that returns nothing.
    it('an exactly-full final page ends the list', async () => {
      const fake = fakeQueryBuilder(rowsAt(10));
      const page = await paginate(fake.qb, query({ limit: 10 }), SPEC);

      expect(page.items).toHaveLength(10);
      expect(page.pageInfo.hasMore).toBe(false);
      expect(page.pageInfo.nextCursor).toBeNull();
    });

    it('the emitted cursor points at the last row of the page', async () => {
      const rows = rowsAt(11);
      const fake = fakeQueryBuilder(rows);
      const page = await paginate(fake.qb, query({ limit: 10 }), SPEC);

      const decoded = decodeCursor(page.pageInfo.nextCursor!, 'createdAt:desc');
      expect(decoded.id).toBe(rows[9].id);
      expect(decoded.sortValue).toBe(rows[9].createdAt.toISOString());
    });

    it('the emitted cursor carries the ordering it was taken under', async () => {
      const fake = fakeQueryBuilder(rowsAt(11));
      const page = await paginate(
        fake.qb,
        query({ limit: 10, sort: 'amount', order: SortDirection.ASC }),
        SPEC,
      );

      expect(decodeCursor(page.pageInfo.nextCursor!, 'amount:asc').sort).toBe('amount:asc');
    });
  });

  // BUG-R17b-P-01. Postgres stores `timestamptz` to the microsecond; a `Date`
  // keeps the millisecond. A cursor built from the entity sits up to 999 µs
  // before the row it names, so ascending pages re-serve the boundary row and
  // descending pages skip rows in the same millisecond.
  describe('a timestamptz cursor is the exact stored instant, not the Date', () => {
    function microRows(): { rows: Row[]; raw: Array<Record<string, unknown>> } {
      const rows = rowsAt(11);
      const raw = rows.map((row, index) => ({
        intent_id: row.id,
        __keyset_sort_value: row.createdAt.toISOString().replace('Z', `${100 + index}Z`),
      }));
      return { rows, raw };
    }

    it('selects the column at microsecond precision alongside the entities', async () => {
      const { rows, raw } = microRows();
      const fake = fakeQueryBuilder(rows, raw);
      await paginate(fake.qb, query({ limit: 10 }), SPEC);

      expect(fake.selects).toEqual([
        { expr: exactInstantSql('intent.created_at'), alias: '__keyset_sort_value' },
      ]);
      expect(fake.executed).toEqual(['getRawAndEntities']);
    });

    it('stamps the cursor with the microsecond value of the last row', async () => {
      const { rows, raw } = microRows();
      const fake = fakeQueryBuilder(rows, raw);
      const page = await paginate(fake.qb, query({ limit: 10 }), SPEC);

      const decoded = decodeCursor(page.pageInfo.nextCursor!, 'createdAt:desc');
      expect(decoded.id).toBe(rows[9].id);
      expect(decoded.sortValue).toBe('2026-08-15T10:00:09.000109Z');
      expect(decoded.sortValue).not.toBe(rows[9].createdAt.toISOString());
    });

    it('falls back to the field serialiser when the raw value is missing', async () => {
      const rows = rowsAt(11);
      const fake = fakeQueryBuilder(rows, []);
      const page = await paginate(fake.qb, query({ limit: 10 }), SPEC);

      expect(decodeCursor(page.pageInfo.nextCursor!, 'createdAt:desc').sortValue).toBe(
        rows[9].createdAt.toISOString(),
      );
    });

    it('leaves non-timestamp sorts on a plain entity read', async () => {
      const fake = fakeQueryBuilder(rowsAt(11));
      await paginate(fake.qb, query({ limit: 10, sort: 'amount' }), SPEC);

      expect(fake.selects).toEqual([]);
      expect(fake.executed).toEqual(['getMany']);
    });

    it('renders UTC with six fractional digits', () => {
      expect(exactInstantSql('t.c')).toBe(
        `to_char(t.c AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      );
    });
  });

  it('a cursor from a different ordering is refused rather than mis-paged', async () => {
    const cursor = encodeCursor({ sortValue: 'x', id: 'y' }, 'createdAt:desc');
    const fake = fakeQueryBuilder(rowsAt(3));

    await expect(
      paginate(fake.qb, query({ limit: 10, cursor, sort: 'amount' }), SPEC),
    ).rejects.toMatchObject({ errorCode: ApiErrorCode.API_INVALID_CURSOR });
  });
});

describe('mergeKeysetPages', () => {
  const spec = {
    alias: 'row',
    defaultSort: 'createdAt',
    sortable: {
      createdAt: { column: 'row.created_at', type: 'timestamptz' as const, valueOf: () => '' },
    },
  };
  const row = (id: string, at: string) => ({ id, at });
  const source = (rows: { id: string; at: string }[]) => ({
    rows,
    sortValueOf: (r: { at: string }) => r.at,
  });

  it('merges two sources by (sortValue, id) and cursors at the last row kept', () => {
    const query = Object.assign(new ListQueryDto(), { limit: 2, order: SortDirection.DESC });
    const page = mergeKeysetPages<{ id: string; at: string }>(
      [
        source([row('a', '2026-08-10T10:00:00.000003Z'), row('b', '2026-08-10T09:00:00.000000Z')]),
        source([row('c', '2026-08-10T10:00:00.000002Z')]),
      ],
      query,
      spec,
    );
    expect(page.items.map((r) => r.id)).toEqual(['a', 'c']);
    expect(decodeCursor(page.pageInfo.nextCursor as string, 'createdAt:desc')).toEqual({
      sortValue: '2026-08-10T10:00:00.000002Z',
      id: 'c',
      sort: 'createdAt:desc',
    });
  });

  it('ends the list when every source is exhausted', () => {
    const query = Object.assign(new ListQueryDto(), { limit: 5, order: SortDirection.ASC });
    const page = mergeKeysetPages<{ id: string; at: string }>(
      [source([row('a', '1')]), source([row('b', '0')])],
      query,
      spec,
    );
    expect(page.items.map((r) => r.id)).toEqual(['b', 'a']);
    expect(page.pageInfo).toEqual({ nextCursor: null, hasMore: false });
  });
});
