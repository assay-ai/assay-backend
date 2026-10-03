import { Injectable } from '@nestjs/common';
import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QueueProcessorBase } from '@shared/queue';
import { PostsQueue } from '../constants/posts-queues.constant';
import { PostCreatedJobData } from '../publishers/post-created.publisher';

/**
 * Processor for the `posts.created` queue — runs in the worker process only.
 *
 * Registered by `PostsWorkerModule`, never by `PostsApiModule`: a `@Processor()`
 * starts a BullMQ Worker the moment it is instantiated, and the api process
 * must not become a consumer.
 *
 * Uses the global `attempts: 1` default — the queue is a wakeup signal, not a
 * retry engine. See `docs/adr/0001-bullmq-as-wakeup-mechanism.md`.
 */
@Processor(PostsQueue.CREATED)
@Injectable()
export class PostCreatedProcessor extends QueueProcessorBase<PostCreatedJobData> {
  async process(job: Job<PostCreatedJobData>): Promise<void> {
    const { id, title, enqueuedAt } = job.data;
    const latencyMs = Date.now() - new Date(enqueuedAt).getTime();

    this.logger.log(
      `Processing new post (jobId=${job.id}, postId=${id}, latency=${latencyMs}ms): ${title}`,
    );
  }
}
