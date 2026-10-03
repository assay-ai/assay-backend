import { Module } from '@nestjs/common';
import { PostgresModule } from '@database/postgres';
import { PostsCleanupJob } from './jobs/posts-cleanup.job';

@Module({
  imports: [PostgresModule],
  providers: [PostsCleanupJob],
})
export class SchedulePostsModule {}
