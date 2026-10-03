import { Injectable, Logger } from '@nestjs/common';
import { WebSocketEventMessage } from '../types/event-data.interface';
import type { Server, Socket } from 'socket.io';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { WS_ROOMS_PREFIXES, WS_SUBSCRIBE_MESSAGES } from '../constants/ws-namespaces.constant';
import { BaseGateway } from '../gateways/base.gateway';
import { MAX_MESSAGE_AGE } from '../constants';

/**
 * WebSocket Relayer Service (Singleton)
 * Generic handler that broadcasts queued events to WebSocket clients.
 * Runs only in the WebSocket server instance.
 *
 * It does NOT consume the queue itself — `WebSocketEventsProcessor` owns the
 * BullMQ Worker and calls `handleWebSocketEvent()` per job. Keeping the
 * consumer in a separate class is what stops other bootstraps from becoming
 * consumers just by providing this gateway.
 */
@Injectable()
@WebSocketGateway()
export class WebSocketRelayerService extends BaseGateway {
  protected readonly logger = new Logger(WebSocketRelayerService.name);

  constructor() {
    super();
  }

  afterInit(_server: Server): void {
    this.logger.log('WebSocket server initialized');
  }

  async handleConnection(client: Socket): Promise<void> {
    await super.handleConnection(client);
  }

  async handleDisconnect(client: Socket): Promise<void> {
    await super.handleDisconnect(client);
  }

  @SubscribeMessage(WS_SUBSCRIBE_MESSAGES.PING)
  ping() {
    this.server.emit(WS_SUBSCRIBE_MESSAGES.PONG);
  }

  /** Called by `WebSocketEventsProcessor` for each `websocket.events` job. */
  handleWebSocketEvent(message: WebSocketEventMessage): void {
    if (!this.server) {
      this.logger.warn('WebSocket server not initialized, skipping message');
      return;
    }
    try {
      const { event_name, room, timestamp, data } = message;

      if (timestamp && Date.now() - timestamp > MAX_MESSAGE_AGE) {
        this.logger.warn(`Message is too old, skipping`);
        return;
      }

      const body = { event_name, room, data };
      if (room) {
        this.server.to(room).emit(event_name, body);
      } else {
        this.server.emit(event_name, body);
      }
    } catch (error) {
      this.logger.error(`Failed to handle WebSocket event: ${error.message}`, error.stack);
    }
  }

  // Posts

  @SubscribeMessage(WS_SUBSCRIBE_MESSAGES.SUBSCRIBE_POSTS)
  async subscribeToPosts(
    @MessageBody() data: { postId: string },
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const { postId } = data;
    const room = `${WS_ROOMS_PREFIXES.POST}${postId}`;

    await this.joinRoom(client, room);
    this.logger.log(`Client ${client.id} subscribed to post: ${postId}`);
  }

  @SubscribeMessage(WS_SUBSCRIBE_MESSAGES.UNSUBSCRIBE_POSTS)
  async unsubscribeFromPosts(
    @MessageBody() data: { postId: string },
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const { postId } = data;
    const room = `${WS_ROOMS_PREFIXES.POST}${postId}`;

    await this.leaveRoom(client, room);
    this.logger.log(`Client ${client.id} unsubscribed from post: ${postId}`);
  }
}
