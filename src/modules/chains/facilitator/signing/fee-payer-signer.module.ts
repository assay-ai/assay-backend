import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { EgressHttpClient } from '@shared/network/egress';
import { NetworkModule } from '@shared/network/network.module';

import { createSanctionedSolanaRpc } from '../../solana/sanctioned-rpc';
import { FACILITATOR_SOLANA_RPC } from '../facilitator.tokens';
import type { FacilitatorSvmRpcClient } from '../verification/decode-svm-payload';
import { FEE_PAYER_SIGNER } from './fee-payer-signer.port';
import { KoraFeePayerSigner } from './kora-fee-payer.signer';
import { takeLocalFeePayerKeypair } from './local-fee-payer-key-source';
import { LocalKeypairFeePayerSigner } from './local-keypair-fee-payer.signer';
import type { LocalSignerRpcClient } from './local-keypair-fee-payer.signer';
import { DEFAULT_KORA_TIMEOUT_MS, LOCAL_FEE_PAYER_KEYPAIR_ENV } from './signer.constants';

/**
 * The fee payer, and the Solana RPC it submits through.
 *
 * `FEE_PAYER_SIGNER` resolves to exactly one implementation, chosen by
 * `FEE_PAYER_SIGNER` (env). Only the selected class is ever constructed — the
 * two are not both registered as providers, because `LocalKeypairFeePayerSigner`
 * intentionally throws in its constructor under `NODE_ENV=production`, and that
 * guard must not fire for a deployment that was never going to use it.
 *
 * ## Why it is its own module
 *
 * It used to be two providers inside `FacilitatorModule`, and the facilitator
 * was the only process that paid for a transaction. There is now a second:
 * `SolanaVoucherRedeemer` pays the fee for every `redeem_voucher`, and it runs
 * in the scheduler.
 *
 * Importing `FacilitatorModule` there would have brought `FacilitatorController`
 * with it — an HTTP contract mounted in a process that serves none — so the two
 * providers moved here instead, where either module can import them without
 * dragging the other's surface along.
 *
 * **Importing this module is what puts a fee-payer key in a process's address
 * space, and that is the point of it being a separate import.** The API, worker
 * and MCP bootstraps deliberately do not (`src/bootstrap/mcp/app.module.ts`
 * says so in as many words), and `SolanaVoucherRedeemer` resolves the token
 * through `ModuleRef` at call time so that `ChainsModule` — which every one of
 * those processes imports — never has to.
 */
@Module({
  imports: [ConfigModule, NetworkModule],
  providers: [
    {
      provide: FACILITATOR_SOLANA_RPC,
      useFactory: (config: ConfigService) =>
        createSanctionedSolanaRpc(
          config.get<string>('SOLANA_RPC_URL') ?? 'https://api.devnet.solana.com',
        ),
      inject: [ConfigService],
    },
    {
      provide: FACILITATOR_SOLANA_RPC,
      useFactory: (config: ConfigService) =>
        createSanctionedSolanaRpc(
          config.get<string>('SOLANA_RPC_URL') ?? 'https://api.devnet.solana.com',
        ),
      inject: [ConfigService],
    },
    {
      provide: FEE_PAYER_SIGNER,
      // `config.get(...)` reads the env keys below directly, the same
      // un-namespaced style `ChainsModule` uses for `SOLANA_RPC_URL` — the
      // DI tokens imported above (`KORA_RPC_URL` etc.) label the *constructor
      // parameters* those two signer classes declare, not these env keys;
      // they are separate labels for separate things on purpose.
      useFactory: (
        config: ConfigService,
        rpc: FacilitatorSvmRpcClient,
        egress: EgressHttpClient,
      ) => {
        const mode = config.get<string>('FEE_PAYER_SIGNER') ?? 'kora';

        if (mode === 'local') {
          // Inline first, and read straight off `process.env` rather than
          // through `ConfigService` — the call DELETES the variable, and a
          // config cache that had already copied it would keep the material
          // alive for the life of the process, defeating the one property that
          // makes deleting it worth doing. Same reasoning as
          // `VerifierSigningModule`.
          const inline = takeLocalFeePayerKeypair();
          const keypairPath = config.get<string>('LOCAL_FEE_PAYER_KEYPAIR_PATH');

          if (!inline && !keypairPath) {
            throw new Error(
              `${LOCAL_FEE_PAYER_KEYPAIR_ENV} or LOCAL_FEE_PAYER_KEYPAIR_PATH ` +
                'is required when FEE_PAYER_SIGNER=local',
            );
          }

          return new LocalKeypairFeePayerSigner(
            inline ?? (keypairPath as string),
            rpc as unknown as LocalSignerRpcClient,
          );
        }

        const baseUrl = config.get<string>('KORA_RPC_URL') ?? 'http://127.0.0.1:8080';
        const timeoutMs = Number(config.get<string>('KORA_TIMEOUT_MS') ?? DEFAULT_KORA_TIMEOUT_MS);
        return new KoraFeePayerSigner(baseUrl, timeoutMs, egress);
      },
      inject: [ConfigService, FACILITATOR_SOLANA_RPC, EgressHttpClient],
    },
  ],
  exports: [FACILITATOR_SOLANA_RPC, FEE_PAYER_SIGNER],
})
export class FeePayerSignerModule {}
