import { Injectable, Logger } from '@nestjs/common';

import {
  DepositIntentRepository,
  DueDepositIntent,
} from '@database/postgres/repositories/deposit-intent.repository';

import {
  DEPOSIT_INTENT_EXPIRY_REASON,
  DEPOSIT_INTENT_EXPIRY_SWEEP_BATCH,
} from '../constants/deposit-intent.constants';
import { DepositIntentStatus } from '../ports/deposit.types';
import { DepositIntentService } from './deposit-intent.service';

export interface DepositIntentSweepReport {
  readonly expired: number;
  readonly failed: number;
}

/**
 * The deposit-intent expiry sweep.
 *
 * One pass, not two — unlike `PaymentIntentExpiryService`, there is no hold
 * to release and no repair pass to run: a deposit intent never reserves
 * anything from the ledger, so expiring one moves a status and nothing else.
 * See `DEPOSIT_INTENT_TRANSITIONS`'s header for why `SETTLING` needs no
 * backstop of its own.
 */
@Injectable()
export class DepositIntentExpiryService {
  private readonly logger = new Logger(DepositIntentExpiryService.name);

  constructor(
    private readonly deposits: DepositIntentRepository,
    private readonly depositIntents: DepositIntentService,
  ) {}

  async sweep(
    now: Date = new Date(),
    limit: number = DEPOSIT_INTENT_EXPIRY_SWEEP_BATCH,
  ): Promise<DepositIntentSweepReport> {
    const due = await this.deposits.findDueForExpiry(now, limit);

    let expired = 0;
    let failed = 0;

    for (const candidate of due) {
      try {
        await this.expire(candidate);
        expired += 1;
      } catch (error) {
        failed += 1;
        this.logger.error(
          `Deposit intent ${candidate.id}: expiry sweep failed from ${candidate.status}. ${describe(error)}`,
        );
      }
    }

    if (expired || failed) {
      this.logger.log(`Deposit expiry sweep: ${expired} expired, ${failed} failed`);
    }

    return { expired, failed };
  }

  private async expire(candidate: DueDepositIntent): Promise<void> {
    await this.depositIntents.transition(
      candidate.organizationId,
      candidate.id,
      candidate.status as DepositIntentStatus,
      DepositIntentStatus.EXPIRED,
      { reason: DEPOSIT_INTENT_EXPIRY_REASON },
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
