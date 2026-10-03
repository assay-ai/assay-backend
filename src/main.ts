// First, and for its side effect: it puts `.env` into `process.env` before any
// module below is imported. See the file for what breaks without it.
import './load-env';

import { EServiceType } from '@config/app.config';
import { installEgressLockdown, isEgressLockdownEnabled } from '@shared/network/egress';
import {
  bootstrapApi,
  bootstrapWebSocket,
  bootstrapScheduler,
  bootstrapWorker,
  bootstrapFacilitator,
  bootstrapMcp,
} from './bootstrap';

/**
 * Main entry point - decides which service to start based on SERVICE_TYPE env variable
 *
 * SERVICE_TYPE values:
 * - 'api' or undefined: Start API server (default)
 * - 'websocket': Start WebSocket server
 * - 'scheduler': Start CronJob/Scheduler
 * - 'worker': Start BullMQ worker
 * - 'facilitator': Start the x402 SVM facilitator (`/verify` `/settle` `/supported`)
 * - 'mcp': Start the MCP server (`tools/list` with prices, `tools/call`)
 * - 'all': Start all services in parallel (for local development)
 */
async function bootstrap() {
  // Before any module is constructed: a provider that makes a request in its
  // constructor would otherwise run before the guard exists. See
  // `src/shared/network/egress/egress-lockdown.ts` for what this catches that
  // the lint rule and the architecture test cannot.
  if (isEgressLockdownEnabled()) {
    installEgressLockdown();
  }

  const serviceType = process.env.SERVICE_TYPE || 'api';

  console.log(`🎯 Starting service type: ${serviceType.toUpperCase()}`);

  try {
    switch (serviceType.toLowerCase()) {
      case EServiceType.API:
        await bootstrapApi();
        break;

      case EServiceType.WEBSOCKET:
        await bootstrapWebSocket();
        break;

      case EServiceType.SCHEDULER:
      case 'cronjob':
        await bootstrapScheduler();
        break;

      case EServiceType.WORKER:
        await bootstrapWorker();
        break;

      case EServiceType.FACILITATOR:
        await bootstrapFacilitator();
        break;

      case EServiceType.MCP:
        await bootstrapMcp();
        break;

      case EServiceType.ALL:
        console.log('⚠️  Running all services in parallel. Each service on its own port.');
        await Promise.all([
          bootstrapApi(),
          bootstrapWebSocket(),
          bootstrapScheduler(),
          bootstrapWorker(),
          bootstrapFacilitator(),
          bootstrapMcp(),
        ]);
        console.log('\n✅ All services started successfully!');
        break;
      case EServiceType.API_AND_SCHEDULER: // for local development
        console.log('⚠️  Running API and Scheduler in parallel. Each service on its own port.');
        await Promise.all([bootstrapApi(), bootstrapScheduler()]);
        break;
      case EServiceType.API_AND_WEBSOCKET: // for local development
        console.log('⚠️  Running API and WebSocket in parallel. Each service on its own port.');
        await Promise.all([bootstrapApi(), bootstrapWebSocket()]);
        break;
      case EServiceType.SCHEDULER_AND_WORKER: // for local development
        console.log('⚠️  Running Worker and Scheduler in parallel. Each service on its own port.');
        await Promise.all([bootstrapWorker(), bootstrapScheduler()]);
        break;

      default:
        console.error(`❌ Invalid SERVICE_TYPE: ${serviceType}`);
        console.error(`Valid values: ${Object.values(EServiceType).join(', ')}`);
        process.exit(1);
    }
  } catch (error: unknown) {
    console.error('❌ Failed to start application:', error);
    process.exit(1);
  }
}

void bootstrap();
