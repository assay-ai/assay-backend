import { Injectable } from '@nestjs/common';
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

    return this.dataSource.transaction(async (manager) => {
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

      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `oauth-grants:${agentId}`,
      ]);

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
      }

      const credentialId = await insertReturningId(manager, AgentCredentialEntity, {
        organizationId,
        agentId,
        name: code.credentialName,
        issuedVia: CredentialIssuedVia.OAUTH,
        oauthClientId: client.id,
        prefix: null,
        tokenHash: null,
        scopes: [],
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
        after: {
          agentId,
          name: code.credentialName,
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
  }

  /**
   * Revokes a grant: the credential and every one of its tokens, with its
   * audit entry, in one transaction (R-OA-23). A credential already revoked is
   * left as it is (its first revocation stands) and `false` is returned.
   */
  async revokeGrant(input: RevokeGrantInput): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
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
    await manager.update(
      OAuthRefreshTokenEntity,
      { organizationId, credentialId, revokedAt: IsNull() },
      { revokedAt: revocation.revokedAt },
    );
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
