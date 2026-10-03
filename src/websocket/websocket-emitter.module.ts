import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WebSocketEmitterService } from './services/websocket-emitter.service';
import { WebSocketQueue } from './constants/websocket-queues.constant';

/**
 * WebSocket Emitter Module (publish side).
 *
 * Provides `WebSocketEmitterService` for publishing WebSocket events onto the
 * `websocket.events` BullMQ queue. Global so feature services can inject it
 * without importing this module explicitly.
 *
 * Import this in bootstraps that only PUBLISH (api, worker, scheduler).
 * The websocket bootstrap imports `WebSocketModule` instead, which owns the
 * consumer side.
 */
@Global()
@Module({
  imports: [BullModule.registerQueue({ name: WebSocketQueue.EVENTS })],
  providers: [WebSocketEmitterService],
  exports: [WebSocketEmitterService, BullModule],
})
export class WebSocketEmitterModule {}
