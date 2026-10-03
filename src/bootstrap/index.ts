/**
 * Bootstrap module - exports all service bootstrap functions
 *
 * This module provides entry points for different services:
 * - API Server: REST API endpoints with Swagger documentation + Bull Board
 * - WebSocket Server: Real-time WebSocket connections
 * - Scheduler: CronJobs for data synchronization
 * - Worker: BullMQ processors for async background work
 * - MCP: the Streamable HTTP MCP server, its own process because it
 *   is the surface every agent calls and scales on agent traffic alone
 * - Facilitator: x402 SVM `/verify` `/settle` `/supported`, its own
 *   process so the fee-payer signer's credentials never enter the API's
 *   address space
 */

export { bootstrapApi } from './api/main';
export { bootstrapWebSocket } from './websocket/main';
export { bootstrapScheduler } from './scheduler/main';
export { bootstrapWorker } from './worker/main';
export { bootstrapFacilitator } from './facilitator/main';
export { bootstrapMcp } from './mcp/main';
