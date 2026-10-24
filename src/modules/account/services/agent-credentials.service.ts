import { Inject, Injectable, Optional } from '@nestjs/common';
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
import { AgentScope, DEFAULT_AGENT_SCOPES } from '@shared/auth/agent-scope';
import { digestToken } from '@shared/crypto/token-digest';

import {
  AGENT_CREDENTIAL_TOKEN_PREFIX,
  agentCredentialHint,
  agentCredentialLast4,
} from '../constants/agent-credential-token.constants';

import {
  CreateAgentCredentialBodyDto,
  CreateAgentCredentialResponseDto,
} from '../dto/create-agent-credential.dto';
import {
  AgentCredentialDto,
  AgentCredentialsPage,
  ListAgentCredentialsQueryDto,
} from '../dto/list-agent-credentials.dto';
import {
  CREDENTIAL_DEFAULT_LIFETIME_DAYS,
  CREDENTIAL_MAX_LIFETIME_DAYS,
  ONE_DAY_MS,
} from '../constants/credential-expiry.constants';
import { AccountErrors } from '../errors/account.errors';
import { LastSeenKind, LastSeenRecorder, credentialKey } from '@shared/last-seen';

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
 * entry names the credential by id and name — never the token, its hint or
 * its hash.
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
    @Optional() private readonly lastSeen: LastSeenRecorder | null = null,
  ) {}

  async list(
    organizationId: string,
    agentId: string,
    query: ListAgentCredentialsQueryDto,
  ): Promise<CursorPageDto<AgentCredentialDto>> {
    // An agent of another organization, or none at all, is a 404 like
    // `/agents/:agentId/access`, not an empty page: a client must be able to
    // tell "no keys" from "no such agent".
    await this.assertAgentOf(organizationId, agentId);

    const qb = this.credentials
      .createQueryBuilder('credential')
      .where('credential.organizationId = :organizationId', { organizationId })
      .andWhere('credential.agentId = :agentId', { agentId });

    applyTimeWindow(qb, query, CREDENTIALS_LIST);

    const page = await paginate(qb, query, CREDENTIALS_LIST);
    // `last_used_at` is buffered (`LastSeenRecorder`): the list, and the
    // "first call seen" step that polls it, read the latest of the row and
    // the stamps not yet written.
    const [clients, pending] = await Promise.all([
      this.clientsOf(page.items),
      this.lastSeen?.pending(
        LastSeenKind.CREDENTIAL_USE,
        page.items.map((row) => credentialKey(organizationId, row.id)),
      ) ?? Promise.resolve(new Map<string, Date>()),
    ]);
    return page.map((row) =>
      this.toDto(row, clients, pending.get(credentialKey(organizationId, row.id))),
    );
  }

  /**
   * The first page `list` answers for each of `agentIds` (no cursor, no time
   * window, newest first, `limit` rows), in ONE query for all of them — what
   * `GET /agents?include=credentials` nests, instead of one
   * `GET /agents/:agentId/credentials` per agent.
   *
   * Ranked in SQL by the same key `paginate` orders by (`created_at DESC,
   * id DESC`, compared at the column's own microsecond precision), and mapped
   * through the same `toDto`, so each agent's `items` are that route's items.
   * An agent with no credential gets an empty page.
   */
  async firstPagesFor(
    organizationId: string,
    agentIds: readonly string[],
    limit: number,
  ): Promise<Map<string, AgentCredentialsPage>> {
    const pages = new Map<string, AgentCredentialsPage>(
      agentIds.map((agentId) => [agentId, { items: [], hasMore: false }]),
    );
    if (agentIds.length === 0) return pages;

    // `limit + 1` per agent, as `paginate` reads one extra row to know there is more.
    const rows = await this.credentials
      .createQueryBuilder('credential')
      .where('credential.organizationId = :organizationId', { organizationId })
      .andWhere('credential.agentId IN (:...agentIds)', { agentIds })
      .andWhere(
        `credential.id IN (SELECT ranked.id FROM (SELECT c.id, ROW_NUMBER() OVER (` +
          `PARTITION BY c.agent_id ORDER BY c.created_at DESC, c.id DESC) AS rn ` +
          `FROM agent_credentials c WHERE c.organization_id = :organizationId ` +
          `AND c.deleted_at IS NULL ` +
          `AND c.agent_id IN (:...agentIds)) ranked WHERE ranked.rn <= :rankLimit)`,
        { rankLimit: limit + 1 },
      )
      .orderBy('credential.agent_id', 'ASC')
      .addOrderBy('credential.created_at', 'DESC')
      .addOrderBy('credential.id', 'DESC')
      .getMany();

    const byAgent = new Map<string, AgentCredentialEntity[]>();
    for (const row of await this.withBufferedLastUse(rows)) {
      const list = byAgent.get(row.agentId) ?? [];
      list.push(row);
      byAgent.set(row.agentId, list);
    }

    const kept = [...byAgent.values()].flatMap((list) => list.slice(0, limit));
    const clients = await this.clientsOf(kept);
    for (const [agentId, list] of byAgent) {
      pages.set(agentId, {
        items: list.slice(0, limit).map((row) => this.toDto(row, clients)),
        hasMore: list.length > limit,
      });
    }
    return pages;
  }

  /** `ACCOUNT_AGENT_NOT_FOUND` unless the agent exists in this organization. */
  private async assertAgentOf(organizationId: string, agentId: string): Promise<void> {
    const agent = await this.agents.findById(agentId);
    if (!agent || agent.organizationId !== organizationId) {
      throw AccountErrors.agentNotFound({ agentId });
    }
  }

  /**
   * The one place rows read for {@link firstPagesFor} get their `lastUsedAt`:
   * the latest of the column and the stamp `LastSeenRecorder` has not written
   * yet, as `list` reads it — the DTO and every `health` field derive from
   * what this returns, so the two routes never disagree.
   */
  private async withBufferedLastUse(
    rows: AgentCredentialEntity[],
  ): Promise<AgentCredentialEntity[]> {
    if (!this.lastSeen || rows.length === 0) return rows;
    const pending = await this.lastSeen.pending(
      LastSeenKind.CREDENTIAL_USE,
      rows.map((row) => credentialKey(row.organizationId, row.id)),
    );
    return rows.map((row) => {
      const used = pending.get(credentialKey(row.organizationId, row.id));
      if (!used) return row;
      return Object.assign(Object.create(Object.getPrototypeOf(row)), row, {
        lastUsedAt: LastSeenRecorder.latest(row.lastUsedAt, used),
      });
    });
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
    const scopes = scopesFor(body.scopes);
    const expiresAt = expiryFor(body.expiresAt, new Date());
    await this.assertAgentOf(organizationId, agentId);

    const token = generateToken();

    const entity = this.credentials.create({
      organizationId,
      agentId,
      name: body.name,
      tokenLast4: agentCredentialLast4(token),
      tokenHash: digestToken(token),
      scopes,
      expiresAt,
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
          // One shape with a grant's entry (owner rule: same audit).
          issuedVia: CredentialIssuedVia.API_KEY,
          clientId: null,
          replaces: null,
        },
      });
      return row;
    });

    return {
      id: saved.id,
      agentId: saved.agentId,
      name: saved.name,
      hint: agentCredentialHint(saved.tokenLast4) as string,
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
          clientId: isGrant ? (client?.clientId ?? null) : null,
        },
      });
      return true;
    });

    // After commit. `bump` never throws (it logs); the sweep never throws
    // either, so neither can skip the other or fail a committed revoke.
    if (revoked) await this.accessEpoch.bump(organizationId);
    if (isGrant) await sweepRevokedCredentialTokens(this.dataSource, id);
  }

  /**
   * The owner discards the payment key a credential waits with (M3): a key
   * the agent proved while another was bound, which the owner does not mean
   * to approve. The bound key is untouched and keeps signing. Idempotent:
   * nothing pending is not an error.
   */
  async discardPendingDelegate(
    organizationId: string,
    agentId: string,
    id: string,
    actor: AuditActor,
  ): Promise<void> {
    const credential = await this.credentials.findOneBy({ organizationId, id });
    if (!credential || credential.agentId !== agentId) {
      throw AccountErrors.credentialNotFound({ id });
    }
    if (!(await this.credentials.clearPendingDelegate(organizationId, id))) return;
    await this.audit.recordAfterCommit({
      organizationId,
      actor,
      action: 'credential.pending_delegate_discarded',
      resourceType: 'agent_credential',
      resourceId: id,
      before: { pendingDelegateAccount: credential.pendingDelegateAccount ?? null },
      after: { pendingDelegateAccount: null },
    });
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
    used?: Date,
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
      hint: agentCredentialHint(entity.tokenLast4),
      scopes: entity.scopes,
      lastUsedAt: LastSeenRecorder.latest(entity.lastUsedAt, used),
      expiresAt: entity.expiresAt,
      revokedAt: entity.revokedAt,
      rotatedFromId: entity.rotatedFromId,
      delegateAccount: entity.delegateAccount ?? null,
      delegateBoundAt: entity.delegateBoundAt ?? null,
      pendingDelegateAccount: entity.pendingDelegateAccount ?? null,
      pendingDelegateRequestedAt: entity.pendingDelegateRequestedAt ?? null,
      createdAt: entity.createdAt,
    };
  }
}

function generateToken(): string {
  return `${AGENT_CREDENTIAL_TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
}

/**
 * The scopes a new key gets: the default (`tools:call payments activity:read`)
 * when none are named, else exactly those named (the DTO has already refused
 * an unknown or repeated one). `payments` without `tools:call` is refused.
 */
function scopesFor(requested: readonly AgentScope[] | undefined): AgentScope[] {
  const scopes = [...(requested ?? DEFAULT_AGENT_SCOPES)];
  if (scopes.includes(AgentScope.PAYMENTS) && !scopes.includes(AgentScope.TOOLS_CALL)) {
    throw AccountErrors.credentialScopesInvalid();
  }
  return scopes;
}

/**
 * When a new key expires: `CREDENTIAL_DEFAULT_LIFETIME_DAYS` from `now` when
 * none is named; a named one must be in the future and no further than
 * `CREDENTIAL_MAX_LIFETIME_DAYS` away. A key always expires.
 */
function expiryFor(requested: Date | undefined, now: Date): Date {
  if (!requested) return new Date(now.getTime() + CREDENTIAL_DEFAULT_LIFETIME_DAYS * ONE_DAY_MS);
  const latest = now.getTime() + CREDENTIAL_MAX_LIFETIME_DAYS * ONE_DAY_MS;
  if (requested.getTime() <= now.getTime() || requested.getTime() > latest) {
    throw AccountErrors.credentialExpiryInvalid({ maxDays: CREDENTIAL_MAX_LIFETIME_DAYS });
  }
  return requested;
}
