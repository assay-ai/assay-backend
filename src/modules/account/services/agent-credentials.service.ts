import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { DataSource, In, IsNull } from 'typeorm';

import {
  AgentCredentialEntity,
  CredentialIssuedVia,
} from '@database/postgres/entities/agent-credential.entity';
import { OAuthAccessTokenEntity } from '@database/postgres/entities/oauth-access-token.entity';
import { OAuthClientEntity } from '@database/postgres/entities/oauth-client.entity';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { OAuthClientRepository } from '@database/postgres/repositories/oauth-client.repository';
import {
  OAUTH_CLIENT_TRUST,
  OAuthClientTrust,
  credentialClientView,
} from '@modules/oauth/domain/credential-client-view';
import { sweepRevokedCredentialTokens } from '@modules/oauth/services/oauth-grant.writer';
import { AccessEpochService } from '@modules/toolset/services/access-epoch.service';
import { CursorPageDto, ListSpec, applyTimeWindow, asInstant, paginate } from '@shared/api';
import { AuditActor, AuditLogWriter } from '@shared/audit';
import { digestToken } from '@shared/crypto/token-digest';

import {
  AGENT_CREDENTIAL_STORED_PREFIX_LENGTH,
  AGENT_CREDENTIAL_TOKEN_PREFIX,
} from '../constants/agent-credential-token.constants';

import {
  CreateAgentCredentialBodyDto,
  CreateAgentCredentialResponseDto,
} from '../dto/create-agent-credential.dto';
import {
  AgentCredentialDto,
  ListAgentCredentialsQueryDto,
} from '../dto/list-agent-credentials.dto';
import { AccountErrors } from '../errors/account.errors';

const CREDENTIALS_LIST: ListSpec = {
  alias: 'credential',
  defaultSort: 'createdAt',
  sortable: {
    createdAt: {
      column: 'credential.created_at',
      type: 'timestamptz',
      valueOf: asInstant((row: AgentCredentialEntity) => row.createdAt),
    },
  },
};

/**
 * Exported so `DbCredentialMcpSessionSource` can recognise its own tokens
 * without re-typing the literal — the same drift risk `digestToken`'s own
 * docstring names: two copies of this string are one refactor away from a
 * credential that mints fine and never authenticates.
 */

/**
 * `GET/POST /api/v1/agents/:agentId/credentials`, `DELETE …/:id` — machine
 * tokens.
 *
 * The secret rule, twice over: `create` is the only method that ever sees the
 * plaintext token, and it returns it exactly once and does not persist it —
 * only `tokenHash` (a SHA-256 digest) is written. `list` and its DTO
 * (`AgentCredentialDto`) never carry `tokenHash` at all, so "never return the
 * secret" cannot be violated by a future field added to the wrong DTO.
 *
 * `create` and `revoke` each append an `audit_log_entries` row in the same
 * transaction as the write (`credential.created` / `credential.revoked`). The
 * entry names the credential by id and name — never the token, its stored
 * prefix or its hash.
 *
 * An OAuth grant (`issued_via = 'OAUTH'`) is a row of the same table and is
 * listed and revoked here like an API key (owner rule: OAuth = API key). Its
 * DTO adds the client it was issued to, and revoking it also revokes every
 * one of its access and refresh tokens, in the same transaction (R-OA-23).
 */
@Injectable()
export class AgentCredentialsService {
  constructor(
    private readonly credentials: AgentCredentialRepository,
    private readonly agents: AgentRepository,
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    private readonly audit: AuditLogWriter,
    private readonly accessEpoch: AccessEpochService,
    private readonly oauthClients: OAuthClientRepository,
    @Inject(OAUTH_CLIENT_TRUST) private readonly clientTrust: OAuthClientTrust,
  ) {}

  async list(
    organizationId: string,
    agentId: string,
    query: ListAgentCredentialsQueryDto,
  ): Promise<CursorPageDto<AgentCredentialDto>> {
    const qb = this.credentials
      .createQueryBuilder('credential')
      .where('credential.organizationId = :organizationId', { organizationId })
      .andWhere('credential.agentId = :agentId', { agentId });

    applyTimeWindow(qb, query, CREDENTIALS_LIST);

    const page = await paginate(qb, query, CREDENTIALS_LIST);
    const clients = await this.clientsOf(page.items);
    return page.map((row) => this.toDto(row, clients));
  }

  /**
   * Refuses an `agentId` that is not one of this organization's agents
   * (`ACCOUNT_AGENT_NOT_FOUND`, 404 either way). `DbCredentialMcpSessionSource`
   * already rejects a token whose agent is missing or in another organization,
   * so minting one would only hand back a secret that can never authenticate.
   */
  async create(
    organizationId: string,
    agentId: string,
    body: CreateAgentCredentialBodyDto,
    actor: AuditActor,
  ): Promise<CreateAgentCredentialResponseDto> {
    const agent = await this.agents.findById(agentId);
    if (!agent || agent.organizationId !== organizationId) {
      throw AccountErrors.agentNotFound({ agentId });
    }

    const token = generateToken();

    const entity = this.credentials.create({
      organizationId,
      agentId,
      name: body.name,
      prefix: token.slice(0, AGENT_CREDENTIAL_STORED_PREFIX_LENGTH),
      tokenHash: digestToken(token),
      scopes: body.scopes ?? [],
      expiresAt: body.expiresAt ?? null,
    });

    const saved = await this.dataSource.transaction(async (manager) => {
      const row = await manager.save(AgentCredentialEntity, entity);
      await this.audit.record(manager, {
        organizationId,
        actor,
        action: 'credential.created',
        resourceType: 'agent_credential',
        resourceId: row.id,
        before: null,
        after: {
          agentId: row.agentId,
          name: row.name,
          scopes: row.scopes,
          expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
        },
      });
      return row;
    });

    return {
      id: saved.id,
      agentId: saved.agentId,
      name: saved.name,
      prefix: saved.prefix,
      // Exactly once, and only here — see the class comment.
      token,
      scopes: saved.scopes,
      expiresAt: saved.expiresAt,
      createdAt: saved.createdAt,
    };
  }

  /**
   * Sets `revoked_at`/`revoked_by`; never deletes the row — see
   * `AgentCredentialEntity`'s class comment on why revocation must stay
   * visible. A credential id that belongs to another organization, or to a
   * different agent than the one in the route, is the same 404: neither case
   * distinguishes "does not exist" from "is not yours" to the caller.
   *
   * An OAuth grant's refresh and access tokens are revoked in the same
   * transaction, after the credential row, exactly as
   * `OAuthGrantWriter.revokeInTransaction` does. Refresh tokens are taken with
   * `FOR UPDATE SKIP LOCKED`: a row locked elsewhere is one a rotation holds
   * (§6.3.11), and that rotation then waits for this credential row, finds it
   * revoked, and revokes its own token. Waiting for it here instead would
   * deadlock: it holds the token and waits for the credential. If that
   * rotation rolls back instead, the post-commit sweep
   * (`sweepRevokedCredentialTokens`) catches the row; it never throws, and the
   * cleanup job is its backstop. After commit the organization's access epoch
   * is bumped, so no cached access of the credential outlives it (R-OA-23).
   */
  async revoke(
    organizationId: string,
    agentId: string,
    id: string,
    actor: AuditActor,
  ): Promise<void> {
    const credential = await this.credentials.findOneBy({ organizationId, id });
    if (!credential || credential.agentId !== agentId) {
      throw AccountErrors.credentialNotFound({ id });
    }

    const isGrant = credential.issuedVia === CredentialIssuedVia.OAUTH;

    // Idempotent: revoking an already-revoked credential must not overwrite
    // the original revocation time. A grant's sweep still runs, to finish any
    // token an earlier revocation skipped (as `OAuthTokenService.revoke`).
    if (credential.revokedAt) {
      if (isGrant) await sweepRevokedCredentialTokens(this.dataSource, id);
      return;
    }

    const client =
      isGrant && credential.oauthClientId
        ? await this.oauthClients.findOneBy({ id: credential.oauthClientId })
        : null;

    const revokedAt = new Date();
    const revoked = await this.dataSource.transaction(async (manager) => {
      const result = await manager.update(
        AgentCredentialEntity,
        { organizationId, id, revokedAt: IsNull() },
        { revokedAt, revokedBy: actor.id },
      );
      // Revoked meanwhile by someone else: that revocation and its entry stand.
      if (!result.affected) return false;
      if (isGrant) {
        await manager.query(
          `UPDATE "oauth_refresh_tokens" SET "revoked_at" = $3
            WHERE "id" IN (SELECT "id" FROM "oauth_refresh_tokens"
                            WHERE "organization_id" = $1 AND "credential_id" = $2
                              AND "revoked_at" IS NULL
                              FOR UPDATE SKIP LOCKED)`,
          [organizationId, id, revokedAt],
        );
        // Access tokens: a blocking update, not `SKIP LOCKED`. Lock rule: no
        // path may lock an access-token row before the credential row (1.8
        // inserts them under the credential lock; the `first_used_at` stamp and
        // the RFC 7009 revoke are autocommit statements that lock nothing else).
        // A path that broke it, e.g. a stamp followed by a `FOR SHARE` read of
        // the credential in one transaction, would deadlock with this update.
        await manager.update(
          OAuthAccessTokenEntity,
          { organizationId, credentialId: id, revokedAt: IsNull() },
          { revokedAt },
        );
      }
      await this.audit.record(manager, {
        organizationId,
        actor,
        action: 'credential.revoked',
        resourceType: 'agent_credential',
        resourceId: id,
        before: { revokedAt: null },
        after: {
          revokedAt: revokedAt.toISOString(),
          name: credential.name,
          issuedVia: credential.issuedVia,
          ...(isGrant ? { clientId: client?.clientId ?? null } : {}),
        },
      });
      return true;
    });

    // After commit. `bump` never throws (it logs); the sweep never throws
    // either, so neither can skip the other or fail a committed revoke.
    if (revoked) await this.accessEpoch.bump(organizationId);
    if (isGrant) await sweepRevokedCredentialTokens(this.dataSource, id);
  }

  /** The OAuth clients of a page's grants, by row id, in one query. */
  private async clientsOf(
    rows: readonly AgentCredentialEntity[],
  ): Promise<Map<string, OAuthClientEntity>> {
    const ids = [
      ...new Set(
        rows
          .filter((row) => row.issuedVia === CredentialIssuedVia.OAUTH && row.oauthClientId)
          .map((row) => row.oauthClientId as string),
      ),
    ];
    if (ids.length === 0) return new Map();
    const clients = await this.oauthClients.findBy({ id: In(ids) });
    return new Map(clients.map((client) => [client.id, client]));
  }

  private toDto(
    entity: AgentCredentialEntity,
    clients: ReadonlyMap<string, OAuthClientEntity>,
  ): AgentCredentialDto {
    const client =
      entity.issuedVia === CredentialIssuedVia.OAUTH && entity.oauthClientId
        ? clients.get(entity.oauthClientId)
        : undefined;
    return {
      id: entity.id,
      agentId: entity.agentId,
      name: entity.name,
      issuedVia: entity.issuedVia,
      oauthClient: client ? credentialClientView(client, this.clientTrust) : null,
      prefix: entity.prefix,
      scopes: entity.scopes,
      lastUsedAt: entity.lastUsedAt,
      expiresAt: entity.expiresAt,
      revokedAt: entity.revokedAt,
      rotatedFromId: entity.rotatedFromId,
      delegateAccount: entity.delegateAccount ?? null,
      delegateBoundAt: entity.delegateBoundAt ?? null,
      createdAt: entity.createdAt,
    };
  }
}

function generateToken(): string {
  return `${AGENT_CREDENTIAL_TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
}
