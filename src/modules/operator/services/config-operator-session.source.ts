import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { OperatorRepository } from '@database/postgres/repositories/operator.repository';
import { digestToken } from '@shared/crypto/token-digest';

import { OperatorRole } from '../domain/override-register';
import { OperatorErrors } from '../errors/operator.errors';
import { OperatorSession, OperatorSessionPort } from '../ports/operator-session.port';

/**
 * Operator credentials, from configuration.
 *
 * Mirrors `ConfigMcpSessionSource` — a token file standing in for an SSO
 * issuer that does not exist yet — and reuses its exact technique: SHA-256
 * digest indexing at construction, constant-time scan at request time, a
 * missing env var meaning an empty snapshot, and a malformed file throwing at
 * boot rather than degrading into "nothing configured".
 *
 * ## Where this class stops being that pattern
 *
 * `ConfigMcpSessionSource` reads the *whole* session out of its file, because
 * an agent's organization and account never change without a new credential
 * being issued. An operator's authority does change without a new
 * credential — that is the entire point of the revocation story: at
 * 03:00, when a laptop is reported stolen, the fix must be "flip a status
 * column", not "SSH to a box and edit a file". So this file maps a token to
 * nothing but a `subject`, and every other fact about the caller — roles,
 * spend ceiling, whether they are still allowed in at all — is read from the
 * `operators` table **on every resolve**, never cached here. The secret and
 * the authority live in different places, controlled by different people,
 * so that revoking one never requires touching the other.
 */
export const OPERATOR_CREDENTIAL_SNAPSHOT = 'OPERATOR_CREDENTIAL_SNAPSHOT';

/** One configured credential. The token is the map key and is never stored here. */
export interface OperatorCredentialRecord {
  readonly subject: string;
}

/** `token → { subject }`. Empty by default: no token is valid until one is configured. */
export type OperatorCredentialSnapshot = Readonly<Record<string, OperatorCredentialRecord>>;

export const EMPTY_OPERATOR_CREDENTIALS: OperatorCredentialSnapshot = Object.freeze({});

/**
 * Load the snapshot named by `OPERATOR_CREDENTIALS_FILE`, or nothing.
 *
 * Read once, at boot, from a file rather than an environment variable holding
 * JSON — a token in the environment is a token in `ps`, in a crash dump and
 * in every child process the API spawns.
 *
 * A missing variable yields an empty snapshot, which refuses every request. A
 * variable naming an unreadable or malformed file **throws at boot**: the two
 * failures look identical to a caller (`OPERATOR_CREDENTIAL_INVALID` either
 * way) and are opposite for an operator, so "you configured this and it did
 * not load" must not degrade quietly into "nothing is configured".
 */
export function loadOperatorCredentials(
  path = process.env.OPERATOR_CREDENTIALS_FILE,
): OperatorCredentialSnapshot {
  if (!path) return EMPTY_OPERATOR_CREDENTIALS;

  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `OPERATOR_CREDENTIALS_FILE (${path}) must contain a JSON object of token → { subject }`,
    );
  }

  return Object.freeze(parsed as OperatorCredentialSnapshot);
}

@Injectable()
export class ConfigOperatorSessionSource implements OperatorSessionPort {
  private readonly logger = new Logger(ConfigOperatorSessionSource.name);

  /**
   * Tokens are indexed by digest, not by value — same reasoning as
   * `ConfigMcpSessionSource.byDigest`: a plain lookup is a hash-table probe
   * on the secret, and the snapshot object would keep every token in memory
   * as an enumerable property.
   */
  private readonly byDigest: ReadonlyMap<string, OperatorCredentialRecord>;

  constructor(
    @Inject(OPERATOR_CREDENTIAL_SNAPSHOT) snapshot: OperatorCredentialSnapshot,
    private readonly operators: OperatorRepository,
  ) {
    this.byDigest = new Map(
      Object.entries(snapshot).map(([token, record]) => [digestToken(token), record]),
    );
  }

  async resolve(bearerToken: string | null): Promise<OperatorSession> {
    if (!bearerToken) {
      throw OperatorErrors.credentialInvalid();
    }

    const record = this.find(digestToken(bearerToken));
    if (!record) {
      throw OperatorErrors.credentialInvalid();
    }

    // The authority, read fresh — never from the token file. A subject the
    // file names but the table has never provisioned is refused exactly like
    // an unknown token; the two must be indistinguishable from outside.
    const operator = await this.operators.findActiveBySubject(record.subject);
    if (!operator) {
      throw OperatorErrors.credentialInvalid();
    }
    if (operator.status === 'SUSPENDED') {
      throw OperatorErrors.suspended({ subject: operator.subject });
    }

    // Fire-and-forget: `last_seen_at` is observability ("read tools
    // are audited too"), not authorization. A stale value authorises
    // nothing, so a failed stamp must never turn into a failed request —
    // that would make the audit trail load-bearing for access, which is
    // exactly backwards.
    this.stampLastSeen(operator.id);

    return {
      operatorId: operator.id,
      subject: operator.subject,
      displayName: operator.displayName,
      email: operator.email,
      roles: operator.roles as OperatorRole[],
      authorityLimitMinor: operator.authorityLimitMinor,
    };
  }

  private stampLastSeen(operatorId: string): void {
    this.operators.update({ id: operatorId }, { lastSeenAt: new Date() }).catch((error) => {
      this.logger.warn(`failed to stamp last_seen_at for operator ${operatorId}: ${error}`);
    });
  }

  /**
   * Constant-time over the *digest*, then a map lookup — same technique as
   * `ConfigMcpSessionSource.find`: every configured digest is compared
   * before answering, so timing does not depend on which credential matched
   * or how far down the list it is.
   */
  private find(candidate: string): OperatorCredentialRecord | null {
    const probe = Buffer.from(candidate, 'hex');
    let match: OperatorCredentialRecord | null = null;

    for (const [known, record] of this.byDigest) {
      if (timingSafeEqual(Buffer.from(known, 'hex'), probe)) match = record;
    }

    return match;
  }
}
