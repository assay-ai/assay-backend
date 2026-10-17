import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull } from 'typeorm';

import { OrgHandleClaimEntity } from '@database/postgres/entities/org-handle-claim.entity';
import { OrganizationEntity } from '@database/postgres/entities/organization.entity';
import { UNIQUE_VIOLATION_CODE } from '@database/postgres/repositories/abstract.repository';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { OrganizationRepository } from '@database/postgres/repositories/organization.repository';
import {
  OrgHandleClaimRepository,
  OrgHandleHistoryRepository,
} from '@database/postgres/repositories/toolset-sharing.repository';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { AuditActor, AuditLogWriter } from '@shared/audit';

import {
  HANDLE_CLAIM_WINDOW_MS,
  HandleHistoryReason,
  HandleStatus,
  OFFICIAL_HANDLE,
  claimGateAllows,
  handleRefusal,
  handleSuggestions,
  normalizeHandle,
} from '../domain/handle';
import { ToolsetErrors } from '../errors/toolset.errors';
import { TOOLSET_CLOCK, ToolsetClock, systemClock } from './toolset-clock';

/** What a handle in a URL names right now. */
export type ResolvedHandle =
  | { readonly kind: 'OFFICIAL' }
  | {
      readonly kind: 'ORG';
      readonly organizationId: string;
      readonly handle: string;
      /** Set when `handle` is an old name kept as an alias: the current one. */
      readonly renamedTo: string | null;
      readonly aliasUntil: Date | null;
    };

export interface OrgHandleView {
  readonly handle: string | null;
  readonly status: string | null;
  readonly lockedAt: Date | null;
  /** Free to claim or change: there is no handle yet, or it is not locked. */
  readonly canChange: boolean;
}

/**
 * Handles (design spec §7.1): claim and change before the lock, the claim
 * gate, and what a handle in a URL resolves to.
 *
 * Availability is decided under a transaction-scoped advisory lock on the
 * handle, so two claims racing for one name — or a claim racing a rename to
 * it — serialise; the unique indexes are the backstop.
 */
@Injectable()
export class HandlesService {
  constructor(
    private readonly organizations: OrganizationRepository,
    private readonly agents: AgentRepository,
    private readonly history: OrgHandleHistoryRepository,
    private readonly claims: OrgHandleClaimRepository,
    private readonly audit: AuditLogWriter,
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    @Optional() @Inject(TOOLSET_CLOCK) private readonly now: ToolsetClock = systemClock,
  ) {}

  async get(organizationId: string): Promise<OrgHandleView> {
    const org = await this.organizations.findById(organizationId);
    return {
      handle: org?.handle ?? null,
      status: org?.handleStatus ?? null,
      lockedAt: org?.handleLockedAt ?? null,
      canChange: !!org && !org.handleLockedAt && org.handleStatus !== HandleStatus.FROZEN,
    };
  }

  /** `PUT /org/handle`: claim, or change before the lock. */
  async claim(session: McpSession, raw: string, actor: AuditActor): Promise<OrgHandleView> {
    const organizationId = session.organizationId;
    const handle = normalizeHandle(raw);
    const refusal = handleRefusal(handle, await this.categories());
    if (refusal) throw ToolsetErrors.handleInvalid({ reason: refusal });

    const org = await this.organizations.findById(organizationId);
    if (!org) throw ToolsetErrors.notFound();
    if (org.handle === handle && org.handleStatus === HandleStatus.ACTIVE) {
      return this.get(organizationId);
    }
    if (org.handleLockedAt || org.handleStatus === HandleStatus.FROZEN) {
      throw ToolsetErrors.handleLocked();
    }

    if (!(await this.isVerified(organizationId))) {
      throw ToolsetErrors.handleClaimRefused({ reason: 'NOT_VERIFIED' });
    }
    const user = await this.claimantOf(session);
    const since = new Date(this.now().getTime() - HANDLE_CLAIM_WINDOW_MS);
    if (!claimGateAllows(await this.claims.recentOrgIds(user, since), organizationId)) {
      throw ToolsetErrors.handleClaimRefused({ reason: 'CLAIM_LIMIT' });
    }

    try {
      await this.dataSource.transaction(async (manager) => {
        await lockHandle(manager, handle);
        if (!(await this.isAvailable(manager, handle, organizationId))) {
          throw ToolsetErrors.handleTaken({ suggestions: await this.freeSuggestions(handle) });
        }
        await manager.update(
          OrganizationEntity,
          { id: organizationId, handleLockedAt: IsNull() },
          { handle, handleStatus: HandleStatus.ACTIVE },
        );
        await manager.insert(OrgHandleClaimEntity, {
          orgId: organizationId,
          privyUserId: user,
          handle,
          claimedAt: this.now(),
        });
        await this.audit.record(manager, {
          organizationId,
          actor,
          action: org.handle ? 'org.handle_changed' : 'org.handle_claimed',
          resourceType: 'organization',
          resourceId: organizationId,
          before: { handle: org.handle },
          after: { handle },
        });
      });
    } catch (error) {
      if ((error as { code?: string })?.code === UNIQUE_VIOLATION_CODE) {
        throw ToolsetErrors.handleTaken({ suggestions: await this.freeSuggestions(handle) });
      }
      throw error;
    }
    return this.get(organizationId);
  }

  /**
   * Sets `handle_locked_at` on the first UNLISTED or PUBLIC share, in the
   * sharing transaction. Refuses when the organization has no active handle.
   */
  async lockForSharing(manager: EntityManager, organizationId: string): Promise<string> {
    const org = await manager.findOne(OrganizationEntity, { where: { id: organizationId } });
    if (!org?.handle || org.handleStatus !== HandleStatus.ACTIVE) {
      throw ToolsetErrors.handleRequired();
    }
    if (!org.handleLockedAt) {
      await manager.update(
        OrganizationEntity,
        { id: organizationId, handleLockedAt: IsNull() },
        { handleLockedAt: this.now() },
      );
    }
    return org.handle;
  }

  /**
   * A handle in a URL → whom it names, or `null` (the same 404 for unknown,
   * frozen and expired). An old handle kept as a rename alias resolves to its
   * organization until `alias_until`, unless that organization's current
   * handle is frozen: a takedown stops the aliases too.
   */
  async resolve(handle: string): Promise<ResolvedHandle | null> {
    if (handle === OFFICIAL_HANDLE) return { kind: 'OFFICIAL' };
    const current = await this.organizations
      .createQueryBuilder('org')
      .where('lower(org.handle) = :handle', { handle })
      .getOne();
    if (current) {
      return current.handleStatus === HandleStatus.ACTIVE
        ? {
            kind: 'ORG',
            organizationId: current.id,
            handle,
            renamedTo: null,
            aliasUntil: null,
          }
        : null;
    }

    const held = await this.history.findHeld(handle);
    if (
      !held ||
      held.reason !== HandleHistoryReason.RENAME ||
      !held.aliasUntil ||
      held.aliasUntil.getTime() <= this.now().getTime()
    ) {
      return null;
    }
    const org = await this.organizations.findById(held.orgId);
    if (!org?.handle || org.handleStatus !== HandleStatus.ACTIVE) return null;
    return {
      kind: 'ORG',
      organizationId: org.id,
      handle,
      renamedTo: org.handle,
      aliasUntil: held.aliasUntil,
    };
  }

  /** The active handle of each organization, for building URLs and pages. */
  async handlesOf(organizationIds: readonly string[]): Promise<Map<string, string>> {
    const ids = [...new Set(organizationIds)];
    if (ids.length === 0) return new Map();
    const rows = await this.organizations
      .createQueryBuilder('org')
      .where('org.id IN (:...ids)', { ids })
      .andWhere('org.handle IS NOT NULL')
      .andWhere(`org.handle_status = 'ACTIVE'`)
      .getMany();
    return new Map(rows.map((row) => [row.id, row.handle as string]));
  }

  /**
   * Verified: the organization funded once (a confirmed deposit or an opened
   * escrow), or holds a provider account the platform verified. The provider
   * publish gate (T4) will join this.
   */
  async isVerified(organizationId: string): Promise<boolean> {
    const [row] = (await this.dataSource.query(
      `SELECT (
         EXISTS (SELECT 1 FROM ledger_entries
                  WHERE organization_id = $1 AND entry_type IN ('DEPOSIT', 'DEPOSIT_CONFIRM'))
         OR EXISTS (SELECT 1 FROM deposit_intents
                     WHERE organization_id = $1 AND status = 'SETTLED')
         OR EXISTS (SELECT 1 FROM buyer_escrows
                     WHERE organization_id = $1 AND opened_at IS NOT NULL)
         OR EXISTS (SELECT 1 FROM providers WHERE organization_id = $1 AND verified)
       ) AS verified`,
      [organizationId],
    )) as { verified: boolean }[];
    return row?.verified === true;
  }

  /** Free of every current handle and every held old one (`manager` holds the lock). */
  async isAvailable(
    manager: EntityManager,
    handle: string,
    exceptOrganizationId: string | null,
  ): Promise<boolean> {
    const [row] = (await manager.query(
      `SELECT
         EXISTS (SELECT 1 FROM organizations
                  WHERE lower(handle) = $1 AND ($2::uuid IS NULL OR id <> $2::uuid)) AS current,
         EXISTS (SELECT 1 FROM org_handle_history
                  WHERE lower(old_handle) = $1 AND reassigned_at IS NULL) AS held`,
      [handle, exceptOrganizationId],
    )) as { current: boolean; held: boolean }[];
    return !row.current && !row.held;
  }

  /** Category names in use, every one of them reserved. */
  async categories(): Promise<string[]> {
    const rows = (await this.dataSource.query(`SELECT DISTINCT category FROM tools`)) as {
      category: string;
    }[];
    return rows.map((row) => row.category);
  }

  /** The Privy user behind a person's session; a config-file person is keyed by its agent. */
  private async claimantOf(session: McpSession): Promise<string> {
    const agent = await this.agents.findById(session.agentId).catch(() => null);
    return agent?.privyUserId ?? `agent:${session.agentId}`;
  }

  private async freeSuggestions(handle: string): Promise<string[]> {
    const out: string[] = [];
    for (const candidate of handleSuggestions(handle, 6)) {
      if (out.length === 3) break;
      if (await this.isAvailable(this.dataSource.manager, candidate, null)) out.push(candidate);
    }
    return out;
  }
}

/** Serialises every claim, rename and reassignment of one handle. */
export async function lockHandle(manager: EntityManager, handle: string): Promise<void> {
  await manager.query(`SELECT pg_advisory_xact_lock(hashtext('handle:' || $1))`, [handle]);
}
