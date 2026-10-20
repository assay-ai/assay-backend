import { Injectable } from '@nestjs/common';

import { SlaWindowEntity } from '@database/postgres/entities/sla-window.entity';
import { SlaWindowCallEntity } from '@database/postgres/entities/sla-window-call.entity';
import { SlaWindowCallRepository } from '@database/postgres/repositories/sla-window-call.repository';
import { SlaWindowRepository } from '@database/postgres/repositories/sla-window.repository';
import { CursorPageDto, ListSpec, asInstant, paginate } from '@shared/api';

import { ConfidenceInterval, observedRate } from '../domain/sla/sla-statistics';
import { SlaWindowOutcome, SlaWindowStatus, positionFor } from '../domain/sla/sla-window';
import {
  GetSlaWindowEvidenceResponseDto,
  GetSlaWindowResponseDto,
  ListSlaWindowsQueryDto,
  SlaWindowFailureGroupDto,
  SlaWindowSummaryDto,
} from '../dto/get-sla-windows.dto';
import { ProviderErrors } from '../errors/provider.errors';
import { countersFrom, snapshotFrom } from './sla-window-row.util';

const EVIDENCE_CALL_LIMIT = 2000;

/**
 * The list spec for `sla_windows` — one `openedAt` sort, `window.id` tiebreak.
 * `idx_sla_windows_binding_opened_at` covers the common `?bindingId=` case;
 * the unfiltered list falls back to the table's own `created_at`-style scan,
 * which is acceptable at the volume one provider's own windows reach.
 */
const SLA_WINDOW_LIST: ListSpec = {
  alias: 'window',
  defaultSort: 'openedAt',
  sortable: {
    openedAt: {
      column: 'window.opened_at',
      type: 'timestamptz',
      valueOf: asInstant((row: SlaWindowEntity) => row.openedAt),
    },
  },
  timeColumn: 'window.opened_at',
};

/**
 * `GET /providers/me/sla-windows`, `/:windowId`, `/:windowId/evidence` and
 * `/providers/me/bindings/:bindingId/sla` — the SLA workbench, live SLA
 * position and window evidence.
 *
 * Reads the real `sla_windows` / `sla_window_calls` tables, replacing the
 * rolling-UTC-day fold over `payment_intents` this service used to compute; see
 * the migration's comment for the three reasons a fold could not carry a
 * penalty. The fold also got verification wrong (`verificationVerdict IS NOT
 * NULL` counted `SKIPPED`/`MISAPPLIED`/`DEGRADED` as verified, understating
 * every provider's failure rate).
 *
 * `listWindows` / `getWindow` / `getEvidence` are ordinary organization-scoped
 * queries — a window belongs to the provider it measures
 * (`SlaWindowEntity.organizationId` is written as the provider's own org, the
 * same identity the payout records rested on).
 */
@Injectable()
export class ProviderSlaWindowsService {
  constructor(
    private readonly windows: SlaWindowRepository,
    private readonly calls: SlaWindowCallRepository,
  ) {}

  async listWindows(
    organizationId: string,
    query: ListSlaWindowsQueryDto,
  ): Promise<CursorPageDto<SlaWindowSummaryDto>> {
    const qb = this.windows
      .createQueryBuilder('window')
      .where('window.organizationId = :organizationId', { organizationId });

    if (query.bindingId) {
      qb.andWhere('window.bindingId = :bindingId', { bindingId: query.bindingId });
    }
    if (query.status) {
      qb.andWhere('window.status = :status', { status: query.status });
    }
    if (query.outcome) {
      qb.andWhere('window.outcome = :outcome', { outcome: query.outcome });
    }

    const page = await paginate(qb, query, SLA_WINDOW_LIST);
    return page.map(toSummaryDto);
  }

  /** One window with its full live position. */
  async getWindow(organizationId: string, windowId: string): Promise<GetSlaWindowResponseDto> {
    const window = await this.windows.findOneBy({ organizationId, id: windowId });
    if (!window) {
      throw ProviderErrors.slaWindowNotFound({ windowId });
    }

    const position = positionFor(snapshotFrom(window), countersFrom(window));

    return {
      ...toSummaryDto(window),
      state: position.state,
      slashable: position.slashable,
      confidenceInterval: toIntervalDto(position.confidenceInterval),
      projectedSampleAtClose: position.projectedSampleAtClose,
      effectiveThresholdAtClose: position.effectiveThresholdAtClose,
      toleranceAtClose: position.toleranceAtClose,
      errorBudgetCalls: position.errorBudgetCalls,
      errorBudgetUsedCalls: position.errorBudgetUsedCalls,
      errorBudgetRemainingCalls: position.errorBudgetRemainingCalls,
      errorBudgetUsedFraction: position.errorBudgetUsedFraction,
      projectedFailureRate: position.projectedFailureRate,
      projectedFailedCalls: position.projectedFailedCalls,
      projectedBreach: position.projectedBreach,
      confidentlyAboveDeclared: position.confidentlyAboveDeclared,
    };
  }

  /** Window evidence — retrievable for any window, not only slashed ones. */
  async getEvidence(
    organizationId: string,
    windowId: string,
  ): Promise<GetSlaWindowEvidenceResponseDto> {
    const window = await this.windows.findOneBy({ organizationId, id: windowId });
    if (!window) {
      throw ProviderErrors.slaWindowNotFound({ windowId });
    }

    const [calls, reasonGroups, agentGroups] = await Promise.all([
      this.calls.findByWindow(organizationId, windowId, EVIDENCE_CALL_LIMIT),
      this.calls.countFailuresByReasonCode(organizationId, windowId),
      this.calls.countFailuresByAgentId(organizationId, windowId),
    ]);

    return {
      ...toSummaryDto(window),
      calls: calls.map(toCallDto),
      failuresByReasonCode: reasonGroups.map(toGroupDto),
      failuresByAgentId: agentGroups.map(toGroupDto),
    };
  }
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function toSummaryDto(window: SlaWindowEntity): SlaWindowSummaryDto {
  return {
    windowId: window.id,
    label: `w_${window.sequence}`,
    sequence: window.sequence,
    bindingId: window.bindingId,
    toolId: window.toolId,
    status: window.status as SlaWindowStatus,
    outcome: window.outcome as SlaWindowOutcome | null,
    openedAt: window.openedAt,
    deadlineAt: window.deadlineAt,
    closedAt: window.closedAt,
    declaredFailureRate: Number(window.declaredFailureRate),
    minVerifiedCalls: window.minVerifiedCalls,
    totalCalls: window.totalCalls,
    verifiedCalls: window.verifiedCalls,
    failedCalls: window.failedCalls,
    observedFailureRate: observedRate(window.failedCalls, window.verifiedCalls),
    totalCallAmount: window.totalCallAmount,
    assetId: window.assetId,
    warningLevel: window.warningLevel as 'WARNING' | 'CRITICAL' | null,
    samplingEscalationRequested: window.samplingEscalationRequested,
  };
}

function toCallDto(call: SlaWindowCallEntity) {
  return {
    intentId: call.intentId,
    agentId: call.agentId,
    verdict: call.verdict,
    reasonCode: call.reasonCode,
    countedAsQuality: call.countedAsQuality,
    countedAsFailure: call.countedAsFailure,
    priceAmount: call.priceAmount,
    assetId: call.assetId,
    postedAt: call.postedAt,
  };
}

function toGroupDto(row: { key: string; count: string }): SlaWindowFailureGroupDto {
  return { key: row.key, count: Number(row.count) };
}

function toIntervalDto(
  interval: ConfidenceInterval | null,
): { lower: number; upper: number } | null {
  return interval === null ? null : { lower: interval.lower, upper: interval.upper };
}
