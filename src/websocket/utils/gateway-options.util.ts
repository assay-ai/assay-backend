import type { GatewayMetadata } from '@nestjs/websockets';
import { parseCorsAllowedOrigins } from '@config/app.config';

/**
 * Constants for time intervals
 */
const ONE_SEC = 1000; // 1 second in milliseconds

/**
 * Create WebSocket Gateway options with common configuration
 * @param namespace - Optional namespace for the gateway
 * @returns GatewayMetadata configuration object
 */
export const getGatewayOptions = (namespace?: string): GatewayMetadata => {
  const options: GatewayMetadata = {
    pingInterval: 10 * ONE_SEC, // 10 seconds
    pingTimeout: 5 * ONE_SEC, // 5 seconds
    maxHttpBufferSize: 1e7, // 10mb
    allowEIO3: true, // Allow Engine.IO v3 clients
    allowUpgrades: true, // Allow transport upgrades
    // The API's allowlist (`CORS_ALLOWED_ORIGINS`), never `*` with credentials.
    cors: {
      origin: parseCorsAllowedOrigins(),
      credentials: true,
    },
  };

  if (namespace) {
    options.namespace = namespace;
  }

  return options;
};
