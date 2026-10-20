import { Inject, Injectable, Optional } from '@nestjs/common';

import { SlaStrikeEntity } from '@database/postgres/entities/sla-strike.entity';
import { SlaWindowCallEntity } from '@database/postgres/entities/sla-window-call.entity';
import { SlaWindowEntity } from '@database/postgres/entities/sla-window.entity';
import { SlashProposalEntity } from '@database/postgres/entities/slash-proposal.entity';
import { SlashProposalEventEntity } from '@database/postgres/entities/slash-proposal-event.entity';
import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { BindingVersionRepository } from '@database/postgres/repositories/binding-version.repository';
import { SlaStrikeRepository } from '@database/postgres/repositories/sla-strike.repository';
import {
  SlaWindowFailureGroup,
  SlaWindowCallRepository,
} from '@database/postgres/repositories/sla-window-call.repository';
import { SlaWindowRepository } from '@database/postgres/repositories/sla-window.repository';
import { SlashCaseReadRepository } from '@database/postgres/repositories/slash-case-read.repository';
import { SlashProposalPartRepository } from '@database/postgres/repositories/slash-proposal-part.repository';
import { SlashProposalEventRepository } from '@database/postgres/repositories/slash-proposal-event.repository';
import { ToolBindingRepository } from '@database/postgres/repositories/tool-binding.repository';
import { AssetId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';
import { STAKE_GRACE_PERIOD_MS } from '@modules/provider/constants/stake-monitor.constants';
import { GetProviderStakeResponseDto } from '@modules/provider/dto/get-provider-stake.dto';
import { ProviderStakeService } from '@modules/provider/services/provider-stake.service';
import { TOOL_CATALOGUE, ToolCataloguePort } from '@modules/tool/ports/tool-catalogue.port';
import { Tool } from '@modules/tool/ports/tool.types';
import { MoneyUtil } from '@shared/utils/money.util';

import { ResolutionKind } from '../domain/arbitration';
import { DISPUTE_TIMEOUT_MS } from '../constants/slash.constants';
import { ChainProposalStatus } from '../domain/chain-slash-outcome';
import {
  disputeByOf,
  OnChainDisputeState,
  onChainDisputeState,
  OnChainRecordMirror,
} from '../domain/on-chain-dispute';
import { SlashProposalStatus } from '../domain/slash-proposal-state';
import {
  ChangeOverlayDto,
  InactionForecastDto,
  PriorWindowRowDto,
  RestorationRowDto,
  SlashArithmeticRowDto,
  SlashAttributionRowDto,
  SlashProposalCaseDto,
  SlashProposalClocksDto,
  SlashProposalDto,
  SlashProposalEventDto,
  SlashProposalSource,
} from '../dto/slash-proposal.dto';
import { SlashProposalService } from './slash-proposal.service';

/**
 * The read side of one slash case — the case screen for the provider and the
 * case brief for an operator. One object, two renderings, because serving
 * different shapes to the two audiences is how they come to disagree about
 * what the penalty was.
 *
 * `sla_strikes.computation` already froze the arithmetic at the moment the
 * window closed. This class renders that freeze — and the strike's own
 * columns — into the case screen's fixed row list; it never recomputes a rate,
 * a tolerance or a penalty. Where a displayed row has no counterpart in either
 * the strike's columns or its `computation` array, the row says so (`null`
 * expression, or an explanatory `value`) rather than inventing the working —
 * see `buildArithmeticRows` and its notes on `per_window_cap` and
 * `declared_sla` in particular.
 *
 * Every method takes `organizationId` and reads through `SlashProposalService
 * .require`, which is the same not-found error every other slash surface
 * throws — a provider or an operator asking about a case in the wrong tenant
 * gets the identical 404 a case that does not exist would.
 */
@Injectable()
export class SlashCaseService {
  constructor(
    private readonly lifecycle: SlashProposalService,
    private readonly events: SlashProposalEventRepository,
    private readonly strikes: SlaStrikeRepository,
    private readonly windows: SlaWindowRepository,
    private readonly calls: SlaWindowCallRepository,
    private readonly bindingVersions: BindingVersionRepository,
    private readonly bindings: ToolBindingRepository,
    private readonly caseRead: SlashCaseReadRepository,
    private readonly stakeService: ProviderStakeService,
    @Inject(TOOL_CATALOGUE) private readonly catalogue: ToolCataloguePort,
    @Optional() private readonly parts: SlashProposalPartRepository | null = null,
  ) {}

  /** The case screen and the case brief in one response — see the class comment. */
  async buildCase(organizationId: string, proposalId: string): Promise<SlashProposalCaseDto> {
    const proposal = await this.lifecycle.require(organizationId, proposalId);

    const bindingPromise = this.bindings.findOneBy({
      organizationId,
      id: proposal.bindingId,
    });
    const strikePromise: Promise<SlaStrikeEntity | null> = proposal.strikeId
      ? this.strikes.findOneBy({ organizationId, id: proposal.strikeId })
      : Promise.resolve(null);
    const windowPromise: Promise<SlaWindowEntity | null> = proposal.windowId
      ? this.windows.findOneBy({ organizationId, id: proposal.windowId })
      : Promise.resolve(null);

    const [binding, strike, window] = await Promise.all([
      bindingPromise,
      strikePromise,
      windowPromise,
    ]);

    const tool = binding ? await this.catalogue.findTool(binding.toolId) : null;

    const callsPromise: Promise<SlaWindowCallEntity[]> = window
      ? this.calls.findByWindow(organizationId, window.id, WINDOW_CALL_SCAN_LIMIT)
      : Promise.resolve([]);
    const reasonGroupsPromise: Promise<SlaWindowFailureGroup[]> = window
      ? this.calls.countFailuresByReasonCode(organizationId, window.id)
      : Promise.resolve([]);
    const agentGroupsPromise: Promise<SlaWindowFailureGroup[]> = window
      ? this.calls.countFailuresByAgentId(organizationId, window.id)
      : Promise.resolve([]);
    const evidenceCountPromise: Promise<number> = window
      ? this.caseRead.countEvidencePacksForWindow(organizationId, window.id)
      : Promise.resolve(0);

    const [calls, reasonGroups, agentGroups, evidenceVerdictCount, priorWindows] =
      await Promise.all([
        callsPromise,
        reasonGroupsPromise,
        agentGroupsPromise,
        evidenceCountPromise,
        this.loadPriorWindows(organizationId, proposal.bindingId, proposal.windowId),
      ]);

    const changeOverlay = window
      ? await this.buildChangeOverlay(organizationId, proposal.bindingId, window, calls)
      : null;

    // Review N-4: an EVM case reads its state per record, not from one
    // case-level timestamp.
    const records = this.parts
      ? (await this.parts.findForEpoch(organizationId, proposal.id, proposal.chainEpoch ?? 0)).map(
          (part) => ({
            chainStatus: part.chainStatus,
            chainDisputedAt: part.chainDisputedAt,
            chainExecutableAt: part.chainExecutableAt,
            cancelReason: part.cancelReason ?? null,
          }),
        )
      : undefined;
    const clocks = computeClocks(proposal, new Date(), records);
    const proposalDto = buildProposalDto(proposal, binding, tool, window, clocks);
    const arithmetic = buildArithmeticRows(strike, proposal, calls);
    const inaction = await this.buildInaction(proposal);

    return {
      proposal: proposalDto,
      inaction,
      arithmetic,
      priorWindows,
      changeOverlay,
      failuresByRule: toAttributionRows(reasonGroups),
      failuresByAgent: toAttributionRows(agentGroups),
      evidenceVerdictCount,
    };
  }

  /** The dispute case timeline. */
  async timeline(organizationId: string, proposalId: string): Promise<SlashProposalEventDto[]> {
    await this.lifecycle.require(organizationId, proposalId);
    const rows = await this.events.findForProposal(organizationId, proposalId);
    return rows.map(toEventDto);
  }

  /** The dispute case restoration record. */
  async restoration(organizationId: string, proposalId: string): Promise<RestorationRowDto[]> {
    const proposal = await this.lifecycle.require(organizationId, proposalId);
    return buildRestorationRows(proposal);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** This window and the previous five for the same binding, `CLOSED` only. */
  private async loadPriorWindows(
    organizationId: string,
    bindingId: string,
    subjectWindowId: string | null,
  ): Promise<PriorWindowRowDto[]> {
    const rows = await this.windows
      .createQueryBuilder('window')
      .where('window.organizationId = :organizationId', { organizationId })
      .andWhere('window.bindingId = :bindingId', { bindingId })
      .andWhere('window.status = :status', { status: 'CLOSED' })
      .orderBy('window.sequence', 'DESC')
      .limit(PRIOR_WINDOWS_LIMIT)
      .getMany();

    return rows
      .slice()
      .reverse()
      .map((window) => ({
        windowId: window.id,
        label: renderWindowLabel(window.sequence),
        observedRate: window.verifiedCalls > 0 ? window.failedCalls / window.verifiedCalls : 0,
        closedAt: window.closedAt as Date,
        isSubject: window.id === subjectWindowId,
      }));
  }

  /**
   * The change-overlay banner. Null when no binding or mapping edit published
   * inside the window — the common case, and itself evidence.
   */
  private async buildChangeOverlay(
    organizationId: string,
    bindingId: string,
    window: SlaWindowEntity,
    calls: readonly SlaWindowCallEntity[],
  ): Promise<ChangeOverlayDto | null> {
    const to = window.closedAt ?? new Date();

    const edits = await this.bindingVersions
      .createQueryBuilder('version')
      .where('version.organizationId = :organizationId', { organizationId })
      .andWhere('version.bindingId = :bindingId', { bindingId })
      .andWhere('version.publishedAt IS NOT NULL')
      .andWhere('version.publishedAt >= :openedAt', { openedAt: window.openedAt })
      .andWhere('version.publishedAt <= :to', { to })
      .orderBy('version.publishedAt', 'DESC')
      .getMany();

    if (edits.length === 0) return null;

    // The most recent publish inside the window. Earlier same-window edits
    // were superseded before the window closed, and the DTO carries exactly
    // one split point; picking the latest keeps "after" meaning "under the
    // version that was actually live when the window ended". A heuristic, not
    // a documented rule — multiple edits inside one window are
    // rare and this collapses them to the one that matters most for the
    // before/after read.
    const edit = edits[0];
    const changedAt = edit.publishedAt as Date;

    const before = calls.filter((call) => call.postedAt < changedAt);
    const after = calls.filter((call) => call.postedAt >= changedAt);

    const verifiedBefore = before.filter((call) => call.countedAsQuality).length;
    const failuresBefore = before.filter((call) => call.countedAsFailure).length;
    const verifiedAfter = after.filter((call) => call.countedAsQuality).length;
    const failuresAfter = after.filter((call) => call.countedAsFailure).length;

    return {
      changedAt,
      changedBy: edit.publishedBy ?? edit.authoredBy,
      fromVersion: `v${edit.mappingVersion - 1}`,
      toVersion: `v${edit.mappingVersion}`,
      verifiedBefore,
      failuresBefore,
      verifiedAfter,
      failuresAfter,
      rateBefore: verifiedBefore > 0 ? failuresBefore / verifiedBefore : 0,
      rateAfter: verifiedAfter > 0 ? failuresAfter / verifiedAfter : 0,
    };
  }

  /** The case screen's "what happens if you do nothing" panel. */
  private async buildInaction(proposal: SlashProposalEntity): Promise<InactionForecastDto> {
    const asset = proposal.assetId as AssetId;
    const decimals = proposal.decimals;
    const penalty = MoneyUtil.of(proposal.penaltyAmount, asset, decimals);

    const stake = await this.stakeService.getStake(proposal.providerId);

    // The stake is a LIST, one entry per chain, and the entry this
    // forecast is about is the one denominated in the **proposal's own asset**.
    // That is not a convenience: the penalty is confiscated by the settlement
    // contract of the chain the call was paid on, and collateral on any other
    // chain is unreachable to it, so subtracting a Solana penalty from an EVM
    // balance would forecast a slash that cannot happen. A CAIP-19 asset names
    // its chain, so at most one entry can match.
    //
    // A reading can still be absent (`hasKnownStake: false` on that chain), and
    // this DTO has no way to say "unknown" — `stakeBefore` is a required field.
    // A slash proposal only exists for a binding that served paid traffic,
    // which in the ordinary case means a known stake reading exists; the zero
    // fallback below is the compromise for the edge case where it does not,
    // forced by the DTO's shape rather than a claim that the stake is actually
    // zero. A known limitation of the DTO.
    const onProposalChain = stake.stake.find((entry) => entry.staked?.asset === asset)?.staked;
    const stakeBefore = onProposalChain
      ? MoneyUtil.of(onProposalChain.amount, asset, onProposalChain.decimals)
      : MoneyUtil.zero(asset, decimals);

    const stakeAfter = MoneyUtil.greaterThanOrEqual(stakeBefore, penalty)
      ? MoneyUtil.subtract(stakeBefore, penalty)
      : MoneyUtil.zero(asset, decimals);

    const minimumRequired = minimumRequiredFor(stake, proposal.bindingId, asset, decimals);
    const fallsBelowMinimum =
      minimumRequired.asset === stakeAfter.asset && MoneyUtil.lessThan(stakeAfter, minimumRequired);

    return {
      executesAt: proposal.earliestExecutionAt,
      stakeBefore: toMoneyDto(stakeBefore),
      stakeAfter: toMoneyDto(stakeAfter),
      minimumRequired: toMoneyDto(minimumRequired),
      fallsBelowMinimum,
      graceHours: fallsBelowMinimum ? STAKE_GRACE_PERIOD_MS / HOUR_MS : null,
      // No producer anywhere in this codebase computes an earnings run-rate
      // for a provider (`ProviderEarningsService` answers an explicit
      // `[from, to)` range, not a continuous rate). A fabricated "restored in
      // ~N hours" on a screen about taking someone's money is worse than an
      // honest gap.
      projectedRestoreHours: null,
      routingContinues: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Rendering conventions. The thresholds and the binding label below are
// heuristics of this service rather than values stored anywhere.
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
/** Full window scan cap, matching `ProviderSlaWindowsService.EVIDENCE_CALL_LIMIT`. */
const WINDOW_CALL_SCAN_LIMIT = 2000;
/** This window plus the previous five. */
const PRIOR_WINDOWS_LIMIT = 6;
/** Top rows before an attribution table folds the remainder into "N others". */
const TOP_ATTRIBUTION_ROWS = 3;

/**
 * `bnd_<label>` — the provider-facing rendering the case screen and case
 * brief show for a binding, the same way `w_<sequence>` renders a window.
 *
 * Unlike a window, a binding carries no sequence number and no label column
 * of its own — `ToolBindingEntity` has neither. This derives one
 * deterministically from the id (uppercase hex, first three bytes) rather
 * than inventing a counter this service would have to own: it renders the
 * same way every time for the same binding. It is a rendering convention of
 * this service, not a value stored anywhere.
 */
function renderBindingLabel(bindingId: string): string {
  const hex = bindingId.replace(/-/g, '').toUpperCase();
  return `bnd_${hex.slice(0, 3)}`;
}

/** `w_<sequence>` — a render of the real, stored `sla_windows.sequence`. */
function renderWindowLabel(sequence: number): string {
  return `w_${sequence}`;
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

function formatMoney(amount: string, assetId: string, decimals: number): string {
  return MoneyUtil.format(MoneyUtil.of(amount, assetId as AssetId, decimals));
}

function toMoneyDto(money: Money): MoneyDto {
  return { amount: money.amount, asset: money.asset, decimals: money.decimals };
}

function toEventDto(event: SlashProposalEventEntity): SlashProposalEventDto {
  return {
    id: event.id,
    occurredAt: event.occurredAt,
    kind: event.kind,
    actorType: event.actorType as 'provider' | 'operator' | 'system',
    actorId: event.actorId,
    summary: event.summary,
    detail: event.detail,
  };
}

function computeClocks(
  proposal: SlashProposalEntity,
  now: Date,
  records?: readonly OnChainRecordMirror[],
): SlashProposalClocksDto {
  let runningClock: 'PROVIDER' | 'NONE' = 'NONE';
  let deadline: Date | null = null;

  // The record's executableAt is the provider's only deadline, and no
  // platform clock runs (the arbiter rules on chain).
  const chainState = onChainDisputeState(
    {
      chainStatus: proposal.chainStatus ?? ChainProposalStatus.NONE,
      chainDisputedAt: proposal.chainDisputedAt ?? null,
      chainDisputeWonAt: proposal.chainDisputeWonAt ?? null,
      chainDisputedParts: proposal.chainDisputedParts ?? 0,
      records,
    },
    DISPUTE_TIMEOUT_MS,
  );
  // Per record when the records are at hand (review N-4): a part disputed, or
  // a case moved on, does not close the window of a sibling still pending.
  const disputeBy =
    records && records.length > 0
      ? disputeByOf(records)
      : proposal.status === SlashProposalStatus.PROPOSED &&
          chainState === OnChainDisputeState.PENDING
        ? (proposal.chainExecutableAt ?? null)
        : null;

  if (disputeBy && disputeBy.getTime() > now.getTime()) {
    runningClock = 'PROVIDER';
    deadline = disputeBy;
  }

  const secondsRemaining =
    deadline === null ? null : Math.max(0, Math.floor((deadline.getTime() - now.getTime()) / 1000));

  return {
    proposedAt: proposal.proposedAt,
    notifiedAt: proposal.notifiedAt,
    acknowledgedAt: proposal.acknowledgedAt,
    earliestExecutionAt: proposal.earliestExecutionAt,
    secondsRemaining,
    runningClock,
    // The on-chain record, as mirrored. The case screen reads its execution
    // date and dispute state from these, not from the off-chain promise.
    chainStatus: (proposal.chainStatus ?? ChainProposalStatus.NONE) as ChainProposalStatus,
    chainExecutableAt: proposal.chainExecutableAt ?? null,
    chainDisputedAt: proposal.chainDisputedAt ?? null,
    chainDisputedParts: proposal.chainDisputedParts ?? 0,
    chainState,
    disputeBy,
    chainRecords: records?.length ?? 0,
    cancelledRecords: records?.filter((record) => record.chainStatus === 'CANCELLED').length ?? 0,
  };
}

function buildProposalDto(
  proposal: SlashProposalEntity,
  binding: ToolBindingEntity | null,
  tool: Tool | null,
  window: SlaWindowEntity | null,
  clocks: SlashProposalClocksDto,
): SlashProposalDto {
  const asset = proposal.assetId as AssetId;

  return {
    id: proposal.id,
    status: proposal.status as SlashProposalStatus,
    source: proposal.source as SlashProposalSource,
    providerId: proposal.providerId,
    bindingId: proposal.bindingId,
    bindingLabel: renderBindingLabel(proposal.bindingId),
    // `slash_proposals.tool_id` is declared `uuid`, while `tool_bindings
    // .tool_id` — and therefore the catalogue's own ids ("search_web") — are
    // plain strings (`ToolBindingEntity.toolId` is `varchar`). The two columns
    // cannot agree, so the binding's own `toolId` is rendered here rather than
    // the column on this row. The column type mismatch is a known schema
    // limitation that this rendering works around.
    toolId: binding?.toolId ?? proposal.toolId,
    // Null rather than an id when the catalogue cannot name the tool: a
    // penalty titled with a UUID tells the provider nothing.
    toolName: tool?.name ?? null,
    windowId: proposal.windowId,
    windowLabel: window ? renderWindowLabel(window.sequence) : null,
    penaltyAmount: toMoneyDto(MoneyUtil.of(proposal.penaltyAmount, asset, proposal.decimals)),
    appliedAmount: proposal.appliedAmount
      ? toMoneyDto(MoneyUtil.of(proposal.appliedAmount, asset, proposal.decimals))
      : null,
    clocks,
    disputeId: proposal.disputeId,
    resolutionKind: proposal.resolutionKind as ResolutionKind | null,
    resolvedAt: proposal.resolvedAt,
    executedAt: proposal.executedAt,
    executionSignature: proposal.executionSignature,
    reversedAt: proposal.reversedAt,
    reversalSignature: proposal.reversalSignature,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
  };
}

function minimumRequiredFor(
  stake: GetProviderStakeResponseDto,
  bindingId: string,
  asset: AssetId,
  decimals: number,
): Money {
  const item = stake.requirement.find((row) => row.bindingId === bindingId);
  const candidate = item?.minimum ?? stake.negotiatedMinimum ?? stake.requirementTotal;
  return candidate && candidate.asset === asset
    ? MoneyUtil.of(candidate.amount, asset, candidate.decimals)
    : MoneyUtil.zero(asset, decimals);
}

/** The single agent behind every non-quality (excluded) call, or null. */
function soleExcludedAgent(calls: readonly SlaWindowCallEntity[]): string | null {
  const agents = new Set(
    calls.filter((call) => !call.countedAsQuality).map((call) => call.agentId),
  );
  return agents.size === 1 ? [...agents][0] : null;
}

function arithmeticRow(
  key: string,
  expression: string | null,
  value: string,
  note: string | null,
  tone: 'NEUTRAL' | 'GOOD' | 'BAD',
): SlashArithmeticRowDto {
  return { key, expression, value, note, tone };
}

/**
 * The case screen's "measurement" table, rendered from `sla_strikes` — the strike's
 * own columns for `value`, and `computation` for `expression` wherever a
 * step with a matching label exists. `[]` when there is no strike at all
 * (a `DATA_FAIL` proposal): there is nothing frozen to render.
 */
function buildArithmeticRows(
  strike: SlaStrikeEntity | null,
  proposal: SlashProposalEntity,
  calls: readonly SlaWindowCallEntity[],
): SlashArithmeticRowDto[] {
  if (!strike) return [];

  const expr = (label: string): string | null =>
    strike.computation.find((step) => step.label === label)?.expression ?? null;

  const excludedAgent = soleExcludedAgent(calls);
  const excludedCalls = strike.totalCalls - strike.verifiedCalls;
  const breaches = strike.observedRate > strike.effectiveThreshold;

  return [
    arithmeticRow('window_calls', null, String(strike.totalCalls), null, 'NEUTRAL'),
    arithmeticRow(
      'verified_calls',
      expr('sample_gate'),
      String(strike.verifiedCalls),
      `≥ ${strike.minVerifiedCalls} minimum sample — window is slashable`,
      'GOOD',
    ),
    arithmeticRow(
      'excluded_calls',
      null,
      String(excludedCalls),
      excludedAgent ? `excluded agent: ${excludedAgent}` : null,
      'NEUTRAL',
    ),
    arithmeticRow('failed_verified_calls', null, String(strike.failedCalls), null, 'NEUTRAL'),
    arithmeticRow(
      'observed_rate',
      expr('observed_rate'),
      formatPercent(strike.observedRate),
      null,
      breaches ? 'BAD' : 'NEUTRAL',
    ),
    arithmeticRow(
      'declared_sla',
      null,
      formatPercent(Number(strike.declaredFailureRate)),
      // No producer records when a binding's declared SLA went into force —
      // `binding_versions` does not carry `slaFailureRate` at all, only the
      // mapping/price/timeout fields. "in force since <date>" cannot be
      // answered honestly, so the row leaves it empty.
      null,
      'NEUTRAL',
    ),
    arithmeticRow('tolerance', expr('tolerance'), formatPercent(strike.tolerance), null, 'NEUTRAL'),
    arithmeticRow(
      'effective_threshold',
      expr('effective_threshold'),
      formatPercent(strike.effectiveThreshold),
      `observed ${formatPercent(strike.observedRate)} > ${formatPercent(strike.effectiveThreshold)} → breach`,
      'BAD',
    ),
    arithmeticRow(
      'penalty',
      expr('penalty'),
      formatMoney(strike.penaltyAmount, proposal.assetId, proposal.decimals),
      null,
      'NEUTRAL',
    ),
    arithmeticRow(
      'per_window_cap',
      null,
      // The per-window ceiling is enforced ON CHAIN against a signed
      // attestation and never computed or stored in this
      // backend — `sla-window.ts`'s own comment on `strikeArithmeticFor` is
      // explicit that the caps are not applied here. Inventing the $5/100×
      // formula in this service would be a second, unsigned copy of a
      // consensus rule.
      'enforced on chain — not computed here',
      null,
      'NEUTRAL',
    ),
  ];
}

function toAttributionRows(groups: readonly SlaWindowFailureGroup[]): SlashAttributionRowDto[] {
  const parsed = groups.map((group) => ({ key: group.key, count: Number(group.count) }));
  const total = parsed.reduce((sum, group) => sum + group.count, 0);
  if (total === 0) return [];

  const top = parsed.slice(0, TOP_ATTRIBUTION_ROWS);
  const rest = parsed.slice(TOP_ATTRIBUTION_ROWS);

  const rows: SlashAttributionRowDto[] = top.map((group) => ({
    key: group.key,
    count: group.count,
    share: group.count / total,
  }));

  if (rest.length > 0) {
    const restCount = rest.reduce((sum, group) => sum + group.count, 0);
    rows.push({ key: `${rest.length} others`, count: restCount, share: restCount / total });
  }

  return rows;
}

/**
 * Whether the case is still waiting on a decision. `S-1` closes a case
 * without a resolution (no kind, no `resolvedAt`); it is settled, not pending.
 */
function restorationPending(proposal: SlashProposalEntity): boolean {
  return !proposal.resolvedAt && proposal.status !== 'CANCELLED';
}

/**
 * The dispute case restoration record — four rows. Two (`penalty cancelled`,
 * `false-positive metric`) are read off real columns on the proposal itself;
 * two ("tier progress", "policy recalibration ticket") have no backing data
 * anywhere in this codebase and say so rather than guessing.
 *
 * No resolution the system writes promises to undo anything, so a closed case
 * reads `NOT_APPLICABLE` throughout.
 */
function buildRestorationRows(proposal: SlashProposalEntity): RestorationRowDto[] {
  const pending = restorationPending(proposal);

  const rows: RestorationRowDto[] = [];

  rows.push({
    label: 'Tier progress restored',
    // No column, no job and no other row in this system tracks a binding's
    // tier progress at all — there is nothing here to read honestly, pending
    // or otherwise.
    value: 'not tracked — no producer exists for this yet',
    status: 'NOT_APPLICABLE',
  });

  rows.push({
    label: 'Penalty cancelled',
    value: formatMoney(proposal.penaltyAmount, proposal.assetId, proposal.decimals),
    status: pending ? 'ON_DECISION' : 'NOT_APPLICABLE',
  });

  rows.push({
    label: 'Counted against our false-positive metric',
    value: pending
      ? 'pending decision'
      : proposal.countsAsFalsePositive
        ? 'yes'
        : 'no — does not count',
    status: pending
      ? 'ON_DECISION'
      : proposal.countsAsFalsePositive
        ? 'RESTORED'
        : 'NOT_APPLICABLE',
  });

  rows.push({
    label: 'Policy recalibration ticket',
    // Same gap as tier progress: `ticketRef` on a decision is free text an
    // operator may type into the override log entry, not a coupling to any
    // tracked recalibration workflow. Nothing here to read honestly.
    value: 'not tracked — no producer exists for this yet',
    status: 'NOT_APPLICABLE',
  });

  return rows;
}
