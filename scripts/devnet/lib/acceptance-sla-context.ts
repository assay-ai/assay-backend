/**
 * The **second** Nest context the acceptance suite boots, for the one step that
 * cannot be driven over HTTP.
 *
 * ## Why `bootIdentityContext()` is not enough
 *
 * `lib/acceptance-identity.ts` boots `DatabaseModule` and nothing else, because
 * everything it does is a repository write. `seedSlaWindowCalls`
 * (`scripts/demo/lib/seed-slash-window.ts`) needs four repositories **and
 * `SlaWindowService`** — the real `postCall` seam, which is what opens the
 * window, freezes its rules onto the row, closes it at `MIN_VERIFIED_CALLS` and
 * reaches `SLASH_PROPOSAL_OPENER` to mint the case. That service lives in
 * `SlaWindowModule`, which pulls in `NotificationModule` (BullMQ-backed, hence
 * the Bull root and the Redis cache below) and `SlashOpenerModule`.
 *
 * Growing the identity context to cover that would give every run of every
 * step a BullMQ connection and a slash lifecycle it has no use for, and would
 * make the "minted rows only" contract that file states untrue. So this is a
 * separate composition with a separate lifetime — booted by the step that needs
 * it and closed in that step's own `finally`.
 *
 * ## It is `seed-slash-case.ts`'s module, deliberately
 *
 * The import list is `SlashCaseSeedModule`'s, field for field
 * (`scripts/demo/seed-slash-case.ts`). That file is the only other caller of
 * `seedSlaWindowCalls` and it is known to work against this deployment; a
 * composition invented here that merely *looked* sufficient would fail as a DI
 * error minutes into a run, after the suite had already staked and spent. The
 * one thing not copied is that script's `process.exit(0)` escape hatch — a step
 * inside a longer run has to hand the process back.
 *
 * ## There is no HTTP route to do this instead
 *
 * `SlaWindowService.postCall` is reached in production only from
 * `VerificationSettlementService.settle()`, i.e. from a real paid call that has
 * already been judged. Filling a 400-call window that way would mean 400 real
 * payments per window. The seam this context reaches is the same one settlement
 * uses; what it skips is the money, not the judging.
 */
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { appConfig } from '@config/app.config';
import { authConfig } from '@config/auth.config';
import { bullmqConfig } from '@config/bullmq.config';
import { databaseConfig } from '@config/database.config';
import { observabilityConfig } from '@config/observability.config';
import { redisConfig } from '@config/redis.config';
import { DatabaseModule } from '@database/database.module';
import { SlaWindowModule } from '@modules/provider/sla-window.module';
import { RedisCacheModule } from '@shared/cache/redis-cache/redis-cache.module';
import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';
import { NetworkModule } from '@shared/network/network.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, redisConfig, bullmqConfig, observabilityConfig, authConfig],
      envFilePath: ['.env.local', '.env'],
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => configService.get('bullmq'),
    }),
    NetworkModule,
    DatabaseModule,
    RedisCacheModule,
    SlaWindowModule,
  ],
})
class AcceptanceSlaWindowModule {}

export async function bootSlaWindowContext(): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(AcceptanceSlaWindowModule, {
    logger: ['error', 'warn'],
    abortOnError: false,
  });
}

/** Just enough of `ioredis` to hang up on it, without importing the client type. */
interface Quittable {
  quit(): Promise<unknown>;
  disconnect(): void;
}

/**
 * Releases everything a script-booted Nest context holds — best-effort, never
 * throws.
 *
 * Not specific to the SLA-window context, despite living beside it: every
 * token is resolved with `strict: false` and a miss is `undefined`, so a
 * context that never bound Redis (or never bound the named Postgres pool)
 * passes through untouched. `lib/acceptance-resume-context.ts` closes with
 * this too, and it is exported under a context-agnostic name for that reason.
 *
 * ## Three handles, and `app.close()` releases exactly one of them
 *
 * - **The named `'postgres'` pool** survives `close()` — the same behaviour
 *   `main()`'s own teardown and `deposit.ts` both work around, and closing a
 *   context that owns one throws on some shutdown paths (`seed-slash-case.ts`
 *   sidesteps that with `process.exit`, which a step in the middle of a run
 *   cannot do).
 * - **`REDIS_CACHE_CLIENT`** is an `ioredis` instance built by a `useFactory`
 *   with **no `onModuleDestroy`** (`redis-cache.provider.ts`), so nothing hangs
 *   up on it. That is harmless in the API server, which never shuts down, and
 *   fatal in a script: the suite's first run with this context printed its whole
 *   report, set `process.exitCode`, and then **sat there forever** on one
 *   `ESTABLISHED` socket to Redis. Observed, then fixed here — this teardown is
 *   the only thing between a green run and a process that never ends.
 * - **BullMQ's queues** do close themselves on `app.close()`, which is why they
 *   are not named here; if that ever changes, the symptom is the one above and
 *   this is the function to add it to.
 *
 * `quit()` waits for in-flight commands and then closes; `disconnect()` is the
 * fallback for a client that is mid-reconnect and would otherwise never resolve.
 */
export async function closeScriptContext(app: INestApplicationContext): Promise<void> {
  // Resolved BEFORE the close, and in **separate** `try` blocks: `get()` throws
  // `UnknownElementException` for a missing token rather than returning
  // undefined, so one lookup sharing a block with the other would let a context
  // that failed to build the first silently keep the second's handle open —
  // which is the exact failure this function exists to prevent.
  const dataSource = resolve<DataSource>(app, getDataSourceToken('postgres'));
  const redis = resolve<Quittable>(app, REDIS_CACHE_CLIENT);

  await app.close().catch(() => undefined);
  await redis?.quit().catch(() => {
    try {
      redis?.disconnect();
    } catch {
      // Nothing left to try; the handle leaks and the process may not exit,
      // which is strictly better than losing the run's report to a throw here.
    }
  });
  await dataSource?.destroy().catch(() => undefined);
}

/** `app.get()` with "not bound" as `undefined` rather than as a throw. */
function resolve<T>(app: INestApplicationContext, token: unknown): T | undefined {
  try {
    return app.get<T>(token as never, { strict: false });
  } catch {
    return undefined;
  }
}
