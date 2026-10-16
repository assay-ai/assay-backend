/**
 * A query builder that records what was asked of it and replays a fixed
 * result — same technique as `test/unit/shared/api/keyset.spec.ts`.
 */
export function fakeQueryBuilder<T>(rows: T[]) {
  const wheres: Array<{ sql: string; params: Record<string, unknown> }> = [];
  const orders: Array<[string, string]> = [];
  const groups: string[] = [];
  let taken = 0;

  const qb: any = {
    where(sql: string, params: Record<string, unknown> = {}) {
      wheres.push({ sql, params });
      return qb;
    },
    andWhere(sql: string, params: Record<string, unknown> = {}) {
      wheres.push({ sql, params });
      return qb;
    },
    select() {
      return qb;
    },
    addSelect() {
      return qb;
    },
    groupBy(column: string) {
      groups.push(column);
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
    // `paginate()` uses `limit`, not `take` — `take` switches TypeORM to a
    // distinct-id subquery as soon as the query joins, which cannot resolve
    // the raw SQL sort columns a `ListSpec` carries. Both are modelled here so
    // the fake matches a real builder whichever a caller reaches for.
    limit(n: number) {
      taken = n;
      return qb;
    },
    take(n: number) {
      taken = n;
      return qb;
    },
    async getMany() {
      return rows;
    },
    // `paginate()` reads a `timestamptz` sort through this, for the exact
    // microsecond cursor; no raw rows means it falls back to the field's `valueOf`.
    async getRawAndEntities() {
      return { entities: rows, raw: [] };
    },
    async getRawMany() {
      return rows;
    },
  };

  return {
    qb,
    wheres,
    orders,
    groups,
    get taken() {
      return taken;
    },
  };
}
