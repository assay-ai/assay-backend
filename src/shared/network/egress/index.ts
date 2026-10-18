/**
 * The single outbound-HTTP boundary. Import from here, never from a file
 * inside it — the directory is the unit the lint rule and the architecture test
 * both name.
 */
export { EGRESS_CONNECT_OVERRIDE, EGRESS_DNS_LOOKUP, EgressHttpClient } from './egress-http.client';
export type { EgressConnectOverride, EgressRequest, EgressResponse } from './egress-http.client';
export {
  EgressLockdownError,
  installEgressLockdown,
  isEgressLockdownEnabled,
  isEgressLockdownInstalled,
  withSanctionedEgress,
} from './egress-lockdown';
export {
  EGRESS_RELAY_CONFIG,
  EGRESS_RELAY_TOKEN_ENV,
  EGRESS_RELAY_URL_ENV,
  takeEgressRelayConfig,
} from './egress-relay.config';
export type { EgressRelayConfig } from './egress-relay.config';
export { EgressRelayTransport } from './egress-relay.transport';
export type { RelayHop, RelayedResponse } from './egress-relay.transport';
export { EgressError, EgressFailureKind, isEgressError } from './egress.errors';
export type { EgressErrorCode, EgressErrorContext } from './egress.errors';
export {
  DEFAULT_EGRESS_LIMITS,
  EgressTrust,
  INTERNAL_EGRESS_POLICY,
  UNTRUSTED_EGRESS_POLICY,
  withLimits,
} from './egress.policy';
export type { EgressLimits, EgressPolicy } from './egress.policy';
export {
  BlockedAddressReason,
  classifyAddress,
  isBlockedAddress,
  isBlockedVerdict,
} from './ip-rules';
export type { AddressVerdict, AllowedAddress, BlockedAddress } from './ip-rules';
export { resolveEgressTarget } from './resolve-target';
export type { EgressDnsLookup, EgressTarget } from './resolve-target';
