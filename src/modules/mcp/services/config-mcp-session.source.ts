import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Inject, Injectable } from '@nestjs/common';

import { AccountId, ChainId } from '@modules/chains/ports/caip.types';
import { AgentScope, DEFAULT_AGENT_SCOPES, isAgentScope } from '@shared/auth/agent-scope';
import { digestToken } from '@shared/crypto/token-digest';

import { McpErrors } from '../errors/mcp.errors';
import { McpCallerKind, McpSession, McpSessionPort } from '../ports/mcp-session.port';

/**
 * MCP credentials, from configuration.
 *
 * A stand-in for Privy-issued session tokens, and for the
 * `mcp_credentials` table that goes with them. It exists because the MCP server has to
 * know *whose* balance a tool call spends before either of those is built, not
 * because a JSON file is a reasonable place to keep credentials.
 *
 * Replaced wholesale once tokens are issued rather than configured. Nothing
 * depends on this class; the server depends on {@link McpSessionPort}.
 */
export const MCP_CREDENTIAL_SNAPSHOT = 'MCP_CREDENTIAL_SNAPSHOT';

/** One configured credential. The token is the map key and is never stored here. */
export interface McpCredentialRecord {
  readonly credentialId: string;
  readonly organizationId: string;
  readonly agentId: string;
  readonly agentAccount: AccountId;
  readonly chainId: ChainId;
  readonly label?: string;
  /**
   * `"human"` when a person uses this token, as the local stack's dashboard
   * logins do. Anything else resolves as a machine (`AGENT`): an agent process
   * handed a config token is not a person, and a file that forgets to say is
   * trusted as little as possible (review A-2).
   */
  readonly kind?: 'human';
  /**
   * A machine token's scopes (`AgentScope`), as an API key's. Omitted: the
   * new-key default (`tools:call payments activity:read`). Not read for a
   * person's token.
   */
  readonly scopes?: readonly AgentScope[];
}

/** `token → credential`. Empty by default: no token is valid until one is configured. */
export type McpCredentialSnapshot = Readonly<Record<string, McpCredentialRecord>>;

export const EMPTY_MCP_CREDENTIALS: McpCredentialSnapshot = Object.freeze({});

/** Shorter than this is a guessable demo string, not a credential (same rule as the operator file). */
export const MIN_CONFIG_TOKEN_LENGTH = 32;

/** The stacks the committed demo file, whose tokens are short, is for. */
const DEVELOPMENT_ENVIRONMENTS: ReadonlySet<string> = new Set(['development', 'local', 'test']);

/**
 * Load the snapshot named by `MCP_CREDENTIALS_FILE`, or nothing.
 *
 * Read once, at boot, and read from a file rather than from an environment
 * variable holding JSON — a token in the environment is a token in `ps`, in a
 * crash dump and in every child process the API spawns.
 *
 * A missing variable yields an empty snapshot, which refuses every request. A
 * variable that names an unreadable or malformed file **throws at boot**: the
 * two failures look identical to a caller (`MCP_CREDENTIAL_INVALID` for
 * everyone) and are opposite for an operator, so the one that means "you
 * configured this and it did not load" must not degrade quietly into the one
 * that means "nothing is configured".
 *
 * **Never in production, and weak tokens only in development** (review A-2).
 * The seed file is committed to git and its tokens are short readable
 * strings, so a deployment that loaded it would hand every reader of the
 * repository a session. `NODE_ENV=production` refuses any credentials file at
 * boot; any other environment outside development refuses a token shorter
 * than {@link MIN_CONFIG_TOKEN_LENGTH}.
 */
export function loadMcpCredentials(
  path = process.env.MCP_CREDENTIALS_FILE,
  nodeEnv = process.env.NODE_ENV,
): McpCredentialSnapshot {
  if (!path) return EMPTY_MCP_CREDENTIALS;

  if (nodeEnv === 'production') {
    throw new Error(
      `MCP_CREDENTIALS_FILE (${path}) is refused when NODE_ENV=production: ` +
        'config credentials are for development stacks only',
    );
  }

  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`MCP_CREDENTIALS_FILE (${path}) must contain a JSON object of token → record`);
  }

  const records = Object.entries(parsed as Record<string, { kind?: unknown } | null>);
  // Neither message names the token: it is the secret.
  if (
    !DEVELOPMENT_ENVIRONMENTS.has(nodeEnv ?? '') &&
    records.some(([token]) => token.length < MIN_CONFIG_TOKEN_LENGTH)
  ) {
    throw new Error(
      `MCP_CREDENTIALS_FILE (${path}) holds a token shorter than ${MIN_CONFIG_TOKEN_LENGTH} ` +
        `characters, which only a development stack accepts (NODE_ENV=${nodeEnv ?? 'unset'})`,
    );
  }
  const badKind = records.find(
    ([, record]) => record?.kind !== undefined && record.kind !== 'human',
  );
  if (badKind) {
    throw new Error(
      `MCP_CREDENTIALS_FILE (${path}): credential ${JSON.stringify(
        (badKind[1] as { credentialId?: unknown }).credentialId ?? null,
      )} has kind ${JSON.stringify(badKind[1]?.kind)}; the only kind is "human"`,
    );
  }

  const badScopes = records.find(([, record]) => {
    const scopes = (record as { scopes?: unknown } | null)?.scopes;
    return scopes !== undefined && !(Array.isArray(scopes) && scopes.every(isAgentScope));
  });
  if (badScopes) {
    throw new Error(
      `MCP_CREDENTIALS_FILE (${path}): credential ${JSON.stringify(
        (badScopes[1] as { credentialId?: unknown }).credentialId ?? null,
      )} has scopes outside the vocabulary`,
    );
  }

  // The same rule as a new key (`ACCOUNT_CREDENTIAL_SCOPES_INVALID`): a key
  // that may pay must be able to call the tool it pays for.
  const paysWithoutCalling = records.find(([, record]) => {
    const scopes = (record as { scopes?: readonly string[] } | null)?.scopes;
    return (
      scopes !== undefined &&
      scopes.includes(AgentScope.PAYMENTS) &&
      !scopes.includes(AgentScope.TOOLS_CALL)
    );
  });
  if (paysWithoutCalling) {
    throw new Error(
      `MCP_CREDENTIALS_FILE (${path}): credential ${JSON.stringify(
        (paysWithoutCalling[1] as { credentialId?: unknown }).credentialId ?? null,
      )} has payments without tools:call`,
    );
  }

  return Object.freeze(parsed as McpCredentialSnapshot);
}

@Injectable()
export class ConfigMcpSessionSource implements McpSessionPort {
  /**
   * Tokens are indexed by digest, not by value.
   *
   * A plain `Record` lookup is a hash-table probe on the secret, and the
   * snapshot object would keep every token in memory as an enumerable property
   * — one `JSON.stringify` of the wrong object away from a log line. Digesting
   * both sides means the comparison is over fixed-width values and the tokens
   * themselves are only ever held by the configuration loader.
   */
  private readonly byDigest: ReadonlyMap<string, McpCredentialRecord>;

  constructor(@Inject(MCP_CREDENTIAL_SNAPSHOT) snapshot: McpCredentialSnapshot) {
    this.byDigest = new Map(
      Object.entries(snapshot).map(([token, record]) => [digestToken(token), record]),
    );
  }

  resolve(bearerToken: string | null): Promise<McpSession> {
    if (!bearerToken) {
      throw McpErrors.credentialInvalid();
    }

    const record = this.find(digestToken(bearerToken));
    if (!record) {
      throw McpErrors.credentialInvalid();
    }

    const scopes = record.kind === 'human' ? undefined : (record.scopes ?? DEFAULT_AGENT_SCOPES);
    return Promise.resolve({
      credentialId: record.credentialId,
      organizationId: record.organizationId,
      agentId: record.agentId,
      agentAccount: record.agentAccount,
      chainId: record.chainId,
      label: record.label ?? null,
      // A person only when the record says so — see `McpCredentialRecord.kind`.
      callerKind: record.kind === 'human' ? McpCallerKind.CONFIG : McpCallerKind.AGENT,
      paymentsAllowed: scopes === undefined || scopes.includes(AgentScope.PAYMENTS),
      ...(scopes ? { scopes } : {}),
      ...(scopes && !scopes.includes(AgentScope.PAYMENTS) ? { paymentsScopeMissing: true } : {}),
    });
  }

  /**
   * Constant-time over the *digest*, then a map lookup.
   *
   * The scan compares every configured digest before answering, so the time
   * taken does not depend on which credential matched or on how far down the
   * list it is. It is cheap — the credential list is small by construction, and
   * this is one comparison per request, not per byte.
   */
  private find(candidate: string): McpCredentialRecord | null {
    const probe = Buffer.from(candidate, 'hex');
    let match: McpCredentialRecord | null = null;

    for (const [known, record] of this.byDigest) {
      if (timingSafeEqual(Buffer.from(known, 'hex'), probe)) match = record;
    }

    return match;
  }
}
