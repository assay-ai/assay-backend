import { Inject, Injectable } from '@nestjs/common';

import { SlaWindowEntity } from '@database/postgres/entities/sla-window.entity';
import { SlaWindowCallEntity } from '@database/postgres/entities/sla-window-call.entity';
import { SlaWindowCallRepository } from '@database/postgres/repositories/sla-window-call.repository';
import { SlaWindowRepository } from '@database/postgres/repositories/sla-window.repository';
import { ToolBindingRepository } from '@database/postgres/repositories/tool-binding.repository';
import { CursorPageDto, ListSpec, asInstant, paginate } from '@shared/api';

import { SLA_WINDOW_CONFIG, SlaWindowConfig } from '../constants/sla-window.constants';
import {
  ConfidenceInterval,
  effectiveThreshold,
  observedRate,
  wilsonInterval,
} from '../domain/sla/sla-statistics';
import { SlaWindowOutcome, SlaWindowStatus, positionFor } from '../domain/sla/sla-window';
import {
  GetBindingSlaResponseDto,
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

interface PeerRow {
  readonly bindingId: string;
  readonly verifiedCalls: string;
  readonly failedCalls: string;
}

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
 * same identity `ProviderPayoutsService` rests on). `getBindingSla`'s peer
 * distribution is the one **deliberately cross-organization** query here, on
 * the same terms as `ProviderTrafficService`: "the median binding on this
 * tool" is a question about every provider who implements it, not about the
 * caller alone, and the `organizationId IS NOT NULL` idiom is what proves
 * that to `OrganizationScopedRepository.createQueryBuilder`'s guard. Only
 * aggregates cross that boundary — never another binding's id, provider, or
 * identity.
 */
@Injectable()
export class ProviderSlaWindowsService {
  constructor(
    private readonly windows: SlaWindowRepository,
    private readonly calls: SlaWindowCallRepository,
    private readonly bindings: ToolBindingRepository,
    @Inject(SLA_WINDOW_CONFIG) private readonly config: SlaWindowConfig,
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

  /** The SLA workbench. */
  async getBindingSla(
    organizationId: string,
    bindingId: string,
  ): Promise<GetBindingSlaResponseDto> {
    const binding = await this.bindings.findOneBy({ organizationId, id: bindingId });
    if (!binding) {
      throw ProviderErrors.bindingNotFound({ bindingId });
    }

    const [openWindow, closedAggregate, peerRows] = await Promise.all([
      this.windows.findOpenForBinding(organizationId, bindingId),
      this.closedAggregateForBinding(organizationId, bindingId),
      this.peerRowsForTool(binding.toolId),
    ]);

    const measured =
      closedAggregate.verifiedCalls > 0
        ? {
            verifiedCalls: closedAggregate.verifiedCalls,
            failedCalls: closedAggregate.failedCalls,
            observedFailureRate: observedRate(
              closedAggregate.failedCalls,
              closedAggregate.verifiedCalls,
            ),
            confidenceInterval: toIntervalDto(
              wilsonInterval(
                closedAggregate.failedCalls,
                closedAggregate.verifiedCalls,
                this.config.zScore,
              ),
            ),
          }
        : null;

    const currentDeclaredFailureRate = Number(binding.slaFailureRate);
    // "The effective threshold at the provider's own volume": the volume
    // actually measured across closed windows, floored at the sample gate —
    // the same `max(measured, minVerifiedCalls)` `positionFor` uses to project
    // an in-flight window's threshold, applied here to the provider's whole
    // closed history instead of one window.
    const n = Math.max(closedAggregate.verifiedCalls, this.config.minVerifiedCalls);
    const threshold =
      effectiveThreshold(currentDeclaredFailureRate, n, this.config.zScore) ??
      currentDeclaredFailureRate;

    return {
      bindingId,
      toolId: binding.toolId,
      currentDeclaredFailureRate,
      inFlightWindow: openWindow
        ? {
            windowId: openWindow.id,
            label: `w_${openWindow.sequence}`,
            declaredFailureRate: Number(openWindow.declaredFailureRate),
            openedAt: openWindow.openedAt,
            verifiedCalls: openWindow.verifiedCalls,
          }
        : null,
      measured,
      effectiveThreshold: threshold,
      minVerifiedCalls: this.config.minVerifiedCalls,
      peers: computePeerDistribution(bindingId, peerRows),
    };
  }

  private async closedAggregateForBinding(
    organizationId: string,
    bindingId: string,
  ): Promise<{ verifiedCalls: number; failedCalls: number }> {
    const row = await this.windows
      .createQueryBuilder('window')
      .select('COALESCE(SUM(window.verifiedCalls), 0)', 'verifiedCalls')
      .addSelect('COALESCE(SUM(window.failedCalls), 0)', 'failedCalls')
      .where('window.organizationId = :organizationId', { organizationId })
      .andWhere('window.bindingId = :bindingId', { bindingId })
      .andWhere('window.status = :status', { status: SlaWindowStatus.CLOSED })
      .getRawOne<{ verifiedCalls: string; failedCalls: string }>();

    return {
      verifiedCalls: Number(row?.verifiedCalls ?? 0),
      failedCalls: Number(row?.failedCalls ?? 0),
    };
  }

  /**
   * Every binding on this tool with at least one closed window, from any
   * organization. **Deliberately cross-organization** — see the class
   * comment.
   */
  private async peerRowsForTool(toolId: string): Promise<PeerRow[]> {
    return this.windows
      .createQueryBuilder('window')
      .select('window.bindingId', 'bindingId')
      .addSelect('SUM(window.verifiedCalls)', 'verifiedCalls')
      .addSelect('SUM(window.failedCalls)', 'failedCalls')
      .where('window.organizationId IS NOT NULL')
      .andWhere('window.toolId = :toolId', { toolId })
      .andWhere('window.status = :status', { status: SlaWindowStatus.CLOSED })
      .groupBy('window.bindingId')
      .getRawMany<PeerRow>();
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

/**
 * Median, p90, rank and count over the per-binding observed rate — "median
 * binding on `search_web` runs 3.1%, p90 at 8.4%, your rank 4 of 11"
 * (the SLA workbench). The percentile method: linear interpolation between order statistics is the
 * ordinary definition and is what is used here. `rank` 1 is the tightest
 * (lowest) observed rate — a provider outcompetes on quality, not on having
 * the loosest number.
 */
function computePeerDistribution(bindingId: string, rows: readonly PeerRow[]) {
  const rates = rows
    .map((row) => ({
      bindingId: row.bindingId,
      verified: Number(row.verifiedCalls),
      failed: Number(row.failedCalls),
    }))
    .filter((row) => row.verified > 0)
    .map((row) => ({ bindingId: row.bindingId, rate: row.failed / row.verified }))
    .sort((a, b) => a.rate - b.rate);

  if (rates.length === 0) {
    return { median: null, p90: null, rank: null, count: 0 };
  }

  const values = rates.map((row) => row.rate);
  const rankIndex = rates.findIndex((row) => row.bindingId === bindingId);

  return {
    median: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    rank: rankIndex === -1 ? null : rankIndex + 1,
    count: rates.length,
  };
}

function percentile(sortedAscending: readonly number[], p: number): number {
  if (sortedAscending.length === 1) {
    return sortedAscending[0];
  }
  const index = (sortedAscending.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sortedAscending[lower];
  }
  const weight = index - lower;
  return sortedAscending[lower] * (1 - weight) + sortedAscending[upper] * weight;
}
