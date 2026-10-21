import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { QueryRunner } from 'typeorm';

import { SlashProposalEntity } from '@database/postgres/entities/slash-proposal.entity';
import { SlaStrikeEntity } from '@database/postgres/entities/sla-strike.entity';
import { SlashProposalEventRepository } from '@database/postgres/repositories/slash-proposal-event.repository';
import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';
import { AssetId, ChainNamespace, namespaceOf } from '@modules/chains/ports/caip.types';
import {
  NOTIFICATION_PORT,
  NotificationEvent,
  NotificationPort,
} from '@modules/notification/ports/notification.port';

import { SLASH_PROPOSAL_SUBJECT_TYPE } from '../constants/slash-subject.constants';
import { SLASH_CONFIG, SlashConfig } from '../constants/slash.constants';
import { ResolutionKind } from '../domain/arbitration';
import { ChainProposalStatus } from '../domain/chain-slash-outcome';
import { SlashProposalStatus } from '../domain/slash-proposal-state';
import { SlashErrors } from '../errors/slash.errors';
import { SlashProposalSource } from '../dto/slash-proposal.dto';
import { formatDollars } from '@shared/utils/money-display.util';

/**
 * The proposal's lifecycle up to the chain.
 *
 * Opening a case, delivering it, and the undisputed sweep. The on-chain
 * dispute and the arbiter's ruling are mirrored by `ArbitrationService`.
 *
 * ## One door, and it opens by itself
 *
 * `SLA_STRIKE`: a window closes `BREACH_PROPOSED`, the SLA sweep writes an
 * `sla_strikes` row, and `openFromStrike` turns it into a case. One case per
 * window per binding.
 *
 * **Only an EVM strike opens a case.** Solana has no slash path: no paid rail
 * runs there, there is no dispute, and its single-record judgement named the
 * pooled treasury vault as beneficiary, which is gone. The strike stays
 * recorded; the case is not opened.
 *
 * ## Where the clocks come from
 *
 * `proposedAt` is now. `earliestExecutionAt` is `proposedAt + timelock`, and it
 * is set **at creation and never moved**, because the case screen states it to
 * the provider as a promise — *"never before that deadline, even if you do
 * nothing"*. The provider disputes on chain until the record's own
 * `executableAt`; no delivery starts that clock.
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
  async openFromStrike(strike: SlaStrikeEntity): Promise<SlashProposalEntity | null> {
    if (namespaceOf(strike.assetId as AssetId) !== ChainNamespace.EIP155) {
      this.logger.log(
        `strike ${strike.id} on ${strike.assetId} opens no slash case: only EVM slashes`,
      );
      return null;
    }
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
    // `null` — so a client polling a case would see `notifiedAt` appear from
    // nowhere rather than change from null. It also makes an in-memory guard
    // like `notifiedAt === null` agree with the SQL predicate
    // `notified_at IS NULL`, which is the same condition written twice and must
    // not be able to disagree.
    proposal.notifiedAt = null;
    proposal.acknowledgedAt = null;
    proposal.disputedAt = null;
    proposal.disputeId = null;
    proposal.appliedAmount = null;
    proposal.beneficiaryAccount = proposal.beneficiaryAccount ?? null;
    proposal.executedAt = null;
    proposal.executionSignature = null;
    proposal.reversedAt = null;
    proposal.reversalSignature = null;
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
    // Words, not minor units and a binding id: the operator console prints the
    // summary as is on the case History (BUG-OPS-CASES-03). The WAIVED line is
    // left as it was: the provider console rewrites it by pattern.
    const penalty = formatDollars({
      amount: saved.penaltyAmount,
      decimals: saved.decimals,
      asset: saved.assetId,
    });

    await this.events.append({
      organizationId: saved.organizationId,
      proposalId: saved.id,
      occurredAt: saved.proposedAt,
      kind: belowFloor ? 'WAIVED' : 'PROPOSED',
      actorType: 'system',
      actorId: null,
      summary: belowFloor
        ? `Penalty of ${saved.penaltyAmount} is below the de-minimis floor; recorded, not levied`
        : `Penalty of ${penalty} proposed`,
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
   * The notification is sent; `markDelivered` records its delivery, which the
   * propose sweep waits for.
   */
  private async notify(proposal: SlashProposalEntity): Promise<void> {
    const outcome = await this.notifications.notify({
      organizationId: proposal.organizationId,
      event: NotificationEvent.PROVIDER_SLASH_PROPOSED,
      // Dollars, never minor units: "A penalty of 28470000" reads as millions.
      // "Up to": this is the uncapped figure; the chain may reserve less, and
      // the penalty page leads with what it reserved.
      title:
        `A penalty of up to ${formatDollars({ amount: proposal.penaltyAmount, decimals: proposal.decimals, asset: proposal.assetId })} ` +
        `is proposed against your stake`,
      body:
        `Nothing is taken before ${utcMinute(proposal.earliestExecutionAt)}. Disputing ` +
        `freezes the penalty on chain until the arbiter decides; the penalty page shows the ` +
        `deadline to dispute. Your tools keep taking calls, and nothing is taken from ` +
        `earnings already paid.`,
      subjectType: SLASH_PROPOSAL_SUBJECT_TYPE,
      subjectId: proposal.id,
      dedupeKey: `${proposal.id}:proposed`,
      payload: {
        proposalId: proposal.id,
        bindingId: proposal.bindingId,
        windowId: proposal.windowId,
        penaltyAmount: proposal.penaltyAmount,
        assetId: proposal.assetId,
        decimals: proposal.decimals,
        earliestExecutionAt: proposal.earliestExecutionAt.toISOString(),
        source: proposal.source,
      },
    });

    // `IN_APP` is marked `DELIVERED` inside `NotificationService` at insert —
    // the inbox row *is* the delivery, and no preference can switch it off — so
    // it never enters the queue and the deliver processor never runs for it.
    // The processor hook stays for the queued channels; this is the one that
    // fires today.
    if (outcome.deliveredNow) {
      await this.markDelivered(proposal.organizationId, proposal.id, new Date());
    }
  }

  /**
   * A channel confirmed delivery. Recorded once: guarded on
   * `notified_at IS NULL`, so a webhook retried three times records one
   * delivery. No clock starts here (business review 5: most channels only log
   * and report "delivered"); the record's on-chain `executableAt` is the only
   * deadline.
   */
  async markDelivered(
    organizationId: string,
    proposalId: string,
    deliveredAt: Date,
  ): Promise<void> {
    const affected = await this.proposals.markNotifiedIfUnnotified(
      organizationId,
      proposalId,
      deliveredAt,
    );
    if (affected === 0) return;

    await this.events.append({
      organizationId,
      proposalId,
      occurredAt: deliveredAt,
      kind: 'NOTIFIED',
      actorType: 'system',
      actorId: null,
      summary:
        'Delivered in the app; the provider can dispute on chain until the record can execute',
      detail: {},
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
   * The undisputed sweep: the record's door passed and nobody disputed it.
   *
   * The case is upheld with `AUTO_UNDISPUTED` and **no** `outcome` — nobody
   * adjudicated it, and recording an adjudicator's verdict on a case no human
   * read would corrupt the taxonomy our own false-positive rate is measured from.
   *
   * Review R2-2, R2-10: the query admits a case only once every record
   * still pending undisputed has passed its door by `CHAIN_DISPUTE_SETTLE_MS`.
   * A case one of whose records the arbiter already upheld on chain (it was
   * disputed, and stands again) is the arbiter's uphold, `CHAIN_ARBITER`.
   */
  async sweepUndisputed(now: Date = new Date()): Promise<number> {
    const due = await this.proposals.findUndisputedPast(now, this.config.sweepBatchSize);
    let closed = 0;

    for (const row of due) {
      const arbiter = row.arbiterUpheld === true;
      const affected = await this.proposals.transitionIfIn(
        row.organizationId,
        row.id,
        [SlashProposalStatus.PROPOSED],
        {
          status: SlashProposalStatus.UPHELD,
          resolutionKind: arbiter ? ResolutionKind.CHAIN_ARBITER : ResolutionKind.AUTO_UNDISPUTED,
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
        summary: arbiter
          ? `The arbiter upheld a disputed record of this case on chain, and no other record ` +
            `was disputed by ${row.executableAt.toISOString()}; the proposal stands`
          : `No dispute was filed by ${row.executableAt.toISOString()}; the proposal stands`,
        detail: { executableAt: row.executableAt.toISOString(), arbiterUpheld: arbiter },
      });
    }

    if (closed > 0) {
      this.logger.log(`auto-closed ${closed} undisputed slash proposal(s)`);
    }
    return closed;
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
  /**
   * Whether the case's timeline already has a `kind` entry for the on-chain
   * record `requestId` (review R2-2: the watcher's "disputed on chain" entry
   * is written once per record, whatever a chain read mirrored before it).
   */
  async hasTimelineEntry(
    organizationId: string,
    proposalId: string,
    kind: string,
    requestId: string,
  ): Promise<boolean> {
    const rows = await this.events.findForProposal(organizationId, proposalId);
    return rows.some(
      (row) =>
        row.kind === kind &&
        (row.detail as Record<string, unknown> | null)?.requestId === requestId,
    );
  }

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
 * `sha256('assay:slash-request:v1' || id)` at epoch 0, and
 * `sha256('assay:slash-request:v1' || id || ':' || epoch)` above it. 32 bytes,
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
  const digest = createHash('sha256').update('assay:slash-request:v1').update(proposal.id);
  if (proposal.chainEpoch > 0) {
    digest.update(`:${proposal.chainEpoch}`);
  }
  return digest.digest('hex');
}

/** "2026-10-20 17:14 UTC": a time in a provider's notice, without the ISO noise. */
function utcMinute(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
