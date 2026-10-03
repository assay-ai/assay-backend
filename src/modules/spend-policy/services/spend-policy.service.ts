import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';

import { SpendPolicyEntity } from '@database/postgres/entities/spend-policy.entity';
import { SpendPolicyRepository } from '@database/postgres/repositories/spend-policy.repository';
import { assertOrganizationScopedValues } from '@database/postgres/organization-scope';
import { AssetId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';
import { MoneyUtil } from '@shared/utils/money.util';
import { CursorPageDto, ListSpec, applyTimeWindow, asInstant, paginate } from '@shared/api';

import {
  ListSpendPolicyHistoryQueryDto,
  SpendPolicyHistoryEntryDto,
} from '../dto/list-spend-policy-history.dto';
import { SpendPolicyDto, SpendPolicyScope, SpendPolicyUsageDto } from '../dto/get-spend-policy.dto';
import { UpdateSpendPolicyDto } from '../dto/update-spend-policy.dto';
import { SpendPolicyErrors } from '../errors/spend-policy.errors';
import { SpendUsageService } from './spend-usage.service';
import { SpendPolicyVelocityService } from './spend-policy-velocity.service';

const POLICY_HISTORY_LIST: ListSpec = {
  alias: 'policy',
  defaultSort: 'createdAt',
  sortable: {
    createdAt: {
      column: 'policy.created_at',
      type: 'timestamptz',
      valueOf: asInstant((row: SpendPolicyEntity) => row.createdAt),
    },
  },
};

/**
 * The live spend policy, its edit path, and its version history.
 *
 * ## Scope
 *
 * `McpSession` identifies an agent, not a human dashboard operator — there is
 * no separate "org admin" session type yet. So every write here targets the
 * **agent's own scope** (`agentId = session.agentId`), never the organization
 * default: a session editing its own limits is safe, a session able to
 * silently move the organization-wide default for every other agent from one
 * agent's credential would not be. `GET` still falls back to the organization
 * default for *reading* — `SpendPolicyRepository.findLive` — because an agent
 * with no override of its own is legitimately governed by the org default and
 * needs to see it.
 *
 * ## TODO
 *
 * A write here should append an `audit_log_entries` row (before/after,
 * actor, timestamp) — the audit log's "Policy" event class is exactly this.
 * Not done yet.
 */
@Injectable()
export class SpendPolicyService {
  private readonly logger = new Logger(SpendPolicyService.name);

  constructor(
    private readonly policies: SpendPolicyRepository,
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    /**
     * The live-usage block on `GET /spend-policy`.
     *
     * `@Optional()`: this service predates the enforcement services and
     * is constructed directly (no Nest DI) by `test/unit/spend-policy/spend-policy.service.spec.ts`
     * with just the first two arguments. Making these two required would
     * break that file. When absent, `get()` simply omits the `usage` block rather than
     * throwing — see that method.
     */
    @Optional() private readonly usage?: SpendUsageService,
    @Optional() private readonly velocity?: SpendPolicyVelocityService,
  ) {}

  /**
   * The live policy for `agentId`, falling back to the organization default,
   * with `usage` attached when both optional collaborators are
   * wired and computing it does not fail.
   */
  async get(organizationId: string, agentId: string): Promise<SpendPolicyDto> {
    const row = await this.policies.findLive(organizationId, agentId);
    if (!row) {
      throw SpendPolicyErrors.notFound({ agentId });
    }
    const dto = toDto(row);
    dto.usage = await this.usageFor(organizationId, agentId, row).catch((error) => {
      this.logger.warn(
        `org ${organizationId} agent ${agentId}: could not compute spend-policy usage. ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    });
    return dto;
  }

  private async usageFor(
    organizationId: string,
    agentId: string,
    policy: SpendPolicyEntity,
  ): Promise<SpendPolicyUsageDto | undefined> {
    if (!this.usage || !this.velocity) return undefined;

    const asset = policy.assetId as AssetId;
    const [spend, velocityUsage] = await Promise.all([
      this.usage.spendSoFar(organizationId, agentId, asset, policy.decimals),
      this.velocity.read(agentId),
    ]);

    return {
      spendToday: toMoneyDto(spend.spendToday),
      spendThisMonth: toMoneyDto(spend.spendThisMonth),
      spendThisHour:
        velocityUsage.readable && velocityUsage.spendThisHour !== null
          ? toMoneyDto(MoneyUtil.of(velocityUsage.spendThisHour, asset, policy.decimals))
          : null,
      callsThisMinute: velocityUsage.readable ? velocityUsage.callsThisMinute : null,
      callsThisHour: velocityUsage.readable ? velocityUsage.callsThisHour : null,
      usageReadable: velocityUsage.readable,
    };
  }

  /**
   * Writes a new version at `agentId`'s scope and supersedes the one it
   * replaces — see the class comment for why this never touches the
   * organization default.
   *
   * Every field the caller omits keeps the value of the row being replaced;
   * an explicit `null` clears it. The first version at a scope has nothing to
   * inherit from except the organization default (for the asset only, so a
   * brand-new agent override starts denominated the same way the org is), and
   * if neither exists the caller must name `assetId`/`decimals` itself.
   */
  async patch(
    organizationId: string,
    agentId: string,
    patch: UpdateSpendPolicyDto,
  ): Promise<SpendPolicyDto> {
    const current = await this.policies.findOne({
      where: { organizationId, agentId, supersededAt: IsNull() },
    });
    const orgDefault = current
      ? null
      : await this.policies.findOne({
          where: { organizationId, agentId: IsNull(), supersededAt: IsNull() },
        });
    const base = current ?? orgDefault;

    const assetId = patch.assetId ?? base?.assetId;
    const decimals = patch.decimals ?? base?.decimals;
    if (!assetId || decimals === undefined || decimals === null) {
      throw SpendPolicyErrors.assetRequired();
    }

    const values: Partial<SpendPolicyEntity> = {
      agentId,
      policyVersion: (current?.policyVersion ?? 0) + 1,
      assetId,
      decimals,
      perCallMax: resolveNullable(patch.perCallMax, current?.perCallMax ?? null),
      dailyCap: resolveNullable(patch.dailyCap, current?.dailyCap ?? null),
      monthlyCap: resolveNullable(patch.monthlyCap, current?.monthlyCap ?? null),
      maxCallsPerHour: resolveNullable(patch.maxCallsPerHour, current?.maxCallsPerHour ?? null),
      maxCallsPerMinute: resolveNullable(
        patch.maxCallsPerMinute,
        current?.maxCallsPerMinute ?? null,
      ),
      maxSpendPerHour: resolveNullable(patch.maxSpendPerHour, current?.maxSpendPerHour ?? null),
      allowedTools: resolveNullable(patch.allowedTools, current?.allowedTools ?? null),
      requireApprovalAbove: resolveNullable(
        patch.requireApprovalAbove,
        current?.requireApprovalAbove ?? null,
      ),
      paused: patch.paused ?? current?.paused ?? false,
      changedBy: patch.changedBy ?? `agent:${agentId}`,
      changeReason: patch.changeReason ?? null,
      supersededAt: null,
    };

    const row = await this.writeVersion(organizationId, current, values);
    return toDto(row);
  }

  /**
   * The version history, scoped the same way `get()` resolves —
   * the agent's own override chain if it has ever had one, otherwise the
   * organization default's chain.
   */
  async history(
    organizationId: string,
    agentId: string,
    query: ListSpendPolicyHistoryQueryDto,
  ): Promise<CursorPageDto<SpendPolicyHistoryEntryDto>> {
    const hasOwnScope = await this.policies.existsBy({ organizationId, agentId });

    const qb = this.policies
      .createQueryBuilder('policy')
      .where('policy.organizationId = :organizationId', { organizationId });

    if (hasOwnScope) {
      qb.andWhere('policy.agentId = :agentId', { agentId });
    } else {
      qb.andWhere('policy.agentId IS NULL');
    }

    applyTimeWindow(qb, query, POLICY_HISTORY_LIST);
    const page = await paginate(qb, query, POLICY_HISTORY_LIST);
    return page.map(toHistoryDto);
  }

  /**
   * Supersedes `current` (if any) and inserts `values` as the new live row, in
   * one transaction. The supersede is a compare-and-set on `superseded_at IS
   * NULL`, same reasoning as `LedgerHoldRepository.resolveIfOpen`: a second
   * concurrent PATCH loses cleanly instead of leaving two live rows at one
   * scope, which the partial unique index would refuse anyway — this turns
   * that refusal into a typed `409` instead of a raw constraint violation.
   */
  private async writeVersion(
    organizationId: string,
    current: SpendPolicyEntity | null,
    values: Partial<SpendPolicyEntity>,
  ): Promise<SpendPolicyEntity> {
    return this.dataSource.transaction(async (manager) => {
      if (current) {
        const result = await manager
          .createQueryBuilder()
          .update(SpendPolicyEntity)
          .set({ supersededAt: new Date() })
          .where('organization_id = :organizationId', { organizationId })
          .andWhere('id = :id', { id: current.id })
          .andWhere('superseded_at IS NULL')
          .execute();

        if (result.affected !== 1) {
          throw SpendPolicyErrors.concurrentModification({ id: current.id });
        }
      }

      const insertValues = { ...values, organizationId };
      assertOrganizationScopedValues(insertValues, 'SpendPolicyEntity.insertVersion');

      const insertResult = await manager
        .createQueryBuilder()
        .insert()
        .into(SpendPolicyEntity)
        .values(insertValues)
        .execute();

      const insertedId = insertResult.identifiers[0]?.id as string;
      return manager.findOneByOrFail(SpendPolicyEntity, { organizationId, id: insertedId });
    });
  }
}

/** `undefined` (omitted) keeps `previous`; an explicit `null` clears it. */
function resolveNullable<T>(patchValue: T | null | undefined, previous: T | null): T | null {
  return patchValue === undefined ? previous : patchValue;
}

/**
 * `undefined` is treated the same as `null` here, not just as a defensive
 * habit: the enforcement work added three columns to a row shape that existed
 * before it, and any fixture or partial row built against the older shape —
 * this module's own `spend-policy.service.spec.ts` included — has no key at
 * all for them rather than an explicit `null`. `MoneyUtil.of(undefined, …)` throws; treating an
 * absent key the same as an explicit `null` is what keeps every caller of
 * this DTO mapping tolerant of a row narrower than the current entity.
 */
function moneyOrNull(
  amount: string | null | undefined,
  asset: AssetId,
  decimals: number,
): MoneyDto | null {
  if (amount === null || amount === undefined) return null;
  return toMoneyDto(MoneyUtil.of(amount, asset, decimals));
}

function toMoneyDto(money: Money): MoneyDto {
  return { amount: money.amount, asset: money.asset, decimals: money.decimals };
}

function toDto(row: SpendPolicyEntity): SpendPolicyDto {
  const asset = row.assetId as AssetId;
  return {
    id: row.id,
    scope: row.agentId === null ? SpendPolicyScope.ORGANIZATION : SpendPolicyScope.AGENT,
    agentId: row.agentId,
    policyVersion: row.policyVersion,
    asset: row.assetId,
    decimals: row.decimals,
    perCallMax: moneyOrNull(row.perCallMax, asset, row.decimals),
    dailyCap: moneyOrNull(row.dailyCap, asset, row.decimals),
    monthlyCap: moneyOrNull(row.monthlyCap, asset, row.decimals),
    maxCallsPerHour: row.maxCallsPerHour ?? null,
    maxCallsPerMinute: row.maxCallsPerMinute ?? null,
    maxSpendPerHour: moneyOrNull(row.maxSpendPerHour, asset, row.decimals),
    allowedTools: row.allowedTools ?? null,
    requireApprovalAbove: moneyOrNull(row.requireApprovalAbove, asset, row.decimals),
    paused: row.paused,
    changedBy: row.changedBy,
    changeReason: row.changeReason,
    createdAt: row.createdAt.toISOString(),
  };
}

function toHistoryDto(row: SpendPolicyEntity): SpendPolicyHistoryEntryDto {
  const asset = row.assetId as AssetId;
  return {
    id: row.id,
    scope: row.agentId === null ? SpendPolicyScope.ORGANIZATION : SpendPolicyScope.AGENT,
    agentId: row.agentId,
    policyVersion: row.policyVersion,
    perCallMax: moneyOrNull(row.perCallMax, asset, row.decimals),
    dailyCap: moneyOrNull(row.dailyCap, asset, row.decimals),
    monthlyCap: moneyOrNull(row.monthlyCap, asset, row.decimals),
    maxCallsPerHour: row.maxCallsPerHour ?? null,
    maxCallsPerMinute: row.maxCallsPerMinute ?? null,
    maxSpendPerHour: moneyOrNull(row.maxSpendPerHour, asset, row.decimals),
    allowedTools: row.allowedTools ?? null,
    requireApprovalAbove: moneyOrNull(row.requireApprovalAbove, asset, row.decimals),
    paused: row.paused,
    changedBy: row.changedBy,
    changeReason: row.changeReason,
    changedAt: row.createdAt.toISOString(),
    supersededAt: row.supersededAt ? row.supersededAt.toISOString() : null,
  };
}
