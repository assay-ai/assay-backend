import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { OAuthAuthorizationCodeEntity } from '@database/postgres/entities/oauth-authorization-code.entity';
import { OAuthAuthorizationCodeRepository } from '@database/postgres/repositories/oauth-authorization-code.repository';
import { OAuthClientRepository } from '@database/postgres/repositories/oauth-client.repository';
import { AccessEpochService } from '@modules/toolset/services/access-epoch.service';
import { AuditLogWriter } from '@shared/audit';

import { OAUTH_CONFIG, OAuthConfig } from '../config/oauth.config';
import {
  OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  OAUTH_AUTHORIZATION_CODE_TTL_SECONDS,
} from '../constants/oauth.constants';
import { hashOpaqueToken, isWellFormed, mint } from '../domain/opaque-token';
import { verifyS256 } from '../domain/pkce';
import { normaliseResource } from '../domain/resource';
import { OAUTH_SYSTEM_ACTOR, OAuthGrantWriter } from './oauth-grant.writer';

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
  | 'invalid_target';

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

/** `revoked_by` of a grant whose code was presented a second time (R-OA-6). */
export const OAUTH_REVOKED_BY_CODE_REUSED = 'system:oauth-code-reused';

const SYSTEM_ACTOR = OAUTH_SYSTEM_ACTOR;

const INVALID_GRANT: OAuthError = { error: 'invalid_grant' };
const INVALID_TARGET: OAuthError = { error: 'invalid_target' };
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
 * Token service A: authorization codes and the grant an exchange creates
 * (spec §6.3.10, R-OA-5, R-OA-6, R-OA-11, R-OA-12, R-OA-17).
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
