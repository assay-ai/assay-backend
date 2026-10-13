import { Injectable, Logger, Optional } from '@nestjs/common';

import { SlashProposalEntity } from '@database/postgres/entities/slash-proposal.entity';
import { SlashProposalPartEntity } from '@database/postgres/entities/slash-proposal-part.entity';
import { SlashProposalPartRepository } from '@database/postgres/repositories/slash-proposal-part.repository';
import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';

import { ChainProposalStatus } from '../domain/chain-slash-outcome';
import {
  SlashChainCancelledEvent,
  SlashChainDisputedEvent,
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
 *   so a partly disputed case reads honestly. A case still `PROPOSED` is moved
 *   into review exactly as an in-app objection would
 *   (`ArbitrationService.fileDisputeFromChain`). A case the platform already
 *   decided keeps its decision; the console shows the part "disputed on
 *   chain", waiting for the arbiter.
 * - **`SlashUpheld`** — the arbiter ruled against the provider. The part goes
 *   back to `PENDING` at the `executableAt` the EVENT carries (never assumed
 *   to be "now"), and the case's mirror and count follow.
 *
 * - **`SlashCancelled`** — the arbiter's `cancelSlash` (a ruling for the
 *   provider) or anybody's `expireSlash` (audit E-6). The part becomes
 *   `CANCELLED`; once no part of the case stands and none executed, the case
 *   closes AT ONCE (it used to stay `DISPUTED` until the 30-day sweep, which
 *   then said, falsely, that the arbiter never ruled).
 *
 * A case whose cancel is already requested (`CANCEL_REQUESTED`) keeps that
 * mirror: `cancelSlash` accepts a disputed record, and only the 30-day clock
 * is noted. Idempotent — the watcher re-reads a range after any failure.
 */
@Injectable()
export class SlashChainRulingService implements SlashChainRulingsPort {
  private readonly logger = new Logger(SlashChainRulingService.name);

  constructor(
    private readonly parts: SlashProposalPartRepository,
    private readonly proposals: SlashProposalRepository,
    private readonly lifecycle: SlashProposalService,
    @Optional() private readonly arbitration: ArbitrationService | null = null,
    @Optional() private readonly execution: SlashExecutionService | null = null,
  ) {}

  async recordDisputed(event: SlashChainDisputedEvent): Promise<boolean> {
    const part = await this.parts.findOneByChainRequestId(event.requestId);
    if (!part) return false;
    const proposal = await this.proposals.findOneScoped(part.organizationId, part.proposalId);
    if (!proposal) return false;

    const first = part.chainStatus !== 'DISPUTED' && part.chainDisputedAt === null;
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
      // Into review, as an in-app objection would put it.
      await this.arbitration
        ?.fileDisputeFromChain(proposal.organizationId, proposal.id, {
          requestId: event.requestId,
          transactionHash: event.transactionHash,
        })
        .catch((error: unknown) => {
          this.logger.error(
            `slash case ${proposal.id} was disputed on chain but could not be moved into review`,
            error instanceof Error ? error.stack : String(error),
          );
        });
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

    // Idempotent: our own expire already wrote it, or the watcher re-read.
    if (!['PENDING', 'DISPUTED', 'REFUSED'].includes(part.chainStatus)) return true;
    const wasDisputed = part.chainStatus === 'DISPUTED';
    await this.parts.updatePart(part.organizationId, part.id, {
      chainStatus: 'CANCELLED',
      cancelledAt: event.cancelledAt,
    });

    const ruledForProvider = event.reason === 'WITHDRAWN';
    // The provider won its dispute (B7): the record was cancelled while it
    // stood DISPUTED, or expired unruled. Remembered on the case so it is
    // never proposed again.
    if ((wasDisputed || event.reason === 'DISPUTE_UNRESOLVED') && !proposal.chainDisputeWonAt) {
      await this.proposals.update(
        { organizationId: proposal.organizationId, id: proposal.id },
        { chainDisputeWonAt: event.cancelledAt },
      );
    }
    await this.timeline(proposal, event.cancelledAt, 'CHAIN_CANCELLED', {
      summary: ruledForProvider
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

    if (part.chainEpoch !== proposal.chainEpoch) return true;
    const parts = await this.parts.findForEpoch(
      proposal.organizationId,
      proposal.id,
      proposal.chainEpoch,
    );
    const standing = parts.some((row: SlashProposalPartEntity) =>
      ['PENDING', 'DISPUTED'].includes(row.chainStatus),
    );
    const executed = parts.some((row: SlashProposalPartEntity) => row.chainStatus === 'EXECUTED');
    if (standing || executed) {
      await this.mirrorParts(proposal, {});
      return true;
    }
    const because = ruledForProvider
      ? 'the arbiter ruled for the provider on chain (cancelSlash)'
      : `its on-chain record was expired (${event.reason})`;
    await this.proposals.update(
      { organizationId: proposal.organizationId, id: proposal.id },
      { chainDisputedParts: 0 },
    );
    if (this.execution) {
      await this.execution.closeCancelledOnChain(proposal, because);
    } else {
      await this.proposals.update(
        { organizationId: proposal.organizationId, id: proposal.id },
        { chainStatus: ChainProposalStatus.CANCELLED, chainDisputedParts: 0 },
      );
    }
    return true;
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
