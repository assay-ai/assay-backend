import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AlertingModule } from '@shared/alerting';

import { ENABLED_CHAINS } from '../enabled-chains';
import { EnabledChainsModule } from '../enabled-chains.module';
import { ChainId, ChainNamespace, namespaceOf } from '../ports/caip.types';
import { EVM_GAS_GRANT_MAX_WEI_ENV } from './evm-gas-grant.service';
import {
  EVM_RELAYER_FLOAT_CRITICAL_WEI,
  EVM_RELAYER_FLOAT_LOW_WEI,
  EVM_RELAYER_FLOAT_MARKS,
  parseFloatMarks,
} from './evm-relayer-float.constants';
import { EvmRelayerFloatMonitor } from './evm-relayer-float.monitor';
import { EvmSlashProposalWatcher } from './evm-slash-proposal.watcher';
import { EvmModule, readPositiveInt } from './evm.module';
import {
  DEFAULT_EVM_CHAIN_STATE_CONFIRMATIONS,
  EVM_CHAIN_STATE_INDEXER_CONFIG,
  EvmChainStateIndexer,
  EvmChainStateIndexerConfig,
} from './chain-state/evm-chain-state.indexer';
import { EvmSlashHoldMonitor } from './evm-slash-hold.monitor';
import { EvmVerifierExpiryMonitor } from './evm-verifier-expiry.monitor';
import { ChainErrors } from '../errors/chains.errors';
import { isChainId } from '../ports/caip.types';

const FIVE_MINUTES_MS = 5 * 60 * 1000;

/** `EVM_CHAIN_STATE_FROM_BLOCK`: `{"eip155:46630": 135000000}` — where a chain with no cursor starts. */
function readFromBlocks(raw: string | undefined): ReadonlyMap<ChainId, bigint> {
  if (raw === undefined || raw.trim() === '') return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw ChainErrors.configValueInvalid({
      variable: 'EVM_CHAIN_STATE_FROM_BLOCK',
      accepted: 'a JSON object of CAIP-2 chain id to a block number',
    });
  }
  return new Map(
    Object.entries(parsed).map(([chainId, block]) => {
      if (!isChainId(chainId) || !Number.isInteger(block) || (block as number) < 0) {
        throw ChainErrors.configValueInvalid({
          variable: 'EVM_CHAIN_STATE_FROM_BLOCK',
          accepted: 'a JSON object of CAIP-2 chain id to a block number',
        });
      }
      return [chainId as ChainId, BigInt(block as number)];
    }),
  );
}

/** `EVM_CHAIN_STATE_CONFIRMATIONS`: a whole number of blocks, default 12. */
function readConfirmations(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_EVM_CHAIN_STATE_CONFIRMATIONS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw ChainErrors.configValueInvalid({
      variable: 'EVM_CHAIN_STATE_CONFIRMATIONS',
      accepted: 'a whole number of blocks from 0 to 10000',
    });
  }
  return value;
}

/**
 * The scheduler-only half of the `eip155` wiring.
 *
 * Only `AppSchedulerModule` imports this. `EvmRelayerFloatMonitor` carries a
 * `@Cron`, and the scheduler runs as a single instance by design
 * (`docs/architecture.md` §Scaling Design) — registering it in `EvmModule`, which
 * `ChainsModule` imports and therefore every API replica loads, would read the
 * float once per replica and page five times for one dry account.
 *
 * ## The marks are parsed here, and that is deliberate
 *
 * `EVM_RELAYER_FLOAT_CRITICAL_WEI` is the monitor's alone; the low mark and the
 * grant cap are already required at boot by `parseGasGrantCaps` wherever an
 * eip155 chain is enabled. Parsing all three here means an API replica does not
 * refuse to start over a variable only the scheduler reads, while the scheduler
 * — the process that actually spends the float — still fails closed on all
 * three. Unset is a boot failure, not an unwatched faucet.
 */
@Module({
  imports: [EvmModule, EnabledChainsModule, AlertingModule],
  providers: [
    {
      provide: EVM_RELAYER_FLOAT_MARKS,
      useFactory: (config: ConfigService, enabled: readonly ChainId[]) =>
        enabled.some((chainId) => namespaceOf(chainId) === ChainNamespace.EIP155)
          ? parseFloatMarks(
              config.get<string>(EVM_RELAYER_FLOAT_LOW_WEI),
              config.get<string>(EVM_RELAYER_FLOAT_CRITICAL_WEI),
              config.get<string>(EVM_GAS_GRANT_MAX_WEI_ENV),
            )
          : null,
      inject: [ConfigService, ENABLED_CHAINS],
    },
    EvmRelayerFloatMonitor,
    // The pause/blocklist indexer (D-19) and the Config-lever alerts.
    {
      provide: EVM_CHAIN_STATE_INDEXER_CONFIG,
      useFactory: (config: ConfigService): EvmChainStateIndexerConfig => ({
        reconcileMs: readPositiveInt(
          config.get<string>('EVM_CHAIN_STATE_RECONCILE_MS'),
          FIVE_MINUTES_MS,
          'EVM_CHAIN_STATE_RECONCILE_MS',
        ),
        maxLagMs: readPositiveInt(
          config.get<string>('EVM_CHAIN_STATE_MAX_LAG_MS'),
          FIVE_MINUTES_MS,
          'EVM_CHAIN_STATE_MAX_LAG_MS',
        ),
        fromBlock: readFromBlocks(config.get<string>('EVM_CHAIN_STATE_FROM_BLOCK')),
        confirmations: readConfirmations(config.get<string>('EVM_CHAIN_STATE_CONFIRMATIONS')),
        now: () => Date.now(),
      }),
      inject: [ConfigService],
    },
    EvmChainStateIndexer,
    // Read-only: alerts on SlashProposed records this platform did not plan
    // (review H-1). The repositories come from global modules.
    EvmSlashProposalWatcher,
    // Follow-up B5: WARN 45 days before a verifier key with open records expires.
    EvmVerifierExpiryMonitor,
    // The provider slash hold: stop routing paid calls to a provider whose
    // penalties cannot be collected promptly.
    EvmSlashHoldMonitor,
  ],
})
export class EvmSchedulerModule {}
