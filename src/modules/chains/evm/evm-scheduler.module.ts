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
import { EvmModule } from './evm.module';

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
    // Read-only: alerts on SlashProposed records this platform did not plan
    // (review H-1). The repository and Redis come from global modules.
    EvmSlashProposalWatcher,
  ],
})
export class EvmSchedulerModule {}
