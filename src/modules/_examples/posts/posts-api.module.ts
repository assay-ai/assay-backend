import { Module } from '@nestjs/common';
import { registerQueueOnBoard } from '@shared/queue';
import { PostsModule } from './posts.module';
import { PostsQueue } from './constants/posts-queues.constant';
import { PostsController } from './controllers/posts.controller';

/**
 * API-side posts module — imported only by `AppApiModule`.
 *
 * Holds anything that should run only in the api process: HTTP controllers,
 * Bull Board feature registration (which depends on the api-only root).
 *
 * Pattern every feature module pair must follow — see
 * `backend/docs/adr/0001-bullmq-as-wakeup-mechanism.md` for why the api side
 * and worker side are kept in separate Nest modules instead of one combined
 * feature module.
 */
@Module({
  imports: [PostsModule, registerQueueOnBoard(PostsQueue.CREATED)],
  controllers: [PostsController],
  exports: [PostsModule],
})
export class PostsApiModule {}
