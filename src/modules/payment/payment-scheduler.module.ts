import { Module } from '@nestjs/common';

import { ChainsModule } from '@modules/chains/chains.module';
import { FeePayerSignerModule } from '@modules/chains/facilitator/signing/fee-payer-signer.module';
import { LedgerModule } from '@modules/ledger/ledger.module';

import { DepositFinalityJob } from './jobs/deposit-finality.job';
import { DepositFinalityWatcher } from './services/deposit-finality-watcher.service';
import { DepositIntentExpiryJob } from './jobs/deposit-intent-expiry.job';
import { PaymentIntentExpiryJob } from './jobs/payment-intent-expiry.job';
import { VoucherRedemptionJob } from './jobs/voucher-redemption.job';
import { PaymentModule } from './payment.module';
import { VoucherRedemptionService } from './services/voucher-redemption.service';

/**
 * Scheduler-only half of the payment domain.
 *
 * `AppSchedulerModule` imports this and no other process does, so each `@Cron`
 * handler is instantiated exactly once across the deployment. The scheduler is
 * a single instance by design (`docs/architecture.md` §Scaling Design); importing
 * this into the API would run one sweep per API replica.
 *
 * `src/bootstrap/scheduler/app.module.ts` already imports this module (wired
 * first for `PaymentIntentExpiryJob`), so `DepositIntentExpiryJob` and
 * `DepositFinalityJob` are DI-verified in the real scheduler process
 * boot the moment they are added here — no bootstrap file needed to change.
 */
@Module({
  // `ChainsModule` alongside `PaymentModule` because `VoucherRedemptionService`
  // injects `VOUCHER_REDEEMER` directly. `PaymentModule` imports `ChainsModule`
  // but does not re-export its tokens, and a Nest provider resolves only
  // against its own module's context — so without this the scheduler dies at
  // boot on `VOUCHER_REDEEMER`. (`DepositFinalityWatcher` used to be the
  // reason this import existed — it injected `VAULT_PORT` and
  // `ACCOUNT_WATCH_PORT` to watch the pooled vault — but per-buyer escrows
  // disabled it unconditionally; see its own class comment.)
  // `FeePayerSignerModule` is what puts a fee-payer key in this
  // process, and it is imported here, in the facilitator's bootstrap, and in
  // `PaymentApiModule` (for opening a buyer's escrow at deposit time) — and in
  // no other. `SolanaVoucherRedeemer` pays the transaction fee for every
  // `redeem_voucher` and resolves the token through `ModuleRef`, so without
  // this import the redemption pass fails at its first submission naming
  // exactly this line.
  // `LedgerModule` for the same reason as `ChainsModule`:
  // `VoucherRedemptionService` injects `LedgerService` to write the
  // platform-absorbed `PROVIDER_CREDIT`, and `PaymentModule` imports the ledger
  // without re-exporting it.
  imports: [PaymentModule, ChainsModule, LedgerModule, FeePayerSignerModule],
  providers: [
    PaymentIntentExpiryJob,
    DepositIntentExpiryJob,
    DepositFinalityJob,
    // Scheduler-only, matching every other single-instance job here — see the
    // class comment for why it no longer watches anything.
    DepositFinalityWatcher,

    // A rail-B hold is retired by the redemption, not by the
    // verdict, and this is the only thing that retires one. Scheduler-only for
    // the same reason as the sweeps above, and with no lock for the reason
    // `ReconciliationJob` has none.
    VoucherRedemptionService,
    VoucherRedemptionJob,
  ],
})
export class PaymentSchedulerModule {}
