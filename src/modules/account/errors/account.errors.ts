import { AssertDomainErrorCodes, createDomainErrorFactory } from '@shared/errors/error-catalog';

/**
 * `ACCOUNT_*` — the buyer-side account surface: notifications, the
 * audit log, agents, and agent credentials.
 *
 * The audit log has no write endpoint (it is append-only, read through this
 * module only). Listing under an unrecognised `agentId` is a filter that
 * matches nothing; minting a credential for one is a 404.
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
   * the proof. A person's session has no credential of its own to bind.
   */
  delegateBindingAgentOnly: {
    code: AccountErrorCode.ACCOUNT_DELEGATE_BINDING_AGENT_ONLY,
    statusCode: 403,
    message: () =>
      `Only an agent credential can bind a delegate key — call this with the agent's own token`,
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
});
