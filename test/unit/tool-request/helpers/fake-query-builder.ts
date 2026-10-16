/**
 * A query builder that records what was asked of it and replays a fixed
 * result — same technique as `test/unit/account/helpers/fake-query-builder.ts`
 * and `test/unit/shared/api/keyset.spec.ts`.
 */
export function fakeQueryBuilder<T>(rows: T[]) {
  const wheres: Array<{ sql: string; params: Record<string, unknown> }> = [];
  const orders: Array<[string, string]> = [];
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
    orderBy(column: string, direction: string) {
      orders.push([column, direction]);
      return qb;
    },
    addOrderBy(column: string, direction: string) {
      orders.push([column, direction]);
      return qb;
    },
    // `paginate()` uses `limit`, not `take` — see the account helper's own
    // note on why both are modelled here.
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
    get taken() {
      return taken;
    },
  };
}
