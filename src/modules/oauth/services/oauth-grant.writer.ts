import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, EntityTarget, IsNull, ObjectLiteral } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import {
  AgentCredentialEntity,
  CredentialIssuedVia,
} from '@database/postgres/entities/agent-credential.entity';
import { OAuthAccessTokenEntity } from '@database/postgres/entities/oauth-access-token.entity';
import { OAuthAuthorizationCodeEntity } from '@database/postgres/entities/oauth-authorization-code.entity';
import {
  OAuthClientEntity,
  OAuthClientKind,
} from '@database/postgres/entities/oauth-client.entity';
import { OAuthRefreshTokenEntity } from '@database/postgres/entities/oauth-refresh-token.entity';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { AuditActor, AuditLogWriter } from '@shared/audit';

import {
  OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  OAUTH_MAX_LIVE_GRANTS_PER_AGENT,
  OAUTH_REFRESH_TOKEN_TTL_SECONDS,
  OAUTH_REVOKED_BY_REFRESH_REUSE,
} from '../constants/oauth.constants';
import { hashOpaqueToken, mint } from '../domain/opaque-token';

/** The actor of audit entries the authorization server writes on its own. */
export const OAUTH_SYSTEM_ACTOR: AuditActor = { type: 'system', id: 'oauth' };

/** `revoked_by` of a grant replaced by a newer approval of the same app (§6.3.10 step 3). */
export const OAUTH_REVOKED_BY_REPLACED = 'system:oauth-replaced';

/** The raw tokens of a new grant. Returned once, never stored. */
export interface IssuedGrantTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}

export type CreateGrantResult =
  | {
      readonly ok: true;
      readonly credentialId: string;
      readonly tokens: IssuedGrantTokens;
      /**
       * A replaced grant's narrowing was copied, or the replaced grant was
       * revoked: the organization's cached access views must be invalidated.
       */
      readonly invalidateAccess: boolean;
    }
  | {
      readonly ok: false;
      /**
       * `code_reused`: a replay of this code was detected before the grant
       * existed, so none is created. `agent_not_active`: the agent is missing,
       * suspended, in a suspended organization, or has no linked wallet.
       */
      readonly reason: 'grant_limit_reached' | 'code_reused' | 'agent_not_active';
    };

export interface RotateRefreshInput {
  /** The presented refresh token's row, as read before the rotation. */
  readonly parent: OAuthRefreshTokenEntity;
  /** The credential's agent: the key of the per-agent advisory lock. */
  readonly agentId: string;
  /**
   * The scope of the new access token: the parent's, or narrower. The child
   * refresh token always keeps the parent's scope (RFC 6749 §6).
   */
  readonly scope: string;
  readonly audience: string;
  /**
   * Runs inside the transaction once the new tokens exist, before commit:
   * the grace entry is stored here, so a racing presentation of the parent,
   * which waits on the parent row until this commits, always finds it.
   */
  readonly beforeCommit: (tokens: IssuedGrantTokens) => Promise<void>;
}

export type RotateRefreshResult =
  | { readonly ok: true; readonly tokens: IssuedGrantTokens }
  | {
      readonly ok: false;
      /**
       * `lost`: the parent was already used, revoked or expired when the
       * compare-and-set ran. `credential_not_live`: the credential was revoked
       * or expired under its row lock; nothing was issued.
       */
      readonly reason: 'lost' | 'credential_not_live';
    };

export interface RefreshReuseInput {
  /** The rotated refresh token presented again, more than 30 s after its use. */
  readonly parent: OAuthRefreshTokenEntity;
  readonly agentId: string;
  /** The public `client_id`, for the audit entry. */
  readonly clientId: string;
}

export type RefreshReuseResult =
  | { readonly outcome: 'revoked'; readonly credentialName: string }
  | { readonly outcome: 'stale' }
  /** The credential was already revoked or expired: nothing to decide. */
  | { readonly outcome: 'not_live' };

export interface RevokeGrantInput {
  readonly organizationId: string;
  readonly credentialId: string;
  /** `agent_credentials.revoked_by`, e.g. `system:oauth-code-reused`. */
  readonly revokedBy: string;
  /**
   * The audit entry written in the same transaction. It is written even when
   * the credential was already revoked (a replayed code is a signal on its
   * own); `before`/`after` then record that nothing changed.
   */
  readonly audit: {
    readonly actor: AuditActor;
    readonly action: string;
    readonly after?: Record<string, unknown>;
  };
}

/**
 * Writes OAuth grants: the `agent_credentials` row an approval turns into, and
 * its first refresh and access tokens (spec §6.3.10 step 3, R-OA-17).
 *
 * A grant is the same row an API key is (owner rule: OAuth = API key): the
 * same limits, narrowing, revocation and audit. It differs only in
 * `issued_via = 'OAUTH'`, an `oauth_client_id`, no token of its own, and an
 * `expires_at` that follows its refresh chain (R-OA-13).
 *
 * The 50-live-grants cap (R-OA-31) is a count-then-insert, so it runs under a
 * per-agent transaction-scoped advisory lock: two exchanges for the same agent
 * serialise on it, and the second one counts the first one's row.
 *
 * Lock order, always: the code row, then the per-agent advisory lock, then
 * credential rows. Task 1.8 (refresh) must keep it, or the two can deadlock.
 */
@Injectable()
export class OAuthGrantWriter {
  constructor(
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    private readonly credentials: AgentCredentialRepository,
    private readonly audit: AuditLogWriter,
  ) {}

  /**
   * Creates the grant `code` was approved for, in one transaction. `code` must
   * already be burned (`used_at` set) and checked by the caller; this sets its
   * `credential_id`, so a second exchange can find and revoke the grant.
   *
   * The code row is locked first: a replay that marked it
   * (`reuse_detected_at`) before this transaction got there stops the grant
   * here; a replay arriving later waits on the row lock until this commits,
   * then sees `credential_id` and revokes the grant (R-OA-6).
   */
  async createGrant(input: {
    readonly code: OAuthAuthorizationCodeEntity;
    readonly client: OAuthClientEntity;
    readonly audience: string;
  }): Promise<CreateGrantResult> {
    const { code, client, audience } = input;
    const { organizationId, agentId } = code;

    let sweep: string | null = null;
    const result = await this.dataSource.transaction(async (manager) => {
      const [codeRow] = (await manager.query(
        `SELECT "reuse_detected_at" FROM "oauth_authorization_codes" WHERE "id" = $1 FOR UPDATE`,
        [code.id],
      )) as { reuse_detected_at: Date | null }[];
      if (!codeRow || codeRow.reuse_detected_at !== null) {
        await this.audit.record(manager, {
          organizationId,
          actor: OAUTH_SYSTEM_ACTOR,
          action: 'oauth.code_reused',
          resourceType: 'agent',
          resourceId: agentId,
          before: null,
          after: { clientId: client.clientId, grantCreated: false },
        });
        return { ok: false, reason: 'code_reused' } as const;
      }

      await this.lockAgent(manager, agentId);

      // Approval checked the agent up to ~11 minutes ago; check it again.
      if (!(await isAgentActive(manager, organizationId, agentId))) {
        return { ok: false, reason: 'agent_not_active' } as const;
      }

      // The transaction's own clock: every expiry below derives from one instant.
      const [{ now }] = (await manager.query(`SELECT now() AS "now"`)) as { now: Date }[];
      const refreshExpiresAt = new Date(now.getTime() + OAUTH_REFRESH_TOKEN_TTL_SECONDS * 1000);
      const accessExpiresAt = new Date(now.getTime() + OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000);

      // A live grant this one replaces is revoked below, so it does not count
      // against the cap: replacing one at the cap succeeds.
      const replaced = await this.findReplaceable(manager, code, client);
      const replacesLive = replaced !== null && isLive(replaced, now);
      const live = await this.credentials.countLiveOAuthForAgent(organizationId, agentId, manager);
      if (live - (replacesLive ? 1 : 0) >= OAUTH_MAX_LIVE_GRANTS_PER_AGENT) {
        return { ok: false, reason: 'grant_limit_reached' } as const;
      }
      if (replaced && replacesLive) {
        await this.revokeInTransaction(manager, organizationId, replaced.id, {
          revokedAt: now,
          revokedBy: OAUTH_REVOKED_BY_REPLACED,
        });
        sweep = replaced.id;
      }

      const scopes: string[] = [];
      const credentialId = await insertReturningId(manager, AgentCredentialEntity, {
        organizationId,
        agentId,
        name: code.credentialName,
        issuedVia: CredentialIssuedVia.OAUTH,
        oauthClientId: client.id,
        prefix: null,
        tokenHash: null,
        scopes,
        expiresAt: refreshExpiresAt,
        accessMode: replaced?.accessMode ?? null,
        allowedToolsets: replaced?.allowedToolsets ?? null,
        allowedToolIds: replaced?.allowedToolIds ?? null,
        createdAt: now,
      });

      const refreshToken = mint('assay_rt_');
      const refreshTokenId = await insertReturningId(manager, OAuthRefreshTokenEntity, {
        organizationId,
        credentialId,
        oauthClientId: client.id,
        tokenHash: hashOpaqueToken(refreshToken),
        parentId: null,
        scope: code.scope,
        expiresAt: refreshExpiresAt,
        usedAt: null,
        revokedAt: null,
        createdAt: now,
      });

      const accessToken = mint('assay_at_');
      await insertReturningId(manager, OAuthAccessTokenEntity, {
        organizationId,
        credentialId,
        refreshTokenId,
        tokenHash: hashOpaqueToken(accessToken),
        scope: code.scope,
        audience,
        expiresAt: accessExpiresAt,
        firstUsedAt: null,
        revokedAt: null,
        createdAt: now,
      });

      await manager.update(OAuthAuthorizationCodeEntity, { id: code.id }, { credentialId });

      // The replaced grant's own trail ends in `credential.revoked`, as an API
      // key's does (R-OA-23).
      if (replaced && replacesLive) {
        await this.audit.record(manager, {
          organizationId,
          actor: { type: 'user', id: code.approvedBy },
          action: 'credential.revoked',
          resourceType: 'agent_credential',
          resourceId: replaced.id,
          before: { revokedAt: null },
          after: {
            revokedAt: now.toISOString(),
            name: replaced.name,
            issuedVia: CredentialIssuedVia.OAUTH,
            clientId: client.clientId,
            reason: 'replaced',
            replacedBy: credentialId,
          },
        });
      }

      await this.audit.record(manager, {
        organizationId,
        actor: { type: 'user', id: code.approvedBy },
        action: 'credential.created',
        resourceType: 'agent_credential',
        resourceId: credentialId,
        before: null,
        // One shape with an API key's entry (owner rule: same audit).
        after: {
          agentId,
          name: code.credentialName,
          scopes,
          expiresAt: refreshExpiresAt.toISOString(),
          issuedVia: CredentialIssuedVia.OAUTH,
          clientId: client.clientId,
          replaces: replaced?.id ?? null,
        },
      });

      return {
        ok: true,
        credentialId,
        tokens: { accessToken, refreshToken },
        invalidateAccess: replaced !== null && (hasNarrowing(replaced) || replacesLive),
      } as const;
    });
    if (sweep) await this.sweepRevokedTokens(sweep);
    return result;
  }

  /**
   * Revokes a grant: the credential and every one of its tokens, with its
   * audit entry, in one transaction, then the post-commit sweep (R-OA-23). A
   * credential already revoked is left as it is (its first revocation
   * stands) and `false` is returned; the sweep still runs.
   */
  async revokeGrant(input: RevokeGrantInput): Promise<boolean> {
    const revoked = await this.dataSource.transaction(async (manager) => {
      const [{ now }] = (await manager.query(`SELECT now() AS "now"`)) as { now: Date }[];
      const revoked = await this.revokeInTransaction(
        manager,
        input.organizationId,
        input.credentialId,
        { revokedAt: now, revokedBy: input.revokedBy },
      );
      await this.audit.record(manager, {
        organizationId: input.organizationId,
        actor: input.audit.actor,
        action: input.audit.action,
        resourceType: 'agent_credential',
        resourceId: input.credentialId,
        before: revoked ? { revokedAt: null } : null,
        after: {
          ...(revoked ? { revokedAt: now.toISOString() } : { alreadyRevoked: true }),
          ...(input.audit.after ?? {}),
        },
      });
      return revoked;
    });
    // Also when it was already revoked: a token an earlier revocation skipped
    // is caught here.
    await this.sweepRevokedTokens(input.credentialId);
    return revoked;
  }

  /** {@link sweepRevokedCredentialTokens} on this writer's data source; never throws. */
  async sweepRevokedTokens(credentialId: string): Promise<void> {
    await sweepRevokedCredentialTokens(this.dataSource, credentialId);
  }

  /**
   * Rotates a refresh token (spec §6.3.11 step 4), in one transaction:
   * compare-and-set `used_at` on the parent, then insert the child refresh
   * token (30 days) and an access token (1 h), and move the credential's
   * `expires_at` to the child's (R-OA-13).
   *
   * Lock order, as everywhere: the refresh token row (the compare-and-set),
   * then the per-agent advisory lock, then the credential row. A presentation
   * racing this one blocks on the parent row until this commits, then loses
   * the compare-and-set and reads the grace entry `beforeCommit` stored.
   *
   * The credential is checked again under its row lock. A revocation that
   * committed first skipped the parent (it was locked here), so the parent is
   * revoked here, with the credential's own `revoked_at`.
   */
  async rotateRefresh(input: RotateRefreshInput): Promise<RotateRefreshResult> {
    const { parent, agentId, scope, audience } = input;
    const { organizationId, credentialId } = parent;

    return this.dataSource.transaction(async (manager) => {
      const won = (await manager.query(
        `UPDATE "oauth_refresh_tokens" SET "used_at" = now()
          WHERE "id" = $1 AND "used_at" IS NULL AND "revoked_at" IS NULL
            AND "expires_at" > now()
          RETURNING "id"`,
        [parent.id],
      )) as [unknown[], number];
      if (won[1] === 0) return { ok: false, reason: 'lost' } as const;

      await this.lockAgent(manager, agentId);
      const [now, credential] = await Promise.all([
        transactionNow(manager),
        lockCredential(manager, organizationId, credentialId),
      ]);
      if (!credential || credential.revoked_at !== null) {
        await manager.query(
          `UPDATE "oauth_refresh_tokens" SET "revoked_at" = $2
            WHERE "id" = $1 AND "revoked_at" IS NULL`,
          [parent.id, credential?.revoked_at ?? now],
        );
        return { ok: false, reason: 'credential_not_live' } as const;
      }
      if (credential.expires_at !== null && credential.expires_at.getTime() <= now.getTime()) {
        // Undo the compare-and-set: nothing is issued from an expired grant.
        await manager.query(`UPDATE "oauth_refresh_tokens" SET "used_at" = NULL WHERE "id" = $1`, [
          parent.id,
        ]);
        return { ok: false, reason: 'credential_not_live' } as const;
      }

      // Times are written by the database, at its microsecond precision, from
      // the transaction's `now()`: the child's `created_at` is exactly the
      // parent's `used_at`, which reuse detection compares against.
      const refreshExpiresAt = () =>
        `now() + interval '${OAUTH_REFRESH_TOKEN_TTL_SECONDS} seconds'`;
      const accessExpiresAt = () => `now() + interval '${OAUTH_ACCESS_TOKEN_TTL_SECONDS} seconds'`;
      const issuedAt = () => 'now()';

      const refreshToken = mint('assay_rt_');
      const refreshTokenId = await insertReturningId(manager, OAuthRefreshTokenEntity, {
        organizationId,
        credentialId,
        oauthClientId: parent.oauthClientId,
        tokenHash: hashOpaqueToken(refreshToken),
        parentId: parent.id,
        scope: parent.scope,
        expiresAt: refreshExpiresAt,
        usedAt: null,
        revokedAt: null,
        createdAt: issuedAt,
      });

      const accessToken = mint('assay_at_');
      await insertReturningId(manager, OAuthAccessTokenEntity, {
        organizationId,
        credentialId,
        refreshTokenId,
        tokenHash: hashOpaqueToken(accessToken),
        scope,
        audience,
        expiresAt: accessExpiresAt,
        firstUsedAt: null,
        revokedAt: null,
        createdAt: issuedAt,
      });

      await manager.update(
        AgentCredentialEntity,
        { organizationId, id: credentialId },
        { expiresAt: refreshExpiresAt },
      );

      const tokens = { accessToken, refreshToken };
      await input.beforeCommit(tokens);
      return { ok: true, tokens } as const;
    });
  }

  /**
   * A rotated refresh token presented again after the grace (spec §6.3.11,
   * R-OA-15). If a descendant was used, the grant is revoked with all its
   * tokens and `oauth.refresh_reuse_detected` is audited; otherwise
   * `oauth.refresh_stale_reuse` is audited and the grant stays.
   *
   * "A descendant was used": a refresh token of the same credential issued at
   * or after the parent's use (its child is issued in the very transaction
   * that set `used_at`, so at the same instant) that was itself used, or an
   * access token issued at or after it, other than the parent's own, that was
   * presented.
   *
   * Same lock order as a rotation, so the decision sees every rotation of the
   * chain that committed before it, and a rotation still in flight sees the
   * revocation when it reaches the credential row.
   *
   * A descendant use that has not committed yet (a child rotation past its
   * compare-and-set, or a `first_used_at` stamp still in flight) reads as
   * unused, so that replay is classed stale; the next replay detects it.
   * Locking the descendants to see it would invert the lock order. The stale
   * replay gains nothing (T14).
   */
  async detectRefreshReuse(input: RefreshReuseInput): Promise<RefreshReuseResult> {
    const { parent, agentId, clientId } = input;
    const { organizationId, credentialId } = parent;

    const result = await this.dataSource.transaction(
      async (manager): Promise<RefreshReuseResult> => {
        const [locked] = (await manager.query(
          `SELECT "used_at" FROM "oauth_refresh_tokens" WHERE "id" = $1 FOR UPDATE`,
          [parent.id],
        )) as { used_at: Date | null }[];
        await this.lockAgent(manager, agentId);
        const [now, credential] = await Promise.all([
          transactionNow(manager),
          lockCredential(manager, organizationId, credentialId),
        ]);
        if (!credential || credential.revoked_at !== null) {
          // A revocation that committed while this held the row skipped it.
          await manager.query(
            `UPDATE "oauth_refresh_tokens" SET "revoked_at" = $2
            WHERE "id" = $1 AND "revoked_at" IS NULL`,
            [parent.id, credential?.revoked_at ?? now],
          );
          return { outcome: 'not_live' } as const;
        }
        if (!locked?.used_at) return { outcome: 'not_live' } as const;
        if (credential.expires_at !== null && credential.expires_at.getTime() <= now.getTime()) {
          return { outcome: 'not_live' } as const;
        }

        const [{ used }] = (await manager.query(
          `SELECT (EXISTS (SELECT 1 FROM "oauth_refresh_tokens"
                          WHERE "organization_id" = $1 AND "credential_id" = $2
                            AND "id" <> $3 AND "created_at" >= p."used_at"
                            AND "used_at" IS NOT NULL)
              OR EXISTS (SELECT 1 FROM "oauth_access_tokens"
                          WHERE "organization_id" = $1 AND "credential_id" = $2
                            AND "refresh_token_id" IS DISTINCT FROM $3
                            AND "created_at" >= p."used_at" AND "first_used_at" IS NOT NULL))
                AS "used"
           FROM "oauth_refresh_tokens" p WHERE p."id" = $3`,
          // `used_at` is compared in SQL, at the database's microsecond precision.
          [organizationId, credentialId, parent.id],
        )) as { used: boolean }[];

        if (!used) {
          await this.audit.record(manager, {
            organizationId,
            actor: OAUTH_SYSTEM_ACTOR,
            action: 'oauth.refresh_stale_reuse',
            resourceType: 'agent_credential',
            resourceId: credentialId,
            before: null,
            after: { agentId, clientId },
          });
          return { outcome: 'stale' } as const;
        }

        await this.revokeInTransaction(manager, organizationId, credentialId, {
          revokedAt: now,
          revokedBy: OAUTH_REVOKED_BY_REFRESH_REUSE,
        });
        await this.audit.record(manager, {
          organizationId,
          actor: OAUTH_SYSTEM_ACTOR,
          action: 'oauth.refresh_reuse_detected',
          resourceType: 'agent_credential',
          resourceId: credentialId,
          before: { revokedAt: null },
          after: { revokedAt: now.toISOString(), agentId, clientId },
        });
        return { outcome: 'revoked', credentialName: credential.name } as const;
      },
    );
    if (result.outcome !== 'stale') await this.sweepRevokedTokens(credentialId);
    return result;
  }

  private async lockAgent(manager: EntityManager, agentId: string): Promise<void> {
    await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`oauth-grants:${agentId}`]);
  }

  /**
   * The grant the code replaces, when it is one this approval may replace:
   * the built-in client only, and a grant of the same organization, agent and
   * client. Anything else is ignored, as the consent API already drops it
   * (§6.3.5); this is the second check.
   */
  private async findReplaceable(
    manager: EntityManager,
    code: OAuthAuthorizationCodeEntity,
    client: OAuthClientEntity,
  ): Promise<AgentCredentialEntity | null> {
    if (!code.replacesCredentialId || client.kind !== OAuthClientKind.BUILTIN) return null;
    const row = await manager.findOne(AgentCredentialEntity, {
      where: {
        organizationId: code.organizationId,
        id: code.replacesCredentialId,
        agentId: code.agentId,
        oauthClientId: code.oauthClientId,
        issuedVia: CredentialIssuedVia.OAUTH,
      },
      lock: { mode: 'pessimistic_write' },
    });
    return row ?? null;
  }

  /** Sets `revoked_at` on a live credential and all its live tokens; `false` if it was not live. */
  private async revokeInTransaction(
    manager: EntityManager,
    organizationId: string,
    credentialId: string,
    revocation: { revokedAt: Date; revokedBy: string },
  ): Promise<boolean> {
    const result = await manager.update(
      AgentCredentialEntity,
      { organizationId, id: credentialId, revokedAt: IsNull() },
      { revokedAt: revocation.revokedAt, revokedBy: revocation.revokedBy },
    );
    if (!result.affected) return false;
    // `SKIP LOCKED`: a refresh token locked by another transaction is one a
    // rotation holds (§6.3.11). That rotation then waits for this credential
    // row, finds it revoked, and revokes its own token; if it rolls back
    // instead, the post-commit sweep (`sweepRevokedCredentialTokens`) catches
    // the row. Waiting for it here would deadlock: it holds the token and
    // waits for the credential.
    await manager.query(
      `UPDATE "oauth_refresh_tokens" SET "revoked_at" = $3
        WHERE "id" IN (SELECT "id" FROM "oauth_refresh_tokens"
                        WHERE "organization_id" = $1 AND "credential_id" = $2
                          AND "revoked_at" IS NULL
                          FOR UPDATE SKIP LOCKED)`,
      [organizationId, credentialId, revocation.revokedAt],
    );
    // Access tokens: a blocking update, safe because no path locks an
    // access-token row before the credential row (the same rule as
    // `AgentCredentialsService.revoke`).
    await manager.update(
      OAuthAccessTokenEntity,
      { organizationId, credentialId, revokedAt: IsNull() },
      { revokedAt: revocation.revokedAt },
    );
    return true;
  }
}

/** Inserts one row with the values as given (an issue time included) and returns its id. */
async function insertReturningId<T extends ObjectLiteral>(
  manager: EntityManager,
  entity: EntityTarget<T>,
  values: QueryDeepPartialEntity<T>,
): Promise<string> {
  const result = await manager
    .createQueryBuilder()
    .insert()
    .into(entity)
    .values(values)
    .returning(['id'])
    .execute();
  return (result.raw as { id: string }[])[0].id;
}

const sweepLogger = new Logger('OAuthTokenSweep');

/**
 * How long one sweep statement waits for a token row another transaction
 * holds. A rotation holds its row for at most its grace write (500 ms), so
 * this is generous; anything held longer is left to the cleanup backstop.
 */
export const OAUTH_TOKEN_SWEEP_LOCK_TIMEOUT_MS = 5_000;

/**
 * The post-commit sweep of a revoked credential (R-OA-23): every token of it
 * still live gets the credential's `revoked_at`.
 *
 * Runs after the revoking transaction has committed, holding no other lock.
 * Each of its two statements (refresh tokens, then access tokens) runs in its
 * own short transaction with `SET LOCAL lock_timeout`, so it waits for a token
 * row an in-flight rotation holds (the row `SKIP LOCKED` left), but never
 * longer than {@link OAUTH_TOKEN_SWEEP_LOCK_TIMEOUT_MS}. A rotation that rolled
 * back instead of revoking its own token is caught here. It does nothing
 * unless the credential is revoked, and is idempotent. Every path that
 * revokes an OAuth credential calls it, the admin revoke included.
 *
 * Best effort: it never throws. The revocation it follows has committed, and
 * every authentication path already refuses a token of a revoked credential,
 * so a failed or timed-out sweep (a lock timeout, a deadlock victim, a
 * dropped connection) must not fail that operation or skip what follows it
 * (the access-epoch bump, the notification). The failure is logged, and the
 * cleanup job's backstop pass revokes the stray tokens. Returns whether both
 * statements ran.
 */
export async function sweepRevokedCredentialTokens(
  executor: Pick<DataSource, 'transaction'>,
  credentialId: string,
  options: { readonly lockTimeoutMs?: number } = {},
): Promise<boolean> {
  const lockTimeoutMs = Math.trunc(options.lockTimeoutMs ?? OAUTH_TOKEN_SWEEP_LOCK_TIMEOUT_MS);
  try {
    for (const table of ['oauth_refresh_tokens', 'oauth_access_tokens']) {
      await executor.transaction(async (manager) => {
        // `SET LOCAL` takes no bind parameter; the value is an integer.
        await manager.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
        await manager.query(
          `UPDATE "${table}" t SET "revoked_at" = c."revoked_at"
             FROM "agent_credentials" c
            WHERE t."credential_id" = $1 AND c."id" = t."credential_id"
              AND c."revoked_at" IS NOT NULL AND t."revoked_at" IS NULL`,
          [credentialId],
        );
      });
    }
    return true;
  } catch (error) {
    sweepLogger.warn(
      `credential ${credentialId}: post-commit token sweep failed; the cleanup job revokes ` +
        `the remaining tokens. ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/** The transaction's own clock: every time written in one transaction derives from it. */
async function transactionNow(manager: EntityManager): Promise<Date> {
  const [{ now }] = (await manager.query(`SELECT now() AS "now"`)) as { now: Date }[];
  return now;
}

/** The credential row, locked `FOR UPDATE`; soft-deleted rows read as missing. */
async function lockCredential(
  manager: EntityManager,
  organizationId: string,
  credentialId: string,
): Promise<{ revoked_at: Date | null; expires_at: Date | null; name: string } | null> {
  const [row] = (await manager.query(
    `SELECT "revoked_at", "expires_at", "name" FROM "agent_credentials"
      WHERE "id" = $1 AND "organization_id" = $2 AND "deleted_at" IS NULL
      FOR UPDATE`,
    [credentialId, organizationId],
  )) as { revoked_at: Date | null; expires_at: Date | null; name: string }[];
  return row ?? null;
}

/**
 * The agent exists in the organization, both are ACTIVE, and it has a linked
 * wallet: the approval's R-OA-32 check, repeated at exchange.
 */
async function isAgentActive(
  manager: EntityManager,
  organizationId: string,
  agentId: string,
): Promise<boolean> {
  const rows = (await manager.query(
    `SELECT 1 FROM "agents" a JOIN "organizations" o ON o."id" = a."organization_id"
      WHERE a."id" = $1 AND a."organization_id" = $2
        AND a."status" = 'ACTIVE' AND o."status" = 'ACTIVE'
        AND a."primary_account_id" IS NOT NULL AND a."chain_id" IS NOT NULL`,
    [agentId, organizationId],
  )) as unknown[];
  return rows.length > 0;
}

function isLive(credential: AgentCredentialEntity, now: Date): boolean {
  return (
    credential.revokedAt === null &&
    (credential.expiresAt === null || credential.expiresAt.getTime() > now.getTime())
  );
}

function hasNarrowing(credential: AgentCredentialEntity): boolean {
  return (
    credential.accessMode !== null ||
    credential.allowedToolsets !== null ||
    credential.allowedToolIds !== null
  );
}
