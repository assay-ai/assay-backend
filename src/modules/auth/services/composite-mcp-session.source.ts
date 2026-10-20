import { McpErrorCode, McpErrors } from '@modules/mcp/errors/mcp.errors';
import { McpSession, McpSessionPort } from '@modules/mcp/ports/mcp-session.port';
import {
  McpUnauthorizedReason,
  unauthorizedReasonOf,
} from '@modules/mcp/ports/mcp-unauthorized.port';
import { BaseError } from '@shared/errors/base.error';

import { SessionSourceMode } from '../domain/session-source-mode';

/**
 * Two issuers, one port.
 *
 * A deployment that has real Privy users and still runs the demo seed needs
 * both kinds of bearer token to work at once — every unit test, every local
 * stack and `yarn demo:seed` present a token from `MCP_CREDENTIALS_FILE`, and
 * deleting that on the day login ships would be a migration disguised as a
 * feature. Which issuers are trusted is `AUTH_SESSION_SOURCE`; this class is
 * how "more than one" is expressed without any *caller* learning that there is
 * more than one.
 *
 * ## Only "not my token" moves to the next source
 *
 * A source that raises `MCP_CREDENTIAL_INVALID` is saying *"I do not recognise
 * this credential"* — the next source gets a turn. **Anything else propagates
 * immediately**, unexamined:
 *
 * - `AUTH_WALLET_NOT_LINKED` and `AUTH_*_SUSPENDED` are facts about a caller
 *   who was successfully identified. Letting the next source have a go would
 *   turn a precise 424/403 into a generic 401 and send the user
 *   re-authenticating against a problem their token cannot fix.
 * - `AUTH_IDENTITY_PROVIDER_UNAVAILABLE` is the fail-closed branch. Swallowing
 *   it into "try the next one, then 401" would report an outage as a wave of
 *   invalid credentials, which is exactly the wrong page at 03:00.
 *
 * ## The final answer is the generic one
 *
 * When every source declines, the error raised is a fresh
 * `MCP_CREDENTIAL_INVALID` rather than the last source's — identical whichever
 * issuer was tried last, and identical to what a single-source deployment
 * raises. An unauthenticated caller learns nothing about which issuers this
 * deployment trusts.
 */
export class CompositeMcpSessionSource implements McpSessionPort {
  constructor(private readonly sources: readonly McpSessionPort[]) {}

  async resolve(bearerToken: string | null): Promise<McpSession> {
    // The private 401 reason a source gave (only the OAuth source gives one),
    // kept for the metric; the refusal itself is the same either way.
    let reason: McpUnauthorizedReason | null = null;
    for (const source of this.sources) {
      try {
        return await source.resolve(bearerToken);
      } catch (error) {
        if (!isUnrecognisedCredential(error)) {
          throw error;
        }
        reason = unauthorizedReasonOf(error) ?? reason;
      }
    }

    throw reason
      ? McpErrors.credentialInvalid({ unauthorizedReason: reason })
      : McpErrors.credentialInvalid();
  }
}

function isUnrecognisedCredential(error: unknown): boolean {
  return error instanceof BaseError && error.errorCode === McpErrorCode.MCP_CREDENTIAL_INVALID;
}

/**
 * Binds `AUTH_SESSION_SOURCE` to an actual implementation.
 *
 * Lives here rather than in `mcp.module.ts` so that the mode's behaviour is
 * testable without a Nest container, and so the wiring line stays one call.
 *
 * There is no branch that returns "no source": an unrecognised mode is already
 * refused at boot by `auth.config.ts`, and `parseSessionSourceMode` turns a
 * missing one into `config`. A misconfiguration must never be able to produce
 * a port that lets everyone through — but note that it *can* produce one that
 * lets nobody through (an empty credential file), which is the correct
 * direction for that failure.
 */
export function createSessionSource(
  mode: SessionSourceMode,
  sources: {
    readonly config: McpSessionPort;
    readonly db: McpSessionPort;
    /** OAuth access tokens: `both` only, because consent needs the Privy source. */
    readonly oauth: McpSessionPort;
    readonly privy: McpSessionPort;
  },
): McpSessionPort {
  switch (mode) {
    case SessionSourceMode.PRIVY:
      return sources.privy;
    case SessionSourceMode.DB:
      return sources.db;
    case SessionSourceMode.BOTH:
      // The API-key and OAuth sources refuse a token of another shape before
      // any read, so each token reaches its own source and a Privy JWT the last.
      return new CompositeMcpSessionSource([
        sources.config,
        sources.db,
        sources.oauth,
        sources.privy,
      ]);
    case SessionSourceMode.CONFIG:
    default:
      return sources.config;
  }
}
