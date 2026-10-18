/**
 * A query builder that records what was asked of it and replays a fixed
 * result — same technique as `test/unit/shared/api/keyset.spec.ts`'s
 * `fakeQueryBuilder` (and its siblings in `test/unit/ledger/helpers/` and
 * `test/unit/payment/helpers/`), extended with `.setParameter()`/
 * `.setParameters()`/`.limit()` for the provider report services, which
 * chain those too.
 *
 * The point is proving what SQL fragment a *service* builds (filters, the
 * cross-organization predicate, the grouping expression) without a database;
 * `keyset.spec.ts` already covers what `paginate()` itself adds on top
 * (ordering, the keyset bound, the limit).
 *
 * `getRawOne()`/`getOne()` were added for `ProviderSlaWindowsService`'s
 * single-row aggregates (`SUM(...)` over a binding's closed windows) — they
 * return the first (and, in every caller so far, only) row of the fixture.
 *
 * `having()` was added for `ProviderPayoutsService`'s redemption groups, whose
 * keyset bound is on the aggregate.
 *
 * `leftJoin()` was added for `ProviderVerdictService.list`, which registers a
 * join alias for an optional filter (`agentId` → `payment_intents`, `windowId`
 * → `sla_window_calls`) without an `addSelect` — same shape
 * `ToolCallsService.list` uses against a real builder. It only records the
 * call; it does not change what `getMany()` replays, matching the real
 * builder's behaviour when nothing is selected off the joined alias.
 */
export function fakeQueryBuilder<T>(rows: T[]) {
  const wheres: Array<{ sql: string; params: Record<string, unknown> }> = [];
  const selects: Array<{ expr: string; alias?: string }> = [];
  const orders: Array<[string, string]> = [];
  const groups: string[] = [];
  const havings: Array<{ sql: string; params: Record<string, unknown> }> = [];
  const joins: Array<{ entityOrProperty: unknown; alias: string; condition?: string }> = [];
  const params: Record<string, unknown> = {};
  let taken = 0;
  let limited: number | undefined;

  const qb: any = {
    select(expr: string | string[], alias?: string) {
      selects.push({ expr: Array.isArray(expr) ? expr.join(',') : expr, alias });
      return qb;
    },
    addSelect(expr: string, alias?: string) {
      selects.push({ expr, alias });
      return qb;
    },
    leftJoin(entityOrProperty: unknown, alias: string, condition?: string) {
      joins.push({ entityOrProperty, alias, condition });
      return qb;
    },
    where(sql: string, p: Record<string, unknown> = {}) {
      wheres.push({ sql, params: p });
      Object.assign(params, p);
      return qb;
    },
    andWhere(sql: string, p: Record<string, unknown> = {}) {
      wheres.push({ sql, params: p });
      Object.assign(params, p);
      return qb;
    },
    having(sql: string, p: Record<string, unknown> = {}) {
      havings.push({ sql, params: p });
      Object.assign(params, p);
      return qb;
    },
    groupBy(column: string) {
      groups.push(column);
      return qb;
    },
    addGroupBy(column: string) {
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
    setParameter(name: string, value: unknown) {
      params[name] = value;
      return qb;
    },
    setParameters(p: Record<string, unknown>) {
      Object.assign(params, p);
      return qb;
    },
    take(n: number) {
      taken = n;
      return qb;
    },
    limit(n: number) {
      limited = n;
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
    async getRawOne() {
      return rows[0];
    },
    async getOne() {
      return rows[0] ?? null;
    },
  };

  return {
    qb,
    wheres,
    selects,
    orders,
    groups,
    havings,
    joins,
    params,
    get taken() {
      return taken;
    },
    get limited() {
      return limited;
    },
  };
}

/** A `createQueryBuilder` chained call that yields a different fake per call, in order. */
export function fakeRepository(queryBuilders: Array<ReturnType<typeof fakeQueryBuilder>['qb']>) {
  let call = 0;
  return {
    createQueryBuilder: jest.fn(() => queryBuilders[call++]),
  };
}
