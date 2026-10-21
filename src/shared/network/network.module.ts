import { Global, Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import {
  DNS_SERVERS_ENV,
  EGRESS_CONFIG_HOSTS,
  EGRESS_DNS_LOOKUP,
  EGRESS_RELAY_CONFIG,
  EgressHttpClient,
  EgressRelayConfig,
  configOriginEgressHosts,
  dnsServersLookup,
  parseDnsServers,
  takeEgressRelayConfig,
} from './egress';
import type { EgressDnsLookup } from './egress';

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
 * `DNS_SERVERS` set: the egress lookup asks those servers. Unset: `undefined`,
 * so `EgressHttpClient` keeps the system resolver. A malformed value fails
 * the boot with a message that names the variable.
 */
function egressDnsLookupFactory(config: ConfigService): EgressDnsLookup | undefined {
  const servers = parseDnsServers(config.get<string>(DNS_SERVERS_ENV));
  if (!servers) return undefined;
  const logger = new Logger('NetworkModule');
  logger.log(`Egress DNS lookups go to ${servers.length} configured server(s)`);
  // A single-label host (a Docker service name) is only known to the local
  // resolver, which DNS_SERVERS bypasses (review M-3). Named, never resolved here.
  for (const host of singleLabelConfigHosts(config)) {
    logger.warn(
      `${DNS_SERVERS_ENV} is set, but the configured host "${host}" has no dot: ` +
        'the configured name servers are unlikely to resolve it',
    );
  }
  return dnsServersLookup(servers);
}

/** Config-URL hosts with no dot (e.g. `kora`), which public name servers do not know. */
export function singleLabelConfigHosts(config: ConfigService): string[] {
  return [...configOriginEgressHosts((name) => config.get<string>(name))].filter(
    (host) => !host.includes('.'),
  );
}

/** Hosts of the URLs the server's configuration names (see `EGRESS_CONFIG_HOSTS`). */
function egressConfigHostsFactory(config: ConfigService): ReadonlySet<string> {
  return configOriginEgressHosts((name) => config.get<string>(name));
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
    { provide: EGRESS_DNS_LOOKUP, useFactory: egressDnsLookupFactory, inject: [ConfigService] },
    { provide: EGRESS_CONFIG_HOSTS, useFactory: egressConfigHostsFactory, inject: [ConfigService] },
    EgressHttpClient,
  ],
  exports: [EgressHttpClient, EGRESS_RELAY_CONFIG, EGRESS_DNS_LOOKUP],
})
export class NetworkModule {}
