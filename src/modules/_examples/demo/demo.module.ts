import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DemoQueue } from './constants/demo-queues.constant';
import { DemoPingPublisher } from './publishers/demo-ping.publisher';
import { DemoService } from './services/demo.service';

/**
 * SHARED demo module — providers usable from both api and worker bootstraps.
 *
 * Belongs in `imports` of the api/worker-specific demo modules, never
 * directly in a bootstrap. Holds anything that does not, by itself, cause a
 * BullMQ Worker or a scheduled cron to start: services, publishers, queue
 * registration.
 *
 * `BullModule.registerQueue` is in `imports` AND re-exported, so the api side
 * (Bull Board) can resolve the queue token via `getQueueToken(...)`. Bull
 * Board `forFeature` itself stays out of this shared module — it depends on
 * `BullBoardModule.forRootAsync` which only the api bootstrap mounts.
 */
@Module({
  imports: [BullModule.registerQueue({ name: DemoQueue.PING })],
  providers: [DemoService, DemoPingPublisher],
  exports: [DemoService, DemoPingPublisher, BullModule],
})
export class DemoModule {}
