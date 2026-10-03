import { Module } from '@nestjs/common';

import { VerificationJudgeProcessor } from './processors/verification-judge.processor';
import { VerificationModule } from './verification.module';

/**
 * Worker-side verification module — imported only by `AppWorkerModule`.
 *
 * Holds `VerificationJudgeProcessor` alone: instantiating a `@Processor()`
 * starts a BullMQ `Worker` immediately, and neither the api process nor the
 * mcp process may become a consumer of `verification.judge` — both of them
 * only ever publish to it (the api indirectly, through whatever surface
 * calls verification services; the mcp process directly, from
 * `McpToolCallService`). See `docs/adr/0001-bullmq-as-wakeup-mechanism.md`
 * §"Module split: shared / api / worker".
 */
@Module({
  imports: [VerificationModule],
  providers: [VerificationJudgeProcessor],
})
export class VerificationWorkerModule {}
