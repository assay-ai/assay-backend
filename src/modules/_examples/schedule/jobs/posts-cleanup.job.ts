import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PostRepository } from '@database/postgres/repositories/post.repository';
import { LessThan } from 'typeorm';

@Injectable()
export class PostsCleanupJob {
  private readonly logger = new Logger(PostsCleanupJob.name);

  constructor(private readonly postRepository: PostRepository) {}

  @Cron('0 0 * * *') // Runs daily at midnight
  async handleCleanup() {
    this.logger.log('Running posts cleanup job...');

    // Example: find old unpublished drafts (older than 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const oldDrafts = await this.postRepository.find({
      where: {
        isPublished: false,
        createdAt: LessThan(thirtyDaysAgo),
      },
    });

    if (oldDrafts.length > 0) {
      this.logger.log(`Found ${oldDrafts.length} old unpublished drafts for cleanup`);
      // Placeholder: implement actual cleanup logic (soft delete, archive, etc.)
    } else {
      this.logger.log('No old unpublished drafts found');
    }
  }
}
