import { Injectable, Logger, Optional } from '@nestjs/common';

import { SlashProposalEntity } from '@database/postgres/entities/slash-proposal.entity';
import { SlashProposalPartEntity } from '@database/postgres/entities/slash-proposal-part.entity';
import { SlashProposalPartRepository } from '@database/postgres/repositories/slash-proposal-part.repository';
import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';

import { ChainProposalStatus } from '../domain/chain-slash-outcome';
import {
  SlashChainDisputedEvent,
  SlashChainRulingsPort,
  SlashChainUpheldEvent,
} from '../ports/slash-chain-rulings.port';
import { ArbitrationService } from './arbitration.service';
import { SlashProposalService } from './slash-proposal.service';

/**
 * The dispute upgrade's two events (assay-evm D-19), mirrored onto the case.
 *
 * - **`SlashDisputed`** — the provider froze a record. Its part becomes
 *   `DISPUTED` with the chain's `disputedAt`; the case's mirror follows
 *   (`PENDING` → `DISPUTED`, which takes it out of the execute sweep), and a
 *   case still `PROPOSED` is moved into review exactly as an in-app
 *   objection would (`ArbitrationService.fileDisputeFromChain`). A case the
 *   platform already decided keeps its decision; the console shows it
 *   "disputed on chain", waiting for the arbiter.
 * - **`SlashUpheld`** — the arbiter ruled against the provider. The part goes
 *   back to `PENDING` at the `executableAt` the EVENT carries (never assumed
 *   to be "now"), and the case's mirror back to `PENDING` once none of its
 *   parts is still disputed.
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
      const patch: Partial<SlashProposalEntity> = {};
      if (proposal.chainStatus === ChainProposalStatus.PENDING) {
        patch.chainStatus = ChainProposalStatus.DISPUTED;
      }
      if (!proposal.chainDisputedAt || proposal.chainDisputedAt > event.disputedAt) {
        patch.chainDisputedAt = event.disputedAt;
      }
      if (Object.keys(patch).length > 0) {
        await this.proposals.update(
          { organizationId: proposal.organizationId, id: proposal.id },
          patch,
        );
      }
    }

    if (first) {
      await this.timeline(proposal, event.disputedAt, 'CHAIN_DISPUTED', {
        summary:
          'The provider disputed this judgement on chain (disputeSlash). Nothing of it can ' +
          'execute until the arbiter rules; unruled, it expires 30 days after the dispute',
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
      const siblings = await this.parts.findForEpoch(
        proposal.organizationId,
        proposal.id,
        proposal.chainEpoch,
      );
      const stillDisputed = siblings.some(
        (sibling: SlashProposalPartEntity) =>
          sibling.id !== part.id && sibling.chainStatus === 'DISPUTED',
      );
      if (proposal.chainStatus === ChainProposalStatus.DISPUTED && !stillDisputed) {
        const doors = siblings
          .map((sibling) =>
            sibling.id === part.id ? event.executableAt : sibling.chainExecutableAt,
          )
          .filter((date): date is Date => date instanceof Date)
          .map((date) => date.getTime());
        await this.proposals.update(
          { organizationId: proposal.organizationId, id: proposal.id },
          {
            chainStatus: ChainProposalStatus.PENDING,
            chainExecutableAt: new Date(Math.max(...doors, event.executableAt.getTime())),
          },
        );
      }
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
