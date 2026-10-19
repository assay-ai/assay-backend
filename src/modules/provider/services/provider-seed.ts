import { readFileSync } from 'node:fs';

import { AccountId, ChainId, isAccountId, isChainId } from '@modules/chains/ports/caip.types';

import { ProviderRoutingState } from '../ports/provider.types';
import { ProviderRegistrySnapshot } from './config-provider-registry';

/** The provider registry, from a file — for `ConfigProviderRegistry`. */
export function loadProviderRegistry(
  path = process.env.PROVIDER_REGISTRY_SEED_FILE,
): ProviderRegistrySnapshot {
  const raw = loadRecord(path, 'PROVIDER_REGISTRY_SEED_FILE') as Readonly<
    Record<string, SeededProviderRoutingState>
  >;

  return Object.freeze(
    Object.fromEntries(
      Object.entries(raw).map(([providerId, state]) => [
        providerId,
        toRoutingState(providerId, state),
      ]),
    ),
  );
}

/**
 * One provider as the seed file spells it.
 *
 * Identical to {@link ProviderRoutingState} except for the payout map, which
 * JSON cannot express: a `Map` round-trips through `JSON.stringify` as `{}`,
 * so the file carries a plain object and this loader is where it becomes a
 * `Map`. Without the conversion an operator's seed would parse, type-check
 * (the snapshot was cast, not validated) and then answer `undefined` to every
 * `get` — a provider present in the file and unroutable in the platform.
 */
interface SeededProviderRoutingState extends Omit<ProviderRoutingState, 'payoutAccountByChain'> {
  /** CAIP-2 → CAIP-10. Absent means enrolled nowhere, which is the empty map. */
  readonly payoutAccountByChain?: Readonly<Record<string, string>>;
}

function toRoutingState(
  providerId: string,
  state: SeededProviderRoutingState,
): ProviderRoutingState {
  const byChain = new Map<ChainId, AccountId>();
  for (const [chainId, accountId] of Object.entries(state.payoutAccountByChain ?? {})) {
    // Validated, not cast — the same grammar `DbChainEnrolmentSource` holds its
    // rows to. A cast here would make the branded types a claim
    // about the file rather than a fact about the value, and the first typo in
    // a hand-edited seed would travel into the router as a well-typed lie: a
    // `Map` key that is not a chain id can never be `get`, so the provider is
    // silently unroutable while the file says otherwise. This throws at boot,
    // for the reason `loadRecord` throws at boot — "nothing is configured" must
    // not be how "your configuration did not load" presents itself.
    if (!isChainId(chainId) || !isAccountId(accountId)) {
      throw new Error(
        `PROVIDER_REGISTRY_SEED_FILE: provider ${providerId} has a malformed ` +
          `payoutAccountByChain entry ${JSON.stringify(chainId)} → ` +
          `${JSON.stringify(accountId)}; the key must be CAIP-2 and the value CAIP-10`,
      );
    }
    byChain.set(chainId, accountId);
  }

  // A seed has no lifecycle: every entry it names is an ACTIVE enrolment, so
  // the status-blind chain set is exactly the map's keys. `evaluatePayoutGate`
  // therefore never reports `PAYOUT_ENROLMENT_NOT_ACTIVE` off a seed, which is
  // right — a seed file cannot express a suspended chain and must not look as
  // though it did.
  return {
    ...state,
    payoutAccountByChain: byChain,
    payoutEnrolmentChains: new Set(byChain.keys()),
  };
}

/**
 * An unset variable yields an empty snapshot; a set-but-broken one throws at
 * boot.
 *
 * The two failures are indistinguishable at request time — every provider is
 * unknown and every call is refused — and opposite for an operator. "Nothing is
 * configured" must not be how "your configuration did not load" presents
 * itself.
 */
function loadRecord(path: string | undefined, variable: string): Readonly<Record<string, unknown>> {
  if (!path) return Object.freeze({});

  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${variable} (${path}) must contain a JSON object keyed by provider id`);
  }

  return Object.freeze(parsed as Record<string, unknown>);
}
