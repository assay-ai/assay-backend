import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Inject, Injectable } from '@nestjs/common';

import { AccountId, ChainId } from '@modules/chains/ports/caip.types';
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
}

/** `token → credential`. Empty by default: no token is valid until one is configured. */
export type McpCredentialSnapshot = Readonly<Record<string, McpCredentialRecord>>;

export const EMPTY_MCP_CREDENTIALS: McpCredentialSnapshot = Object.freeze({});

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
 */
export function loadMcpCredentials(path = process.env.MCP_CREDENTIALS_FILE): McpCredentialSnapshot {
  if (!path) return EMPTY_MCP_CREDENTIALS;

  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`MCP_CREDENTIALS_FILE (${path}) must contain a JSON object of token → record`);
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

    return Promise.resolve({
      credentialId: record.credentialId,
      organizationId: record.organizationId,
      agentId: record.agentId,
      agentAccount: record.agentAccount,
      chainId: record.chainId,
      label: record.label ?? null,
      callerKind: McpCallerKind.CONFIG,
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
