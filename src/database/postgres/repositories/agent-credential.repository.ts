import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { AgentCredentialEntity, CredentialIssuedVia } from '../entities/agent-credential.entity';
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
   * key, or as a pending one, and are neither revoked nor deleted (expired ones included; the caller
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
      .where(
        '(lower(credential.delegate_account) = lower(:delegate) ' +
          'OR lower(credential.pending_delegate_account) = lower(:delegate))',
        { delegate },
      )
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
    for (const [column, set] of [
      ['delegate_account', { delegateAccount: null, delegateBoundAt: null }],
      [
        'pending_delegate_account',
        { pendingDelegateAccount: null, pendingDelegateRequestedAt: null },
      ],
    ] as const) {
      await this.manager
        .createQueryBuilder()
        .update(AgentCredentialEntity)
        .set(set)
        .where(`lower(${column}) = lower(:delegate)`, { delegate })
        .andWhere('id <> :exceptCredentialId', { exceptCredentialId })
        .andWhere('revoked_at IS NULL')
        .andWhere('deleted_at IS NULL')
        .andWhere('expires_at IS NOT NULL AND expires_at <= now()')
        .execute();
    }
  }

  /**
   * The payer approved `delegate` on chain: every live credential of this
   * organization's `agentId` that waits with it as its PENDING key gets it as
   * its bound key, in one UPDATE (the old key stops signing for it at the
   * same instant). Returns the promoted credential ids; none when no
   * credential waits with that key.
   */
  async promotePendingDelegate(
    organizationId: string,
    agentId: string,
    delegate: string,
  ): Promise<string[]> {
    const result = await this.manager
      .createQueryBuilder()
      .update(AgentCredentialEntity)
      .set({
        delegateAccount: () => 'pending_delegate_account',
        delegateBoundAt: () => 'now()',
        pendingDelegateAccount: null,
        pendingDelegateRequestedAt: null,
      })
      .where('organization_id = :organizationId', { organizationId })
      .andWhere('agent_id = :agentId', { agentId })
      .andWhere('lower(pending_delegate_account) = lower(:delegate)', { delegate })
      .andWhere('revoked_at IS NULL')
      .andWhere('deleted_at IS NULL')
      .andWhere('(expires_at IS NULL OR expires_at > now())')
      .returning(['id'])
      .execute();
    return ((result.raw ?? []) as { id: string }[]).map((row) => row.id);
  }

  /**
   * The agent's live OAuth grants, for the per-agent cap (spec §6.3.14).
   * Live = not revoked and not expired; an idle-dead grant (its refresh chain
   * ran out) and a soft-deleted row do not count. Served by
   * `idx_agent_credentials_oauth_live`.
   *
   * Scoped to `organizationId` as well as the agent: an agent id is already
   * unique platform-wide, so the tenant predicate is a second safeguard
   * against a caller that did not resolve the agent inside its tenant.
   *
   * Pass `manager` to count inside a transaction: the grant writer counts and
   * inserts under one per-agent lock, so the count must see that transaction.
   */
  async countLiveOAuthForAgent(
    organizationId: string,
    agentId: string,
    manager?: EntityManager,
  ): Promise<number> {
    const qb = manager
      ? manager.createQueryBuilder(AgentCredentialEntity, 'credential')
      : this.createQueryBuilder('credential');
    return qb
      .where('credential.organization_id = :organizationId', { organizationId })
      .andWhere('credential.agent_id = :agentId', { agentId })
      .andWhere('credential.issued_via = :oauth', { oauth: CredentialIssuedVia.OAUTH })
      .andWhere('credential.revoked_at IS NULL')
      .andWhere('(credential.expires_at IS NULL OR credential.expires_at > now())')
      .getCount();
  }

  /**
   * {@link countLiveOAuthForAgent} for every agent of an organization at once,
   * as the consent page lists them: agent id → live OAuth grants. An agent
   * with none is absent.
   */
  async countLiveOAuthByAgent(organizationId: string): Promise<Map<string, number>> {
    const rows = await this.createQueryBuilder('credential')
      .select('credential.agent_id', 'agentId')
      .addSelect('count(*)::int', 'live')
      .where('credential.organization_id = :organizationId', { organizationId })
      .andWhere('credential.issued_via = :oauth', { oauth: CredentialIssuedVia.OAUTH })
      .andWhere('credential.revoked_at IS NULL')
      .andWhere('(credential.expires_at IS NULL OR credential.expires_at > now())')
      .groupBy('credential.agent_id')
      .getRawMany<{ agentId: string; live: number }>();
    return new Map(rows.map((row) => [row.agentId, Number(row.live)]));
  }
}
