import { Logger } from '@nestjs/common';
import type { OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit } from '@nestjs/websockets';
import { WebSocketServer } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';

/**
 * Base Gateway for WebSocket connections
 * Provides common functionality for all namespaced gateways
 */
export abstract class BaseGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  public server: Server;

  protected readonly logger: Logger;

  constructor() {
    this.logger = new Logger(this.constructor.name);
  }

  /**
   * Called after gateway initialization
   */
  afterInit(_server: Server): void {
    this.logger.log(`${this.constructor.name} initialized`);
  }

  /**
   * Handle client connection
   * Override this method in child classes for custom logic
   */
  async handleConnection(client: Socket): Promise<void> {
    this.logger.log(`Client connected: ${client.id}`);
  }

  /**
   * Handle client disconnection
   * Override this method in child classes for custom logic
   */
  async handleDisconnect(client: Socket): Promise<void> {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  /**
   * Broadcast to all clients in the namespace
   */
  protected broadcast(event: string, data: any): void {
    this.server.emit(event, data);
    this.logger.verbose(`Broadcast event: ${event}`);
  }

  /**
   * Send message to specific client by socket ID
   */
  protected sendToClient(socketId: string, event: string, data: any): void {
    this.server.to(socketId).emit(event, data);
    this.logger.verbose(`Sent event ${event} to client: ${socketId}`);
  }

  /**
   * Send message to specific clients by socket IDs
   */
  protected sendToClients(socketIds: string[], event: string, data: any): void {
    socketIds.forEach((socketId) => {
      this.sendToClient(socketId, event, data);
    });
  }

  /**
   * Broadcast to all clients in a room
   */
  protected broadcastToRoom(room: string, event: string, data: any): void {
    this.server.to(room).emit(event, data);
    this.logger.verbose(`Broadcast event ${event} to room: ${room}`);
  }

  /**
   * Join a room
   */
  protected async joinRoom(client: Socket, room: string): Promise<void> {
    await client.join(room);
    this.logger.verbose(`Client ${client.id} joined room: ${room}`);
  }

  /**
   * Leave a room
   */
  protected async leaveRoom(client: Socket, room: string): Promise<void> {
    await client.leave(room);
    this.logger.verbose(`Client ${client.id} left room: ${room}`);
  }

  /**
   * Get all clients in a room
   */
  protected async getClientsInRoom(room: string): Promise<string[]> {
    const sockets = await this.server.in(room).fetchSockets();
    return sockets.map((socket) => socket.id);
  }

  /**
   * Validate and extract user ID from socket handshake
   * Override this method if you need authentication
   */
  protected getUserId(client: Socket): string | null {
    // Example: Extract from auth token in handshake
    const userId = client.handshake.auth?.userId;
    return userId || null;
  }
}
