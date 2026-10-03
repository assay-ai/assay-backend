import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { NetworkModule } from '@shared/network/network.module';
import { FacilitatorController } from './facilitator.controller';
import { FacilitatorService } from './facilitator.service';
import { FeePayerSignerModule } from './signing/fee-payer-signer.module';
import { DuplicateSettlementGuard } from './verification/duplicate-settlement.guard';
import { X402SvmVerifierService } from './verification/x402-svm-verifier.service';

/**
 * `SERVICE_TYPE=facilitator`'s domain module.
 *
 * Deliberately imports nothing from `src/modules/payment/`, `ledger/` or
 * `settlement/` — the facilitator knows about transactions, not about
 * accounts (it is a separate *process* precisely so a compromise here cannot reach the vault).
 * It also does not import `ChainsModule`: that module wires the *client* half
 * (`HttpFacilitatorAdapter`) for the API process, and sharing a provider graph
 * across a process boundary that exists to isolate a key would defeat the
 * isolation.
 *
 * The fee payer itself, and the RPC it submits through, live in
 * `FeePayerSignerModule`, because the scheduler needs one too —
 * `SolanaVoucherRedeemer` pays for every `redeem_voucher` — and importing
 * this whole module there would mount `FacilitatorController`
 * in a process that serves no HTTP contract.
 */
@Module({
  imports: [ConfigModule, NetworkModule, FeePayerSignerModule],
  controllers: [FacilitatorController],
  providers: [FacilitatorService, X402SvmVerifierService, DuplicateSettlementGuard],
})
export class FacilitatorModule {}
