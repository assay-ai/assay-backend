import { Global, Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import {
  EGRESS_RELAY_CONFIG,
  EgressHttpClient,
  EgressRelayConfig,
  takeEgressRelayConfig,
} from './egress';

/**
 * Read once at boot: the token is taken out of `process.env` here. Unset in
 * production means every call that must be relayed is refused (see
 * `EgressHttpClient`); elsewhere those calls go direct.
 */
function egressRelayConfigFactory(): EgressRelayConfig | null {
  const config = takeEgressRelayConfig(process.env);
  if (!config && process.env.NODE_ENV === 'production') {
    new Logger('NetworkModule').warn(
      'EGRESS_RELAY_URL is not set: calls that must go through the relay will be refused',
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
  exports: [EgressHttpClient, EGRESS_RELAY_CONFIG],
})
export class NetworkModule {}
