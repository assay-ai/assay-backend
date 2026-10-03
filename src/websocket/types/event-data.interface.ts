export interface WebSocketEventMessage {
  event_name: string;
  room?: string;
  timestamp: number;
  data: Record<string, any>;
}
