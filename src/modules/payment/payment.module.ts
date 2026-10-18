import { Module } from '@nestjs/common';

import { BlocklistModule } from '@modules/blocklist/blocklist.module';
import { ChainsModule } from '@modules/chains/chains.module';
import { LedgerModule } from '@modules/ledger/ledger.module';
import { NotificationModule } from '@modules/notification/notification.module';

import { BuyerDebtSchemaCheck } from './services/buyer-debt-schema-check.service';
import { DepositFinalityService } from './services/deposit-finality.service';
import { EscrowSeqService } from './services/escrow-seq.service';
import { DepositIntentExpiryService } from './services/deposit-intent-expiry.service';
import { DepositIntentService } from './services/deposit-intent.service';
import { DepositService } from './services/deposit.service';
import { PaymentIntentExpiryService } from './services/payment-intent-expiry.service';
import { HeldCollectionService } from './services/held-collection.service';
import { PaymentIntentService } from './services/payment-intent.service';
import { ToolCallsService } from './services/tool-calls.service';
import { VoucherService } from './services/voucher.service';

/**
 * Payment domain — the payment intent lifecycle, the x402 voucher, and the
 * deposit path that funds an agent's balance in the first place.
 *
 * Scope: the intent state machine, idempotency and the expiry sweep; ed25519
 * vouchers (v2: `seq`, `escrowPda`, `requestHash` binding, no fast-path nonce
 * store — single-use is the durable `uq_payment_intents_account_voucher_seq`
 * index); deposit intents, their own state machine, and crediting the ledger
 * for what settlement actually observed on chain.
 *
 * The repositories are provided globally by `PostgresModule`, so this module
 * declares only the services. It imports `LedgerModule` because an intent's
 * price is reserved by a ledger hold: securing funds opens one, and expiry
 * gives it back — and because `DepositService` credits the ledger directly
 * once it observes a settled deposit. That dependency runs one way and must
 * keep doing so — the ledger knows an `intentId` and nothing else about
 * payments or deposits.
 *
 * The `@Cron` jobs live in `payment-scheduler.module.ts` so they only ever
 * instantiate in the scheduler process, which runs as a single instance.
 *
 * `ChainsModule` is what makes both vouchers and deposits possible: verifying a
 * voucher signature, building `402` requirements, calling the facilitator and
 * resolving the treasury vault are all chain-shaped, and every one of them is
 * reached through `ChainAdapterRegistry` / `FACILITATOR_PORT` / `VAULT_PORT`
 * — never directly. `CacheService` needs no import — `RedisCacheModule` is
 * `@Global()`.
 */
@Module({
  // `NotificationModule`: `DepositFinalityService` emits
  // `deposit.credited` / `deposit.failed` once finality resolves. Imported,
  // not re-exported — same reasoning as `LedgerModule`.
  imports: [LedgerModule, ChainsModule, NotificationModule, BlocklistModule],
  providers: [
    // Boot refuses a schema without the buyer-debt columns (review-buyer-debt H2).
    BuyerDebtSchemaCheck,
    PaymentIntentService,
    // Collects held payments past their dispute window (G3.B1).
    HeldCollectionService,
    PaymentIntentExpiryService,
    VoucherService,
    // The durable `seq` allocator behind `GET /escrow/next-seq`. The
    // repository is global (`PostgresModule`); `ALERT_PORT` comes from the
    // global `AlertingModule`, the same way every other alert emitter reaches
    // it.
    EscrowSeqService,
    DepositIntentService,
    DepositService,
    DepositFinalityService,
    DepositIntentExpiryService,
    ToolCallsService,
  ],
  exports: [
    PaymentIntentService,
    HeldCollectionService,
    PaymentIntentExpiryService,
    VoucherService,
    EscrowSeqService,
    DepositIntentService,
    DepositService,
    DepositFinalityService,
    DepositIntentExpiryService,
    ToolCallsService,
  ],
})
export class PaymentModule {}
