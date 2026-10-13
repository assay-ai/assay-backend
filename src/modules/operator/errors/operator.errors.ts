import { AssertDomainErrorCodes, createDomainErrorFactory } from '@shared/errors/error-catalog';

/**
 * `OPERATOR_*` — authenticating an internal human, checking what their role
 * and authority permit, and the register-driven refusals the override log
 * itself raises before it will write a row. The decision
 * logic that raises most of these — `OverrideLogService` and the
 * arbitration flow — is the orchestrator's; this catalog is shared because
 * every domain's error codes live in one place, per `error-catalog.ts`.
 */
export enum OperatorErrorCode {
  OPERATOR_CREDENTIAL_INVALID = 'OPERATOR_CREDENTIAL_INVALID',
  OPERATOR_SUSPENDED = 'OPERATOR_SUSPENDED',
  OPERATOR_ROLE_REQUIRED = 'OPERATOR_ROLE_REQUIRED',
  OPERATOR_NOT_FOUND = 'OPERATOR_NOT_FOUND',
  OPERATOR_AUTHORITY_EXCEEDED = 'OPERATOR_AUTHORITY_EXCEEDED',
  OPERATOR_SELF_APPROVAL_REFUSED = 'OPERATOR_SELF_APPROVAL_REFUSED',
  OPERATOR_UNKNOWN_OVERRIDE_CODE = 'OPERATOR_UNKNOWN_OVERRIDE_CODE',
  OPERATOR_OVERRIDE_NOT_IMPLEMENTED = 'OPERATOR_OVERRIDE_NOT_IMPLEMENTED',
  OPERATOR_SECOND_APPROVER_REQUIRED = 'OPERATOR_SECOND_APPROVER_REQUIRED',
  OPERATOR_APPROVER_ROLE_REQUIRED = 'OPERATOR_APPROVER_ROLE_REQUIRED',
  OPERATOR_APPROVER_AUTHORITY_EXCEEDED = 'OPERATOR_APPROVER_AUTHORITY_EXCEEDED',
}

export type OperatorErrorCodesArePrefixed = AssertDomainErrorCodes<
  'OPERATOR',
  `${OperatorErrorCode}`
>;

export const OperatorErrors = createDomainErrorFactory('OPERATOR', {
  /**
   * A missing token, an unknown token, or a token whose subject has no
   * `operators` row at all. The three are deliberately indistinguishable
   * from outside — same reasoning as `MCP_CREDENTIAL_INVALID` — so that a
   * caller cannot tell "you typed it wrong" from "that account was never
   * provisioned" from "the whole thing is misconfigured".
   */
  credentialInvalid: {
    code: OperatorErrorCode.OPERATOR_CREDENTIAL_INVALID,
    statusCode: 401,
    message: () => 'Operator credential invalid',
  },
  /**
   * The token is genuine and its subject is provisioned, but `status =
   * 'SUSPENDED'`. Distinguished from `credentialInvalid` on purpose: a
   * suspension is an authenticated fact about a known operator, not a bad
   * secret, and the two must not share a code or a 401.
   */
  suspended: {
    code: OperatorErrorCode.OPERATOR_SUSPENDED,
    statusCode: 403,
    message: (context?: Record<string, any>) =>
      `Operator is suspended${context?.subject ? `: ${context.subject}` : ''}`,
  },
  /**
   * The session holds none of the roles the action requires. `context` may
   * name the register `code` this was checked against (`OverrideLogService`)
   * or not (`OperatorRolesGuard`'s route-level check, which knows only the
   * roles a handler declared) — both pass `required`, and `held` when the
   * caller has it, so the message is useful either way.
   */
  roleRequired: {
    code: OperatorErrorCode.OPERATOR_ROLE_REQUIRED,
    statusCode: 403,
    message: (context?: Record<string, any>) => {
      const required = Array.isArray(context?.required) ? context.required.join(', ') : null;
      const held = Array.isArray(context?.held) ? context.held.join(', ') || '(none)' : null;
      return (
        `Requires one of: ${required ?? 'a named role'}` +
        `${context?.code ? ` (${context.code})` : ''}` +
        `${held ? ` — held: ${held}` : ''}`
      );
    },
  },
  /** Looked up by id (e.g. as an approver or an assignee) and no such row exists. */
  notFound: {
    code: OperatorErrorCode.OPERATOR_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `Operator not found${context?.id ? ` with id: ${context.id}` : ''}`,
  },
  /** Authority is bounded by a number. The action's amount exceeds the operator's ceiling. */
  authorityExceeded: {
    code: OperatorErrorCode.OPERATOR_AUTHORITY_EXCEEDED,
    statusCode: 403,
    message: (context?: Record<string, any>) =>
      `Action exceeds the operator's authority limit` +
      `${context?.code ? ` (${context.code})` : ''}` +
      `${context?.limit ? ` of ${context.limit}` : ''}` +
      `${context?.requested ? `, requested ${context.requested}` : ''}`,
  },
  /** No self-approval, enforced in code and again by `chk_override_log_entries_no_self_approval`. */
  selfApprovalRefused: {
    code: OperatorErrorCode.OPERATOR_SELF_APPROVAL_REFUSED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `An operator cannot approve their own action${context?.code ? ` (${context.code})` : ''}`,
  },
  /**
   * `code` is not a key of `OVERRIDE_REGISTER`. The register is a compile-time
   * constant, so this can only be a typo in our own routing table or a row
   * somebody deleted — never something a client's input can cause. `500`,
   * and the message must not imply the caller did anything wrong.
   */
  unknownOverrideCode: {
    code: OperatorErrorCode.OPERATOR_UNKNOWN_OVERRIDE_CODE,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `Unknown override code${context?.code ? `: ${context.code}` : ''} — this is a platform bug, not a caller error`,
  },
  /** `OVERRIDE_REGISTER[code].implemented === false` — enumerated in the register, not built. */
  overrideNotImplemented: {
    code: OperatorErrorCode.OPERATOR_OVERRIDE_NOT_IMPLEMENTED,
    statusCode: 501,
    message: (context?: Record<string, any>) =>
      `Override ${context?.code ?? ''} is not implemented`,
  },
  /** `approval = TWO_PERSON` and no second signature has been recorded yet. */
  secondApproverRequired: {
    code: OperatorErrorCode.OPERATOR_SECOND_APPROVER_REQUIRED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `A second signature is required${context?.code ? ` for ${context.code}` : ''}`,
  },
  /**
   * A second identity authenticated, and holds none of the roles the register
   * row demands of its approver. Distinct from `roleRequired`, which is about
   * the actor: an operator reading the refusal has to know which of the two
   * people to replace.
   */
  approverRoleRequired: {
    code: OperatorErrorCode.OPERATOR_APPROVER_ROLE_REQUIRED,
    statusCode: 403,
    message: (context?: Record<string, any>) => {
      const required = Array.isArray(context?.required) ? context.required.join(', ') : null;
      const held = Array.isArray(context?.held) ? context.held.join(', ') || '(none)' : null;
      return (
        `The second approver must hold one of: ${required ?? 'a named role'}` +
        `${context?.code ? ` (${context.code})` : ''}` +
        `${held ? ` — held: ${held}` : ''}`
      );
    },
  },
  /**
   * The second identity holds a qualifying role, but the action's amount is
   * above their own authority limit. A checker who could not have taken the
   * action cannot approve it either — otherwise a zero-authority token turns
   * any two-person action into a one-person one.
   */
  approverAuthorityExceeded: {
    code: OperatorErrorCode.OPERATOR_APPROVER_AUTHORITY_EXCEEDED,
    statusCode: 403,
    message: (context?: Record<string, any>) =>
      `Action exceeds the second approver's authority limit` +
      `${context?.code ? ` (${context.code})` : ''}` +
      `${context?.limit ? ` of ${context.limit}` : ''}` +
      `${context?.requested ? `, requested ${context.requested}` : ''}`,
  },
});
