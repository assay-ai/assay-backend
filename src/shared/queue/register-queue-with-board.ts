import { DynamicModule } from '@nestjs/common';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';

/**
 * Helper for api-side feature modules: registers a queue with the Bull Board
 * dashboard.
 *
 * MUST only be called from a module that ends up inside `AppApiModule` —
 * `BullBoardModule.forFeature` requires the `bull_board_instance` provider,
 * which is created only by `BullBoardModule.forRootAsync` (mounted in
 * `BullBoardConfigModule`, api-only). Calling this from a shared module that
 * also gets imported by `AppWorkerModule` will crash the worker at boot.
 *
 * The matching `BullModule.registerQueue({ name })` call belongs in the
 * SHARED `*.module.ts` (so both api publisher and worker processor can inject
 * the same queue). Pair them as:
 *
 *   // {feature}.module.ts (shared)
 *   imports: [BullModule.registerQueue({ name: MyQueue.X })]
 *   exports: [BullModule]   // re-export so api side can find the queue token
 *
 *   // {feature}-api.module.ts
 *   imports: [FeatureModule, registerQueueOnBoard(MyQueue.X)]
 */
export function registerQueueOnBoard(queueName: string): DynamicModule {
  return BullBoardModule.forFeature({
    name: queueName,
    adapter: BullMQAdapter,
  });
}
