import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { OperatorApprovalRepository } from '@database/postgres/repositories/operator-approval.repository';

/** Every 30 seconds, offset from the minute's other jobs. */
export const OPERATOR_APPROVAL_EXPIRY_CRON = '20,50 * * * * *';

/**
 * Stores `EXPIRED` on approvals past their window.
 *
 * The reads (`GET /operator/approvals`, `/:id`) used to run this UPDATE on
 * every request. They now answer a lapsed `PENDING` row as `EXPIRED` without
 * writing, and every path that decides on a row (approve, reject, the
 * publish freeze) still sweeps first, so the stored state only needs to catch
 * up for the record. Idempotent, so a second scheduler replica is harmless.
 */
@Injectable()
export class OperatorApprovalExpiryJob {
  private readonly logger = new Logger(OperatorApprovalExpiryJob.name);

  constructor(private readonly approvals: OperatorApprovalRepository) {}

  @Cron(OPERATOR_APPROVAL_EXPIRY_CRON, { waitForCompletion: true })
  async handleExpiry(): Promise<void> {
    try {
      const expired = await this.approvals.expireStale();
      if (expired > 0) this.logger.log(`Operator approvals expired: ${expired}`);
    } catch (error) {
      // A throw out of a @Cron handler would be an unhandled rejection.
      this.logger.error(
        `Operator approval expiry failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
