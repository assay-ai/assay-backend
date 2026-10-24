import { Injectable, Logger, Optional } from '@nestjs/common';
import { WebSocketEventMessage } from '../types/event-data.interface';
import type { Server, Socket } from 'socket.io';
import { ConnectedSocket, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
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
    const userId = await this.resolveUserId(client);
    if (!userId) {
      this.logger.warn(`Rejecting unauthenticated socket ${client.id}`);
      client.disconnect(true);
      return;
    }
    (client.data as { userId?: string }).userId = userId;
    await super.handleConnection(client);
  }

  /**
   * The verified Privy subject for this handshake, or null for any reason to
   * refuse. `verify()` is NOT total — `PrivyTokenVerifier` lets
   * `PrivyJwksCache` throw `identityProviderUnavailable()` when it holds no
   * usable key yet (cold start before the first JWKS fetch) or the IdP is
   * unreachable. NestJS does not await or catch this gateway's
   * `handleConnection`, so a throw here would (a) skip the disconnect below,
   * leaving an unauthenticated socket connected — fail OPEN — and (b) surface
   * as an unhandled rejection that can take the websocket process down. So any
   * failure, thrown or null, resolves to null: the socket is refused.
   */
  private async resolveUserId(client: Socket): Promise<string | null> {
    const token = extractHandshakeToken(client);
    if (!token || !this.tokenVerifier) return null;
    try {
      const claims = await this.tokenVerifier.verify(token);
      return claims?.subject ?? null;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Socket ${client.id} token verification errored — refusing: ${reason}`);
      return null;
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    await super.handleDisconnect(client);
  }

  @SubscribeMessage(WS_SUBSCRIBE_MESSAGES.PING)
  ping(@ConnectedSocket() client: Socket) {
    // Reply only to the caller. `this.server.emit` would fan `pong` out to
    // every connected socket — a pre-auth-reachable amplifier (NestJS binds
    // message handlers at connect, before handleConnection's async auth
    // resolves), turning one packet into N.
    client.emit(WS_SUBSCRIBE_MESSAGES.PONG);
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
