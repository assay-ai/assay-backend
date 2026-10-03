import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PostgresModule } from '@database/postgres';
import { PostsQueue } from './constants/posts-queues.constant';
import { PostCreatedPublisher } from './publishers/post-created.publisher';
import { PostsService } from './services/posts.service';

/**
 * SHARED posts module — providers usable from both api and worker bootstraps.
 *
 * Belongs in `imports` of the api/worker-specific posts modules, never
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
  imports: [PostgresModule, BullModule.registerQueue({ name: PostsQueue.CREATED })],
  providers: [PostsService, PostCreatedPublisher],
  exports: [PostsService, PostCreatedPublisher, BullModule],
})
export class PostsModule {}
