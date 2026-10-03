import { Injectable } from '@nestjs/common';
import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QueueProcessorBase } from '@shared/queue';
import { WebSocketQueue } from '../constants/websocket-queues.constant';
import { WebSocketEventMessage } from '../types/event-data.interface';
import { WebSocketRelayerService } from '../services/websocket-relayer.service';

/**
 * Consumes the `websocket.events` queue and hands each message to the relayer
 * gateway, which owns the Socket.IO server and does the actual broadcast.
 *
 * Instantiated only by `WebSocketModule` (websocket bootstrap). Kept as a
 * separate class from the gateway because `@Processor()` starts a BullMQ
 * Worker on instantiation — mixing it into a provider that other bootstraps
 * import would turn them into consumers.
 */
@Processor(WebSocketQueue.EVENTS)
@Injectable()
export class WebSocketEventsProcessor extends QueueProcessorBase<WebSocketEventMessage> {
  constructor(private readonly relayer: WebSocketRelayerService) {
    super();
  }

  async process(job: Job<WebSocketEventMessage>): Promise<void> {
    this.relayer.handleWebSocketEvent(job.data);
  }
}
