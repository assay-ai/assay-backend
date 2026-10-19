import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { databaseConfig } from '@config/database.config';
import { redisConfig } from '@config/redis.config';
import { DatabaseModule } from '@database/database.module';
import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { ChainsModule } from '@modules/chains/chains.module';
import { DisputeModule } from '@modules/dispute/dispute.module';
import { CallDisputeService } from '@modules/dispute/services/call-dispute.service';
import { RefundEligibilityService } from '@modules/dispute/services/refund-eligibility.service';
import { VAULT_PORT } from '@modules/chains/ports/vault.port';
import { LedgerModule } from '@modules/ledger/ledger.module';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { PaymentModule } from '@modules/payment/payment.module';
import { PaymentSchedulerModule } from '@modules/payment/payment-scheduler.module';
import { VoucherRedemptionJob } from '@modules/payment/jobs/voucher-redemption.job';
import { HeldCollectionService } from '@modules/payment/services/held-collection.service';
import { DepositFinalityWatcher } from '@modules/payment/services/deposit-finality-watcher.service';
import { VoucherRedemptionService } from '@modules/payment/services/voucher-redemption.service';
import { DepositFinalityService } from '@modules/payment/services/deposit-finality.service';
import { DepositIntentExpiryService } from '@modules/payment/services/deposit-intent-expiry.service';
import { DepositIntentService } from '@modules/payment/services/deposit-intent.service';
import { DepositService } from '@modules/payment/services/deposit.service';
import { PaymentIntentService } from '@modules/payment/services/payment-intent.service';
import { SettlementModule } from '@modules/settlement/settlement.module';
import { SettlementSchedulerModule } from '@modules/settlement/settlement-scheduler.module';
import { ReconciliationJob } from '@modules/settlement/jobs/reconciliation.job';
import { ReconciliationService } from '@modules/settlement/services/reconciliation.service';
import { WithdrawalService } from '@modules/settlement/services/withdrawal.service';
import { ALERT_PORT, AlertingModule } from '@shared/alerting';
import { RedisCacheModule } from '@shared/cache/redis-cache/redis-cache.module';
import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';
import type { Redis } from 'ioredis';

/**
 * Proves `LedgerModule`, `PaymentModule` and `SettlementModule` — including
 * the vault, deposit and withdrawal providers — resolve inside a real Nest DI
 * container, wired exactly the way `src/bootstrap/api/app.module.ts` wires
 * them (same module imports, same config source).
 *
 * `LedgerModule` and `PaymentModule` had never been DI-verified in a real Nest
 * boot: no controller existed to force Nest to instantiate them, so only a
 * hand-assembled test harness had ever exercised them. This closes that gap.
 *
 * **Why this boots a purpose-built module instead of importing
 * `AppApiModule` directly**: `AppApiModule` conditionally imports
 * `BullBoardConfigModule` (`BULLBOARD_ENABLED=true` in this repo's `.env`),
 * and that module has a pre-existing type error under `ts-jest`'s full
 * type-check (`express-basic-auth`'s namespace import called as a function,
 * `bull-board.module.ts:28`) that `nest build`'s webpack/ts-loader does not
 * surface — that toolchain difference is why `AppApiModule` cannot be
 * imported from a `ts-jest` test today. This harness
 * imports the same domain modules `AppApiModule` does
 * (`PaymentModule`, `LedgerModule`, `SettlementModule`) without the unrelated
 * infrastructure modules, which is what actually forces Nest to build the
 * vault and deposit DI graph.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, redisConfig],
      envFilePath: ['.env.local', '.env'],
    }),
    DatabaseModule,
    RedisCacheModule,
    AlertingModule,
    ChainsModule,
    LedgerModule,
    PaymentModule,
    SettlementModule,
    // The reconciler's scheduler-only half, so the cron job's own graph is
    // verified here rather than at 03:05 in production.
    SettlementSchedulerModule,
    // The deposit scheduler half, added after it died at boot on
    // `VAULT_PORT` with the whole suite green. `DepositFinalityWatcher`
    // injects two `chains/` tokens directly, and `PaymentModule` imports
    // `ChainsModule` without re-exporting them, so nothing short of composing
    // this module could have caught it.
    PaymentSchedulerModule,
    // A buyer's report reaches the escrow hold through `HELD_PAYMENTS`, which
    // `PaymentModule` does not re-export. The injection used to be optional,
    // so a missing import filed every rail-B report unheld with nothing failing.
    DisputeModule,
  ],
})
class DiWiringHarnessModule {}

describe('DI wiring — the real domain modules resolve the vault, deposit, reconciler and withdrawal providers', () => {
  jest.setTimeout(60_000);

  it('resolves every settlement provider from one composed module graph', async () => {
    const app = await NestFactory.createApplicationContext(DiWiringHarnessModule, {
      logger: false,
      // Without this, a Nest initialization error calls `process.exit(1)`
      // directly instead of rejecting the promise — the framework's default
      // teardown, meant for a real process boot, is exactly wrong inside a
      // test runner: it kills the Jest worker instead of failing the test.
      abortOnError: false,
    });
    try {
      expect(app.get(LedgerService)).toBeInstanceOf(LedgerService);
      expect(app.get(PaymentIntentService)).toBeInstanceOf(PaymentIntentService);
      expect(app.get(DepositIntentService)).toBeInstanceOf(DepositIntentService);
      expect(app.get(DepositService)).toBeInstanceOf(DepositService);
      expect(app.get(DepositFinalityService)).toBeInstanceOf(DepositFinalityService);
      expect(app.get(DepositIntentExpiryService)).toBeInstanceOf(DepositIntentExpiryService);
      expect(app.get(ReconciliationService)).toBeInstanceOf(ReconciliationService);
      expect(app.get(WithdrawalService)).toBeInstanceOf(WithdrawalService);
      expect(app.get(ReconciliationJob)).toBeInstanceOf(ReconciliationJob);
      expect(app.get(ALERT_PORT)).toBeDefined();
      expect(app.get(ChainAdapterRegistry)).toBeInstanceOf(ChainAdapterRegistry);
      expect(app.get(VAULT_PORT)).toBeDefined();
      expect(app.get(DepositFinalityWatcher)).toBeInstanceOf(DepositFinalityWatcher);
      // The voucher redemption pass reaches across three module boundaries
      // (`LedgerService`, `VOUCHER_REDEEMER`, `FEE_PAYER_SIGNER`), which is
      // exactly the shape of gap that took the deposit scheduler down at boot.
      expect(app.get(VoucherRedemptionService)).toBeInstanceOf(VoucherRedemptionService);
      expect(app.get(VoucherRedemptionJob)).toBeInstanceOf(VoucherRedemptionJob);
      // Every consumer of the escrow hold gets the real port, not null.
      for (const consumer of [
        CallDisputeService,
        RefundEligibilityService,
        HeldCollectionService,
        ReconciliationService,
      ]) {
        expect(
          (app.get(consumer, { strict: false }) as unknown as { held: unknown }).held,
        ).toBeDefined();
        expect(
          (app.get(consumer, { strict: false }) as unknown as { held: unknown }).held,
        ).not.toBeNull();
      }
    } finally {
      // `app.close()` alone is not enough: a pre-existing, unrelated Nest
      // quirk — `TypeOrmCoreModule`'s
      // shutdown hook looks up the default `DataSource` token while this app
      // registers the named `'postgres'` connection — throws
      // `UnknownElementException` *before* it reaches the code that would
      // destroy the connection, so swallowing that error alone leaves the
      // pool open and Jest hanging on a live handle. Destroying the named
      // `DataSource` directly is what the ledger/payment test harnesses do
      // for the same reason.
      //
      // `REDIS_CACHE_CLIENT` has the same symptom for a different reason:
      // its provider never registers an `onModuleDestroy` hook at all, so
      // `app.close()` leaves the `ioredis` connection open regardless of
      // whether the TypeORM shutdown bug fires first. Both are pre-existing
      // gaps worked around here, not fixed.
      const dataSource = app.get<DataSource>(getDataSourceToken('postgres'), { strict: false });
      const redis = app.get<Redis>(REDIS_CACHE_CLIENT, { strict: false });
      await app.close().catch(() => {
        // See comment above — expected, and already worked around below.
      });
      await dataSource?.destroy().catch(() => {
        // Already closed by a successful `app.close()`; destroying twice is a no-op we do not need to see.
      });
      redis?.disconnect();
    }
  });
});
