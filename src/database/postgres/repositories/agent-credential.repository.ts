import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AgentCredentialEntity } from '../entities/agent-credential.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/** Machine tokens, by prefix and by agent. */
@Injectable()
export class AgentCredentialRepository extends OrganizationScopedRepository<AgentCredentialEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(AgentCredentialEntity, dataSource);
  }

  /**
   * The credential a bearer token's digest names — whichever tenant issued it.
   *
   * A **deliberate** cross-tenant point read, on the same pattern as
   * `SlashProposalRepository.tenantOf` and `ToolRequestRepository.tenantOf`:
   * `this.manager.createQueryBuilder(...)` rather than
   * `this.createQueryBuilder(...)`, which is what bypasses
   * `OrganizationScopedRepository`'s `ORGANIZATION_SCOPE_MISSING` guard. This
   * is not a forgotten tenant filter — a session source authenticating a
   * bearer token has no `organizationId` to supply. Discovering *which*
   * tenant issued the credential is the entire point of the lookup, so
   * requiring one here would mean already knowing the answer in order to ask
   * the question.
   *
   * `uq_agent_credentials_token` is a platform-wide unique index (not scoped
   * to `organization_id`), so at most one row can ever match.
   *
   * Returns `null` for "no such token" and returns a revoked or expired
   * credential exactly like a live one — this repository never decides what
   * a caller does with what it found. That is the session source's job (the
   * one built on this method), and collapsing "revoked" into "not found"
   * here would take that decision away from it silently.
   */
  async findByTokenHash(tokenHash: string): Promise<AgentCredentialEntity | null> {
    return this.manager
      .createQueryBuilder(AgentCredentialEntity, 'credential')
      .where('credential.token_hash = :tokenHash', { tokenHash })
      .getOne();
  }
}
