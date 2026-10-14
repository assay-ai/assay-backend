import { OperatorRole } from '../domain/override-register';

/**
 * Who is calling, resolved from the operator's sign-in session.
 *
 * Mirrors `McpSession` deliberately: an authenticated route reads *who* off a
 * resolved session and never off the request body. The one thing this session
 * carries that `McpSession` does not is `roles` — `McpSessionPort` answers
 * "which balance", this port answers "which of the register's rows".
 */
export interface OperatorSession {
  readonly operatorId: string;

  /** A short handle, e.g. `dan@`. Rendered verbatim in the override log. */
  readonly subject: string;

  readonly displayName: string;
  readonly email: string;

  /** The EVM address the operator signed in with, lower-case. */
  readonly walletAddress?: string | null;

  /** The operator's roles, as held **right now** — read from `operators`, not from the session. */
  readonly roles: readonly OperatorRole[];

  /**
   * Per-action ceiling, minor units of the platform asset. `null` means
   * unbounded — correct for roles whose actions move no money, and not a
   * missing value.
   */
  readonly authorityLimitMinor: string | null;
}

/**
 * The second person of a two-person action.
 *
 * Only `OperatorApprovalService` makes one: it is the session of the operator
 * who approved a queued action with their own sign-in, carrying the id of the
 * approval it approves. `OverrideLogService.perform` marks that approval
 * `APPROVED` in the action's own transaction. Typing the approver this way is
 * what keeps a plain session — somebody else's, passed along — from standing
 * in for a second person.
 */
export interface OperatorApprover extends OperatorSession {
  readonly approvalId: string;
}

/**
 * Resolve an operator session token, or refuse.
 *
 * **Fails closed by throwing**, the same contract as `McpSessionPort`: there
 * is no "anonymous operator" branch. A missing, unknown, expired or revoked
 * token is `OPERATOR_CREDENTIAL_INVALID` (401); a live session whose operator
 * is no longer active is `OPERATOR_NOT_AUTHORIZED` (403).
 */
export interface OperatorSessionPort {
  resolve(bearerToken: string | null): Promise<OperatorSession>;
}

/** DI token for the bound {@link OperatorSessionPort}. */
export const OPERATOR_SESSION_SOURCE = 'OPERATOR_SESSION_SOURCE';
