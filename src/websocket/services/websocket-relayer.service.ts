import { Injectable, Logger, Optional } from '@nestjs/common';
import { WebSocketEventMessage } from '../types/event-data.interface';
import type { Server, Socket } from 'socket.io';
import { SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { WS_SUBSCRIBE_MESSAGES } from '../constants/ws-namespaces.constant';
import { BaseGateway } from '../gateways/base.gateway';
import { MAX_MESSAGE_AGE } from '../constants';
import { PrivyTokenVerifier } from '@modules/auth/services/privy-token.verifier';

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

  constructor(@Optional() private readonly tokenVerifier?: PrivyTokenVerifier) {
    super();
  }

  afterInit(_server: Server): void {
    this.logger.log('WebSocket server initialized');
  }

  /**
   * Authenticate the handshake before the socket is allowed to stay. A client
   * controls its own handshake, so identity is taken from a verified token,
   * never from a client-supplied `userId`. A socket with no token, or one that
   * does not verify, is disconnected — no anonymous sockets linger on a
   * public, Cloudflare-exposed gateway, and any future room-join derives its
   * room from `client.data.userId` set here, server-side.
   *
   * The verifier is `@Optional()` only so the gateway still boots in a
   * bootstrap that has not wired auth (e.g. a local harness); when it is
   * absent every connection is refused rather than silently trusted.
   */
  async handleConnection(client: Socket): Promise<void> {
    const token = extractHandshakeToken(client);
    const claims = token && this.tokenVerifier ? await this.tokenVerifier.verify(token) : null;
    if (!claims) {
      this.logger.warn(`Rejecting unauthenticated socket ${client.id}`);
      client.disconnect(true);
      return;
    }
    (client.data as { userId?: string }).userId = claims.subject;
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
        // Never fan out to every connected socket. A roomless event would
        // reach all clients indiscriminately — the leak this gateway must not
        // have now that it is authenticated but shared across tenants. A
        // producer that wants a broadcast must address an explicit room.
        this.logger.warn(`Dropping roomless event "${event_name}" — no room to scope it to`);
      }
    } catch (error) {
      this.logger.error(`Failed to handle WebSocket event: ${error.message}`, error.stack);
    }
  }
}

/**
 * The bearer token a client offers at the handshake, from `auth.token` (the
 * socket.io idiom) or, failing that, an `Authorization: Bearer` header. Returns
 * null when neither carries a non-empty string.
 */
function extractHandshakeToken(client: Socket): string | null {
  const fromAuth = (client.handshake.auth as { token?: unknown } | undefined)?.token;
  if (typeof fromAuth === 'string' && fromAuth.length > 0) return fromAuth;
  const header = client.handshake.headers?.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    if (token.length > 0) return token;
  }
  return null;
}
