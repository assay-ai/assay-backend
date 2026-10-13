import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AgentCredentialEntity } from '@database/postgres/entities/agent-credential.entity';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
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
 */
@Injectable()
export class AgentCredentialsService {
  constructor(
    private readonly credentials: AgentCredentialRepository,
    private readonly agents: AgentRepository,
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    private readonly audit: AuditLogWriter,
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
    return page.map((row) => this.toDto(row));
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

    // Idempotent: revoking an already-revoked credential must not overwrite
    // the original revocation time.
    if (credential.revokedAt) return;

    const revokedAt = new Date();
    await this.dataSource.transaction(async (manager) => {
      await manager.update(
        AgentCredentialEntity,
        { organizationId, id },
        { revokedAt, revokedBy: actor.id },
      );
      await this.audit.record(manager, {
        organizationId,
        actor,
        action: 'credential.revoked',
        resourceType: 'agent_credential',
        resourceId: id,
        before: { revokedAt: null },
        after: { revokedAt: revokedAt.toISOString(), name: credential.name },
      });
    });
  }

  private toDto(entity: AgentCredentialEntity): AgentCredentialDto {
    return {
      id: entity.id,
      agentId: entity.agentId,
      name: entity.name,
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
