import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';

import { AgentEntity } from '@database/postgres/entities/agent.entity';
import { SpendPolicyEntity } from '@database/postgres/entities/spend-policy.entity';
import { SpendPolicyRepository } from '@database/postgres/repositories/spend-policy.repository';
import { assertOrganizationScopedValues } from '@database/postgres/organization-scope';
import { AccountErrors } from '@modules/account/errors/account.errors';
import { AssetId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';
import { AuditActor, AuditLogWriter, changedFields } from '@shared/audit';
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

/** A uuid, checked before it reaches a `uuid` column (an invalid one would be a 500). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * ## Audit
 *
 * Every write appends an `audit_log_entries` row (`spend_policy.created` /
 * `spend_policy.updated`, the changed fields before and after) in the same
 * transaction as the version it describes — see `writeVersion`.
 */
@Injectable()
export class SpendPolicyService {
  private readonly logger = new Logger(SpendPolicyService.name);

  constructor(
    private readonly policies: SpendPolicyRepository,
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    private readonly audit: AuditLogWriter,
    /**
     * The live-usage block on `GET /spend-policy`.
     *
     * `@Optional()`: this service predates the enforcement services and
     * is constructed directly (no Nest DI) by `test/unit/spend-policy/spend-policy.service.spec.ts`
     * without the last two arguments. Making these two required would
     * break that file. When absent, `get()` simply omits the `usage` block rather than
     * throwing — see that method.
     */
    @Optional() private readonly usage?: SpendUsageService,
    @Optional() private readonly velocity?: SpendPolicyVelocityService,
  ) {}

  /**
   * Which agent `GET /spend-policy?agentId=` reads (BUG-BUY-CONNECT-05): the
   * named agent only when a person asks and the agent belongs to the
   * caller's own organization. Anything else — an agent credential asking
   * about another agent, a malformed or repeated id, an agent of another
   * organization or none at all — reads the session's own agent, as the route
   * did before the parameter existed, so a foreign id learns nothing about
   * that agent. `ignored` says so, for the response.
   */
  async readableAgentId(
    organizationId: string,
    sessionAgentId: string,
    requestedAgentId: unknown,
    human: boolean,
  ): Promise<{ agentId: string; ignored: boolean }> {
    if (requestedAgentId === undefined || requestedAgentId === sessionAgentId) {
      return { agentId: sessionAgentId, ignored: false };
    }
    const own = { agentId: sessionAgentId, ignored: true };
    if (!human || typeof requestedAgentId !== 'string' || !UUID_PATTERN.test(requestedAgentId)) {
      return own;
    }
    const exists = await this.dataSource
      .getRepository(AgentEntity)
      .exists({ where: { id: requestedAgentId, organizationId } });
    return exists ? { agentId: requestedAgentId, ignored: false } : own;
  }

  /**
   * `GET /spend-policy`: {@link get} for the agent {@link readableAgentId}
   * picks, saying which agent that was (`subjectAgentId`) and whether a
   * requested `agentId` was not read (`requestedAgentIgnored`).
   */
  async getForRequest(
    organizationId: string,
    sessionAgentId: string,
    requestedAgentId: unknown,
    human: boolean,
  ): Promise<SpendPolicyDto> {
    const subject = await this.readableAgentId(
      organizationId,
      sessionAgentId,
      requestedAgentId,
      human,
    );
    const dto = await this.get(organizationId, subject.agentId);
    dto.subjectAgentId = subject.agentId;
    dto.requestedAgentIgnored = subject.ignored;
    return dto;
  }

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
      spendThisHour: toMoneyDto(spend.spendThisHour),
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
   * an explicit `null` clears it. The first version at a scope inherits every
   * field from the organization default. Inheriting only the asset turned the
   * first override into an uncapped policy: `PATCH {paused: false}` — what the
   * console's Pause/Resume sends — replaced the org's per-call, daily and
   * monthly caps with nulls. If neither row exists the caller must name
   * `assetId`/`decimals` itself.
   *
   * A request whose values equal the live version at this scope, with no
   * `changeReason`, writes no version and no audit entry and returns the live
   * policy unchanged.
   */
  async patch(
    organizationId: string,
    agentId: string,
    patch: UpdateSpendPolicyDto,
    actor: AuditActor,
    /** The access policy, agent rules and pinned tools to set — `AgentAccessService` only. */
    access: Partial<AccessFields> = {},
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

    // After a drop ("Use account default") the scope has no live row but has
    // a history: the next version continues it rather than restarting at 1.
    const previousVersion =
      current?.policyVersion ??
      (
        await this.policies.findOne({
          where: { organizationId, agentId },
          order: { policyVersion: 'DESC' },
        })
      )?.policyVersion ??
      0;

    const values: Partial<SpendPolicyEntity> = {
      agentId,
      policyVersion: previousVersion + 1,
      assetId,
      decimals,
      perCallMax: resolveNullable(patch.perCallMax, base?.perCallMax ?? null),
      dailyCap: resolveNullable(patch.dailyCap, base?.dailyCap ?? null),
      monthlyCap: resolveNullable(patch.monthlyCap, base?.monthlyCap ?? null),
      maxCallsPerHour: resolveNullable(patch.maxCallsPerHour, base?.maxCallsPerHour ?? null),
      maxCallsPerMinute: resolveNullable(patch.maxCallsPerMinute, base?.maxCallsPerMinute ?? null),
      maxSpendPerHour: resolveNullable(patch.maxSpendPerHour, base?.maxSpendPerHour ?? null),
      // The access policy and agent rules are carried over unchanged: they
      // are written through `PATCH /agents/:id/access`, not here.
      ...accessFieldsOf(base),
      ...access,
      requireApprovalAbove: resolveNullable(
        patch.requireApprovalAbove,
        base?.requireApprovalAbove ?? null,
      ),
      paused: patch.paused ?? base?.paused ?? false,
      // From the session, never the body: a caller-chosen value would let
      // anyone write any name into the policy history.
      changedBy: `agent:${agentId}`,
      changeReason: patch.changeReason ?? null,
      supersededAt: null,
    };

    // A request that restates the live policy changes nothing, so it writes
    // nothing: an identical version and an audit entry whose only difference is
    // the version number are noise in two histories people read. A reason is
    // itself something to record, so a request that carries one still writes;
    // and the first version at this scope always does, because it is what makes
    // the agent's limits its own rather than the organization default's.
    if (current && !values.changeReason && !decidesDifferently(current, values)) {
      return toDto(current);
    }

    const row = await this.writeVersion(organizationId, current, values, actor);
    return toDto(row);
  }

  /**
   * "Use account default" (BUG-BUY-CONNECT-05 part 2): supersedes the agent's
   * own live policy with nothing, so the agent falls back to the organization
   * default, as an agent that never had a policy of its own does. A person's
   * decision (the route is behind `HumanSessionGuard`), audited as
   * `spend_policy.dropped` in the same transaction.
   *
   * The agent's row is also where its tool access, agent rules and pinned tools
   * live (`AgentAccessService`), and its pause. Dropping the row must change
   * the limits only, so it is refused (`SPEND_POLICY_DROP_REFUSED`) when any of
   * those differs from the default's — it would widen or resume the agent.
   *
   * An agent of another organization is a 404, the same as one that does not
   * exist. An agent with no policy of its own already uses the default: nothing
   * is written.
   */
  async dropAgentPolicy(
    organizationId: string,
    agentId: string,
    actor: AuditActor,
  ): Promise<SpendPolicyDto> {
    const agentExists =
      UUID_PATTERN.test(agentId) &&
      (await this.dataSource
        .getRepository(AgentEntity)
        .exists({ where: { id: agentId, organizationId } }));
    if (!agentExists) throw AccountErrors.agentNotFound({ agentId });

    const [current, orgDefault] = await Promise.all([
      this.policies.findOne({ where: { organizationId, agentId, supersededAt: IsNull() } }),
      this.policies.findOne({
        where: { organizationId, agentId: IsNull(), supersededAt: IsNull() },
      }),
    ]);
    if (!orgDefault) throw SpendPolicyErrors.notFound({ agentId });

    if (current) {
      if (JSON.stringify(accessFieldsOf(current)) !== JSON.stringify(accessFieldsOf(orgDefault))) {
        throw SpendPolicyErrors.dropRefused({ agentId, reason: 'ACCESS_DIFFERS' });
      }
      if (current.paused && !orgDefault.paused) {
        throw SpendPolicyErrors.dropRefused({ agentId, reason: 'PAUSED' });
      }
      await this.dataSource.transaction(async (manager) => {
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
        await this.audit.record(manager, {
          organizationId,
          actor,
          action: 'spend_policy.dropped',
          resourceType: 'spend_policy',
          resourceId: current.id,
          before: { agentId, ...auditedFieldsOf(current) },
          after: {
            agentId,
            fallsBackTo: orgDefault.id,
            organizationPolicyVersion: orgDefault.policyVersion,
          },
        });
      });
    }

    return this.getForRequest(organizationId, agentId, agentId, true);
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
   * one transaction, together with the audit entry for the change — a failed
   * audit write rolls the version back. The supersede is a compare-and-set on `superseded_at IS
   * NULL`, same reasoning as `LedgerHoldRepository.resolveIfOpen`: a second
   * concurrent PATCH loses cleanly instead of leaving two live rows at one
   * scope, which the partial unique index would refuse anyway — this turns
   * that refusal into a typed `409` instead of a raw constraint violation.
   */
  private async writeVersion(
    organizationId: string,
    current: SpendPolicyEntity | null,
    values: Partial<SpendPolicyEntity>,
    actor: AuditActor,
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

      await this.audit.record(manager, {
        organizationId,
        actor,
        action: current ? 'spend_policy.updated' : 'spend_policy.created',
        resourceType: 'spend_policy',
        resourceId: insertedId,
        ...auditDiff(current, values),
      });

      return manager.findOneByOrFail(SpendPolicyEntity, { organizationId, id: insertedId });
    });
  }
}

/**
 * The access policy, the agent rules and the pinned tools: versioned with the
 * rest of the row and audited like it, but edited only by `AgentAccessService`.
 */
export const ACCESS_FIELDS = [
  'accessMode',
  'allowedToolsets',
  'allowedToolIds',
  'ruleExcludeProviderIds',
  'ruleMaxPrice',
  'ruleMinTier',
  'ruleMinQuality',
  'pinnedTools',
] as const;

export type AccessFields = Pick<SpendPolicyEntity, (typeof ACCESS_FIELDS)[number]>;

/** `base`'s access fields, or the defaults (everything allowed, no rules). */
export function accessFieldsOf(base: Partial<SpendPolicyEntity> | null | undefined): AccessFields {
  return {
    accessMode: base?.accessMode ?? 'ALL',
    allowedToolsets: base?.allowedToolsets ?? [],
    allowedToolIds: base?.allowedToolIds ?? [],
    ruleExcludeProviderIds: base?.ruleExcludeProviderIds ?? [],
    ruleMaxPrice: base?.ruleMaxPrice ?? null,
    ruleMinTier: base?.ruleMinTier ?? null,
    ruleMinQuality: base?.ruleMinQuality ?? null,
    pinnedTools: base?.pinnedTools ?? [],
  };
}

/** What a policy version decides — the fields an audit entry compares. */
const AUDITED_FIELDS = [
  'perCallMax',
  'dailyCap',
  'monthlyCap',
  'maxSpendPerHour',
  'maxCallsPerHour',
  'maxCallsPerMinute',
  'requireApprovalAbove',
  'paused',
  ...ACCESS_FIELDS,
  'policyVersion',
] as const;

/** The audited fields of one version, as an audit entry's `before`. */
function auditedFieldsOf(row: SpendPolicyEntity): Record<string, unknown> {
  const normalised = { ...row, ...accessFieldsOf(row) };
  return Object.fromEntries(AUDITED_FIELDS.map((field) => [field, normalised[field] ?? null]));
}

/** Whether `values` would decide anything differently from the live `current`. */
function decidesDifferently(
  current: SpendPolicyEntity,
  values: Partial<SpendPolicyEntity>,
): boolean {
  const pick = (row: Partial<SpendPolicyEntity>): Record<string, unknown> => {
    const normalised = { ...row, ...accessFieldsOf(row) };
    return Object.fromEntries(
      (['assetId', 'decimals', ...AUDITED_FIELDS] as const)
        .filter((field) => field !== 'policyVersion')
        .map((field) => [field, normalised[field] ?? null]),
    );
  };
  return Object.keys(changedFields(pick(current), pick(values)).after).length > 0;
}

/**
 * The changed fields only. A first version has no `before`, and its `after`
 * lists what it sets (nulls omitted). Amounts are base units, as stored.
 */
function auditDiff(
  current: SpendPolicyEntity | null,
  values: Partial<SpendPolicyEntity>,
): { before: Record<string, unknown> | null; after: Record<string, unknown> } {
  const pick = (row: Partial<SpendPolicyEntity>): Record<string, unknown> => {
    const normalised = { ...row, ...accessFieldsOf(row) };
    return Object.fromEntries(AUDITED_FIELDS.map((field) => [field, normalised[field] ?? null]));
  };
  const reason = values.changeReason ? { changeReason: values.changeReason } : {};
  const defaults: Record<string, unknown> = accessFieldsOf(null);

  if (!current) {
    // Nulls omitted, and the access defaults too (everything allowed, no
    // rules): a first version lists what it sets, not what it leaves alone.
    const set = Object.entries(pick(values)).filter(
      ([field, value]) =>
        value !== null &&
        !(field in defaults && JSON.stringify(defaults[field]) === JSON.stringify(value)),
    );
    return { before: null, after: { ...Object.fromEntries(set), ...reason } };
  }
  const diff = changedFields(pick(current), pick(values));
  return { before: diff.before, after: { ...diff.after, ...reason } };
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
    requireApprovalAbove: moneyOrNull(row.requireApprovalAbove, asset, row.decimals),
    paused: row.paused,
    changedBy: row.changedBy,
    changeReason: row.changeReason,
    changedAt: row.createdAt.toISOString(),
    supersededAt: row.supersededAt ? row.supersededAt.toISOString() : null,
  };
}
