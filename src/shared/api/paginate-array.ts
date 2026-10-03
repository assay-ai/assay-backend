import { decodeCursor } from './cursor';
import { CursorPageDto } from './dto/cursor-page.dto';
import { ListQueryDto, SortDirection } from './dto/list-query.dto';
import { ApiErrors } from './errors/api.errors';
import { ListSpec, resolveSort, toPage } from './keyset';

/**
 * {@link paginate} for a resource with no `SelectQueryBuilder` behind it.
 *
 * Some resources on this surface are not tables: the agent list reads the
 * session-credential snapshot, tool bindings walk the in-memory catalogue port,
 * and SLA windows are computed per UTC day rather than stored. The client must
 * not be able to tell — a port-backed list pages, sorts and ends exactly like a
 * table-backed one, or the "one pagination style" promise is only true of the
 * endpoints that happened to have a table.
 *
 * `toPage` alone is half the job. It packages an already-ordered,
 * already-cursor-filtered slice; it says nothing about getting from *all the
 * rows* to that slice. `paginate` does that half in SQL — an `ORDER BY` plus a
 * keyset `WHERE`. This is the in-memory equivalent, replaying the same
 * `(sortValue, id)` row-value comparison that `buildKeysetPredicate` hands to
 * Postgres.
 *
 * ## Why this lives here and not in a module
 *
 * It was once written twice, independently — once under
 * `modules/account` and once under `modules/provider` — because the shared
 * barrel exposed `toPage` but not this. Two implementations of cursor
 * arithmetic is the precise failure "one pagination style" exists to prevent:
 * they were already subtly different (one sorted ascending then reversed, the
 * other folded direction into the comparator), and nothing would have kept them
 * agreeing as either changed. One copy, one set of tests.
 */
export function paginateArray<T extends { readonly id: string }>(
  rows: readonly T[],
  query: ListQueryDto,
  spec: ListSpec,
): CursorPageDto<T> {
  const sort = resolveSort(query, spec);
  assertLexicographicallyOrderable(sort.field.type, sort.key);

  const descending = sort.direction === SortDirection.DESC;

  const keyed = rows.map((row) => ({ row, key: sort.field.valueOf(row) }));
  keyed.sort((a, b) => compare(a, b) * (descending ? -1 : 1));

  let remaining = keyed;
  if (query.cursor) {
    // Decoded once, outside the predicate — not per candidate row.
    const position = decodeCursor(query.cursor, sort.spec);
    const from = { row: { id: position.id }, key: position.sortValue };
    remaining = keyed.filter((candidate) =>
      descending ? compare(candidate, from) < 0 : compare(candidate, from) > 0,
    );
  }

  const page = remaining.slice(0, query.limit + 1).map(({ row }) => row);
  return toPage(page, query.limit, sort);
}

/** Ascending `(key, id)`, the in-memory twin of `ORDER BY <col>, <id>`. */
function compare(
  a: { row: { id: string }; key: string },
  b: { row: { id: string }; key: string },
): number {
  if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  if (a.row.id !== b.row.id) return a.row.id < b.row.id ? -1 : 1;
  return 0;
}

/**
 * Refuses a sort field whose serialised form does not sort like its real value.
 *
 * This helper compares `valueOf(row)` as a **string**, because that is what the
 * cursor round-trips and what `buildKeysetPredicate` compares against the
 * column. In Postgres the cast in that predicate (`:value::numeric`) restores
 * the true ordering; in memory there is no cast, so the comparison is
 * lexicographic — and lexicographically `"10" < "9"`.
 *
 * A `numeric` sort field would therefore page a provider's payouts in an order
 * that looks almost right and interleaves wrongly at every change of digit
 * count. That is a bad failure: it is invisible in a fixture of single-digit
 * amounts and wrong on real money.
 *
 * ISO-8601 instants, uuids and text do sort lexicographically, which is why
 * every non-SQL list on this surface sorts on one of those. Rather than leave
 * that as a comment somebody has to read, the numeric types are refused
 * outright — the same allowlist-not-validation reflex as `resolveSort`.
 */
function assertLexicographicallyOrderable(type: string, field: string): void {
  if (type === 'numeric' || type === 'bigint' || type === 'int') {
    throw ApiErrors.unknownSortField({
      field,
      detail:
        `"${field}" is ${type}, which cannot be ordered in memory: the cursor compares ` +
        `serialised values as text, and "10" sorts before "9"`,
    });
  }
}
