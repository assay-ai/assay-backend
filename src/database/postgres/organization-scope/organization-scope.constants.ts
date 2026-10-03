/**
 * The tenant discriminator. Every business table carries it, and every read and
 * write against those tables must constrain it.
 *
 * Organizations are self-created, with `organizationId` on **every** table.
 * Adding it once twenty tables already exist is a system-wide migration plus a
 * rewrite of every query written in between, so the column and its enforcement
 * land before the first business table does.
 */
export const ORGANIZATION_SCOPE_PROPERTY = 'organizationId';

export const ORGANIZATION_SCOPE_COLUMN = 'organization_id';

/**
 * `FindOperator` types that name the column without narrowing the query to a
 * known set of organizations. `Not(orgId)` reads every *other* tenant's rows —
 * precisely the leak this guard exists to stop — so it is rejected as if the
 * predicate were absent. `In(...)` and `Any(...)` are allowed: they enumerate
 * the organizations they touch.
 */
export const NON_SCOPING_FIND_OPERATORS: ReadonlySet<string> = new Set(['not', 'isNull']);
