import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { RedisCacheModule } from '@shared/cache/redis-cache/redis-cache.module';
import { WebSocketRelayerService } from './services/websocket-relayer.service';
import { WebSocketEventsProcessor } from './processors/websocket-events.processor';
import { WebSocketQueue } from './constants/websocket-queues.constant';

/**
 * WebSocket Module (consumer side) — imported only by `AppWebSocketModule`.
 *
 * Owns the Socket.IO gateway plus the BullMQ processor that drains
 * `websocket.events` and re-emits over the socket. Importing this anywhere
 * else would turn that process into a websocket-event consumer.
 */
@Module({
  imports: [RedisCacheModule, BullModule.registerQueue({ name: WebSocketQueue.EVENTS })],
  providers: [WebSocketRelayerService, WebSocketEventsProcessor],
  exports: [WebSocketRelayerService],
})
export class WebSocketModule {}
