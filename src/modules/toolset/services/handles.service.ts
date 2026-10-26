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
import { DEPOSIT_MINIMUM_USD } from '@modules/payment/constants/deposit-intent.constants';
import { AuditActor, AuditLogWriter } from '@shared/audit';

import {
  HANDLE_CLAIM_WINDOW_MS,
  HandleHistoryReason,
  HandleStatus,
  OFFICIAL_HANDLE,
  claimGateAllows,
  handleRefusal,
  handleSkeleton,
  handleSuggestions,
  normalizeHandle,
} from '../domain/handle';
import { ToolsetErrors } from '../errors/toolset.errors';
import { TOOLSET_CLOCK, ToolsetClock, systemClock } from './toolset-clock';
import { lockHandle, renameHandleTools } from './handle-tools';

export { lockHandle };

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

    // Funded once, or the one free name of a set-up provider (below).
    const funded = await this.isVerified(organizationId);
    if (!funded) await this.assertFreeProviderName(this.dataSource.manager, organizationId);
    const user = await this.claimantOf(session);
    const since = new Date(this.now().getTime() - HANDLE_CLAIM_WINDOW_MS);
    if (!claimGateAllows(await this.claims.recentOrgIds(user, since), organizationId)) {
      throw ToolsetErrors.handleClaimRefused({ reason: 'CLAIM_LIMIT' });
    }

    try {
      await this.dataSource.transaction(async (manager) => {
        // The claimant first, then the handle, then the organization, always
        // in this order: two claims by one person serialise on the gate, two
        // claims of one name on the name, two claims by one organization on
        // its row, and no order can deadlock another.
        await lockClaimant(manager, user);
        await lockHandle(manager, handle);
        // The organization again, locked: a claim, a reassignment or a tool
        // created since the read above changed what it holds.
        const current = await manager.findOne(OrganizationEntity, {
          where: { id: organizationId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!current) throw ToolsetErrors.notFound();
        if (current.handle === handle && current.handleStatus === HandleStatus.ACTIVE) return;
        // Locked or frozen since the read above: nothing changed, so nothing
        // is claimed and nothing is audited.
        if (current.handleLockedAt || current.handleStatus === HandleStatus.FROZEN) {
          throw ToolsetErrors.handleLocked();
        }
        // The gate again, under the claimant's lock: the read above raced.
        const recent = (
          (await manager.query(
            `SELECT DISTINCT org_id AS "orgId" FROM org_handle_claims
              WHERE privy_user_id = $1 AND claimed_at >= $2`,
            [user, since],
          )) as { orgId: string }[]
        ).map((row) => row.orgId);
        if (!claimGateAllows(recent, organizationId)) {
          throw ToolsetErrors.handleClaimRefused({ reason: 'CLAIM_LIMIT' });
        }
        // The free name again, under the organization's lock: two claims of
        // one organization serialise here, so the second sees the first's
        // claim row and its handle, and is refused.
        if (!funded) await this.assertFreeProviderName(manager, organizationId);
        if (!(await this.isAvailable(manager, handle, organizationId))) {
          throw ToolsetErrors.handleTaken({ suggestions: await this.freeSuggestions(handle) });
        }
        // Its provider tools (all PRIVATE before the lock) are named under it.
        const previous = current.handle;
        if (previous) await renameHandleTools(manager, organizationId, previous, handle);
        await manager.update(
          OrganizationEntity,
          { id: organizationId },
          { handle, handleSkeleton: handleSkeleton(handle), handleStatus: HandleStatus.ACTIVE },
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
          action: previous ? 'org.handle_changed' : 'org.handle_claimed',
          resourceType: 'organization',
          resourceId: organizationId,
          before: { handle: previous },
          after: funded ? { handle } : { handle, freeProviderName: true },
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

  /**
   * Whether a toolset of `ownerOrgId` may be reached at all by another
   * organization: Official, or its owner's handle is active. A frozen (taken
   * down) or missing handle stops every way in — URL, id, pin or copy.
   */
  async ownerHandleActive(ownerOrgId: string | null): Promise<boolean> {
    if (ownerOrgId === null) return true;
    return (await this.handlesOf([ownerOrgId])).has(ownerOrgId);
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

  /**
   * The one exception to "fund once first": an organization whose provider
   * setup is complete — an ACTIVE provider with a proved payout address (an
   * ACTIVE enrolment exists only after the payout signature) — may claim its
   * FIRST public name unfunded, so a provider can publish a free tool without
   * a deposit. Proving a payout address is per-wallet work a bulk grabber has
   * to repeat, and the person-wide 3-in-30-days gate still applies.
   *
   * "First" means the organization holds no handle and never claimed one:
   * `org_handle_claims` rows are never deleted, so a takedown that clears the
   * handle, or a change before the lock, cannot replay it. Throws the
   * `NOT_VERIFIED` refusal, with what the console needs to offer "Add funds".
   */
  private async assertFreeProviderName(
    manager: EntityManager,
    organizationId: string,
  ): Promise<void> {
    const [row] = (await manager.query(
      `SELECT
         (EXISTS (SELECT 1 FROM providers
                   WHERE organization_id = $1 AND status = 'ACTIVE')
          AND EXISTS (SELECT 1 FROM provider_chain_enrolments
                       WHERE organization_id = $1 AND status = 'ACTIVE')) AS "providerSetUp",
         (EXISTS (SELECT 1 FROM organizations WHERE id = $1 AND handle IS NOT NULL)
          OR EXISTS (SELECT 1 FROM org_handle_claims WHERE org_id = $1)) AS "claimedBefore"`,
      [organizationId],
    )) as { providerSetUp: boolean; claimedBefore: boolean }[];
    const providerSetUp = row?.providerSetUp === true;
    if (providerSetUp && row?.claimedBefore === false) return;
    throw ToolsetErrors.handleClaimRefused({
      reason: 'NOT_VERIFIED',
      fundingRequired: true,
      minimumDepositUsd: DEPOSIT_MINIMUM_USD,
      providerSetUp,
    });
  }

  /** Free of every current handle and every held old one (`manager` holds the lock). */
  async isAvailable(
    manager: EntityManager,
    handle: string,
    exceptOrganizationId: string | null,
  ): Promise<boolean> {
    // By name and by skeleton: a handle that reads like a current or held
    // one (`strlpe` beside `stripe`) is taken too.
    const [row] = (await manager.query(
      `SELECT
         EXISTS (SELECT 1 FROM organizations
                  WHERE (lower(handle) = $1 OR handle_skeleton = $3)
                    AND ($2::uuid IS NULL OR id <> $2::uuid)) AS current,
         EXISTS (SELECT 1 FROM org_handle_history
                  WHERE (lower(old_handle) = $1 OR old_skeleton = $3)
                    AND reassigned_at IS NULL) AS held`,
      [handle, exceptOrganizationId, handleSkeleton(handle)],
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

/** Serialises the claims of one Privy user, so the 3-in-30-days gate holds under concurrency. */
export async function lockClaimant(manager: EntityManager, user: string): Promise<void> {
  await manager.query(`SELECT pg_advisory_xact_lock(hashtext('claimant:' || $1))`, [user]);
}
