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

  /**
   * The OTHER credentials — in any tenant — that hold `delegate` as their bound
   * key and are neither revoked nor deleted (expired ones included; the caller
   * decides what an expired holder means). A deliberate cross-tenant read, like
   * {@link findByTokenHash}: a delegate key is one key platform-wide, and
   * `uq_agent_credentials_delegate_live` enforces it across tenants, so the
   * check in front of that index has to look across them too. Compared
   * case-insensitively, as the index is.
   */
  async findOtherDelegateHolders(
    delegate: string,
    exceptCredentialId: string,
  ): Promise<AgentCredentialEntity[]> {
    return this.manager
      .createQueryBuilder(AgentCredentialEntity, 'credential')
      .where('lower(credential.delegate_account) = lower(:delegate)', { delegate })
      .andWhere('credential.id <> :exceptCredentialId', { exceptCredentialId })
      .andWhere('credential.revoked_at IS NULL')
      .andWhere('credential.deleted_at IS NULL')
      .getMany();
  }

  /**
   * Clears `delegate` from credentials that can no longer authenticate because
   * they EXPIRED (not revoked — a revoked row is outside the unique index
   * already). An expired credential's binding is dead weight: nobody can use
   * it, and leaving it would hold the key hostage under
   * `uq_agent_credentials_delegate_live`. Cross-tenant for the same reason as
   * {@link findOtherDelegateHolders}.
   */
  async releaseDelegateFromExpired(delegate: string, exceptCredentialId: string): Promise<void> {
    await this.manager
      .createQueryBuilder()
      .update(AgentCredentialEntity)
      .set({ delegateAccount: null, delegateBoundAt: null })
      .where('lower(delegate_account) = lower(:delegate)', { delegate })
      .andWhere('id <> :exceptCredentialId', { exceptCredentialId })
      .andWhere('revoked_at IS NULL')
      .andWhere('deleted_at IS NULL')
      .andWhere('expires_at IS NOT NULL AND expires_at <= now()')
      .execute();
  }
}
