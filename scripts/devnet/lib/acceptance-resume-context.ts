/**
 * The **third** Nest context the acceptance suite boots — the one `--resume`
 * runs inside, for steps 8b and 9.
 *
 * ## Why this exists rather than another HTTP call
 *
 * Step 9 reverses an executed slash, and there is no reachable HTTP route that
 * can. `POST /operator/cases/:id/reverse` is mounted by `OperatorApiModule`,
 * which the API bootstrap imports **without** `VerifierSigningModule`, so the
 * handler resolves no `VerifierSigningService` and throws
 * `CHAIN_PROGRAM_NOT_CONFIGURED` on every call — always, on this deployment and
 * on any other. That is not a bug to route around: it is the same boundary
 * `slash-scheduler.module.ts` draws for `execute`, *"no API pod holds a key
 * that can take a provider's stake"*, and `reverse` inherits it because the key
 * that reverses is the key that slashes.
 *
 * `scripts/devnet/reverse-slash-proposal.ts` established the answer — a script
 * at the same trust tier as `yarn verifier:registry`, holding the key, calling
 * `SlashExecutionService.reverse()` directly — and this module is that file's
 * `ReverseSlashScriptModule`, import for import. It is copied rather than
 * imported because that file ends in a top-level `main()` guarded by nothing,
 * so importing it would run a reversal as a side effect of loading it.
 *
 * ## What must NOT be added here
 *
 * An `executeDue()` call, or `SlashSchedulerModule`, or `ScheduleModule.forRoot()`.
 *
 * Step 8b's whole claim is that the **scheduler's own** `SlashLifecycleJob`
 * fired on its own interval once the timelock elapsed; a suite that triggered
 * execution itself would prove that this script can slash a provider, which is
 * the one thing the platform is built to make impossible. `runResume` waits. It
 * does not trigger.
 *
 * That property is structural, and it is worth being exact about **why**,
 * because the obvious explanation is wrong. `SLASH_EXECUTOR` is **bound in this
 * context** — `ChainsModule` provides
 * `{ provide: SLASH_EXECUTOR, useExisting: SolanaSlashExecutor }`
 * unconditionally, with no `SERVICE_TYPE` gate (unlike `EXPOSURE_AUTHORITY_SIGNER`
 * directly above it, which really is gated). It has to be bound: step 9's
 * `reverse()` refuses outright when `!this.executor`, so a context without an
 * executor could not reverse anything.
 *
 * What actually keeps an API pod from slashing is a different mechanism —
 * `SolanaSlashExecutor` resolves `VerifierSigningService` through `ModuleRef` at
 * call time, and the API bootstrap never imports `VerifierSigningModule`, so the
 * lookup throws there. This context imports it deliberately.
 *
 * So the guarantee here is not "it cannot execute"; it is **"nothing in it
 * ever runs an execution"**, and that rests on the three absences named at the
 * top of this section. Keep them absent.
 *
 * ## Teardown
 *
 * `closeScriptContext` from `./acceptance-sla-context` — `RedisCacheModule` has
 * no `onModuleDestroy`, so a script that only calls `app.close()` finishes its
 * work, prints its report and then sits forever on one Redis socket.
 */
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { appConfig } from '@config/app.config';
import { authConfig } from '@config/auth.config';
import { bullmqConfig } from '@config/bullmq.config';
import { databaseConfig } from '@config/database.config';
import { observabilityConfig } from '@config/observability.config';
import { redisConfig } from '@config/redis.config';
import { DatabaseModule } from '@database/database.module';
import { SlashModule } from '@modules/slash/slash.module';
import { VerifierSigningModule } from '@modules/verification/signing/verifier-signing.module';
import { AlertingModule } from '@shared/alerting';
import { RedisCacheModule } from '@shared/cache/redis-cache/redis-cache.module';

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
    DatabaseModule,
    RedisCacheModule,
    AlertingModule,
    SlashModule,
    // See the file header — this is the one edge the API deliberately does not
    // have, and the reason this context exists at all.
    VerifierSigningModule,
  ],
})
class AcceptanceResumeModule {}

export async function bootResumeContext(): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(AcceptanceResumeModule, {
    logger: ['error', 'warn'],
    abortOnError: false,
  });
}
