import { NestFactory } from '@nestjs/core';

import { StructuredLogger } from '@shared/observability';
import { AppSchedulerModule } from './app.module';
import { ConfigService } from '@nestjs/config';

async function bootstrapScheduler() {
  // A structured logger rather than Nest's default: this is also where the
  // reconciler and the judge worker run — the half of the system a trace must
  // not stop short of.
  const app = await NestFactory.create(AppSchedulerModule, { logger: new StructuredLogger() });
  const configService = app.get(ConfigService);

  // Get config
  const port = configService.get<number>('app.scheduler.port');
  // Global interceptors
  app.useGlobalInterceptors();

  // No need to listen on a port for scheduler
  if (port) {
    await app.listen(port);
  } else {
    await app.init();
  }

  console.log(`
  ⏰ [SCHEDULER SERVER] CronJob/Scheduler is running
  `);
}

export { bootstrapScheduler };
