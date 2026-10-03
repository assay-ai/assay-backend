import { AssertDomainErrorCodes, createDomainErrorFactory } from './error-catalog';

/**
 * `ORGANIZATION_*` — raised by the query-layer guard in
 * `@database/postgres/organization-scope`, never by business logic.
 *
 * These are 500s on purpose. A query that forgot its tenant predicate is a bug
 * in our code, not a bad request from a caller: reporting it as a 4xx would
 * hand the caller a problem they cannot fix and would hide it from the 5xx
 * alerting that should be waking someone up.
 */
export enum OrganizationErrorCode {
  ORGANIZATION_SCOPE_MISSING = 'ORGANIZATION_SCOPE_MISSING',
  ORGANIZATION_SCOPE_NEGATED = 'ORGANIZATION_SCOPE_NEGATED',
  ORGANIZATION_SCOPE_MISSING_ON_WRITE = 'ORGANIZATION_SCOPE_MISSING_ON_WRITE',
  ORGANIZATION_SCOPE_UNSCOPED_OPERATION = 'ORGANIZATION_SCOPE_UNSCOPED_OPERATION',
}

export type OrganizationErrorCodesArePrefixed = AssertDomainErrorCodes<
  'ORGANIZATION',
  `${OrganizationErrorCode}`
>;

export const OrganizationErrors = createDomainErrorFactory('ORGANIZATION', {
  scopeMissing: {
    code: OrganizationErrorCode.ORGANIZATION_SCOPE_MISSING,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `${context?.operation ?? 'Query on an organization-scoped table'} is missing an organizationId predicate` +
      `${context?.detail ? ` — ${context.detail}` : ''}`,
  },
  scopeNegated: {
    code: OrganizationErrorCode.ORGANIZATION_SCOPE_NEGATED,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `${context?.operation ?? 'Query on an organization-scoped table'} constrains organizationId with a non-scoping operator` +
      `${context?.operator ? `: ${context.operator}` : ''}`,
  },
  scopeMissingOnWrite: {
    code: OrganizationErrorCode.ORGANIZATION_SCOPE_MISSING_ON_WRITE,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `${context?.operation ?? 'Write to an organization-scoped table'} is missing organizationId on ` +
      `${context?.detail ?? 'the written values'}`,
  },
  unscopedOperation: {
    code: OrganizationErrorCode.ORGANIZATION_SCOPE_UNSCOPED_OPERATION,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `${context?.operation ?? 'This operation'} cannot be organization-scoped and is forbidden on ` +
      `organization-scoped tables${context?.detail ? ` — ${context.detail}` : ''}`,
  },
});
