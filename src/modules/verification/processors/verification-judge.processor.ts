import { Processor } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Job } from 'bullmq';

import { QueueProcessorBase } from '@shared/queue';

import { VerificationQueue } from '../constants/verification-queues.constant';
import { VerificationJudgeJobData } from '../publishers/verification-judge.publisher';
import { VerificationSettlementService } from '../services/verification-settlement.service';

/**
 * Processor for the `verification.judge` queue — runs in the worker process
 * only.
 *
 * Deliberately thin: every decision — judge, settle, or repair a hold the
 * intent's own status says should already be closed — lives in
 * `VerificationSettlementService`, which is what a `test/unit` suite can
 * exercise without a queue. This class's only job is to unwrap the job data
 * and hand the two ids to it.
 *
 * Registered by `VerificationWorkerModule`, never by anything the api or mcp
 * process imports: a `@Processor()` starts a BullMQ `Worker` the moment it is
 * instantiated, and neither of those processes may become a consumer of a
 * queue they only publish to.
 */
@Processor(VerificationQueue.JUDGE)
@Injectable()
export class VerificationJudgeProcessor extends QueueProcessorBase<VerificationJudgeJobData> {
  constructor(private readonly settlement: VerificationSettlementService) {
    super();
  }

  async process(job: Job<VerificationJudgeJobData>): Promise<void> {
    const { organizationId, intentId, recordId } = job.data;
    this.logger.log(
      `Judging intent ${intentId} (record ${recordId}, attempt ${job.attemptsMade + 1})`,
    );
    await this.settlement.judgeAndSettle(organizationId, intentId);
  }
}
