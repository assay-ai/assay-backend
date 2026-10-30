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
  OPERATOR_AUTH_RATE_LIMITED = 'OPERATOR_AUTH_RATE_LIMITED',
  OPERATOR_NOT_AUTHORIZED = 'OPERATOR_NOT_AUTHORIZED',
  OPERATOR_ROLE_REQUIRED = 'OPERATOR_ROLE_REQUIRED',
  OPERATOR_NOT_FOUND = 'OPERATOR_NOT_FOUND',
  OPERATOR_AUTHORITY_EXCEEDED = 'OPERATOR_AUTHORITY_EXCEEDED',
  OPERATOR_SELF_APPROVAL_REFUSED = 'OPERATOR_SELF_APPROVAL_REFUSED',
  OPERATOR_UNKNOWN_OVERRIDE_CODE = 'OPERATOR_UNKNOWN_OVERRIDE_CODE',
  OPERATOR_OVERRIDE_NOT_IMPLEMENTED = 'OPERATOR_OVERRIDE_NOT_IMPLEMENTED',
  OPERATOR_SECOND_APPROVER_REQUIRED = 'OPERATOR_SECOND_APPROVER_REQUIRED',
  OPERATOR_APPROVER_ROLE_REQUIRED = 'OPERATOR_APPROVER_ROLE_REQUIRED',
  OPERATOR_APPROVER_AUTHORITY_EXCEEDED = 'OPERATOR_APPROVER_AUTHORITY_EXCEEDED',
  OPERATOR_BLOCK_SUBJECT_INVALID = 'OPERATOR_BLOCK_SUBJECT_INVALID',
  OPERATOR_BLOCK_NOT_FOUND = 'OPERATOR_BLOCK_NOT_FOUND',
  OPERATOR_BLOCK_ALREADY_ACTIVE = 'OPERATOR_BLOCK_ALREADY_ACTIVE',
  OPERATOR_BLOCK_ALREADY_LIFTED = 'OPERATOR_BLOCK_ALREADY_LIFTED',
  OPERATOR_WALLET_INVALID = 'OPERATOR_WALLET_INVALID',
  OPERATOR_ALREADY_EXISTS = 'OPERATOR_ALREADY_EXISTS',
  OPERATOR_SELF_CHANGE_REFUSED = 'OPERATOR_SELF_CHANGE_REFUSED',
  OPERATOR_CHANGE_EMPTY = 'OPERATOR_CHANGE_EMPTY',
  OPERATOR_APPROVAL_NOT_FOUND = 'OPERATOR_APPROVAL_NOT_FOUND',
  OPERATOR_APPROVAL_NOT_PENDING = 'OPERATOR_APPROVAL_NOT_PENDING',
  OPERATOR_APPROVAL_NOT_APPROVED = 'OPERATOR_APPROVAL_NOT_APPROVED',
  OPERATOR_APPROVAL_PAYLOAD_MISMATCH = 'OPERATOR_APPROVAL_PAYLOAD_MISMATCH',
  OPERATOR_APPROVAL_CALL_STALE = 'OPERATOR_APPROVAL_CALL_STALE',
  OPERATOR_DEBT_VOID_INVALID = 'OPERATOR_DEBT_VOID_INVALID',
}

export type OperatorErrorCodesArePrefixed = AssertDomainErrorCodes<
  'OPERATOR',
  `${OperatorErrorCode}`
>;

export const OperatorErrors = createDomainErrorFactory('OPERATOR', {
  /**
   * No usable operator credential: a missing or unknown session token, an
   * expired or revoked session, or a sign-in message whose signature, nonce,
   * domain, chain or expiry does not check out. Deliberately one code, so a
   * caller cannot tell which check failed. Counted by `OperatorAuthThrottle`.
   */
  credentialInvalid: {
    code: OperatorErrorCode.OPERATOR_CREDENTIAL_INVALID,
    statusCode: 401,
    message: () => 'Operator credential invalid',
  },
  /**
   * Too many failed sign-ins or refused session tokens from one address or
   * for one wallet. Raised before anything presented is looked at.
   */
  authRateLimited: {
    code: OperatorErrorCode.OPERATOR_AUTH_RATE_LIMITED,
    statusCode: 429,
    message: () => 'Too many failed operator sign-in attempts. Try again later.',
  },
  /**
   * The wallet signed correctly but is not an active operator: unknown,
   * suspended or removed. One code for all three, so the console cannot be
   * used to learn which wallets were ever operators.
   */
  notAuthorized: {
    code: OperatorErrorCode.OPERATOR_NOT_AUTHORIZED,
    statusCode: 403,
    message: () => 'This wallet is not an active operator',
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
  // ── A-9 / A-10 · The account blocklist ──

  /** Not a uuid for an organization, or not a CAIP-10 account for a wallet. */
  blockSubjectInvalid: {
    code: OperatorErrorCode.OPERATOR_BLOCK_SUBJECT_INVALID,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Not a valid ${context?.subjectKind === 'WALLET' ? 'CAIP-10 account' : 'organization id'}` +
      `${context?.subject ? `: ${context.subject}` : ''}`,
  },
  blockNotFound: {
    code: OperatorErrorCode.OPERATOR_BLOCK_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `No block${context?.blockId ? ` with id ${context.blockId}` : ''}`,
  },
  /** One standing block per subject. The existing one is named so it can be read. */
  blockAlreadyActive: {
    code: OperatorErrorCode.OPERATOR_BLOCK_ALREADY_ACTIVE,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `This subject is already blocked${context?.blockId ? ` (block ${context.blockId})` : ''}`,
  },
  blockAlreadyLifted: {
    code: OperatorErrorCode.OPERATOR_BLOCK_ALREADY_LIFTED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `This block was already lifted${context?.unblockedAt ? ` at ${context.unblockedAt}` : ''}`,
  },

  // ── A-12 / A-13 / A-14 · The operator directory ──

  /** Not a `0x` + 40 hex EVM address. */
  walletInvalid: {
    code: OperatorErrorCode.OPERATOR_WALLET_INVALID,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Not a valid EVM address${context?.address ? `: ${context.address}` : ''}`,
  },
  /** The wallet or the subject already names an operator. */
  alreadyExists: {
    code: OperatorErrorCode.OPERATOR_ALREADY_EXISTS,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `An operator with this ${context?.field ?? 'identity'} already exists`,
  },
  /** Nobody changes or removes their own row, nor approves a change to it. */
  selfChangeRefused: {
    code: OperatorErrorCode.OPERATOR_SELF_CHANGE_REFUSED,
    statusCode: 403,
    message: () => 'An operator cannot change, remove or approve a change to their own access',
  },
  /** A change request that names neither roles nor a limit, or changes nothing. */
  changeEmpty: {
    code: OperatorErrorCode.OPERATOR_CHANGE_EMPTY,
    statusCode: 400,
    message: () => 'The change does not alter the operator’s roles or authority limit',
  },

  // ── The approvals queue ──

  approvalNotFound: {
    code: OperatorErrorCode.OPERATOR_APPROVAL_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `No approval${context?.approvalId ? ` with id ${context.approvalId}` : ''}`,
  },
  /** Already approved, rejected or expired — or it expired just now. */
  approvalNotPending: {
    code: OperatorErrorCode.OPERATOR_APPROVAL_NOT_PENDING,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `This approval is no longer pending${context?.status ? ` (${context.status})` : ''}`,
  },
  /** Review N-5: the approved action's result was asked for, but it is not an approved one. */
  approvalNotApproved: {
    code: OperatorErrorCode.OPERATOR_APPROVAL_NOT_APPROVED,
    statusCode: 409,
    publicContext: ['status', 'action'],
    message: (context?: Record<string, any>) =>
      `This approval is not an approved ${context?.expected ?? 'action'}` +
      `${context?.status ? ` (${context.status} ${context?.action ?? ''})`.trimEnd() : ''}`,
  },
  /**
   * Review R2-7: an approved action's result is no longer handed out again —
   * the approval is older than the approvals' expiry, or what it approved was
   * already carried out and later undone. A fresh request is needed.
   */
  approvalCallStale: {
    code: OperatorErrorCode.OPERATOR_APPROVAL_CALL_STALE,
    statusCode: 409,
    publicContext: ['reason'],
    message: (context?: Record<string, any>) =>
      `This approval's call is no longer handed out${context?.reason ? `: ${context.reason}` : ''}` +
      '. Request the action again',
  },
  /** The stored payload no longer matches its hash. A platform fault, never a caller's. */
  approvalPayloadMismatch: {
    code: OperatorErrorCode.OPERATOR_APPROVAL_PAYLOAD_MISMATCH,
    statusCode: 500,
    message: () => 'The stored approval payload does not match its hash',
  },

  // ── M-1 · Bulk void of buyer debts ──

  /**
   * A bulk void request that cannot be queued as asked: an id that is not an
   * open buyer debt now, or ids of more than one asset (one request pins one
   * asset's total). `intentIds` names the offending ids, so the console can
   * drop them and ask again.
   */
  debtVoidInvalid: {
    code: OperatorErrorCode.OPERATOR_DEBT_VOID_INVALID,
    statusCode: 400,
    publicContext: ['detail', 'intentIds'],
    message: (context?: Record<string, any>) =>
      `The bulk void cannot be requested${context?.detail ? `: ${context.detail}` : ''}`,
  },
});
