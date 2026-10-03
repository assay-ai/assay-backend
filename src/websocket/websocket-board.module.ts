import { Module } from '@nestjs/common';
import { registerQueueOnBoard } from '@shared/queue';
import { WebSocketQueue } from './constants/websocket-queues.constant';

/**
 * API-side stub module that exists solely to make `websocket.events` visible
 * in Bull Board.
 *
 * The queue is consumed by the websocket process, not by an api feature
 * module, so nothing else on the api side would register it. Per
 * `docs/adr/0001-bullmq-as-wakeup-mechanism.md`, a worker-only queue opts into
 * dashboard visibility through exactly this kind of stub.
 *
 * MUST only be imported by `AppApiModule`, and only when Bull Board is
 * enabled — `registerQueueOnBoard` depends on the api-only Bull Board root.
 */
@Module({
  imports: [registerQueueOnBoard(WebSocketQueue.EVENTS)],
})
export class WebSocketBoardModule {}
