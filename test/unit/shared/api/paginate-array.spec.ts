import { ApiErrorCode, ListQueryDto, ListSpec, SortDirection, paginateArray } from '@shared/api';
import { BaseError } from '@shared/errors/base.error';

/**
 * The in-memory half of the cursor contract.
 *
 * Merged from two suites that were written independently, in the same
 * milestone, against two copies of this function — one under `modules/account`
 * for the agents list, one under `modules/provider` for tool bindings and SLA
 * windows. Both copies are gone; this is the only implementation and the only
 * suite.
 *
 * The property that matters is stated as a round trip rather than as a set of
 * slices: paging all the way through visits **every row exactly once, in
 * order**. A keyset bug does not usually produce an obviously wrong page — it
 * repeats one row at each boundary, or drops one, which a fixture of four rows
 * and one page will not show.
 */

interface Row {
  readonly id: string;
  readonly key: string;
}

const SPEC: ListSpec = {
  alias: 'row',
  defaultSort: 'key',
  sortable: {
    // `column` is unused here — nothing builds SQL — but `ListSpec` requires it,
    // because the same spec must also serve the table-backed path.
    key: { column: 'row.key', type: 'text', valueOf: (row: Row) => row.key },
  },
};

function rows(...keys: string[]): Row[] {
  return keys.map((key) => ({ id: key, key }));
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

/** Pages all the way through, returning every id in the order it was served. */
function pageThrough(all: Row[], limit: number, order = SortDirection.DESC): string[] {
  const seen: string[] = [];
  let cursor: string | undefined;

  for (let guard = 0; guard <= all.length + 2; guard += 1) {
    const page = paginateArray(all, query({ limit, cursor, order }), SPEC);
    seen.push(...page.items.map((row) => row.id));
    if (!page.pageInfo.hasMore) return seen;
    cursor = page.pageInfo.nextCursor as string;
  }

  throw new Error('pagination did not terminate');
}

describe('paginateArray — the non-SQL cursor page', () => {
  describe('ordering', () => {
    it('sorts descending by default, highest key first', () => {
      const page = paginateArray(rows('a', 'c', 'b'), query(), SPEC);

      expect(page.items.map((row) => row.id)).toEqual(['c', 'b', 'a']);
    });

    it('sorts ascending when asked', () => {
      const page = paginateArray(rows('a', 'c', 'b'), query({ order: SortDirection.ASC }), SPEC);

      expect(page.items.map((row) => row.id)).toEqual(['a', 'b', 'c']);
    });

    it('breaks ties on the id, so equal keys still have a total order', () => {
      const tied: Row[] = [
        { id: 'z', key: 'same' },
        { id: 'a', key: 'same' },
        { id: 'm', key: 'same' },
      ];

      const page = paginateArray(tied, query({ order: SortDirection.ASC }), SPEC);
      expect(page.items.map((row) => row.id)).toEqual(['a', 'm', 'z']);
    });
  });

  describe('page boundaries', () => {
    it('an empty collection is [] with no cursor', () => {
      const page = paginateArray([], query(), SPEC);

      expect(page.items).toEqual([]);
      expect(page.pageInfo).toEqual({ nextCursor: null, hasMore: false });
    });

    it('a short page ends the list', () => {
      const page = paginateArray(rows('a', 'b'), query({ limit: 10 }), SPEC);

      expect(page.pageInfo).toEqual({ nextCursor: null, hasMore: false });
    });

    // The subtle one: exactly `limit` rows remain, so there is no probe row.
    // Emitting a cursor here hands the client one more request returning nothing.
    it('an exactly-full final page ends the list', () => {
      const page = paginateArray(rows('a', 'b'), query({ limit: 2 }), SPEC);

      expect(page.items).toHaveLength(2);
      expect(page.pageInfo.hasMore).toBe(false);
      expect(page.pageInfo.nextCursor).toBeNull();
    });

    it('emits a cursor when rows remain, without hiding any of the current page', () => {
      const page = paginateArray(rows('e', 'd', 'c', 'b', 'a'), query({ limit: 2 }), SPEC);

      expect(page.items.map((row) => row.id)).toEqual(['e', 'd']);
      expect(page.pageInfo.hasMore).toBe(true);
      expect(page.pageInfo.nextCursor).not.toBeNull();
    });
  });

  describe('a full traversal loses and repeats nothing', () => {
    it.each([1, 2, 3, 7])('descending, %i per page', (limit) => {
      const all = rows('e', 'd', 'c', 'b', 'a', 'z', 'y', 'x');
      const seen = pageThrough(all, limit);

      expect(seen).toEqual([...all.map((row) => row.id)].sort().reverse());
      expect(new Set(seen).size).toBe(all.length);
    });

    it.each([1, 2, 3, 7])('ascending, %i per page', (limit) => {
      const all = rows('e', 'd', 'c', 'b', 'a', 'z', 'y', 'x');
      const seen = pageThrough(all, limit, SortDirection.ASC);

      expect(seen).toEqual([...all.map((row) => row.id)].sort());
      expect(new Set(seen).size).toBe(all.length);
    });

    it('traverses a collection whose keys are all equal, on the tiebreak alone', () => {
      const tied = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, key: 'same' }));
      const seen = pageThrough(tied, 2, SortDirection.ASC);

      expect(seen).toEqual(['a', 'b', 'c', 'd', 'e']);
    });
  });

  describe('it fails the same way the SQL path does', () => {
    it('refuses an unknown sort field', () => {
      expect(raisedCode(() => paginateArray(rows('a'), query({ sort: 'nope' }), SPEC))).toBe(
        ApiErrorCode.API_UNKNOWN_SORT_FIELD,
      );
    });

    it('refuses a cursor taken under a different ordering rather than mis-paging', () => {
      const page = paginateArray(rows('c', 'b', 'a'), query({ limit: 1 }), SPEC);
      const cursor = page.pageInfo.nextCursor as string;

      expect(
        raisedCode(() =>
          paginateArray(
            rows('c', 'b', 'a'),
            query({ limit: 1, cursor, order: SortDirection.ASC }),
            SPEC,
          ),
        ),
      ).toBe(ApiErrorCode.API_INVALID_CURSOR);
    });

    it('refuses a malformed cursor', () => {
      expect(raisedCode(() => paginateArray(rows('a'), query({ cursor: '!!!' }), SPEC))).toBe(
        ApiErrorCode.API_INVALID_CURSOR,
      );
    });
  });

  /**
   * The guard neither original copy had.
   *
   * In SQL the keyset predicate casts the cursor value back to the column's
   * type, so `numeric` orders numerically. In memory there is no cast and the
   * comparison is lexicographic, where `"10" < "9"`. A payout list sorted by
   * amount would interleave wrongly at every change of digit count — invisible
   * in a single-digit fixture, wrong on real money.
   */
  describe('it refuses a sort key that does not sort lexicographically', () => {
    it.each(['numeric', 'bigint', 'int'] as const)('rejects a %s sort field', (type) => {
      const numericSpec: ListSpec = {
        alias: 'row',
        defaultSort: 'amount',
        sortable: {
          amount: { column: 'row.amount', type, valueOf: (row: Row) => row.key },
        },
      };

      expect(raisedCode(() => paginateArray(rows('9', '10'), query(), numericSpec))).toBe(
        ApiErrorCode.API_UNKNOWN_SORT_FIELD,
      );
    });

    it('demonstrates why: text ordering puts "10" before "9"', () => {
      const page = paginateArray(rows('9', '10'), query({ order: SortDirection.ASC }), SPEC);

      expect(page.items.map((row) => row.id)).toEqual(['10', '9']);
    });
  });
});
