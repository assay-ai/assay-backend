import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { OverrideLogEntryEntity } from '@database/postgres/entities/override-log-entry.entity';
import { OperatorApprovalRepository } from '@database/postgres/repositories/operator-approval.repository';
import { OverrideLogEntryRepository } from '@database/postgres/repositories/override-log-entry.repository';
import { OperatorRepository } from '@database/postgres/repositories/operator.repository';
import { ApiCursorPage, CursorPageDto, ListSpec, asInstant, paginate } from '@shared/api';
import { OperatorAuthGuard, OperatorRolesGuard } from '@shared/auth';

import { lookupOverride, OverrideFamily } from '../domain/override-register';
import { ListOverrideLogQueryDto, OverrideLogEntryDto } from '../dto/operator-console.dto';
import { OperatorOverrideGuard } from '../guards/operator-override.guard';
import { debtVoidOutcome, DEBT_VOID_TARGET } from '../services/operator-buyer-debt.service';

/**
 * The register, read.
 *
 * Read-only, and every route here is a `GET`, so no `@Override` is declared —
 * `OperatorOverrideGuard` only demands one of mutating handlers. Read tools are
 * audited too, and that is true: a console searchable by wallet address is an
 * exfiltration tool as much as an override is. But the audit a *lookup* needs
 * is access logging, and putting `GET /operator/override-log` into the override
 * register would bury the interventions under the reads of them.
 *
 * That access logging does not exist yet.
 *
 * ## What the search matches
 *
 * Full text over `reason` — the field an incident review actually greps,
 * backed by `idx_override_log_entries_reason_fts` — plus a literal contains
 * match on the ticket and on the actor's or approver's display name or email,
 * which is what the console's "who, reason, ticket" box promises. Actor, target
 * and ticket keep their own exact-match filters for a precise read; `q` is the
 * loose one.
 */
@ApiTags('Operator')
@ApiBearerAuth()
@UseGuards(OperatorAuthGuard, OperatorRolesGuard, OperatorOverrideGuard)
@Controller('operator/override-log')
export class OperatorOverrideLogController {
  constructor(
    private readonly entries: OverrideLogEntryRepository,
    private readonly operators: OperatorRepository,
    private readonly approvals: OperatorApprovalRepository,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Every manual intervention, newest first' })
  @ApiCursorPage(OverrideLogEntryDto)
  async list(@Query() query: ListOverrideLogQueryDto): Promise<CursorPageDto<OverrideLogEntryDto>> {
    const page = await paginate(
      this.entries.feedQueryBuilder({
        family: query.family,
        actorOperatorId: query.actorOperatorId,
        targetType: query.targetType,
        targetId: query.targetId,
        ticketRef: query.ticketRef,
        search: query.q,
      }),
      query,
      OVERRIDE_LOG_LIST,
    );

    const subjects = await this.resolveSubjects(page.items);
    const outcomes = await this.debtVoidOutcomes(page.items);

    const items: OverrideLogEntryDto[] = page.items.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      family: row.family as OverrideFamily,
      code: row.code,
      // The label comes from the register rather than from the row, so a
      // renamed action reads correctly on every historical entry. The `action`
      // string is what was recorded and does not move.
      label: lookupOverride(row.code)?.label ?? row.action,
      action: row.action,
      actorSubject: subjects.get(row.actorOperatorId) ?? row.actorOperatorId,
      approverSubject: row.approverOperatorId
        ? (subjects.get(row.approverOperatorId) ?? row.approverOperatorId)
        : null,
      approvalMode: row.approvalMode as OverrideLogEntryDto['approvalMode'],
      targetType: row.targetType,
      targetId: row.targetId,
      organizationId: row.organizationId,
      reasonCode: row.reasonCode,
      reason: row.reason,
      before: row.before,
      after: row.after,
      ticketRef: row.ticketRef,
      breakGlass: row.breakGlass,
      ...(row.targetType === DEBT_VOID_TARGET
        ? { outcome: outcomes.get(approvalIdOf(row)) ?? null }
        : {}),
    }));

    return new CursorPageDto(items, page.pageInfo.nextCursor);
  }

  /**
   * A bulk buyer-debt void's entry is written BEFORE the voids run (the
   * register is append-only), so its `after` carries only what was pinned and
   * the approval's id. What the void did is kept with that approval
   * (`operator_approvals.result`); it is read here, in one query per page, so
   * the feed can say "voided N, skipped M" rather than repeat the request.
   */
  private async debtVoidOutcomes(
    rows: readonly OverrideLogEntryEntity[],
  ): Promise<Map<string, ReturnType<typeof debtVoidOutcome>>> {
    const ids = [
      ...new Set(
        rows
          .filter((row) => row.targetType === DEBT_VOID_TARGET)
          .map(approvalIdOf)
          .filter((id) => id !== ''),
      ),
    ];
    const found = new Map<string, ReturnType<typeof debtVoidOutcome>>();
    for (const approval of await this.approvals.findManyById(ids)) {
      found.set(approval.id, debtVoidOutcome(approval.result));
    }
    return found;
  }

  private async resolveSubjects(
    rows: { actorOperatorId: string; approverOperatorId: string | null }[],
  ): Promise<Map<string, string>> {
    const ids = new Set<string>();
    for (const row of rows) {
      ids.add(row.actorOperatorId);
      if (row.approverOperatorId) ids.add(row.approverOperatorId);
    }

    const map = new Map<string, string>();
    for (const id of ids) {
      const operator = await this.operators.findById(id);
      if (operator) map.set(id, operator.subject);
    }
    return map;
  }
}

/** The approval a bulk void's entry names in `after.approvalId`; `''` when it names none. */
function approvalIdOf(row: OverrideLogEntryEntity): string {
  const id = (row.after as { approvalId?: unknown } | null)?.approvalId;
  return typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? id : '';
}

/**
 * Newest first, tiebroken on id — the ordering `idx_override_log_entries_feed`
 * is built for.
 *
 * `created_at` is the only sortable field, and that is not a limitation to be
 * lifted later. The register is append-only, so `created_at` *is* the order
 * things happened in; offering any other ordering would let a reader page
 * through an audit trail in a sequence that never occurred.
 */
const OVERRIDE_LOG_LIST: ListSpec = {
  alias: 'entry',
  defaultSort: 'createdAt',
  sortable: {
    createdAt: {
      column: 'entry.created_at',
      type: 'timestamptz',
      valueOf: asInstant((row: OverrideLogEntryEntity) => row.createdAt),
    },
  },
  timeColumn: 'entry.created_at',
};
