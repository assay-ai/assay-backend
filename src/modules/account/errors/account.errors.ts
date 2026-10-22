import { AssertDomainErrorCodes, createDomainErrorFactory } from '@shared/errors/error-catalog';

/**
 * `ACCOUNT_*` — the buyer-side account surface: notifications, the
 * audit log, agents, and agent credentials.
 *
 * The audit log has no write endpoint (it is append-only, read through this
 * module only). Listing or minting credentials under an unrecognised
 * `agentId` is a 404.
 */
export enum AccountErrorCode {
  ACCOUNT_NOTIFICATION_NOT_FOUND = 'ACCOUNT_NOTIFICATION_NOT_FOUND',
  ACCOUNT_CREDENTIAL_NOT_FOUND = 'ACCOUNT_CREDENTIAL_NOT_FOUND',
  ACCOUNT_AGENT_NOT_FOUND = 'ACCOUNT_AGENT_NOT_FOUND',
  // ── Agent payment delegation: binding a credential to its delegate key ──
  ACCOUNT_DELEGATE_BINDING_AGENT_ONLY = 'ACCOUNT_DELEGATE_BINDING_AGENT_ONLY',
  ACCOUNT_DELEGATE_BINDING_UNSUPPORTED = 'ACCOUNT_DELEGATE_BINDING_UNSUPPORTED',
  ACCOUNT_DELEGATE_CHALLENGE_INVALID = 'ACCOUNT_DELEGATE_CHALLENGE_INVALID',
  ACCOUNT_DELEGATE_SIGNATURE_INVALID = 'ACCOUNT_DELEGATE_SIGNATURE_INVALID',
  ACCOUNT_DELEGATE_ALREADY_BOUND = 'ACCOUNT_DELEGATE_ALREADY_BOUND',
  ACCOUNT_DELEGATE_CLIENT_NOT_ALLOWED = 'ACCOUNT_DELEGATE_CLIENT_NOT_ALLOWED',
  ACCOUNT_CREDENTIAL_SCOPES_INVALID = 'ACCOUNT_CREDENTIAL_SCOPES_INVALID',
  ACCOUNT_CREDENTIAL_EXPIRY_INVALID = 'ACCOUNT_CREDENTIAL_EXPIRY_INVALID',
  // ── The account blocklist ──
  ACCOUNT_BLOCKED = 'ACCOUNT_BLOCKED',
}

export type AccountErrorCodesArePrefixed = AssertDomainErrorCodes<'ACCOUNT', `${AccountErrorCode}`>;

export const AccountErrors = createDomainErrorFactory('ACCOUNT', {
  /** Cross-organization id, or no such row at all — the two are indistinguishable on purpose. */
  notificationNotFound: {
    code: AccountErrorCode.ACCOUNT_NOTIFICATION_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `Notification not found${context?.id ? ` with id: ${context.id}` : ''}`,
  },
  /**
   * Also raised when the credential exists but under a different `agentId`
   * than the one in the route — a routing mismatch is not a 403, it is "no
   * such credential under this agent", which is a 404 for the same reason a
   * cross-organization id is.
   */
  credentialNotFound: {
    code: AccountErrorCode.ACCOUNT_CREDENTIAL_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `Agent credential not found${context?.id ? ` with id: ${context.id}` : ''}`,
  },
  /** No such agent, or one in another organization — indistinguishable on purpose. */
  agentNotFound: {
    code: AccountErrorCode.ACCOUNT_AGENT_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `Agent not found${context?.agentId ? ` with id: ${context.agentId}` : ''}`,
  },
  /**
   * Binding a delegate key is the AGENT's act, with its own credential: the
   * binding is per credential, and only the machine holding the key can sign
   * the proof. A person's session has no credential of its own to bind, and
   * neither has a config-file machine token: no stored credential backs it.
   */
  delegateBindingAgentOnly: {
    code: AccountErrorCode.ACCOUNT_DELEGATE_BINDING_AGENT_ONLY,
    statusCode: 403,
    message: () =>
      `Only an agent credential (assay_sk_live_…) can bind a delegate key — call this with the agent's own token`,
  },
  /** The agent's chain has no voucher delegation (Solana). */
  delegateBindingUnsupported: {
    code: AccountErrorCode.ACCOUNT_DELEGATE_BINDING_UNSUPPORTED,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Voucher delegation is not available on ${context?.chainId ?? 'this chain'}`,
  },
  /** The challenge is unknown, already used, expired, or issued to another credential. */
  delegateChallengeInvalid: {
    code: AccountErrorCode.ACCOUNT_DELEGATE_CHALLENGE_INVALID,
    statusCode: 400,
    message: () =>
      `The delegate challenge is unknown, used, expired or not this credential's — request a new one`,
  },
  /** The signature does not recover to the delegate the challenge names. */
  delegateSignatureInvalid: {
    code: AccountErrorCode.ACCOUNT_DELEGATE_SIGNATURE_INVALID,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `The signature was not made by the delegate key${
        context?.delegate ? ` ${context.delegate}` : ''
      }; nothing was bound`,
  },
  /** `payments` without `tools:call`: a key that may pay must be able to call. */
  credentialScopesInvalid: {
    code: AccountErrorCode.ACCOUNT_CREDENTIAL_SCOPES_INVALID,
    statusCode: 400,
    message: () => 'The payments scope needs the tools:call scope too; nothing was created',
  },
  /** `expiresAt` in the past, or more than the maximum lifetime away. */
  credentialExpiryInvalid: {
    code: AccountErrorCode.ACCOUNT_CREDENTIAL_EXPIRY_INVALID,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `expiresAt must be in the future and at most ${context?.maxDays ?? 365} days from now; ` +
      'nothing was created',
  },
  /**
   * The key is already bound to ANOTHER live agent credential (in any
   * organization). A delegate key belongs to one credential, so what it spent
   * is attributable to one agent and revoking that credential ends it. Which
   * credential holds it is not said: it may be another tenant's.
   */
  delegateAlreadyBound: {
    code: AccountErrorCode.ACCOUNT_DELEGATE_ALREADY_BOUND,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `The delegate key${
        context?.delegate ? ` ${context.delegate}` : ''
      } is already bound to another agent credential; nothing was bound. Revoke that credential, or bind a key of this agent's own`,
  },
  /**
   * An OAuth grant of a client outside `OAUTH_PAYMENT_CLIENTS` asked for a
   * delegate challenge or a bind (R-OA-22). Only API keys and `assay-mcp`
   * grants may bind a payment key (spec §6.3.13, owner decision H2).
   */
  delegateClientNotAllowed: {
    code: AccountErrorCode.ACCOUNT_DELEGATE_CLIENT_NOT_ALLOWED,
    statusCode: 403,
    message: () =>
      'This app cannot bind a payment key; use an API key or the Assay app (assay-mcp)',
  },
  /**
   * A party to this request is on the account blocklist: a wallet that is the
   * payer, payee, delegate or stake authority, or the provider serving the
   * call, or the organization behind the session itself (`ORGANIZATION`:
   * "Your account is blocked by Assay", on the API and the MCP host).
   *
   * 403: the request is well formed and re-authenticating will not help. The
   * response's `error.context.role` names the role (`ORGANIZATION` for the
   * caller's own organization, else `PAYER`, `PAYEE`, `PROVIDER`, `DELEGATE`,
   * `STAKE_AUTHORITY`), so a client tells its own block from another party's
   * without reading the message. Never the reason, which is the platform's
   * internal note, and never the subject kind.
   */
  accountBlocked: {
    code: AccountErrorCode.ACCOUNT_BLOCKED,
    statusCode: 403,
    message: (context?: Record<string, any>) =>
      context?.role === 'ORGANIZATION'
        ? 'Your account is blocked by Assay; contact support'
        : `This account is blocked${context?.role ? ` (${String(context.role).toLowerCase()})` : ''}; ` +
          'contact support',
    publicContext: ['role'],
  },
});
