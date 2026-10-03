import { OperatorRole } from '../domain/override-register';

/**
 * Who is holding the token, resolved from the bearer credential.
 *
 * Mirrors {@link McpSession} deliberately: an authenticated route reads
 * *who* off a resolved session and never off the request body, and that
 * discipline should not have a different shape for an operator than it has
 * for an agent. The one thing this session carries that `McpSession` does
 * not is `roles` — `McpSessionPort` answers "which balance", this port
 * answers "which of the register's rows".
 */
export interface OperatorSession {
  readonly operatorId: string;

  /** The SSO subject, e.g. `dan@`. Rendered verbatim in the override log. */
  readonly subject: string;

  readonly displayName: string;
  readonly email: string;

  /** The operator's roles, as held **right now** — read from `operators`, not from the token. */
  readonly roles: readonly OperatorRole[];

  /**
   * Per-action ceiling, minor units of the platform asset. `null` means
   * unbounded — correct for roles whose actions move no money, and not a
   * missing value.
   */
  readonly authorityLimitMinor: string | null;
}

/**
 * Resolve a bearer token, or refuse.
 *
 * **Fails closed by throwing**, the same contract as `McpSessionPort`: there
 * is no "anonymous operator" branch, so no caller can mistake an
 * unauthenticated request for a cheap one and let it reach a code path that
 * decides a case or moves money. A missing token, an unknown token and a
 * suspended operator are all refusals — which one is thrown differs (see
 * `ConfigOperatorSessionSource`), but none of them ever returns.
 */
export interface OperatorSessionPort {
  resolve(bearerToken: string | null): Promise<OperatorSession>;
}

/** DI token for the bound {@link OperatorSessionPort}. */
export const OPERATOR_SESSION_SOURCE = 'OPERATOR_SESSION_SOURCE';
