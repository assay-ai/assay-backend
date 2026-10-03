import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { WebSocketEventMessage } from '@websocket/types';
import { WebSocketQueue } from '@websocket/constants/websocket-queues.constant';

/**
 * Publishes WebSocket events onto the `websocket.events` BullMQ queue.
 *
 * Provided globally by `WebSocketEmitterModule`, so any process (api,
 * worker, scheduler) can emit without owning a Socket.IO server. The
 * websocket process consumes the queue and does the actual broadcast.
 */
@Injectable()
export class WebSocketEmitterService {
  private readonly logger = new Logger(WebSocketEmitterService.name);

  constructor(
    @InjectQueue(WebSocketQueue.EVENTS)
    private readonly queue: Queue<WebSocketEventMessage>,
  ) {}

  async emit(messages: WebSocketEventMessage[]): Promise<void> {
    if (!messages.length) {
      return;
    }

    try {
      await this.queue.addBulk(
        messages.map((message) => ({
          name: WebSocketQueue.EVENTS,
          data: message,
          // Realtime fan-out: a stale event is worthless (the relayer drops
          // anything older than MAX_MESSAGE_AGE anyway), so never retry and
          // keep only a short tail of history in Redis.
          opts: {
            attempts: 1,
            removeOnComplete: { count: 1000, age: 3600 },
            removeOnFail: { count: 1000, age: 3600 },
          },
        })),
      );
    } catch (error) {
      this.logger.error(`Failed to emit socket event to BullMQ: ${error.message}`, error.stack);
      throw error;
    }
  }
}
