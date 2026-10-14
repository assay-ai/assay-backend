import { Inject, Injectable } from '@nestjs/common';

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

import {
  ArbitrationOutcome,
  DisputeClaimType,
  OUTCOME_CONSEQUENCE,
  ResolutionKind,
} from '../domain/arbitration';
import { DISPUTE_TIMEOUT_MS } from '../constants/slash.constants';
import { ChainProposalStatus } from '../domain/chain-slash-outcome';
import {
  disputesOnChain,
  OnChainDisputeState,
  onChainDisputeState,
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
 * The read side of one slash case — the case screen for the provider, the
 * case brief for an adjudicator, and the queue's one-line `caseLabel` /
 * `coFailureCount`. One object, three renderings, because serving different
 * shapes to the two audiences is how they come to disagree about what the
 * penalty was.
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

    const clocks = computeClocks(proposal, new Date());
    const proposalDto = buildProposalDto(proposal, binding, tool, window, clocks);
    const arithmetic = buildArithmeticRows(strike, proposal, calls);
    const inaction = await this.buildInaction(proposal);
    const suggestedClaim = deriveSuggestedClaim(changeOverlay, agentGroups, strike);

    return {
      proposal: proposalDto,
      inaction,
      arithmetic,
      priorWindows,
      changeOverlay,
      failuresByRule: toAttributionRows(reasonGroups),
      failuresByAgent: toAttributionRows(agentGroups),
      evidenceVerdictCount,
      suggestedClaim,
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
    const windowLabel = proposal.windowId
      ? await this.windowLabelFor(organizationId, proposal.windowId)
      : null;
    return buildRestorationRows(proposal, windowLabel);
  }

  /**
   * The adjudication queue's `Case` column — `w_<sequence> · bnd_<label>`, or
   * the binding label alone when there is no window to name.
   *
   * Added for `adjudication-queue.service.ts`, which calls this
   * once per queue row. It costs one indexed primary-key lookup on
   * `sla_windows` when `windowId` is set, on top of the proposal read every
   * method here does — an N+1 across a 25-row queue page in the strict sense,
   * but each lookup is a point read on the table's primary key, not a scan.
   * If that turns out to matter at the queue's actual page size, the fix is a
   * batch method here keyed on a list of window ids, not a change to what
   * this one returns.
   */
  async caseLabel(organizationId: string, proposalId: string): Promise<string> {
    const proposal = await this.lifecycle.require(organizationId, proposalId);
    const bindingLabel = renderBindingLabel(proposal.bindingId);

    if (!proposal.windowId) {
      // `DATA_FAIL` proposals carry a window only when the operator who opened
      // them supplied one. Falling back to the binding label alone is honest;
      // a fabricated `w_0` would not be.
      return bindingLabel;
    }

    const window = await this.windows.findOneBy({ organizationId, id: proposal.windowId });
    return window ? `${renderWindowLabel(window.sequence)} · ${bindingLabel}` : bindingLabel;
  }

  /**
   * How many OTHER bindings on the same tool had their own observed rate move
   * materially away from their own declared rate, in a window overlapping the
   * subject window's time range. The co-failure signal.
   *
   * Returns `0`, honestly, whenever there is no window to align peers
   * against — a `DATA_FAIL` proposal the operator opened without one. That is
   * the one case the caller explicitly asked to be told about rather than
   * guessed at: a non-zero count here can push an adjudicator toward
   * `OVERTURNED_PLATFORM_DEFECT`, which opens a fleet sweep, so an invented
   * number would be the single most expensive wrong answer in the taxonomy.
   *
   * One query beyond the proposal + window reads every other method here
   * pays (`SlashCaseReadRepository.countPeerBindingsWithMaterialDeviation`) —
   * not an N+1, since the peer comparison itself is a single aggregate over
   * every sibling binding at once.
   */
  async coFailureCount(organizationId: string, proposalId: string): Promise<number> {
    const proposal = await this.lifecycle.require(organizationId, proposalId);
    if (!proposal.windowId) return 0;

    const window = await this.windows.findOneBy({ organizationId, id: proposal.windowId });
    if (!window) return 0;

    return this.caseRead.countPeerBindingsWithMaterialDeviation(
      window.toolId,
      proposal.bindingId,
      window.openedAt,
      window.closedAt ?? new Date(),
      MATERIAL_FAILURE_RATE_DELTA,
    );
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async windowLabelFor(organizationId: string, windowId: string): Promise<string | null> {
    const window = await this.windows.findOneBy({ organizationId, id: windowId });
    return window ? renderWindowLabel(window.sequence) : null;
  }

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
 * Share of a window's failures a single agent must account for before this
 * service suggests `AGENT_GRIEFING`. A heuristic, not a documented rule —
 * agent concentration is a signal with no agreed threshold.
 */
const GRIEFING_AGENT_SHARE_THRESHOLD = 0.5;
/**
 * How close to the sample gate counts as "barely enough" for
 * `INSUFFICIENT_SAMPLE` — `verifiedCalls < gate × this`. A heuristic, not a
 * documented rule.
 */
const INSUFFICIENT_SAMPLE_GATE_MULTIPLE = 1.1;
/**
 * Share of a window's failures that must fall after a published edit before
 * this service suggests `PLATFORM_MAPPING_CHANGE`. A heuristic, not a
 * documented rule.
 */
const CHANGE_OVERLAY_MAJORITY_SHARE = 0.5;
/**
 * How far a peer binding's observed rate must sit from its OWN declared rate,
 * in the subject window's time range, to count as a co-failure. A heuristic,
 * not a documented rule — the co-failure panel is the highest-value query on
 * the operator surface, but no threshold for it is agreed.
 */
const MATERIAL_FAILURE_RATE_DELTA = 0.03;

const PLATFORM_CLOCK_STATUSES: ReadonlySet<SlashProposalStatus> = new Set([
  SlashProposalStatus.DISPUTED,
  SlashProposalStatus.UNDER_REVIEW,
  SlashProposalStatus.AWAITING_SECOND,
]);

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

function computeClocks(proposal: SlashProposalEntity, now: Date): SlashProposalClocksDto {
  let runningClock: 'PROVIDER' | 'PLATFORM' | 'NONE' = 'NONE';
  let deadline: Date | null = null;

  // EVM: the record's executableAt is the provider's only deadline, and no
  // platform clock runs (the arbiter rules on chain).
  const onChain = disputesOnChain(proposal.assetId);
  const chainState = onChainDisputeState(
    {
      assetId: proposal.assetId,
      chainStatus: proposal.chainStatus ?? ChainProposalStatus.NONE,
      chainDisputedAt: proposal.chainDisputedAt ?? null,
      chainDisputeWonAt: proposal.chainDisputeWonAt ?? null,
      chainDisputedParts: proposal.chainDisputedParts ?? 0,
    },
    DISPUTE_TIMEOUT_MS,
  );
  const disputeBy =
    onChain &&
    proposal.status === SlashProposalStatus.PROPOSED &&
    chainState === OnChainDisputeState.PENDING
      ? (proposal.chainExecutableAt ?? null)
      : null;

  if (onChain) {
    if (disputeBy && disputeBy.getTime() > now.getTime()) {
      runningClock = 'PROVIDER';
      deadline = disputeBy;
    }
  } else if (
    proposal.status === SlashProposalStatus.PROPOSED &&
    proposal.respondByAt &&
    proposal.respondByAt.getTime() > now.getTime()
  ) {
    runningClock = 'PROVIDER';
    deadline = proposal.respondByAt;
  } else if (
    PLATFORM_CLOCK_STATUSES.has(proposal.status as SlashProposalStatus) &&
    proposal.platformDecisionDueAt
  ) {
    runningClock = 'PLATFORM';
    deadline = proposal.platformDecisionDueAt;
  }

  const secondsRemaining =
    deadline === null ? null : Math.max(0, Math.floor((deadline.getTime() - now.getTime()) / 1000));

  return {
    proposedAt: proposal.proposedAt,
    notifiedAt: proposal.notifiedAt,
    acknowledgedAt: proposal.acknowledgedAt,
    respondByAt: onChain ? null : proposal.respondByAt,
    platformDecisionDueAt: onChain ? null : proposal.platformDecisionDueAt,
    earliestExecutionAt: proposal.earliestExecutionAt,
    secondsRemaining,
    runningClock,
    // The on-chain record, as mirrored. The case screen reads its execution
    // date and dispute state from these, not from the off-chain promise.
    chainStatus: (proposal.chainStatus ?? ChainProposalStatus.NONE) as ChainProposalStatus,
    chainExecutableAt: proposal.chainExecutableAt ?? null,
    chainDisputedAt: proposal.chainDisputedAt ?? null,
    chainDisputedParts: proposal.chainDisputedParts ?? 0,
    disputeOnChain: onChain,
    chainState,
    disputeBy,
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
    toolName: tool?.name ?? binding?.toolId ?? proposal.toolId,
    windowId: proposal.windowId,
    windowLabel: window ? renderWindowLabel(window.sequence) : null,
    penaltyAmount: toMoneyDto(MoneyUtil.of(proposal.penaltyAmount, asset, proposal.decimals)),
    appliedAmount: proposal.appliedAmount
      ? toMoneyDto(MoneyUtil.of(proposal.appliedAmount, asset, proposal.decimals))
      : null,
    clocks,
    disputeId: proposal.disputeId,
    resolutionKind: proposal.resolutionKind as ResolutionKind | null,
    outcome: proposal.outcome as ArbitrationOutcome | null,
    resolvedAt: proposal.resolvedAt,
    executedAt: proposal.executedAt,
    executionSignature: proposal.executionSignature,
    reversedAt: proposal.reversedAt,
    reversalSignature: proposal.reversalSignature,
    sweepId: proposal.sweepId,
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
 * The claim the dispute form should pre-select, derived from the evidence
 * rather than from the provider. Checked in this order: a change overlay
 * that explains most failures, then agent concentration, then a thin sample —
 * the first that fits wins, and `null` when none does.
 */
function deriveSuggestedClaim(
  changeOverlay: ChangeOverlayDto | null,
  agentGroups: readonly SlaWindowFailureGroup[],
  strike: SlaStrikeEntity | null,
): DisputeClaimType | null {
  if (changeOverlay) {
    const total = changeOverlay.failuresBefore + changeOverlay.failuresAfter;
    if (total > 0 && changeOverlay.failuresAfter / total > CHANGE_OVERLAY_MAJORITY_SHARE) {
      return DisputeClaimType.PLATFORM_MAPPING_CHANGE;
    }
  }

  const totalFailures = agentGroups.reduce((sum, group) => sum + Number(group.count), 0);
  const topAgent = agentGroups[0];
  if (
    topAgent &&
    totalFailures > 0 &&
    Number(topAgent.count) / totalFailures >= GRIEFING_AGENT_SHARE_THRESHOLD
  ) {
    return DisputeClaimType.AGENT_GRIEFING;
  }

  if (
    strike &&
    strike.verifiedCalls < strike.minVerifiedCalls * INSUFFICIENT_SAMPLE_GATE_MULTIPLE
  ) {
    return DisputeClaimType.INSUFFICIENT_SAMPLE;
  }

  return null;
}

interface RestorationBasis {
  readonly penaltyStands: boolean;
  readonly strikesStand: boolean;
  readonly routingWeightStands: boolean;
}

/**
 * What an eventual (or already-reached) resolution promises to restore.
 * `null` while the case is still open — nothing has been decided yet, so
 * every row reads `ON_DECISION`.
 */
function restorationBasisFor(proposal: SlashProposalEntity): RestorationBasis | null {
  // `S-1` closes a case without a resolution (no kind, no `resolvedAt`); it is
  // settled, not pending.
  if (!proposal.resolvedAt && proposal.status !== 'CANCELLED') return null;

  if (proposal.outcome) {
    const consequence = OUTCOME_CONSEQUENCE[proposal.outcome as ArbitrationOutcome];
    return {
      penaltyStands: consequence.penaltyStands,
      strikesStand: consequence.strikesStand,
      routingWeightStands: consequence.routingWeightStands,
    };
  }

  // Automatic resolutions carry no `ArbitrationOutcome` —
  // `chk_slash_proposals_outcome_needs_adjudicator` refuses one. Only
  // `AUTO_PLATFORM_MISS` is a genuine overturn among the three: it is our own
  // control failing, not a judgement about the provider, and unlike
  // `OVERTURNED_INSUFFICIENT_EVIDENCE` there is no "we could not tell"
  // carve-out, so it is read here as a full reversal. This mapping names no
  // `ArbitrationOutcome` and is therefore not in `OUTCOME_CONSEQUENCE` — it is
  // a judgement of this service, not a documented rule.
  if (proposal.resolutionKind === ResolutionKind.AUTO_PLATFORM_MISS) {
    return { penaltyStands: false, strikesStand: false, routingWeightStands: false };
  }

  // `AUTO_UNDISPUTED` (penalty stands), `AUTO_DE_MINIMIS` (nothing was ever
  // levied) and a pre-attestation `CANCELLED` (`S-1`, never adjudicated) all
  // land here: none of them promises to undo anything, so every row below
  // reads `NOT_APPLICABLE`.
  return { penaltyStands: true, strikesStand: true, routingWeightStands: true };
}

function restorationStatus(
  pending: boolean,
  restores: boolean,
): 'ON_DECISION' | 'RESTORED' | 'NOT_APPLICABLE' {
  if (pending) return 'ON_DECISION';
  return restores ? 'RESTORED' : 'NOT_APPLICABLE';
}

/**
 * The dispute case restoration record — six rows. Two of them
 * (`strikesStand`/`routingWeightStands`) are read off `OUTCOME_CONSEQUENCE`
 * or the automatic-resolution mapping above; two (`penalty cancelled`,
 * `false-positive metric`) are read off real columns on the proposal itself;
 * and two ("tier progress", "policy recalibration ticket") have no backing
 * data anywhere in this codebase and say so rather than guessing.
 */
function buildRestorationRows(
  proposal: SlashProposalEntity,
  windowLabel: string | null,
): RestorationRowDto[] {
  const basis = restorationBasisFor(proposal);
  const pending = basis === null;

  const strikeRestores = basis !== null && !basis.strikesStand;
  const routingRestores = basis !== null && !basis.routingWeightStands;
  const penaltyStands = basis !== null && basis.penaltyStands;

  const rows: RestorationRowDto[] = [];

  rows.push({
    label: windowLabel ? `Strikes removed from ${windowLabel}` : 'Strikes removed',
    value: proposal.strikeId ? '1 strike' : 'no SLA strike on this proposal',
    status: proposal.strikeId ? restorationStatus(pending, strikeRestores) : 'NOT_APPLICABLE',
  });

  rows.push({
    label: 'Routing weight restored',
    value: pending ? 'pending decision' : routingRestores ? 'restored' : 'stands',
    status: restorationStatus(pending, routingRestores),
  });

  rows.push({
    label: 'Tier progress restored',
    // No column, no job and no other row in this system tracks a binding's
    // tier progress at all — there is nothing here to read honestly, pending
    // or otherwise.
    value: 'not tracked — no producer exists for this yet',
    status: 'NOT_APPLICABLE',
  });

  const penaltyStatus = pending
    ? 'ON_DECISION'
    : penaltyStands
      ? 'NOT_APPLICABLE'
      : // Overturned. Money that already moved needs an on-chain reversal
        // before it is actually undone; overturned before execution, there
        // was never anything to undo and the promise is fulfilled at once.
        proposal.status === 'EXECUTED'
        ? 'ON_DECISION'
        : 'RESTORED';
  rows.push({
    label: 'Penalty cancelled',
    value: formatMoney(proposal.penaltyAmount, proposal.assetId, proposal.decimals),
    status: penaltyStatus,
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
