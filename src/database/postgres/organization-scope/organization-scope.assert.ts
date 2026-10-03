import { FindOperator } from 'typeorm';
import { OrganizationErrors } from '@shared/errors/organization-scope.errors';
import {
  NON_SCOPING_FIND_OPERATORS,
  ORGANIZATION_SCOPE_COLUMN,
  ORGANIZATION_SCOPE_PROPERTY,
} from './organization-scope.constants';

/**
 * The whole point of the multi-organization foundation: a query that forgets
 * `organizationId` FAILS LOUDLY at runtime instead of quietly returning another
 * tenant's rows.
 *
 * These are pure functions so they can be unit-tested without a database, and
 * so `OrganizationScopedRepository` stays a thin delegation layer over them.
 */

const ORGANIZATION_COLUMN_PATTERN = new RegExp(`\\b${ORGANIZATION_SCOPE_COLUMN}\\b`, 'i');

const SQL_EXCERPT_LENGTH = 300;

/**
 * Asserts a `where` constrains `organizationId`. An array is a set of
 * OR-branches: every branch must be scoped, because the union of a scoped and
 * an unscoped branch is unscoped.
 */
export function assertOrganizationScopedWhere(where: unknown, operation: string): void {
  if (Array.isArray(where)) {
    if (where.length === 0) {
      throw OrganizationErrors.scopeMissing({ operation, detail: 'empty where array' });
    }
    where.forEach((branch, index) => assertScopedWhereObject(branch, operation, `where[${index}]`));
    return;
  }

  assertScopedWhereObject(where, operation, 'where');
}

/**
 * Asserts find options carry a scoped `where`. `find()` with no options at all
 * is a full-table read, and is rejected exactly like a missing predicate.
 */
export function assertOrganizationScopedFindOptions(options: unknown, operation: string): void {
  if (!isRecord(options)) {
    throw OrganizationErrors.scopeMissing({ operation, detail: 'no find options given' });
  }

  assertOrganizationScopedWhere(options.where, operation);
}

/**
 * Asserts an update/delete criteria is scoped. A bare primary key is rejected:
 * an id belongs to *some* organization, and acting on it without naming which
 * one is how a row gets written across a tenant boundary.
 */
export function assertOrganizationScopedCriteria(criteria: unknown, operation: string): void {
  const isBareKey =
    typeof criteria === 'string' ||
    typeof criteria === 'number' ||
    criteria instanceof Date ||
    (Array.isArray(criteria) && criteria.some((item) => typeof item !== 'object'));

  if (isBareKey) {
    throw OrganizationErrors.scopeMissing({
      operation,
      detail: 'criteria is a bare primary key — pass { organizationId, id } instead',
    });
  }

  assertOrganizationScopedWhere(criteria, operation);
}

/**
 * Asserts every row being written carries an `organizationId`. Postgres would
 * reject the NULL anyway; failing here names the column and the call site
 * instead of surfacing a constraint violation from three layers down.
 */
export function assertOrganizationScopedValues(values: unknown, operation: string): void {
  const rows = Array.isArray(values) ? values : [values];

  if (rows.length === 0) {
    throw OrganizationErrors.scopeMissingOnWrite({ operation, detail: 'an empty value list' });
  }

  rows.forEach((row, index) => {
    const organizationId = isRecord(row) ? row[ORGANIZATION_SCOPE_PROPERTY] : undefined;
    if (organizationId === undefined || organizationId === null) {
      throw OrganizationErrors.scopeMissingOnWrite({
        operation,
        detail: rows.length > 1 ? `values[${index}]` : 'the written values',
      });
    }
  });
}

/**
 * Asserts generated SQL mentions the tenant column.
 *
 * This is the query builder's guard: a builder can express predicates the
 * `FindOptions` checks never see, so the built statement is inspected just
 * before it executes.
 *
 * It proves the column is *referenced*, not that it is referenced *correctly* —
 * a check on the text of a query cannot know that `organization_id = :orgId`
 * was bound to the caller's own organization. It stops the accident, which is
 * the failure this foundation is built against; it does not stop a deliberate
 * act, and nothing at this layer could.
 */
export function assertOrganizationScopedSql(sql: unknown, operation: string): void {
  const statement = typeof sql === 'string' ? sql : '';

  if (!ORGANIZATION_COLUMN_PATTERN.test(statement)) {
    throw OrganizationErrors.scopeMissing({
      operation,
      detail: `built SQL never references "${ORGANIZATION_SCOPE_COLUMN}": ${excerpt(statement)}`,
    });
  }
}

function assertScopedWhereObject(where: unknown, operation: string, detail: string): void {
  if (!isRecord(where)) {
    throw OrganizationErrors.scopeMissing({ operation, detail: `${detail} is not a condition` });
  }

  const value = where[ORGANIZATION_SCOPE_PROPERTY];

  if (value === undefined || value === null) {
    throw OrganizationErrors.scopeMissing({
      operation,
      detail: `${detail} has no ${ORGANIZATION_SCOPE_PROPERTY}`,
    });
  }

  if (value instanceof FindOperator && NON_SCOPING_FIND_OPERATORS.has(value.type)) {
    throw OrganizationErrors.scopeNegated({ operation, operator: value.type });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function excerpt(statement: string): string {
  if (!statement) {
    return '(empty statement)';
  }
  return statement.length > SQL_EXCERPT_LENGTH
    ? `${statement.slice(0, SQL_EXCERPT_LENGTH)}…`
    : statement;
}
