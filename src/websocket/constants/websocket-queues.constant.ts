/**
 * Queue names owned by the websocket module.
 *
 * A single fan-in queue: any process (api, worker, scheduler) publishes
 * `WebSocketEventMessage`s here via `WebSocketEmitterService`; the websocket
 * process consumes them and re-emits over Socket.IO. Horizontal fan-out across
 * multiple websocket instances is handled by the Socket.IO Redis adapter, so
 * exactly-one-consumer semantics from BullMQ is the correct behaviour here.
 */
export enum WebSocketQueue {
  EVENTS = 'websocket.events',
}
