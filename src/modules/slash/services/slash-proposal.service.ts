import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { IsNull, Not, QueryRunner } from 'typeorm';

import { SlashProposalEntity } from '@database/postgres/entities/slash-proposal.entity';
import { SlaStrikeEntity } from '@database/postgres/entities/sla-strike.entity';
import { SlashProposalEventRepository } from '@database/postgres/repositories/slash-proposal-event.repository';
import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';
import {
  NOTIFICATION_PORT,
  NotificationEvent,
  NotificationPort,
} from '@modules/notification/ports/notification.port';

import { SLASH_PROPOSAL_SUBJECT_TYPE } from '../constants/slash-subject.constants';
import { SLASH_CONFIG, SlashConfig } from '../constants/slash.constants';
import { ResolutionKind } from '../domain/arbitration';
import { disputesOnChain } from '../domain/on-chain-dispute';
import { ChainProposalStatus } from '../domain/chain-slash-outcome';
import { SlashProposalStatus } from '../domain/slash-proposal-state';
import { SlashErrors } from '../errors/slash.errors';
import { SlashProposalSource } from '../dto/slash-proposal.dto';

/**
 * The proposal's lifecycle up to the point a human touches it.
 *
 * Opening a case, delivering it, starting the provider's clock, and the two
 * sweepers that close cases nobody worked. The adjudication itself is
 * `ArbitrationService`; the split is at the point where a decision is made,
 * because everything on this side happens without an operator and everything on
 * that side must not.
 *
 * ## Two doors, and only one of them opens by itself
 *
 * There are two sources: *"strike or DATA_FAIL → slash proposal"*. They are
 * built the same way and wired very differently, and the asymmetry is a
 * decision rather than an omission.
 *
 * - **`SLA_STRIKE` is automatic.** A window closes `BREACH_PROPOSED`, the SLA
 *   sweep writes an `sla_strikes` row, and `openFromStrike` turns it into a case.
 *   That is one case per window per binding — a rate a human queue can absorb.
 * - **`DATA_FAIL` is operator-invoked.** A single `FAIL` verdict is slashable
 *   on chain, so the door has to exist; wiring it to *every* `FAIL` would not.
 *   The arithmetic is the reason: a 30-minute adjudication costs $25–50
 *   fully loaded, and a per-call penalty on a $0.001 call is four orders of
 *   magnitude below that. Auto-proposing per call would generate a queue that
 *   cannot be worked, and the platform-miss rule then overturns everything
 *   in it automatically — a control that produces more cases than it can decide
 *   is not a stricter control, it is a broken one.
 *
 *   So the `DATA_FAIL` door is opened deliberately, by an operator, for the
 *   case it is actually for: one egregious failure on a high-value
 *   `guaranteed` binding, where the window-level rate would never register it.
 *
 * ## Where the clocks come from
 *
 * `proposedAt` is now. `earliestExecutionAt` is `proposedAt + timelock`, and it
 * is set **at creation and never moved**, because the case screen states it to the
 * provider as a promise — *"never before that deadline, even if you do
 * nothing"* — and a deadline the platform can push out is not one.
 *
 * `respondByAt` is deliberately **not** set at creation. It is derived from
 * delivery: a webhook
 * to a dead endpoint must not consume the provider's appeal window. Until
 * something confirms delivery, the case has a timelock and no response
 * deadline, and the undisputed sweeper skips it — a case nobody could have
 * heard about is not one they declined to answer.
 */
@Injectable()
export class SlashProposalService {
  private readonly logger = new Logger(SlashProposalService.name);

  constructor(
    private readonly proposals: SlashProposalRepository,
    private readonly events: SlashProposalEventRepository,
    @Inject(NOTIFICATION_PORT) private readonly notifications: NotificationPort,
    @Inject(SLASH_CONFIG) private readonly config: SlashConfig,
  ) {}

  /**
   * Turn a recorded strike into a case.
   *
   * Idempotent through `uq_slash_proposals_strike`: a retried close, or a
   * re-run of the opener sweep, finds the row already there and returns it
   * rather than minting a second penalty for one window. That is the same
   * guarantee `uq_sla_strikes_window` gives one level down, and it is a
   * unique-violation catch rather than a read-then-write for the same reason —
   * two workers reading "no proposal yet" at the same moment both write one.
   */
  async openFromStrike(strike: SlaStrikeEntity): Promise<SlashProposalEntity> {
    const existing = await this.proposals.findOneBy({
      organizationId: strike.organizationId,
      strikeId: strike.id,
    });
    if (existing) return existing;

    const now = new Date();
    const proposal = new SlashProposalEntity();
    proposal.organizationId = strike.organizationId;
    proposal.providerId = strike.providerId;
    proposal.bindingId = strike.bindingId;
    proposal.toolId = strike.toolId;
    proposal.source = SlashProposalSource.SLA_STRIKE;
    proposal.strikeId = strike.id;
    proposal.verdictId = null;
    proposal.windowId = strike.windowId;
    proposal.penaltyAmount = strike.penaltyAmount;
    proposal.assetId = strike.assetId;
    proposal.decimals = this.config.assetDecimals;
    proposal.proposedAt = now;
    proposal.earliestExecutionAt = new Date(now.getTime() + this.config.timelockMs);

    return this.persistNew(proposal, {
      windowId: strike.windowId,
      observedRate: strike.observedRate,
      effectiveThreshold: strike.effectiveThreshold,
    });
  }

  /**
   * The `DATA_FAIL` door. Opened by an operator against one verdict.
   *
   * The caller is responsible for having established that the verdict is
   * `FAIL` — the only slashable status — and for the override log entry. This
   * method does neither, because a service that could open a case *and* decide
   * it was permissible would be the single call site the whole override
   * register exists to prevent.
   */
  async openFromVerdict(input: {
    organizationId: string;
    providerId: string;
    bindingId: string;
    toolId: string;
    verdictId: string;
    windowId: string | null;
    penaltyAmount: string;
    assetId: string;
  }): Promise<SlashProposalEntity> {
    const existing = await this.proposals.findOneBy({
      organizationId: input.organizationId,
      verdictId: input.verdictId,
    });
    if (existing) {
      throw SlashErrors.proposalAlreadyExists({ verdictId: input.verdictId });
    }
    // B7: the provider won an on-chain dispute over this window's calls; a new
    // case over the same calls would be the same incident under a new id.
    if (input.windowId) {
      const won = await this.proposals.findOneBy({
        organizationId: input.organizationId,
        windowId: input.windowId,
        chainDisputeWonAt: Not(IsNull()),
      });
      if (won) {
        throw SlashErrors.disputeWonOnChain({ proposalId: won.id, windowId: input.windowId });
      }
    }

    const now = new Date();
    const proposal = new SlashProposalEntity();
    proposal.organizationId = input.organizationId;
    proposal.providerId = input.providerId;
    proposal.bindingId = input.bindingId;
    proposal.toolId = input.toolId;
    proposal.source = SlashProposalSource.DATA_FAIL;
    proposal.strikeId = null;
    proposal.verdictId = input.verdictId;
    proposal.windowId = input.windowId;
    proposal.penaltyAmount = input.penaltyAmount;
    proposal.assetId = input.assetId;
    proposal.decimals = this.config.assetDecimals;
    proposal.proposedAt = now;
    proposal.earliestExecutionAt = new Date(now.getTime() + this.config.timelockMs);

    return this.persistNew(proposal, { verdictId: input.verdictId });
  }

  /**
   * Insert, waive if it is beneath the floor, notify, and write the first
   * timeline row.
   *
   * ## The de-minimis check happens before the notification, not after
   *
   * A floor is mandatory, and the arithmetic says why: adjudicating a $5
   * penalty is 5–10× loss-making before the provider's own cost of disputing
   * it. A case that will never be levied must not send a provider a
   * `CRITICAL`, non-suppressible alert telling them their capital is at risk —
   * that is the cost of adjudication moved onto them instead of removed.
   *
   * The floor ships at zero (`SLASH_DE_MINIMIS_MINOR`), so nothing is waived
   * by default. A typical case is a $5 case, which a $25 floor would erase;
   * shipping the mechanism disabled keeps the screens honest and leaves the
   * number a config change.
   */
  private async persistNew(
    proposal: SlashProposalEntity,
    detail: Record<string, unknown>,
  ): Promise<SlashProposalEntity> {
    const deMinimis = BigInt(this.config.deMinimisMinor);
    const belowFloor = deMinimis > 0n && BigInt(proposal.penaltyAmount) < deMinimis;

    proposal.status = belowFloor ? SlashProposalStatus.WAIVED : SlashProposalStatus.PROPOSED;
    if (belowFloor) {
      proposal.resolutionKind = ResolutionKind.AUTO_DE_MINIMIS;
      proposal.resolvedAt = proposal.proposedAt;
    }

    // Every nullable column is set explicitly rather than left `undefined`.
    //
    // Not tidiness. A freshly constructed entity with `undefined` in a nullable
    // field serialises as an *absent* key, and the DTOs on this surface promise
    // `null` — so a client polling a case would see `respondByAt` appear from
    // nowhere rather than change from null. It also makes an in-memory guard
    // like `notifiedAt === null` agree with the SQL predicate
    // `notified_at IS NULL`, which is the same condition written twice and must
    // not be able to disagree.
    proposal.notifiedAt = null;
    proposal.acknowledgedAt = null;
    proposal.respondByAt = null;
    proposal.platformDecisionDueAt = null;
    proposal.disputedAt = null;
    proposal.disputeId = null;
    proposal.appliedAmount = null;
    proposal.beneficiaryAccount = proposal.beneficiaryAccount ?? null;
    proposal.outcome = null;
    proposal.decidedByOperatorId = null;
    proposal.secondedByOperatorId = null;
    proposal.secondedAt = null;
    proposal.secondKind = null;
    proposal.executedAt = null;
    proposal.executionSignature = null;
    proposal.reversedAt = null;
    proposal.reversalSignature = null;
    proposal.rootCauseKey = null;
    proposal.sweepId = null;
    proposal.countsAsFalsePositive = false;
    proposal.resolutionKind = proposal.resolutionKind ?? null;
    proposal.resolvedAt = proposal.resolvedAt ?? null;

    // The id is minted here rather than by the column default, because
    // `chainRequestId` is derived from it and has to be known before the row
    // exists. Letting Postgres generate it would mean writing the row, reading
    // it back and updating it — three statements, and a window in which a row
    // exists whose replay lock is not yet set.
    proposal.id = randomUUID();
    proposal.chainEpoch = 0;
    proposal.chainStatus = ChainProposalStatus.NONE;
    proposal.chainProposedAt = null;
    proposal.chainExecutableAt = null;
    proposal.chainReserved = null;
    proposal.chainProposalSignature = null;
    proposal.chainClaimedAt = null;
    proposal.chainLastError = null;
    proposal.chainRequestId = deriveChainRequestId(proposal);

    const saved = await this.proposals.save(proposal);

    await this.events.append({
      organizationId: saved.organizationId,
      proposalId: saved.id,
      occurredAt: saved.proposedAt,
      kind: belowFloor ? 'WAIVED' : 'PROPOSED',
      actorType: 'system',
      actorId: null,
      summary: belowFloor
        ? `Penalty of ${saved.penaltyAmount} is below the de-minimis floor; recorded, not levied`
        : `Slash proposed: ${saved.penaltyAmount} against ${saved.bindingId}`,
      detail,
    });

    if (!belowFloor) {
      await this.notify(saved);
    }

    return saved;
  }

  /**
   * `provider.slash_proposed` — an event the notification catalogue carried
   * with no possible producer. This is it.
   *
   * The notification is sent, and only *delivery* starts the clock. Nothing
   * here sets `respondByAt`; `markDelivered` does, when a channel confirms.
   */
  private async notify(proposal: SlashProposalEntity): Promise<void> {
    const outcome = await this.notifications.notify({
      organizationId: proposal.organizationId,
      event: NotificationEvent.PROVIDER_SLASH_PROPOSED,
      title: `A penalty of ${proposal.penaltyAmount} is proposed against your stake`,
      body: disputesOnChain(proposal.assetId)
        ? `Nothing executes before ${proposal.earliestExecutionAt.toISOString()}. Disputing ` +
          `freezes the penalty on chain until the arbiter decides; you must dispute before the ` +
          `record's executableAt, which the case page shows. Your routing continues and ` +
          `nothing is taken from earnings already paid.`
        : `Nothing executes before ${proposal.earliestExecutionAt.toISOString()}, even if you ` +
          `do nothing. Your routing continues and nothing is taken from earnings already paid. ` +
          `Open the case to see the measurement and to object.`,
      subjectType: SLASH_PROPOSAL_SUBJECT_TYPE,
      subjectId: proposal.id,
      dedupeKey: `${proposal.id}:proposed`,
      payload: {
        proposalId: proposal.id,
        bindingId: proposal.bindingId,
        windowId: proposal.windowId,
        penaltyAmount: proposal.penaltyAmount,
        assetId: proposal.assetId,
        earliestExecutionAt: proposal.earliestExecutionAt.toISOString(),
        source: proposal.source,
      },
    });

    // The clock starts on DELIVERY, and for the one channel that is real it is
    // delivered by the time this returns.
    //
    // `IN_APP` is marked `DELIVERED` inside `NotificationService` at insert —
    // the inbox row *is* the delivery, and no preference can switch it off — so
    // it never enters the queue and the deliver processor never runs for it.
    // Hanging the clock on that processor alone left `respond_by_at` null in
    // practice, which is the bug this whole path exists to fix. The processor
    // hook stays for the queued channels; this is the one that fires today.
    if (outcome.deliveredNow) {
      await this.markDelivered(proposal.organizationId, proposal.id, new Date());
    }
  }

  /**
   * A channel confirmed delivery. The provider's clock starts here.
   *
   * Guarded on `notified_at IS NULL`, so a webhook retried three times does not
   * move the deadline three times — and the direction it would move is *later*,
   * which looks generous and is really the platform choosing when its own
   * timelock expires.
   */
  async markDelivered(
    organizationId: string,
    proposalId: string,
    deliveredAt: Date,
  ): Promise<void> {
    // EVM: no clock starts on delivery (business review 5: most channels only
    // log and report "delivered"). The record's on-chain `executableAt` is the
    // only deadline, so the delivery is recorded and nothing else.
    const proposal = await this.proposals.findOneScoped(organizationId, proposalId);
    if (!proposal) return;
    const respondByAt = disputesOnChain(proposal.assetId)
      ? null
      : new Date(deliveredAt.getTime() + this.config.responseWindowMs);
    const affected = await this.proposals.markNotifiedIfUnnotified(
      organizationId,
      proposalId,
      deliveredAt,
      respondByAt,
    );
    if (affected === 0) return;

    await this.events.append({
      organizationId,
      proposalId,
      occurredAt: deliveredAt,
      kind: 'NOTIFIED',
      actorType: 'system',
      actorId: null,
      summary: respondByAt
        ? `Delivered; the provider has until ${respondByAt.toISOString()} to object`
        : 'Delivered in the app; the provider can dispute on chain until the record can execute',
      detail: { respondByAt: respondByAt?.toISOString() ?? null },
    });
  }

  /** The provider opened the case. Recorded, and it does not move any clock. */
  async acknowledge(
    organizationId: string,
    proposalId: string,
    actorId: string,
  ): Promise<SlashProposalEntity> {
    const proposal = await this.require(organizationId, proposalId);
    if (proposal.acknowledgedAt) return proposal;

    proposal.acknowledgedAt = new Date();
    const saved = await this.proposals.save(proposal);

    await this.events.append({
      organizationId,
      proposalId,
      occurredAt: saved.acknowledgedAt as Date,
      kind: 'ACKNOWLEDGED',
      actorType: 'provider',
      actorId,
      summary: 'Provider opened the case',
      detail: {},
    });

    return saved;
  }

  /**
   * The undisputed sweep: the provider's window elapsed and nobody objected.
   *
   * The case is upheld with `AUTO_UNDISPUTED` and **no** `outcome` — nobody
   * adjudicated it, and recording an adjudicator's verdict on a case no human
   * read would corrupt the taxonomy our own false-positive rate is measured from.
   *
   * Only `PROPOSED` cases with a `respond_by_at` are eligible, which is the
   * same thing as saying only cases the provider was actually told about.
   */
  async sweepUndisputed(now: Date = new Date()): Promise<number> {
    const due = await this.proposals.findUndisputedPast(now, this.config.sweepBatchSize);
    let closed = 0;

    for (const row of due) {
      const affected = await this.proposals.transitionIfIn(
        row.organizationId,
        row.id,
        [SlashProposalStatus.PROPOSED],
        {
          status: SlashProposalStatus.UPHELD,
          resolutionKind: ResolutionKind.AUTO_UNDISPUTED,
          resolvedAt: now,
          countsAsFalsePositive: false,
        },
      );
      if (affected === 0) continue;

      closed += 1;
      await this.events.append({
        organizationId: row.organizationId,
        proposalId: row.id,
        occurredAt: now,
        kind: 'AUTO_CLOSED',
        actorType: 'system',
        actorId: null,
        summary: `No dispute was filed by ${row.respondByAt.toISOString()}; the proposal stands`,
        detail: { respondByAt: row.respondByAt.toISOString() },
      });
    }

    if (closed > 0) {
      this.logger.log(`auto-closed ${closed} undisputed slash proposal(s)`);
    }
    return closed;
  }

  /**
   * The platform-miss rule, the one rule that costs **us** something: we missed
   * our own deadline.
   *
   * *"If we fail to decide before the timelock expires, the dispute is
   * automatically overturned."* Every other deadline in the lifecycle runs against
   * the provider; this is the only one that runs against the platform, and it
   * is what makes understaffing our cost instead of theirs.
   *
   * `outcome` stays null and `resolutionKind` is `AUTO_PLATFORM_MISS`. It
   * **does** count in the false-positive metric: we proposed taking money and
   * then could not substantiate it in the time we gave ourselves, which is our
   * error whatever the underlying facts were. Recording it as
   * `OVERTURNED_INSUFFICIENT_EVIDENCE` would be more flattering and would put
   * a judgement nobody made into an adjudicator's vocabulary.
   *
   * ## Why it returns the rows and not a count
   *
   * An auto-overturn is still an overturn, and the chain does not know one
   * happened: a standing `SlashRecord` goes on reserving the provider's stake,
   * and `execute_slash` is permissionless once `executable_at` passes. So each
   * of these needs `SlashExecutionService.cancelOnChain`, and the caller cannot
   * re-derive the set afterwards — `findOverduePast` selects `DISPUTED` and
   * `UNDER_REVIEW`, and every row here has just left both.
   *
   * The call is made by `SlashLifecycleJob` rather than from here, and
   * that is a dependency direction rather than a preference:
   * `SlashExecutionService` already takes this service as its `lifecycle`, so
   * injecting it here would make the two mutually dependent.
   */
  async sweepPlatformMisses(
    now: Date = new Date(),
  ): Promise<Array<{ organizationId: string; id: string }>> {
    const overdue = await this.proposals.findOverduePast(now, this.config.sweepBatchSize);
    const overturned: Array<{ organizationId: string; id: string }> = [];

    for (const row of overdue) {
      const affected = await this.proposals.transitionIfIn(
        row.organizationId,
        row.id,
        [SlashProposalStatus.DISPUTED, SlashProposalStatus.UNDER_REVIEW],
        {
          status: SlashProposalStatus.OVERTURNED,
          resolutionKind: ResolutionKind.AUTO_PLATFORM_MISS,
          resolvedAt: now,
          countsAsFalsePositive: true,
        },
      );
      if (affected === 0) continue;

      overturned.push({ organizationId: row.organizationId, id: row.id });
      await this.events.append({
        organizationId: row.organizationId,
        proposalId: row.id,
        occurredAt: now,
        kind: 'AUTO_OVERTURNED_PLATFORM_MISS',
        actorType: 'system',
        actorId: null,
        summary:
          `We did not decide by ${row.platformDecisionDueAt.toISOString()}. ` +
          `The proposal is cancelled and this is recorded against us, not against you.`,
        detail: { platformDecisionDueAt: row.platformDecisionDueAt.toISOString() },
      });

      await this.notifications.notify({
        organizationId: row.organizationId,
        event: NotificationEvent.PROVIDER_SLASH_DECIDED,
        title: 'A proposed penalty against your stake was cancelled',
        body:
          'We did not decide your case within the window we set ourselves, so the proposal is ' +
          'cancelled. Nothing was taken. This is recorded as our failure, not yours.',
        subjectType: SLASH_PROPOSAL_SUBJECT_TYPE,
        subjectId: row.id,
        dedupeKey: `${row.id}:decided`,
        payload: { proposalId: row.id, resolutionKind: ResolutionKind.AUTO_PLATFORM_MISS },
      });

      // At `warn`, not `log`. Every row here is a case we were paid to work and
      // did not, and the number is a staffing signal — it must be visible
      // rather than absorbed.
      this.logger.warn(
        `slash proposal ${row.id} auto-overturned: platform missed its own deadline`,
      );
    }

    return overturned;
  }

  async require(organizationId: string, proposalId: string): Promise<SlashProposalEntity> {
    const proposal = await this.proposals.findOneScoped(organizationId, proposalId);
    if (!proposal) throw SlashErrors.proposalNotFound({ proposalId });
    return proposal;
  }

  /**
   * Append a timeline row on its own connection.
   *
   * Used by the paths that are not overrides — a provider filing an objection,
   * an operator claiming a case. Those have no register entry to commit
   * alongside, so there is nothing for the row to be atomic *with*.
   */
  async appendEventDirect(entry: {
    organizationId: string;
    proposalId: string;
    occurredAt: Date;
    kind: string;
    actorType: 'provider' | 'operator' | 'system';
    actorId: string | null;
    summary: string;
    detail: Record<string, unknown>;
  }): Promise<void> {
    await this.events.append(entry);
  }

  /** Append a timeline row inside somebody else's transaction. */
  async appendEvent(
    queryRunner: QueryRunner,
    entry: {
      organizationId: string;
      proposalId: string;
      occurredAt: Date;
      kind: string;
      actorType: 'provider' | 'operator' | 'system';
      actorId: string | null;
      summary: string;
      detail: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.events.append(entry, queryRunner);
  }
}

/**
 * The chain's replay lock, derived rather than drawn.
 *
 * `sha256('x402:slash-request:v1' || id)` at epoch 0, and
 * `sha256('x402:slash-request:v1' || id || ':' || epoch)` above it. 32 bytes,
 * lower-case hex.
 *
 * Deterministic on purpose. `propose_slash` burns a `request_id` permanently
 * through `init` on `["slash", request_id]`, so a retried submission carrying a
 * *fresh* id would mint a second penalty for one finding — the retry becoming
 * the very thing the lock exists to prevent. Deriving it from the row means
 * every retry of every path computes the same 32 bytes and the chain refuses
 * the second one by itself.
 *
 * The epoch is the one legitimate reason to want a *different* id for the same
 * case: `UPHELD_RECALCULATED` lowers a penalty that is already frozen on chain,
 * and `execute_slash` takes no amount argument, so the only way to pay the
 * revised figure is to cancel the standing record and propose a new one. Epoch
 * 0 omits the suffix entirely so that every row written before epochs existed
 * keeps the id it already published — several of which are on devnet and cannot be
 * rewritten.
 */
export function deriveChainRequestId(
  proposal: Pick<SlashProposalEntity, 'id' | 'chainEpoch'>,
): string {
  const digest = createHash('sha256').update('x402:slash-request:v1').update(proposal.id);
  if (proposal.chainEpoch > 0) {
    digest.update(`:${proposal.chainEpoch}`);
  }
  return digest.digest('hex');
}
