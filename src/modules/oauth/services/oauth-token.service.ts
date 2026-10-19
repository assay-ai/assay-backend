import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { CredentialIssuedVia } from '@database/postgres/entities/agent-credential.entity';
import { OAuthAccessTokenEntity } from '@database/postgres/entities/oauth-access-token.entity';
import { OAuthAuthorizationCodeEntity } from '@database/postgres/entities/oauth-authorization-code.entity';
import { OAuthClientEntity } from '@database/postgres/entities/oauth-client.entity';
import { OAuthRefreshTokenEntity } from '@database/postgres/entities/oauth-refresh-token.entity';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { OAuthAccessTokenRepository } from '@database/postgres/repositories/oauth-access-token.repository';
import { OAuthAuthorizationCodeRepository } from '@database/postgres/repositories/oauth-authorization-code.repository';
import { OAuthClientRepository } from '@database/postgres/repositories/oauth-client.repository';
import { OAuthRefreshTokenRepository } from '@database/postgres/repositories/oauth-refresh-token.repository';
import {
  NOTIFICATION_PORT,
  NotificationEvent,
  NotificationPort,
} from '@modules/notification/ports/notification.port';
import { AccessEpochService } from '@modules/toolset/services/access-epoch.service';
import { AuditLogWriter } from '@shared/audit';
import { CacheService } from '@shared/cache/redis-cache/cache.service';

import { OAUTH_CONFIG, OAuthConfig } from '../config/oauth.config';
import {
  OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  OAUTH_AUTHORIZATION_CODE_TTL_SECONDS,
  OAUTH_REFRESH_GRACE_SECONDS,
} from '../constants/oauth.constants';
import { GracePayload, open as openGrace, seal as sealGrace } from '../domain/grace-box';
import { hashOpaqueToken, isWellFormed, mint } from '../domain/opaque-token';
import { verifyS256 } from '../domain/pkce';
import { normaliseResource } from '../domain/resource';
import { normaliseScope } from '../domain/scope';
import { OAUTH_SYSTEM_ACTOR, OAuthGrantWriter } from './oauth-grant.writer';
import { OAuthMetrics } from './oauth-metrics.service';

/** The 200 body of `POST {MCP}/oauth/token` (RFC 6749 §5.1). */
export interface TokenPair {
  readonly access_token: string;
  readonly token_type: 'Bearer';
  readonly expires_in: number;
  readonly refresh_token: string;
  readonly scope: string;
}

/** RFC 6749 §5.2 / RFC 8707 error codes the token service answers with. */
export type OAuthErrorType =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'invalid_target'
  /**
   * Not a §5.2 token error: the controller answers it with 503. Used when the
   * refresh grace entry cannot be stored, so nothing was issued.
   */
  | 'temporarily_unavailable';

/** An RFC 6749 §5.2 error body. The description is fixed text: never a token, code or id. */
export interface OAuthError {
  readonly error: OAuthErrorType;
  readonly error_description?: string;
}

export function isOAuthError(value: unknown): value is OAuthError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { error?: unknown }).error === 'string'
  );
}

/** What a pending authorization request contributes to its code (Task 1.6's store entry). */
export interface OAuthCodeRequest {
  /** `oauth_clients.id` (the row, not the public `client_id`). */
  readonly oauthClientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  /** Already normalised (`normaliseScope`). */
  readonly scope: string;
  /** The organization the request was bound to by its first reader. */
  readonly boundOrganizationId: string | null;
}

/** The person's approval of a request (§6.3.5). */
export interface OAuthCodeApproval {
  readonly agentId: string;
  /** The credential's name. */
  readonly name: string;
  /** `auditActorOf(humanSession).id`. */
  readonly approvedBy: string;
  /** A grant of the same organization, agent and built-in client to replace. */
  readonly replaces: string | null;
}

export interface ExchangeCodeInput {
  readonly code: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly codeVerifier: string;
  readonly resource?: string | null;
}

export interface RefreshInput {
  readonly refreshToken: string;
  /** The public `client_id` the request names. */
  readonly clientId: string;
  /** RFC 6749 §6: the original scope or a narrower one; omitted, the original. */
  readonly scope?: string | null;
}

export interface RevokeInput {
  readonly token: string;
  readonly clientId: string;
}

/** The Redis key of a rotated refresh token's grace entry (spec §6.2). */
export function refreshGraceKey(parentHash: string): string {
  return `oauth:rt-grace:${parentHash}`;
}

/** The notice sent when a grant is stopped for refresh-token reuse (§6.3.11). */
export function grantStoppedReuseBody(name: string): string {
  return `We stopped ${name} because its sign-in was used twice. Sign in again on that device.`;
}

/** `revoked_by` of a grant whose code was presented a second time (R-OA-6). */
export const OAUTH_REVOKED_BY_CODE_REUSED = 'system:oauth-code-reused';

const SYSTEM_ACTOR = OAUTH_SYSTEM_ACTOR;

const INVALID_GRANT: OAuthError = { error: 'invalid_grant' };
const INVALID_TARGET: OAuthError = { error: 'invalid_target' };
const INVALID_SCOPE: OAuthError = { error: 'invalid_scope' };
const TEMPORARILY_UNAVAILABLE: OAuthError = { error: 'temporarily_unavailable' };

/** How long a rotation waits for Redis to store its grace entry. */
export const OAUTH_REFRESH_GRACE_WRITE_TIMEOUT_MS = 500;

/** Thrown inside the rotation transaction to roll it back. */
class GraceStoreFailed extends Error {}
const GRANT_LIMIT_REACHED: OAuthError = {
  error: 'invalid_grant',
  error_description: 'grant limit reached',
};
const AGENT_NOT_ACTIVE: OAuthError = {
  error: 'invalid_grant',
  error_description: 'agent not active',
};

type RejectReason = 'client_id' | 'redirect_uri' | 'resource' | 'pkce';

/**
 * The token service: authorization codes and the grant an exchange creates
 * (A: spec §6.3.10, R-OA-5, R-OA-6, R-OA-11, R-OA-12, R-OA-17), and refresh
 * rotation, its grace, reuse detection and client revocation (B: §6.3.11,
 * §6.3.12, R-OA-12 to R-OA-15).
 *
 * A code is `assay_ac_` + 32 random bytes, stored only as its digest, valid
 * 60 s and for one exchange, and bound to its client, redirect URI, PKCE
 * challenge and resource. The exchange burns it first, in its own committed
 * statement, so a failed check still uses it up (T9). Presenting a used code
 * again revokes the grant its first exchange created.
 *
 * Nothing here logs: a code, a token or a verifier never leaves this class
 * except as the caller's return value (R-OA-27). Audit entries name the
 * credential and the client only (R-OA-26).
 */
@Injectable()
export class OAuthTokenService {
  private readonly logger = new Logger(OAuthTokenService.name);

  constructor(
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    private readonly codes: OAuthAuthorizationCodeRepository,
    private readonly clients: OAuthClientRepository,
    private readonly grants: OAuthGrantWriter,
    private readonly audit: AuditLogWriter,
    private readonly accessEpoch: AccessEpochService,
    @Inject(OAUTH_CONFIG) private readonly config: Pick<OAuthConfig, 'issuer'>,
    private readonly refreshTokens: OAuthRefreshTokenRepository,
    private readonly accessTokens: OAuthAccessTokenRepository,
    private readonly credentials: AgentCredentialRepository,
    private readonly cache: CacheService,
    private readonly metrics: OAuthMetrics,
    @Inject(NOTIFICATION_PORT) private readonly notifications: NotificationPort,
  ) {}

  /**
   * Inserts the code row for an approved request and returns the code. Called
   * only by `/oauth/authorize/continue`, in the browser that started the
   * request (R-OA-8). The expiry is the database clock's, the same clock the
   * exchange checks it against.
   */
  async mintCode(request: OAuthCodeRequest, approval: OAuthCodeApproval): Promise<string> {
    if (!request.boundOrganizationId) {
      throw new Error('mintCode: the request is not bound to an organization');
    }
    const code = mint('assay_ac_');
    await this.codes
      .createQueryBuilder()
      .insert()
      .into(OAuthAuthorizationCodeEntity)
      .values({
        codeHash: hashOpaqueToken(code),
        oauthClientId: request.oauthClientId,
        organizationId: request.boundOrganizationId,
        agentId: approval.agentId,
        credentialName: approval.name,
        replacesCredentialId: approval.replaces,
        approvedBy: approval.approvedBy,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        scope: request.scope,
        // The audience is always {MCP} (§6.3.13).
        resource: this.config.issuer,
        expiresAt: () => `now() + interval '${OAUTH_AUTHORIZATION_CODE_TTL_SECONDS} seconds'`,
      })
      .execute();
    return code;
  }

  /** `grant_type=authorization_code` (§6.3.10). */
  async exchangeCode(input: ExchangeCodeInput): Promise<TokenPair | OAuthError> {
    if (!isWellFormed(input.code, 'assay_ac_')) return INVALID_GRANT;
    const codeHash = hashOpaqueToken(input.code);

    // Step 1: burn, in its own committed statement.
    const code = await this.burn(codeHash);
    if (!code) {
      await this.handleUnusableCode(codeHash);
      return INVALID_GRANT;
    }

    // Step 2: the code's bindings.
    const client = await this.clients.findOne({ where: { id: code.oauthClientId } });
    const resource = normaliseResource(input.resource, this.config.issuer);
    let rejected: RejectReason | null = null;
    if (!client || client.clientId !== input.clientId) rejected = 'client_id';
    else if (input.redirectUri !== code.redirectUri) rejected = 'redirect_uri';
    else if (!resource.ok || resource.resource !== code.resource) rejected = 'resource';
    else if (!verifyS256(input.codeVerifier, code.codeChallenge)) rejected = 'pkce';
    if (rejected || !client) {
      await this.audit.recordAfterCommit({
        organizationId: code.organizationId,
        actor: SYSTEM_ACTOR,
        action: 'oauth.code_rejected',
        resourceType: 'agent',
        resourceId: code.agentId,
        before: null,
        after: { reason: rejected, clientId: client?.clientId ?? null },
      });
      // RFC 8707 §2: a resource the AS does not serve is `invalid_target`.
      return rejected === 'resource' && !resource.ok ? INVALID_TARGET : INVALID_GRANT;
    }

    // Step 3: the grant.
    const created = await this.grants.createGrant({ code, client, audience: this.config.issuer });
    if ('reason' in created) {
      if (created.reason === 'grant_limit_reached') return GRANT_LIMIT_REACHED;
      if (created.reason === 'agent_not_active') return AGENT_NOT_ACTIVE;
      return INVALID_GRANT;
    }

    // Step 4: after commit.
    if (created.invalidateAccess) await this.bumpAccessEpoch(code.organizationId);

    return {
      access_token: created.tokens.accessToken,
      token_type: 'Bearer',
      expires_in: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: created.tokens.refreshToken,
      scope: code.scope,
    };
  }

  /**
   * `grant_type=refresh_token` (§6.3.11).
   *
   * 1. Unknown, expired or revoked token, another client's token, or a grant
   *    that is revoked or expired → `invalid_grant`. Agent or organization
   *    suspension does not block rotation: the session source refuses the
   *    calls instead, as it does for an API key.
   * 2. Won the compare-and-set → the new pair, and its grace entry.
   * 3. Lost, within 30 s of the first use → the same pair from the grace
   *    entry, or `invalid_grant` (no revocation) when it is gone.
   * 4. Lost, later → reuse: the grant is revoked if a descendant was used,
   *    else this is a stale retry. `invalid_grant` either way.
   *
   * A refused scope (wider than the grant's) answers `invalid_scope` before
   * anything is written, so it does not burn the token.
   */
  async refresh(input: RefreshInput): Promise<TokenPair | OAuthError> {
    if (!isWellFormed(input.refreshToken, 'assay_rt_')) return INVALID_GRANT;
    const tokenHash = hashOpaqueToken(input.refreshToken);

    const token = await this.refreshTokens.findByTokenHash(tokenHash);
    if (!token || token.revokedAt !== null || token.expiresAt.getTime() <= Date.now()) {
      return INVALID_GRANT;
    }
    const client = await this.clients.findOne({ where: { id: token.oauthClientId } });
    if (!client || client.clientId !== input.clientId) return INVALID_GRANT;

    const credential = await this.credentials.findOne({
      where: { organizationId: token.organizationId, id: token.credentialId },
    });
    if (
      !credential ||
      credential.revokedAt !== null ||
      (credential.expiresAt !== null && credential.expiresAt.getTime() <= Date.now())
    ) {
      return INVALID_GRANT;
    }

    const scope = narrowScope(token.scope, input.scope);
    if (scope === null) return INVALID_SCOPE;

    let rotated: Awaited<ReturnType<OAuthGrantWriter['rotateRefresh']>>;
    try {
      rotated = await this.grants.rotateRefresh({
        parent: token,
        agentId: credential.agentId,
        scope,
        audience: this.config.issuer,
        beforeCommit: (tokens) =>
          this.storeGrace(input.refreshToken, tokenHash, {
            access_token: tokens.accessToken,
            refresh_token: tokens.refreshToken,
            expires_in: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
            scope,
          }),
      });
    } catch (error) {
      // Fail closed: no pair is issued without its grace entry. The rotation
      // rolled back, so the token is unused and the client can retry.
      if (error instanceof GraceStoreFailed) return TEMPORARILY_UNAVAILABLE;
      throw error;
    }
    if (!('reason' in rotated)) {
      return {
        access_token: rotated.tokens.accessToken,
        token_type: 'Bearer',
        expires_in: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
        refresh_token: rotated.tokens.refreshToken,
        scope,
      };
    }
    if (rotated.reason !== 'lost') return INVALID_GRANT;

    // Lost: read the parent again, with the database's clock for the grace.
    const [state] = (await this.dataSource.query(
      `SELECT "used_at" IS NOT NULL AS "used", "revoked_at" IS NOT NULL AS "revoked",
              "expires_at" <= now() AS "expired",
              "used_at" >= now() - make_interval(secs => $2) AS "in_grace"
         FROM "oauth_refresh_tokens" WHERE "id" = $1`,
      [token.id, OAUTH_REFRESH_GRACE_SECONDS],
    )) as { used: boolean; revoked: boolean; expired: boolean; in_grace: boolean | null }[];
    if (!state || !state.used || state.revoked || state.expired) return INVALID_GRANT;

    if (state.in_grace) return this.fromGrace(input.refreshToken, tokenHash, token, client);

    const reuse = await this.grants.detectRefreshReuse({
      parent: token,
      agentId: credential.agentId,
      clientId: client.clientId,
    });
    if (reuse.outcome === 'stale') this.metrics.incRefreshReuse('stale');
    if (reuse.outcome === 'revoked') {
      this.metrics.incRefreshReuse('revoked');
      await this.bumpAccessEpoch(token.organizationId);
      await this.notifyStoppedForReuse(token, credential.agentId, client, reuse.credentialName);
    }
    return INVALID_GRANT;
  }

  /**
   * `POST /oauth/revoke` (RFC 7009, §6.3.12). A refresh token revokes its
   * grant, credential and tokens, audited `credential.revoked` by the agent
   * with `reason: 'client_logout'`; an access token revokes itself. A token
   * that is unknown, malformed, already revoked or another client's is a
   * no-op: the endpoint answers 200 whatever happens here.
   */
  async revoke(input: RevokeInput): Promise<void> {
    if (isWellFormed(input.token, 'assay_rt_')) {
      const token = await this.refreshTokens.findByTokenHash(hashOpaqueToken(input.token));
      if (!token || !(await this.isClientOf(token.oauthClientId, input.clientId))) return;
      const credential = await this.credentials.findOne({
        where: { organizationId: token.organizationId, id: token.credentialId },
      });
      if (!credential) return;
      if (credential.revokedAt !== null) {
        // Already revoked: nothing to audit, but finish any token it left.
        await this.grants.sweepRevokedTokens(credential.id);
        return;
      }
      const revoked = await this.grants.revokeGrant({
        organizationId: token.organizationId,
        credentialId: credential.id,
        // As an API key's revocation: `revoked_by` is the actor's id.
        revokedBy: credential.agentId,
        audit: {
          actor: { type: 'agent', id: credential.agentId },
          action: 'credential.revoked',
          after: {
            name: credential.name,
            issuedVia: CredentialIssuedVia.OAUTH,
            clientId: input.clientId,
            reason: 'client_logout',
          },
        },
      });
      if (revoked) await this.bumpAccessEpoch(token.organizationId);
      return;
    }

    if (isWellFormed(input.token, 'assay_at_')) {
      const token = await this.accessTokens.findByTokenHash(hashOpaqueToken(input.token));
      if (!token || token.revokedAt !== null) return;
      const credential = await this.credentials.findOne({
        where: { organizationId: token.organizationId, id: token.credentialId },
      });
      if (!credential?.oauthClientId) return;
      if (!(await this.isClientOf(credential.oauthClientId, input.clientId))) return;
      await this.accessTokens
        .createQueryBuilder()
        .update(OAuthAccessTokenEntity)
        .set({ revokedAt: () => 'now()' })
        .where('id = :id', { id: token.id })
        .andWhere('revoked_at IS NULL')
        .execute();
    }
  }

  private async isClientOf(oauthClientId: string, clientId: string): Promise<boolean> {
    const client = await this.clients.findOne({ where: { id: oauthClientId } });
    return client !== null && client.clientId === clientId;
  }

  /**
   * Stores the sealed pair under the parent's hash for the grace window, from
   * inside the rotation transaction (which holds the parent row, the agent
   * lock and the credential row). Bounded: an error, or no answer within
   * {@link OAUTH_REFRESH_GRACE_WRITE_TIMEOUT_MS}, throws `GraceStoreFailed`,
   * which rolls the rotation back. A pair is never issued without its grace
   * entry, and a stalled Redis never holds those locks for long.
   */
  private async storeGrace(
    parentToken: string,
    parentHash: string,
    payload: GracePayload,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const write = this.cache
        .getRedisClient()
        .set(
          refreshGraceKey(parentHash),
          sealGrace(parentToken, parentHash, payload),
          'EX',
          OAUTH_REFRESH_GRACE_SECONDS,
        );
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('timeout')),
          OAUTH_REFRESH_GRACE_WRITE_TIMEOUT_MS,
        );
      });
      await Promise.race([write, timeout]);
    } catch {
      this.logger.warn('refresh grace entry not stored; the rotation is rolled back');
      throw new GraceStoreFailed();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * The pair a racing presentation receives within the grace (§6.3.11 step 4,
   * "Lost, ≤ 30 s"). Returned only when, read now:
   * - the child refresh token in the entry is in the database, has this
   *   parent as `parent_id`, and is neither revoked nor expired (a timed-out
   *   `SET` from another process can land late and leave an entry whose
   *   rotation rolled back);
   * - the credential is neither revoked nor expired (a revocation that
   *   committed after the rotation, before its sweep reached the child).
   * Otherwise `invalid_grant`, with no revocation, audit entry or metric.
   */
  private async fromGrace(
    parentToken: string,
    parentHash: string,
    token: OAuthRefreshTokenEntity,
    client: OAuthClientEntity,
  ): Promise<TokenPair | OAuthError> {
    let sealed: string | null = null;
    try {
      sealed = await this.cache.getRedisClient().get(refreshGraceKey(parentHash));
    } catch {
      sealed = null;
    }
    const payload = sealed === null ? null : openGrace(parentToken, parentHash, sealed);
    if (!payload) return INVALID_GRANT;

    const child = isWellFormed(payload.refresh_token, 'assay_rt_')
      ? await this.refreshTokens.findByTokenHash(hashOpaqueToken(payload.refresh_token))
      : null;
    if (
      !child ||
      child.parentId !== token.id ||
      child.revokedAt !== null ||
      child.expiresAt.getTime() <= Date.now()
    ) {
      return INVALID_GRANT;
    }
    const credential = await this.credentials.findOne({
      where: { organizationId: token.organizationId, id: token.credentialId },
    });
    if (
      !credential ||
      credential.revokedAt !== null ||
      (credential.expiresAt !== null && credential.expiresAt.getTime() <= Date.now())
    ) {
      return INVALID_GRANT;
    }

    this.metrics.incRefreshGrace();
    await this.audit.recordAfterCommit({
      organizationId: token.organizationId,
      actor: SYSTEM_ACTOR,
      action: 'oauth.refresh_grace_used',
      resourceType: 'agent_credential',
      resourceId: token.credentialId,
      before: null,
      after: { clientId: client.clientId },
    });
    return {
      access_token: payload.access_token,
      token_type: 'Bearer',
      expires_in: payload.expires_in,
      refresh_token: payload.refresh_token,
      scope: payload.scope,
    };
  }

  private async notifyStoppedForReuse(
    token: OAuthRefreshTokenEntity,
    agentId: string,
    client: OAuthClientEntity,
    name: string,
  ): Promise<void> {
    try {
      await this.notifications.notify({
        organizationId: token.organizationId,
        event: NotificationEvent.OAUTH_GRANT_STOPPED_REUSE,
        title: `${name} was stopped`,
        body: grantStoppedReuseBody(name),
        subjectType: 'credential',
        subjectId: token.credentialId,
        payload: { credentialId: token.credentialId, agentId, clientId: client.clientId },
      });
    } catch {
      this.logger.warn(`org ${token.organizationId}: grant-stopped notice not sent`);
    }
  }

  /** `UPDATE … SET used_at = now() … RETURNING *`: the unused, unexpired code, now used. */
  private async burn(codeHash: string): Promise<OAuthAuthorizationCodeEntity | null> {
    const result = await this.codes
      .createQueryBuilder()
      .update(OAuthAuthorizationCodeEntity)
      .set({ usedAt: () => 'now()' })
      .where('code_hash = :codeHash', { codeHash })
      .andWhere('used_at IS NULL')
      .andWhere('expires_at > now()')
      .returning('*')
      .execute();
    const [raw] = (result.raw ?? []) as Record<string, unknown>[];
    if (!raw) return null;
    return this.codes.create({
      id: raw.id as string,
      codeHash: raw.code_hash as string,
      oauthClientId: raw.oauth_client_id as string,
      organizationId: raw.organization_id as string,
      agentId: raw.agent_id as string,
      credentialName: raw.credential_name as string,
      replacesCredentialId: (raw.replaces_credential_id as string | null) ?? null,
      approvedBy: raw.approved_by as string,
      redirectUri: raw.redirect_uri as string,
      codeChallenge: raw.code_challenge as string,
      scope: raw.scope as string,
      resource: raw.resource as string,
      expiresAt: raw.expires_at as Date,
      usedAt: raw.used_at as Date,
      credentialId: (raw.credential_id as string | null) ?? null,
    });
  }

  /**
   * A code that could not be burned. If it was used, this is a replay: mark
   * it (compare-and-set on the code row) and revoke the grant its first
   * exchange created (RFC 6749 §4.1.2, R-OA-6).
   *
   * The mark is what closes the race with an exchange still in flight. If the
   * first exchange's grant transaction already holds the code row, this
   * update waits for it to commit and then returns its `credential_id`. If it
   * does not yet, the mark lands first and that transaction creates nothing.
   * Unknown, unused or expired codes match no row: nothing is written.
   */
  private async handleUnusableCode(codeHash: string): Promise<void> {
    const result = await this.codes
      .createQueryBuilder()
      .update(OAuthAuthorizationCodeEntity)
      .set({ reuseDetectedAt: () => 'coalesce(reuse_detected_at, now())' })
      .where('code_hash = :codeHash', { codeHash })
      .andWhere('used_at IS NOT NULL')
      // A string, not an array: TypeORM drops array entries that are not entity properties.
      .returning('"credential_id", "organization_id", "agent_id", "oauth_client_id"')
      .execute();
    const [marked] = (result.raw ?? []) as {
      credential_id: string | null;
      organization_id: string;
      agent_id: string;
      oauth_client_id: string;
    }[];
    // No grant yet: either a failed check burned it, or the exchange in
    // flight will see the mark and audit the replay itself.
    if (!marked?.credential_id) return;

    const client = await this.clients.findOne({ where: { id: marked.oauth_client_id } });
    const revoked = await this.grants.revokeGrant({
      organizationId: marked.organization_id,
      credentialId: marked.credential_id,
      revokedBy: OAUTH_REVOKED_BY_CODE_REUSED,
      audit: {
        actor: SYSTEM_ACTOR,
        action: 'oauth.code_reused',
        after: { agentId: marked.agent_id, clientId: client?.clientId ?? null },
      },
    });
    if (revoked) await this.bumpAccessEpoch(marked.organization_id);
  }

  /**
   * After commit, so it never fails the exchange: the grant (and its tokens)
   * already exist, and a lost bump only leaves cached views to their TTL.
   */
  private async bumpAccessEpoch(organizationId: string): Promise<void> {
    try {
      await this.accessEpoch.bump(organizationId);
    } catch {
      this.logger.warn(
        `org ${organizationId}: access epoch not bumped after an OAuth grant change; ` +
          'cached access lasts until its TTL',
      );
    }
  }
}

/**
 * The scope of a refreshed pair (RFC 6749 §6): the grant's when none is asked
 * for; otherwise the normalised request, which must not add to the grant's.
 * `null` when it would.
 */
function narrowScope(granted: string, requested: string | null | undefined): string | null {
  if (requested === undefined || requested === null || requested === '') return granted;
  const allowed = new Set(granted.split(' '));
  const asked = requested.split(' ').filter((scope) => scope !== '');
  if (asked.some((scope) => !allowed.has(scope))) return null;
  return normaliseScope(requested);
}
