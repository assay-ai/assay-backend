/**
 * Boots the real `LedgerModule` / `PaymentModule` / `SettlementModule` graph
 * against this deployment's actual Postgres database (`DATABASE_NAME` in
 * `.env` — not a `*_test` database), the same composition
 * `test/integration/bootstrap/di-wiring.integration.spec.ts` proves resolves
 * cleanly. This is how the script reaches `DepositService` and
 * `LedgerService` directly, without going through a controller.
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { INestApplicationContext } from '@nestjs/common';

import { databaseConfig } from '@config/database.config';
import { redisConfig } from '@config/redis.config';
import { DatabaseModule } from '@database/database.module';
import { ChainsModule } from '@modules/chains/chains.module';
import { FeePayerSignerModule } from '@modules/chains/facilitator/signing/fee-payer-signer.module';
import { LedgerModule } from '@modules/ledger/ledger.module';
import { PaymentModule } from '@modules/payment/payment.module';
import { SettlementModule } from '@modules/settlement/settlement.module';
import { AlertingModule } from '@shared/alerting/alerting.module';
import { RedisCacheModule } from '@shared/cache/redis-cache/redis-cache.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, redisConfig],
      envFilePath: ['.env.local', '.env'],
    }),
    DatabaseModule,
    RedisCacheModule,
    // `AlertingModule` is `@Global()`, which makes `ALERT_PORT` visible
    // everywhere — but only once some module in the graph has imported it. The
    // six bootstrap modules each do; this one did not, so `SettlementModule`
    // stopped resolving the moment observability gave it an alert sink. The symptom
    // is a DI error naming `ALERT_PORT`, and it takes down every script that
    // boots this context.
    AlertingModule,
    ChainsModule,
    // `SolanaEscrowOpener` resolves `FEE_PAYER_SIGNER` lazily, so a context
    // without this module boots clean and fails only when a script actually
    // opens an escrow — the same shape as the `AlertingModule` omission above.
    FeePayerSignerModule,
    LedgerModule,
    PaymentModule,
    SettlementModule,
  ],
})
class DevnetScriptModule {}

export async function bootAppContext(): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(DevnetScriptModule, {
    logger: ['error', 'warn'],
    abortOnError: false,
  });
}
