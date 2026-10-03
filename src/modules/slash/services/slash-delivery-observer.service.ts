import { Injectable, Logger } from '@nestjs/common';

import { DeliveryObserverPort } from '@modules/notification/ports/delivery-observer.port';

import { SLASH_PROPOSAL_SUBJECT_TYPE } from '../constants/slash-subject.constants';
import { SlashProposalService } from './slash-proposal.service';

/**
 * The slash side of `DeliveryObserverPort` — the caller
 * `SlashProposalService.markDelivered` never had.
 *
 * Until this existed, `respond_by_at` stayed null on every proposal, so
 * `SlashProposalRepository.findUndisputedPast` (which requires
 * `respond_by_at IS NOT NULL`) matched nothing and `sweepUndisputed` — running
 * every minute since it shipped — could never promote a proposal to `UPHELD`.
 * The demo seed called `markDelivered` by hand and said so in a comment; that
 * was a production gap, not a script convenience.
 *
 * Registered against the port by `NotificationWorkerModule`, so it exists only
 * in the worker process, which is the only process that learns whether a
 * channel delivered.
 */
@Injectable()
export class SlashDeliveryObserver implements DeliveryObserverPort {
  private readonly logger = new Logger(SlashDeliveryObserver.name);

  constructor(private readonly proposals: SlashProposalService) {}

  /**
   * Never throws — the port's contract, and the processor depends on it: the
   * notification has already been delivered and its row already written by the
   * time this runs, so a failure here must not fail the job and re-send it.
   *
   * Idempotency is not re-implemented here. `markDelivered` is guarded on
   * `notified_at IS NULL` in SQL, so a second channel delivering the same
   * proposal is a no-op rather than a deadline pushed further out.
   */
  async onDelivered(
    organizationId: string,
    subjectType: string,
    subjectId: string,
    deliveredAt: Date,
  ): Promise<void> {
    if (subjectType !== SLASH_PROPOSAL_SUBJECT_TYPE) return;

    try {
      await this.proposals.markDelivered(organizationId, subjectId, deliveredAt);
    } catch (error) {
      this.logger.error(
        `Could not start the response clock for slash proposal ${subjectId}: ` +
          `${(error as Error).message}`,
      );
    }
  }
}
