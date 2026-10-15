import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

import { encodeCursor, decodeCursor } from './cursor';
import { CursorPageDto } from './dto/cursor-page.dto';
import { ListQueryDto, SortDirection } from './dto/list-query.dto';
import { ApiErrors } from './errors/api.errors';

/**
 * One field a resource permits ordering by.
 *
 * `column` is raw SQL and is **never** taken from the request — it is looked up
 * in the resource's own map by the caller-supplied key. That indirection is the
 * whole reason the map exists: a `sort` parameter concatenated into an
 * `ORDER BY` is an injection, and no amount of validating the *shape* of the
 * string fixes it. Here the caller chooses an entry, not an expression.
 */
export interface SortableField {
  /** Qualified SQL expression, e.g. `intent.created_at`. */
  readonly column: string;

  /**
   * The Postgres type the cursor value is cast to in the keyset predicate.
   *
   * Required, not inferred. The cursor carries its position as a string; a
   * comparison against a `timestamptz` column with no cast makes Postgres guess
   * from context, and where it guesses `text` the ordering becomes
   * lexicographic — which for ISO-8601 happens to look right until a value with
   * a different fractional-second width shows up, and then silently is not.
   */
  readonly type: 'timestamptz' | 'uuid' | 'text' | 'numeric' | 'int' | 'bigint';

  /**
   * Reads this field off a loaded row and serialises it for the cursor.
   *
   * Serialisation lives with the field because only the field knows the shape:
   * a `Date` must go out as an ISO instant, a `numeric` as its exact decimal
   * string. Round-tripping a `numeric` through `Number` would lose precision on
   * exactly the columns where precision is money.
   */
  readonly valueOf: (row: any) => string;
}

/**
 * How one resource exposes itself to the shared list machinery.
 *
 * Declared once per resource next to its repository, then handed to
 * {@link paginate}. Everything a list endpoint needs to differ in is in here,
 * which is what keeps the endpoints themselves identical.
 */
export interface ListSpec {
  /** The query builder's alias, e.g. `intent`. */
  readonly alias: string;

  /**
   * API field name → column. Only these may be sorted on.
   *
   * **Every entry must be a `NOT NULL` column.** A row-value comparison
   * involving `NULL` is `NULL`, which is not `TRUE`, so a nullable sort column
   * makes rows with no value fall out of the pagination entirely — not
   * mis-ordered, *missing*, and missing without an error. Sort on the nullable
   * field's non-null companion (`created_at`) and expose the nullable one as a
   * filter instead.
   */
  readonly sortable: Readonly<Record<string, SortableField>>;

  /** Used when the request omits `sort`. Must be a key of `sortable`. */
  readonly defaultSort: string;

  /**
   * Column `from` / `to` filter on. Defaults to the default sort field's column.
   *
   * Separable because the two are not always the same thing: a payout list
   * sorts by `created_at` but a user filtering "August" means the payout's
   * settlement date.
   */
  readonly timeColumn?: string;

  /**
   * The unique tiebreak column. Defaults to `<alias>.id`.
   *
   * Must be unique, or pagination is not stable — see {@link buildKeysetPredicate}.
   */
  readonly idColumn?: string;
}

/** The resolved ordering for one request. */
interface ResolvedSort {
  readonly key: string;
  readonly field: SortableField;
  readonly direction: SortDirection;
  /** `<field>:<direction>` — what the cursor is stamped with. */
  readonly spec: string;
}

/**
 * Resolves `sort` / `order` against the resource's allowlist.
 *
 * An unknown field is a 400 that names the valid ones, rather than a silent
 * fallback to the default. Falling back would mean a client asking for
 * `sort=amount` on a resource that cannot do it receives a page ordered by
 * `createdAt` with a `200`, and then renders it under an "Amount ↓" header that
 * is simply a lie.
 */
export function resolveSort(query: ListQueryDto, spec: ListSpec): ResolvedSort {
  const key = query.sort ?? spec.defaultSort;
  // Own properties only: a bare index also finds `constructor`, `toString` and
  // the rest of `Object.prototype`, which would pass the allowlist as truthy.
  const field = Object.prototype.hasOwnProperty.call(spec.sortable, key)
    ? spec.sortable[key]
    : undefined;

  if (!field) {
    throw ApiErrors.unknownSortField({ field: key, allowed: Object.keys(spec.sortable) });
  }

  const direction = query.order ?? SortDirection.DESC;
  return { key, field, direction, spec: `${key}:${direction}` };
}

/**
 * The keyset predicate, as a Postgres row-value comparison.
 *
 * ```sql
 * (intent.created_at, intent.id) < ($1::timestamptz, $2::uuid)
 * ```
 *
 * Row-value rather than the hand-expanded
 * `a < :k OR (a = :k AND id < :i)` for two reasons. It is the form the planner
 * recognises as an index seek on `(a, id)` — the expanded `OR` frequently
 * degrades to a scan — and it cannot be got subtly wrong, which the expanded
 * form very often is (`>=` on the tiebreak repeats a row on every page
 * boundary, and it repeats exactly one, so it survives casual testing).
 *
 * The tiebreak must be unique. If two rows can share both the sort value and
 * the "unique" column, the comparison cannot separate them and one is dropped.
 */
function buildKeysetPredicate(
  sort: ResolvedSort,
  idColumn: string,
): { sql: string; comparator: string } {
  const comparator = sort.direction === SortDirection.DESC ? '<' : '>';
  return {
    sql:
      `(${sort.field.column}, ${idColumn}) ${comparator} ` +
      `(:__cursorValue::${sort.field.type}, :__cursorId::uuid)`,
    comparator,
  };
}

/**
 * Applies `from` / `to` to the resource's time column.
 *
 * Half-open `[from, to)` deliberately, and uniformly. Two adjacent windows must
 * partition rather than overlap: with an inclusive `to`, a call at exactly
 * midnight is counted in both August and September, and a spend report that
 * double-counts a boundary row is a reconciliation defect rather than a
 * rounding one.
 */
export function applyTimeWindow<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  query: ListQueryDto,
  spec: ListSpec,
): void {
  if (query.from && query.to && query.from >= query.to) {
    throw ApiErrors.invalidTimeRange({
      from: query.from.toISOString(),
      to: query.to.toISOString(),
    });
  }

  const column = spec.timeColumn ?? spec.sortable[spec.defaultSort].column;

  if (query.from) qb.andWhere(`${column} >= :__from`, { __from: query.from });
  if (query.to) qb.andWhere(`${column} < :__to`, { __to: query.to });
}

/**
 * Runs a prepared query as one cursor page.
 *
 * The caller builds the query — joins, filters, the `organizationId` predicate
 * — and this adds ordering, the keyset bound and the limit, then packages the
 * result. Ordering and limiting are applied *here*, after the caller is done,
 * so a resource cannot accidentally ship a list endpoint that paginates its own
 * way.
 *
 * ## `limit + 1`
 *
 * One row beyond the page is fetched and discarded, and its only job is to
 * answer `hasMore` honestly. The alternatives are worse: a `COUNT(*)` is the
 * scan cursors exist to avoid, and inferring "last page" from a short page is
 * wrong whenever a filter removes rows — the client stops early on a full
 * collection. Costing one extra row per request buys an end-of-list signal that
 * is never wrong.
 */
export async function paginate<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  query: ListQueryDto,
  spec: ListSpec,
): Promise<CursorPageDto<T>> {
  const sort = resolveSort(query, spec);
  const idColumn = spec.idColumn ?? `${spec.alias}.id`;

  if (query.cursor) {
    const position = decodeCursor(query.cursor, sort.spec);
    const { sql } = buildKeysetPredicate(sort, idColumn);
    qb.andWhere(sql, { __cursorValue: position.sortValue, __cursorId: position.id });
  }

  const direction = sort.direction === SortDirection.DESC ? 'DESC' : 'ASC';
  qb.orderBy(sort.field.column, direction).addOrderBy(idColumn, direction);

  /**
   * `limit`, deliberately, and never `take`.
   *
   * They look interchangeable and are not. `take` means "this many *entities*",
   * so as soon as the query has a join TypeORM switches to its distinct-id
   * strategy: it runs a separate `SELECT DISTINCT` over the primary keys and
   * re-maps the `ORDER BY` onto that subquery. Re-mapping requires resolving
   * each ordered column through entity metadata — and the columns here are raw
   * SQL from the resource's `ListSpec` (`intent.created_at`), not property
   * paths, so the lookup returns `undefined` and the query dies with
   * `Cannot read properties of undefined (reading 'databaseName')`.
   *
   * That failure is invisible until a list endpoint joins. Every unjoined list
   * on this surface worked; `/tool-calls`, which left-joins the verdict store
   * to filter on `verdictStatus`, returned a 500 on its very first request.
   *
   * `limit` emits a plain SQL `LIMIT` and skips the whole strategy. It is also
   * the semantically correct one here: keyset pagination returns a flat page of
   * rows, and nothing on this surface hydrates a one-to-many collection — the
   * only case where "rows" and "entities" differ and `take` would be required.
   */
  qb.limit(query.limit + 1);

  const rows = await qb.getMany();
  return toPage(rows, query.limit, sort, spec);
}

/**
 * Packages already-fetched rows into a page.
 *
 * Split out so a resource whose list cannot be expressed as one query builder —
 * anything reading through a port rather than a table, such as the
 * config-backed provider catalogue — produces a page identical in shape to a
 * database-backed one. The uniform envelope is the deliverable; where the rows
 * came from is not the client's business.
 *
 * Pass `rows` with the extra `limit + 1`-th element still on it.
 */
export function toPage<T>(
  rows: T[],
  limit: number,
  sort: Pick<ResolvedSort, 'field' | 'spec'>,
  _spec?: ListSpec,
): CursorPageDto<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  if (!hasMore || items.length === 0) {
    return new CursorPageDto<T>(items, null);
  }

  const last = items[items.length - 1] as any;
  const nextCursor = encodeCursor(
    { sortValue: sort.field.valueOf(last), id: String(last.id) },
    sort.spec,
  );

  return new CursorPageDto<T>(items, nextCursor);
}

/** Serialiser for a `timestamptz` column — an exact ISO-8601 instant. */
export const asInstant = (get: (row: any) => Date | string) => (row: any) => {
  const value = get(row);
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

/** Serialiser for a `numeric`/`bigint` column — the exact decimal string, never a `Number`. */
export const asExactNumber = (get: (row: any) => string | number | bigint) => (row: any) =>
  String(get(row));

/**
 * A cursor for a list whose order is a composite key rather than one sortable
 * column — the operator's Penalties list orders by next deadline, then amount,
 * then age, which no single `SortableField` can express.
 *
 * The same codec and the same sort stamp as {@link paginate}'s cursors, so a
 * cursor from another ordering is refused the same way; the position's parts
 * travel as a JSON array of strings in `sortValue`. The caller binds each part
 * with a cast, so it still has to check each part's shape before use — a value
 * that does not cast is a 400 there, not a 500 at the database.
 */
export function encodeCompositeCursor(parts: readonly string[], id: string, sort: string): string {
  return encodeCursor({ sortValue: JSON.stringify(parts), id }, sort);
}

/** The inverse of {@link encodeCompositeCursor}: exactly `arity` string parts, or `API_INVALID_CURSOR`. */
export function decodeCompositeCursor(
  cursor: string,
  sort: string,
  arity: number,
): { parts: string[]; id: string } {
  const { sortValue, id } = decodeCursor(cursor, sort);
  let parts: unknown;
  try {
    parts = JSON.parse(sortValue);
  } catch {
    throw ApiErrors.invalidCursor({ detail: 'malformed position' });
  }
  if (
    !Array.isArray(parts) ||
    parts.length !== arity ||
    !parts.every((part) => typeof part === 'string')
  ) {
    throw ApiErrors.invalidCursor({ detail: 'malformed position' });
  }
  return { parts: parts as string[], id };
}
