import { Global, Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import {
  EGRESS_RELAY_CONFIG,
  EgressHttpClient,
  EgressRelayConfig,
  takeEgressRelayConfig,
} from './egress';

/**
 * Read once at boot: the token is taken out of `process.env` here. Unset means
 * provider calls go direct, which in production reveals this server's IP.
 */
function egressRelayConfigFactory(): EgressRelayConfig | null {
  const config = takeEgressRelayConfig(process.env);
  if (!config && process.env.NODE_ENV === 'production') {
    new Logger('NetworkModule').warn(
      "EGRESS_RELAY_URL is not set: provider calls reveal this server's IP",
    );
  }
  return config;
}

/**
 * Outbound HTTP, for every service type.
 *
 * `@Global` so that no module has to remember to import it: a module that
 * cannot inject `EgressHttpClient` is a module that will reach for `axios`, and
 * the whole point of `src/shared/network/egress/` is that there is nowhere else
 * to reach.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    { provide: EGRESS_RELAY_CONFIG, useFactory: egressRelayConfigFactory },
    EgressHttpClient,
  ],
  exports: [EgressHttpClient],
})
export class NetworkModule {}
