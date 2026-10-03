import { NestFactory } from '@nestjs/core';

import { StructuredLogger } from '@shared/observability';
import { ConfigService } from '@nestjs/config';
import { AppWorkerModule } from './app.module';

async function bootstrapWorker() {
  // A structured logger rather than Nest's default: this is also where the
  // reconciler and the judge worker run — the half of the system a trace must
  // not stop short of.
  const app = await NestFactory.create(AppWorkerModule, { logger: new StructuredLogger() });
  const configService = app.get(ConfigService);

  const port = configService.get<number>('app.worker.port');

  if (port) {
    await app.listen(port);
  } else {
    await app.init();
  }

  console.log(`
  ⚙️  [WORKER SERVER] BullMQ worker is running and consuming queues${port ? ` on port ${port}` : ''}.
  `);
}

export { bootstrapWorker };
