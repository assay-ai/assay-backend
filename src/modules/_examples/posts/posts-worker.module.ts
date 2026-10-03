import { Module } from '@nestjs/common';
import { PostsModule } from './posts.module';
import { PostCreatedProcessor } from './processors/post-created.processor';

/**
 * Worker-side posts module — imported only by `AppWorkerModule`.
 *
 * Holds anything whose mere instantiation kicks off background work — BullMQ
 * processors (`@Processor()` starts a Worker that immediately consumes from
 * Redis) and `@nestjs/schedule` cron sweepers. Keeping these out of
 * `PostsApiModule` is what guarantees the api process does not accidentally
 * become a consumer.
 */
@Module({
  imports: [PostsModule],
  providers: [PostCreatedProcessor],
})
export class PostsWorkerModule {}
