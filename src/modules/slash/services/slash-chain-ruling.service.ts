import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { SlashProposalEntity } from '@database/postgres/entities/slash-proposal.entity';
import { SlashProposalPartEntity } from '@database/postgres/entities/slash-proposal-part.entity';
import { SlashProposalPartRepository } from '@database/postgres/repositories/slash-proposal-part.repository';
import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';
import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';

import { CHAIN_DISPUTE_SETTLE_MS } from '../constants/slash.constants';
import { ChainProposalStatus } from '../domain/chain-slash-outcome';
import { cancelledByArbiter } from '../domain/on-chain-dispute';
import { SlashProposalStatus } from '../domain/slash-proposal-state';
import {
  SlashChainCancelledEvent,
  SlashChainDisputedEvent,
  SlashChainExecutedEvent,
  SlashChainProposedEvent,
  SlashChainRulingsPort,
  SlashChainUpheldEvent,
} from '../ports/slash-chain-rulings.port';
import { ArbitrationService } from './arbitration.service';
import { SlashExecutionService } from './slash-execution.service';
import { SlashProposalService } from './slash-proposal.service';

/**
 * The dispute upgrade's two events (assay-evm D-19), mirrored onto the case.
 *
 * - **`SlashDisputed`** — the provider froze a record. ONLY its part becomes
 *   `DISPUTED`, with the chain's `disputedAt` (audit E-4: a dispute on one
 *   part must not freeze the others, which would age out of their 7-day
 *   execution window). The case's mirror stays `PENDING` while any live part
 *   is pending — those parts keep executing — and becomes `DISPUTED` only
 *   when every live part is; `chain_disputed_parts` counts the disputed ones,
 *   so a partly disputed case reads honestly. A case still `PROPOSED`
 *   becomes `DISPUTED` (`ArbitrationService.fileDisputeFromChain`) at its
 *   first disputed part (review R3-5), so the dispute row exists when that
 *   part is later won or upheld; parts standing undisputed still execute
 *   (review N-1: the case is upheld for the executor once they pass their
 *   door). Every part disputed, it waits for the arbiter, with no platform
 *   deadline. A case already decided keeps its decision; the console shows
 *   the part "disputed on chain", waiting for the arbiter.
 * - **`SlashUpheld`** — the arbiter ruled against the provider. The part goes
 *   back to `PENDING` at the `executableAt` the EVENT carries (never assumed
 *   to be "now"), and the case's mirror and count follow. The ruling is the
 *   case's decision: an open case becomes `UPHELD`
 *   (`ArbitrationService.recordChainUphold`).
 *
 * - **`SlashCancelled`** — the arbiter's `cancelSlash` (a ruling for the
 *   provider) or anybody's `expireSlash` (audit E-6). The part becomes
 *   `CANCELLED`; once no part of the case stands and none executed, the case
 *   closes AT ONCE (it used to stay `DISPUTED` until the 30-day sweep, which
 *   then said, falsely, that the arbiter never ruled).
 *
 * After every event the case follows its records ({@link followRecords}),
 * so it always reaches a terminal state: EXECUTED once nothing stands and a
 * part executed, CANCELLED once nothing stands and none did.
 *
 * A case whose cancel is already requested (`CANCEL_REQUESTED`) keeps that
 * mirror: `cancelSlash` accepts a disputed record, and only the 30-day clock
 * is noted. An `UPHELD` case behind that mirror is a downward recalculation
 * (review S-2): its cancel is the platform's own, never a provider win, and
 * the case is left open for `sweepAdminCancels` to re-propose. Idempotent — the watcher re-reads a range after any failure.
 */
/** `chain_last_error` of a record of an earlier epoch that landed late (review N-9). */
const SUPERSEDED_EPOCH = 'SupersededEpoch';

/** Review R2-6: the page for a superseded earlier-epoch record standing on chain. */
export const SLASH_RECORD_SUPERSEDED_ALERT = 'slash_record_superseded';

/** Review R3-7: the page for a superseded record that executed (a double charge). */
export const SLASH_SUPERSEDED_EXECUTED_ALERT = 'slash_superseded_record_executed';

@Injectable()
export class SlashChainRulingService implements SlashChainRulingsPort {
  private readonly logger = new Logger(SlashChainRulingService.name);

  constructor(
    private readonly parts: SlashProposalPartRepository,
    private readonly proposals: SlashProposalRepository,
    private readonly lifecycle: SlashProposalService,
    @Optional() private readonly arbitration: ArbitrationService | null = null,
    @Optional() private readonly execution: SlashExecutionService | null = null,
    @Optional() @Inject(ALERT_PORT) private readonly alerts: AlertPort | null = null,
  ) {}

  async recordDisputed(event: SlashChainDisputedEvent): Promise<boolean> {
    const part = await this.parts.findOneByChainRequestId(event.requestId);
    if (!part) return false;
    const proposal = await this.proposals.findOneScoped(part.organizationId, part.proposalId);
    if (!proposal) return false;

    // Review R2-2: "first" is the timeline's, not the part's. A chain read
    // (the executor's `SlashNotPending`, the stranded-part sweep) may already
    // have mirrored the dispute onto the part before this event arrived.
    const first = !(await this.lifecycle.hasTimelineEntry(
      proposal.organizationId,
      proposal.id,
      'CHAIN_DISPUTED',
      event.requestId,
    ));
    if (part.chainStatus === 'PENDING' || part.chainStatus === 'REFUSED') {
      await this.parts.updatePart(part.organizationId, part.id, {
        chainStatus: 'DISPUTED',
        chainDisputedAt: event.disputedAt,
        chainExecutableAt: event.executableAt,
      });
    } else if (!part.chainDisputedAt) {
      await this.parts.updatePart(part.organizationId, part.id, {
        chainDisputedAt: event.disputedAt,
      });
    }

    // Only the current epoch's parts speak for the case's mirror.
    if (part.chainEpoch === proposal.chainEpoch) {
      await this.mirrorParts(proposal, {
        disputedAt:
          !proposal.chainDisputedAt || proposal.chainDisputedAt > event.disputedAt
            ? event.disputedAt
            : undefined,
      });
    }

    if (first) {
      await this.timeline(proposal, event.disputedAt, 'CHAIN_DISPUTED', {
        summary:
          'The provider disputed one part of this judgement on chain (disputeSlash). That part ' +
          'cannot execute until the arbiter rules, and unruled it expires 30 days after the ' +
          "dispute; the case's other parts are not affected",
        detail: {
          requestId: event.requestId,
          transactionHash: event.transactionHash,
          disputedAt: event.disputedAt.toISOString(),
          executableAt: event.executableAt.toISOString(),
        },
      });
    }
    if (part.chainEpoch === proposal.chainEpoch) {
      await this.followRecords(proposal, event);
    }
    return true;
  }

  async recordUpheld(event: SlashChainUpheldEvent): Promise<boolean> {
    const part = await this.parts.findOneByChainRequestId(event.requestId);
    if (!part) return false;
    const proposal = await this.proposals.findOneScoped(part.organizationId, part.proposalId);
    if (!proposal) return false;

    // Read off the event: the uphold need not make the record executable now.
    const moved =
      part.chainStatus === 'DISPUTED' ||
      part.chainExecutableAt?.getTime() !== event.executableAt.getTime();
    if (part.chainStatus === 'DISPUTED') {
      await this.parts.updatePart(part.organizationId, part.id, {
        chainStatus: 'PENDING',
        chainExecutableAt: event.executableAt,
      });
    }

    if (part.chainEpoch === proposal.chainEpoch) {
      await this.mirrorParts(proposal, {});
      // The arbiter's ruling is the decision on an EVM case: it moves the case
      // to UPHELD, so the executor sends it at the event's executableAt.
      await this.arbitration
        ?.recordChainUphold(proposal.organizationId, proposal.id, {
          arbiter: event.arbiter,
          transactionHash: event.transactionHash,
        })
        .catch((error: unknown) => {
          this.logger.error(
            `slash case ${proposal.id} was upheld on chain but could not be marked upheld`,
            error instanceof Error ? error.stack : String(error),
          );
        });
      await this.followRecords(proposal, event);
    }

    if (moved) {
      await this.timeline(proposal, new Date(), 'CHAIN_UPHELD', {
        summary:
          `The arbiter upheld this judgement on chain (upholdSlash); it is executable from ` +
          `${event.executableAt.toISOString()}`,
        detail: {
          requestId: event.requestId,
          arbiter: event.arbiter,
          transactionHash: event.transactionHash,
          executableAt: event.executableAt.toISOString(),
        },
      });
    }
    return true;
  }

  /**
   * The case's mirror, from its current-epoch parts: the disputed count, and
   * — only while the mirror is `PENDING` or `DISPUTED` — `DISPUTED` when every
   * live part is disputed, else `PENDING` at the latest door of its PENDING
   * parts (the parts the execute sweep will actually send).
   */
  private async mirrorParts(
    proposal: SlashProposalEntity,
    options: { disputedAt?: Date },
  ): Promise<void> {
    const parts = await this.parts.findForEpoch(
      proposal.organizationId,
      proposal.id,
      proposal.chainEpoch,
    );
    const disputed = parts.filter((row: SlashProposalPartEntity) => row.chainStatus === 'DISPUTED');
    const pending = parts.filter((row: SlashProposalPartEntity) => row.chainStatus === 'PENDING');
    const patch: Partial<SlashProposalEntity> = {};
    if (proposal.chainDisputedParts !== disputed.length) {
      patch.chainDisputedParts = disputed.length;
    }
    if (options.disputedAt) patch.chainDisputedAt = options.disputedAt;

    const standing =
      proposal.chainStatus === ChainProposalStatus.PENDING ||
      proposal.chainStatus === ChainProposalStatus.DISPUTED;
    if (standing) {
      if (pending.length === 0 && disputed.length > 0) {
        if (proposal.chainStatus !== ChainProposalStatus.DISPUTED) {
          patch.chainStatus = ChainProposalStatus.DISPUTED;
        }
      } else if (pending.length > 0) {
        if (proposal.chainStatus !== ChainProposalStatus.PENDING) {
          patch.chainStatus = ChainProposalStatus.PENDING;
        }
        const doors = pending
          .map((row) => row.chainExecutableAt)
          .filter((date): date is Date => date instanceof Date)
          .map((date) => date.getTime());
        if (doors.length > 0) {
          const door = new Date(Math.max(...doors));
          if (proposal.chainExecutableAt?.getTime() !== door.getTime()) {
            patch.chainExecutableAt = door;
          }
        }
      }
    }
    if (Object.keys(patch).length > 0) {
      await this.proposals.update(
        { organizationId: proposal.organizationId, id: proposal.id },
        patch,
      );
    }
  }

  async recordCancelled(event: SlashChainCancelledEvent): Promise<boolean> {
    const part = await this.parts.findOneByChainRequestId(event.requestId);
    if (!part) return false;
    const proposal = await this.proposals.findOneScoped(part.organizationId, part.proposalId);
    if (!proposal) return false;

    // Review S-2: the platform's own cancel of a downward recalculation (an
    // UPHELD case only ever has its cancel requested by
    // `reproposeAtRevisedPenalty`). It is neither a ruling for the provider nor
    // a reason to close the case: the decided, lower figure is re-proposed by
    // `sweepAdminCancels` once every part is off the chain. A dispute that ran
    // out unruled is still the provider's win.
    // Review N-9: never a cancel of a record that stood DISPUTED (the
    // arbiter's ruling for the provider), nor on a case the provider already
    // won a dispute of.
    const recalculating =
      proposal.status === SlashProposalStatus.UPHELD &&
      proposal.chainStatus === ChainProposalStatus.CANCEL_REQUESTED &&
      event.reason !== 'DISPUTE_UNRESOLVED' &&
      part.chainStatus !== 'DISPUTED' &&
      !proposal.chainDisputeWonAt;
    const ruledForProvider = event.reason === 'WITHDRAWN' && !recalculating;
    const because = ruledForProvider
      ? 'the arbiter ruled for the provider on chain (cancelSlash)'
      : `its on-chain record was expired (${event.reason})`;

    // Idempotent: our own expire already wrote it, or the watcher re-read. The
    // case still follows its records (review N-1): an expire the sweep wrote
    // first must not leave the case open.
    if (!['PENDING', 'DISPUTED', 'REFUSED'].includes(part.chainStatus)) {
      if (part.chainStatus === 'CANCELLED' && !part.cancelReason) {
        await this.parts.updatePart(part.organizationId, part.id, { cancelReason: event.reason });
      }
      if (part.chainEpoch === proposal.chainEpoch) {
        await this.followRecords(proposal, event, { because, recalculating });
      }
      return true;
    }
    const wasDisputed = part.chainStatus === 'DISPUTED';
    await this.parts.updatePart(part.organizationId, part.id, {
      chainStatus: 'CANCELLED',
      cancelledAt: event.cancelledAt,
      cancelReason: event.reason,
    });

    // Review R3-1: a record of an earlier epoch (superseded by a re-proposal)
    // speaks only for its own part. Its cancel or expiry is the platform's
    // duplicate cleaned up, not a ruling on the case, which follows only its
    // current-epoch records.
    if (part.chainEpoch !== proposal.chainEpoch) {
      await this.timeline(proposal, event.cancelledAt, 'CHAIN_CANCELLED', {
        summary: `A superseded record of an earlier proposal of this case was ${
          event.reason === 'WITHDRAWN' ? 'cancelled (cancelSlash)' : `expired (${event.reason})`
        } on chain and its reservation released; the current proposal is not affected`,
        detail: {
          requestId: event.requestId,
          reason: event.reason,
          transactionHash: event.transactionHash,
          cancelledAt: event.cancelledAt.toISOString(),
          superseded: true,
        },
      });
      return true;
    }

    // The provider won its dispute (B7): the record was cancelled while it
    // stood DISPUTED, or expired unruled. Remembered on the case so it is
    // never proposed again.
    if (
      ((wasDisputed && !recalculating) || event.reason === 'DISPUTE_UNRESOLVED') &&
      !proposal.chainDisputeWonAt
    ) {
      await this.proposals.update(
        { organizationId: proposal.organizationId, id: proposal.id },
        { chainDisputeWonAt: event.cancelledAt },
      );
    }
    await this.timeline(proposal, event.cancelledAt, 'CHAIN_CANCELLED', {
      summary: recalculating
        ? 'This part was cancelled on chain (cancelSlash) so the recalculated penalty can be ' +
          'proposed in its place'
        : ruledForProvider
          ? wasDisputed
            ? 'The arbiter ruled for the provider on chain (cancelSlash): this part is cancelled ' +
              'and its reservation released'
            : 'This part was cancelled on chain (cancelSlash) and its reservation released'
          : `This part was expired on chain (expireSlash, ${event.reason}) and its reservation ` +
            'released',
      detail: {
        requestId: event.requestId,
        reason: event.reason,
        transactionHash: event.transactionHash,
        cancelledAt: event.cancelledAt.toISOString(),
      },
    });

    await this.mirrorParts(proposal, {});
    await this.followRecords(proposal, event, { because, recalculating });
    return true;
  }

  /**
   * Review N-1: the case follows its current-epoch records, so a dispute on
   * one record never holds another and the case always reaches a terminal
   * state. Idempotent; every branch is a compare-and-set on the case status.
   *
   * - **Nothing stands** (no part `PENDING` or `DISPUTED`): `EXECUTED` when any
   *   part executed (the executor's completion, `mirrorChainExecution`, with
   *   the summed amounts; a dispute the provider won in part reads
   *   `PARTIALLY_UPHELD`, review R2-3), else closed `CANCELLED` — unless the cancel was the
   *   platform's own recalculation (S-2), left to `sweepAdminCancels`.
   * - **A part stands disputed on a `PROPOSED` case**: it becomes `DISPUTED`
   *   (its dispute row opened), whatever its siblings (review R3-5).
   * - **Only disputed parts stand**: the case waits for the arbiter. One the
   *   platform labelled `UPHELD` / `AUTO_UNDISPUTED` before the dispute was
   *   mirrored (or the executor holds, `EXECUTING`), with nothing executed,
   *   goes back to `DISPUTED` (review R2-2 / R3-5,
   *   `ArbitrationService.reopenForChainDispute`).
   * - **A part stands pending** (never disputed, or upheld): it executes at its
   *   door. A `PROPOSED` case with no disputed part is upheld there by the
   *   undisputed sweep. An open `DISPUTED` case (its disputed sibling ruled
   *   or lapsed, or a straggler re-adopted) is upheld so the executor sends
   *   it: as the arbiter's uphold (`CHAIN_ARBITER`) when a pending part was
   *   disputed before (review R2-10), else as `AUTO_UNDISPUTED` — and that
   *   only once every pending undisputed part is past its door by
   *   `CHAIN_DISPUTE_SETTLE_MS` (review R2-2; {@link followOpenCasesPastDoor}
   *   comes back for it). The executor sends every pending part whatever its
   *   siblings.
   */
  async followRecords(
    proposal: SlashProposalEntity,
    chain: { readonly requestId?: string; readonly transactionHash: string | null },
    closing?: { readonly because: string; readonly recalculating: boolean },
  ): Promise<void> {
    const fresh =
      (await this.proposals.findOneScoped(proposal.organizationId, proposal.id)) ?? proposal;
    const parts = await this.parts.findForEpoch(fresh.organizationId, fresh.id, fresh.chainEpoch);
    if (parts.length === 0) return;
    const has = (status: string) =>
      parts.some((row: SlashProposalPartEntity) => row.chainStatus === status);
    const scope = { organizationId: fresh.organizationId, id: fresh.id };

    if (!has('PENDING') && !has('DISPUTED')) {
      // A part not yet on chain (or still being proposed) may still land.
      if (has('NONE')) return;
      if (has('EXECUTED')) {
        await this.execution?.mirrorChainExecution(fresh, chain.transactionHash);
        // Review R2-3: executed in part, won in part — the dispute says so.
        if (has('CANCELLED')) {
          await Promise.resolve(
            this.arbitration?.recordPartialChainWin(fresh.organizationId, fresh.id),
          ).catch((error: unknown) => {
            this.logger.error(
              `slash case ${fresh.id}: its partly won dispute could not be recorded`,
              error instanceof Error ? error.stack : String(error),
            );
          });
        }
        return;
      }
      if (fresh.chainStatus === ChainProposalStatus.CANCELLED) return;
      if (fresh.chainDisputedParts !== 0) {
        await this.proposals.update(scope, { chainDisputedParts: 0 });
      }
      // Left `CANCEL_REQUESTED` for `sweepAdminCancels`, which mirrors the
      // cancel and re-proposes the decided figure.
      if (closing?.recalculating) return;
      const because = closing?.because ?? 'every one of its on-chain records was cancelled';
      if (this.execution) {
        // The arbiter's cancelSlash, told from an expiry by the records'
        // cancel reasons (the case screen's `chainState` rule): recorded as
        // the arbiter's ruling, not read as "Expired" (audit D3).
        const byArbiter = cancelledByArbiter(
          parts.map((row: SlashProposalPartEntity) => ({
            chainStatus: row.chainStatus,
            chainDisputedAt: row.chainDisputedAt ?? null,
            chainExecutableAt: row.chainExecutableAt ?? null,
            cancelReason: row.cancelReason ?? null,
          })),
        );
        await this.execution.closeCancelledOnChain(fresh, because, { byArbiter });
      } else {
        await this.proposals.update(scope, {
          chainStatus: ChainProposalStatus.CANCELLED,
          chainDisputedParts: 0,
        });
      }
      return;
    }

    const pending = parts.filter((row: SlashProposalPartEntity) => row.chainStatus === 'PENDING');
    const disputedChain = {
      requestId:
        chain.requestId ??
        parts.find((row: SlashProposalPartEntity) => row.chainStatus === 'DISPUTED')
          ?.chainRequestId ??
        fresh.chainRequestId,
      transactionHash: chain.transactionHash,
    };
    const settled = Date.now() - CHAIN_DISPUTE_SETTLE_MS;
    // Review R3-5: a `PROPOSED` case opens its dispute at the first disputed
    // record, whatever its siblings, so a partly won dispute has its row.
    // Undisputed siblings still execute: the case is upheld for the executor
    // once they pass their door (the pending branch below, on a later tick).
    const reopenable =
      (fresh.status === SlashProposalStatus.UPHELD ||
        fresh.status === SlashProposalStatus.EXECUTING) &&
      !has('EXECUTED');
    const move =
      fresh.status === SlashProposalStatus.PROPOSED && has('DISPUTED')
        ? this.arbitration?.fileDisputeFromChain(fresh.organizationId, fresh.id, disputedChain)
        : pending.length > 0
          ? pending.some((row) => row.chainDisputedAt)
            ? this.arbitration?.recordChainUphold(fresh.organizationId, fresh.id, {
                arbiter: null,
                transactionHash: chain.transactionHash,
              })
            : pending.every((row) => (row.chainExecutableAt?.getTime() ?? Infinity) <= settled)
              ? this.arbitration?.recordChainStanding(fresh.organizationId, fresh.id, {
                  disputeStillOpen: has('DISPUTED'),
                })
              : undefined
          : reopenable
            ? this.arbitration?.reopenForChainDispute(fresh.organizationId, fresh.id, disputedChain)
            : undefined;
    await Promise.resolve(move).catch((error: unknown) => {
      this.logger.error(
        `slash case ${fresh.id} could not follow its on-chain records`,
        error instanceof Error ? error.stack : String(error),
      );
    });
  }

  /**
   * `SlashExecuted`, whoever sent it (BUG-R13-D-03): `executeSlash` is
   * permissionless, so a keeper, a script or the provider may pay a record the
   * backend's executor has not reached yet. The part (or single record) is
   * mirrored `EXECUTED` with the event's amounts, and the case follows through
   * the same completion the executor uses (`mirrorChainExecution`).
   *
   * Idempotent with the executor's own mirror and with itself: a part already
   * `EXECUTED` is not rewritten, and a case already `EXECUTED` (or in the
   * executor's hands, `EXECUTING`) is not moved again. A late part of a case
   * already `EXECUTED` is folded into its money columns, with the same
   * compensation step (`SlashExecutionService.refoldLatePart`, review R2-4).
   */
  async recordExecuted(event: SlashChainExecutedEvent): Promise<boolean> {
    const part = await this.parts.findOneByChainRequestId(event.requestId);
    const proposal = part
      ? await this.proposals.findOneScoped(part.organizationId, part.proposalId)
      : await this.proposals.findOneByChainRequestId(event.requestId);
    if (!proposal) return false;

    if (part && part.chainStatus !== 'EXECUTED') {
      await this.parts.updatePart(part.organizationId, part.id, {
        chainStatus: 'EXECUTED',
        appliedAmount: event.appliedMinor,
        agentAmount: event.agentAmountMinor,
        platformAmount: event.platformAmountMinor,
        executedAt: event.executedAt,
        executionSignature: part.executionSignature ?? event.transactionHash,
        chainLastError: null,
      });
    }
    if (part && part.chainEpoch !== proposal.chainEpoch) {
      this.logger.error(
        `CRITICAL: slash record ${event.requestId} of an earlier epoch of case ${proposal.id} ` +
          `was executed on chain (${event.appliedMinor}); the same calls may have been charged ` +
          'twice and need a human',
      );
      // Review R3-7: an actual double charge pages a human, once per record.
      await this.alerts?.emit({
        severity: AlertSeverity.CRITICAL,
        name: SLASH_SUPERSEDED_EXECUTED_ALERT,
        summary:
          `A superseded slash record of an earlier proposal of case ${proposal.id} was ` +
          `executed on chain (${event.appliedMinor}); the same calls may have been charged ` +
          'twice and need a human',
        details: {
          chainId: event.chainId,
          requestId: `0x${event.requestId}`,
          proposalId: proposal.id,
          organizationId: proposal.organizationId,
          appliedMinor: event.appliedMinor,
          transactionHash: event.transactionHash,
        },
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: `${event.chainId}:${event.requestId}`,
      });
      return true;
    }
    if (part) {
      await this.mirrorParts(proposal, {});
      await this.followRecords(proposal, event);
      // Review R2-4: a late part of a case already closed EXECUTED.
      await this.execution?.refoldLatePart(proposal, event.transactionHash);
    } else if (this.execution) {
      await this.execution.mirrorChainExecution(proposal, event.transactionHash);
    }
    return true;
  }

  /**
   * A straggler that landed after it was given up on (review S-5): its record
   * stands on chain and reserves the provider's stake, but the part says
   * `REFUSED`, so nothing would execute or expire it. The case's records are
   * re-read by the one match rule (`SlashExecutionService.reconcileRecord`),
   * which brings the part back to `PENDING`; the case's mirror then follows,
   * so the part executes with its siblings (or, on a case already executed,
   * the stranded-part sweep pays or expires it).
   *
   * Only a `REFUSED` part of the current epoch: a part still `NONE` is the
   * proposer's own to adopt, and a `RecordMismatch` refusal is not ours.
   */
  async recordLateProposal(event: SlashChainProposedEvent): Promise<boolean> {
    const part = await this.parts.findOneByChainRequestId(event.requestId);
    if (!part) return false;
    if (
      !['REFUSED', 'NONE'].includes(part.chainStatus) ||
      part.chainLastError?.startsWith('RecordMismatch')
    ) {
      return true;
    }
    const proposal = await this.proposals.findOneScoped(part.organizationId, part.proposalId);
    if (!proposal) return false;
    if (part.chainEpoch !== proposal.chainEpoch) {
      // Review N-9: a record of an earlier epoch stands beside the current
      // one, over the same calls, so executing both would charge them twice.
      // It is not re-adopted: no sweep of this platform executes it (they
      // read the current epoch only), and the arbiter is asked to cancel it.
      await this.parts.updatePart(part.organizationId, part.id, {
        chainStatus: 'PENDING',
        chainExecutableAt: event.executableAt,
        chainLastError: SUPERSEDED_EPOCH,
      });
      this.logger.error(
        `CRITICAL: slash record ${event.requestId} of an earlier epoch of case ${proposal.id} ` +
          `landed on chain after the case was re-proposed; it would charge the same calls ` +
          `twice. The arbiter must cancel it (cancelSlash) before ${event.executableAt.toISOString()}`,
      );
      // Review R2-6: a page, not only a log line. The arbiter page lists the
      // record with its guarded cancel (`GET /operator/arbiter/superseded`).
      await this.alerts?.emit({
        severity: AlertSeverity.CRITICAL,
        name: SLASH_RECORD_SUPERSEDED_ALERT,
        summary:
          `A slash record of an earlier proposal of case ${proposal.id} landed on chain late; ` +
          'it would charge the same calls twice. The arbiter must cancel it (arbiter page, ' +
          `superseded records) before ${event.executableAt.toISOString()}`,
        details: {
          chainId: event.chainId,
          requestId: `0x${event.requestId}`,
          proposalId: proposal.id,
          organizationId: proposal.organizationId,
          executableAt: event.executableAt.toISOString(),
        },
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: `${event.chainId}:${event.requestId}`,
      });
      await this.timeline(proposal, new Date(), 'CHAIN_SUPERSEDED_RECORD', {
        summary:
          'A record of an earlier proposal of this case landed on chain late. It is not ' +
          'executed by Assay, and the arbiter is asked to cancel it so the same calls are not ' +
          'charged twice',
        detail: {
          requestId: event.requestId,
          transactionHash: event.transactionHash,
          executableAt: event.executableAt.toISOString(),
        },
      });
      return true;
    }
    // A current-epoch part still `NONE` is the proposer's own to adopt.
    if (part.chainStatus !== 'REFUSED') return true;
    if (!this.execution) {
      this.logger.warn(
        `slash part ${event.requestId} (case ${proposal.id}) was given up on but its record ` +
          'landed on chain; it is not re-adopted here (no slash execution in this process)',
      );
      return true;
    }
    await this.execution.reconcileRecord(proposal);
    await this.mirrorParts(proposal, {});
    await this.timeline(proposal, new Date(), 'CHAIN_PART_READOPTED', {
      summary:
        'A part given up on was proposed on chain after all (its transaction landed late); it ' +
        'is pending again and executes with the rest of the case',
      detail: {
        requestId: event.requestId,
        transactionHash: event.transactionHash,
        executableAt: event.executableAt.toISOString(),
      },
    });
    return true;
  }

  /**
   * Review N-3: open `DISPUTED` cases, re-read after the scheduler starts so
   * one whose event was missed while it was down still moves. Each case's records are re-read from the chain onto its parts,
   * and the case then follows them ({@link followRecords}): a record standing
   * undisputed makes it `UPHELD` for the executor, a case with nothing
   * standing closes, and one whose every record is disputed on chain stays for
   * the arbiter. Idempotent.
   *
   * One page after `after` (review R2-5): `next` is the cursor of the
   * following page, `null` once this page was the last, and `failed` the
   * cases whose read failed, for {@link reconcileCases} to retry.
   */
  async reconcileOpenCases(
    limit: number,
    after: { readonly proposedAt: Date; readonly id: string } | null = null,
  ): Promise<{
    moved: number;
    failed: { organizationId: string; id: string }[];
    next: { proposedAt: Date; id: string } | null;
  }> {
    const rows = await this.proposals.findOpenOnChainCases(limit, after);
    const { moved, failed } = await this.reconcileCases(rows);
    const last = rows[rows.length - 1];
    return {
      moved,
      failed,
      next:
        rows.length < limit || !last
          ? null
          : { proposedAt: new Date(last.proposedAt), id: last.id },
    };
  }

  /** {@link reconcileOpenCases} for the given cases: re-read, then follow. */
  async reconcileCases(
    rows: readonly { readonly organizationId: string; readonly id: string }[],
  ): Promise<{ moved: number; failed: { organizationId: string; id: string }[] }> {
    let moved = 0;
    const failed: { organizationId: string; id: string }[] = [];
    for (const row of rows) {
      try {
        const proposal = await this.proposals.findOneScoped(row.organizationId, row.id);
        if (!proposal) continue;
        await this.execution?.reconcileRecord(proposal);
        await this.mirrorParts(proposal, {});
        await this.followRecords(proposal, { transactionHash: null });
        const after = await this.proposals.findOneScoped(row.organizationId, row.id);
        if (after && after.status !== proposal.status) moved += 1;
      } catch (error) {
        failed.push({ organizationId: row.organizationId, id: row.id });
        this.logger.error(
          `slash case ${row.id}: its on-chain records could not be re-read; retried later`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
    return { moved, failed };
  }

  /**
   * Review R2-2: open `DISPUTED` cases a record of which stands pending past its door by
   * `CHAIN_DISPUTE_SETTLE_MS`. {@link followRecords} leaves such a case open
   * until every undisputed record has settled, and no event comes back for
   * it; every tick follows them again. No chain read: the parts are mirrored
   * already. Returns how many cases moved.
   */
  async followOpenCasesPastDoor(now: Date, limit: number): Promise<number> {
    const rows = await this.proposals.findOpenOnChainPastDoor(
      new Date(now.getTime() - CHAIN_DISPUTE_SETTLE_MS),
      limit,
    );
    let moved = 0;
    for (const row of rows) {
      try {
        const proposal = await this.proposals.findOneScoped(row.organizationId, row.id);
        if (!proposal) continue;
        await this.followRecords(proposal, { transactionHash: null });
        const after = await this.proposals.findOneScoped(row.organizationId, row.id);
        if (after && after.status !== proposal.status) moved += 1;
      } catch (error) {
        this.logger.error(
          `slash case ${row.id}: following its on-chain records past their door failed`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
    return moved;
  }

  private async timeline(
    proposal: SlashProposalEntity,
    occurredAt: Date,
    kind: string,
    entry: { summary: string; detail: Record<string, unknown> },
  ): Promise<void> {
    try {
      await this.lifecycle.appendEventDirect({
        organizationId: proposal.organizationId,
        proposalId: proposal.id,
        occurredAt,
        kind,
        actorType: 'system',
        actorId: null,
        summary: entry.summary,
        detail: entry.detail,
      });
    } catch (error) {
      this.logger.error(
        `slash case ${proposal.id}: the ${kind} timeline entry failed`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
