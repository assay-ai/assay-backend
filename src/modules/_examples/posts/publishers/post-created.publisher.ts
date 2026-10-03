import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PostsQueue } from '../constants/posts-queues.constant';

export interface PostCreatedJobData {
  id: string;
  title: string;
  author: string;
  /** Set by the publisher; included in processor logs for traceability. */
  enqueuedAt: string;
}

/**
 * Publisher for the `posts.created` queue.
 *
 * Enqueued by `PostsService.create()` once the row is committed, so the job
 * can never observe a post that does not exist yet.
 *
 * The job id is derived from the post id, which makes the enqueue idempotent:
 * re-enqueueing the same post is a no-op. BullMQ disallows `:` in custom job
 * ids (it is the Redis key separator), so `-` is used as the separator.
 */
@Injectable()
export class PostCreatedPublisher {
  private readonly logger = new Logger(PostCreatedPublisher.name);

  constructor(
    @InjectQueue(PostsQueue.CREATED)
    private readonly queue: Queue<PostCreatedJobData>,
  ) {}

  async publishPostCreated(post: Omit<PostCreatedJobData, 'enqueuedAt'>): Promise<void> {
    const jobId = `posts-created-${post.id}`;

    await this.queue.add(
      PostsQueue.CREATED,
      { ...post, enqueuedAt: new Date().toISOString() },
      { jobId },
    );

    this.logger.log(`Enqueued ${PostsQueue.CREATED} (jobId=${jobId}) for post: ${post.title}`);
  }
}
