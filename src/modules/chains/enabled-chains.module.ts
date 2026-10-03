import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { assertChainMetadata } from './chain-metadata';
import { ENABLED_CHAINS, ENABLED_CHAINS_ENV, parseEnabledChains } from './enabled-chains';

/**
 * `ENABLED_CHAINS`, parsed and asserted **once**, in its own module.
 *
 * It lived in `ChainsModule` until `EvmModule` needed it too, and `ChainsModule`
 * imports `EvmModule` — so leaving it there is a cycle. The alternative, a
 * second `parseEnabledChains` inside `EvmModule`, is the thing this token's own
 * doc comment already warns about: *"two parsers for one list is two places for
 * 'why is mainnet not resolving' to have a different answer"*. That warning was
 * written when `public-reserves-api.module.ts` had grown exactly such a copy.
 *
 * `assertChainMetadata` runs here rather than in `ChainsApiModule`, unchanged
 * from where it was, so the check still covers the worker, the scheduler and the
 * MCP process — the same coverage `ChainAdapterRegistry`'s three invariants
 * have, and for the same reason: a table disagreement about which chains are
 * live is settled once, at boot, where somebody is looking.
 *
 * `ChainsModule` re-exports the token, so every existing consumer that imports
 * `ChainsModule` keeps resolving it and no call site changed.
 */
@Module({
  providers: [
    {
      provide: ENABLED_CHAINS,
      useFactory: (config: ConfigService) => {
        const enabled = parseEnabledChains(config.get<string>(ENABLED_CHAINS_ENV));
        assertChainMetadata(enabled);
        return enabled;
      },
      inject: [ConfigService],
    },
  ],
  exports: [ENABLED_CHAINS],
})
export class EnabledChainsModule {}
