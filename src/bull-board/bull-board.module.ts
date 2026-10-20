import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullBoardModule } from '@bull-board/nestjs';
import { ExpressAdapter } from '@bull-board/express';
// `export =` module: this form is callable with and without esModuleInterop (test/tsconfig.json enables it).
// eslint-disable-next-line @typescript-eslint/no-require-imports
import basicAuth = require('express-basic-auth');

/**
 * Mounts the Bull Board dashboard at `${global-prefix}${BULLBOARD_PATH}`
 * (default: `/api/admin/queues`) on the API server and protects it with HTTP
 * basic auth using `BULLBOARD_USERNAME` / `BULLBOARD_PASSWORD`.
 *
 * Individual queues do NOT need to be enumerated here — feature modules
 * register themselves via `registerQueueWithBoard()` from `@shared/queue`, so
 * each new queue shows up automatically as long as its module is imported by
 * the API bootstrap.
 *
 * Imported only by `AppApiModule`. The worker bootstrap intentionally never
 * mounts Bull Board: worker is a pure Redis consumer with no HTTP surface.
 */
@Module({
  imports: [
    BullBoardModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        route: configService.get<string>('bullboard.path', '/admin/queues'),
        adapter: ExpressAdapter,
        middleware: basicAuth({
          users: {
            [configService.get<string>('bullboard.username', 'admin')]:
              configService.get<string>('bullboard.password') ?? '',
          },
          challenge: true,
          realm: 'Bull Board',
        }),
      }),
    }),
  ],
})
export class BullBoardConfigModule {}
