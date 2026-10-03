import { readFileSync } from 'node:fs';

import {
  AccountId,
  AssetId,
  ChainId,
  chainIdOf,
  isAccountId,
  isAssetId,
  isChainId,
} from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';

import { ProviderRoutingState } from '../ports/provider.types';
import { stakeKey } from '../ports/provider-stake.port';
import { ProviderRegistrySnapshot } from './config-provider-registry';
import { ProviderStakeSnapshot } from './config-provider-stake.source';

/**
 * The provider registry and the stake source, from files.
 *
 * Both config-backed implementations were written to be seeded and, until now,
 * have only ever been seeded empty — which makes every routing decision
 * `PROVIDER_UNKNOWN` and every tool unroutable. These are the loaders that let
 * an operator stand up a working platform without open registration or
 * on-chain stake reads.
 *
 * **Two files, not one, and that is the point.** The ports are split so that
 * moving the stake read to chain state touches nothing else; a single
 * seed document holding both would put them back together in the one place a
 * future migration has to separate them again.
 */
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
 * One seeded stake reading, as the file spells it.
 *
 * A **triple**, not a `providerId → Money` entry: a stake is collateral some
 * chain's settlement contract can reach, and a provider-keyed file has to
 * answer every chain with the same number — which is a bootstrap discount the
 * per-chain stake rule forbids, arriving as a file format.
 *
 * `amount` / `asset` / `decimals` are `Money`'s own three fields, flattened,
 * because an amount without its asset and scale is not a quantity of anything.
 */
interface SeededProviderStake {
  readonly providerId: string;
  readonly chainId: string;
  readonly amount: string;
  readonly asset: string;
  readonly decimals: number;
}

/**
 * The stake seed, keyed by `stakeKey(providerId, chainId)`.
 *
 * The file is a JSON **array**, unlike the registry seed's object: the key is
 * now a pair, and a JSON object key can only be one string — encoding
 * `"org|chain"` into it would put this module's private key format into a file
 * an operator hand-edits.
 *
 * Everything is validated rather than cast, for the reason `toRoutingState`
 * gives: a malformed entry that type-checks is a provider who is silently
 * unroutable while the file says otherwise. The asset's own chain is checked
 * against `chainId` as well — a reading denominated in Solana USDC cannot be
 * filed under `eip155:4663`, and the gate's own cross-check would refuse it at
 * request time with `STAKE_UNKNOWN`, which reads like an RPC outage rather than
 * like a typo in a file.
 */
export function loadProviderStakes(
  path = process.env.PROVIDER_STAKE_SEED_FILE,
): ProviderStakeSnapshot {
  const rows = loadArray(path, 'PROVIDER_STAKE_SEED_FILE') as readonly SeededProviderStake[];

  const snapshot: Record<string, Money> = {};
  for (const [index, row] of rows.entries()) {
    const where = `PROVIDER_STAKE_SEED_FILE entry ${index}`;

    if (typeof row?.providerId !== 'string' || row.providerId.length === 0) {
      throw new Error(`${where} has no providerId`);
    }
    if (!isChainId(row.chainId)) {
      throw new Error(
        `${where} (provider ${row.providerId}) has a malformed chainId ` +
          `${JSON.stringify(row.chainId)}; it must be CAIP-2`,
      );
    }
    if (!isAssetId(row.asset)) {
      throw new Error(
        `${where} (provider ${row.providerId}) has a malformed asset ` +
          `${JSON.stringify(row.asset)}; it must be CAIP-19`,
      );
    }
    if (chainIdOf(row.asset as AssetId) !== row.chainId) {
      throw new Error(
        `${where} (provider ${row.providerId}) is filed under ${row.chainId} but is ` +
          `denominated in ${row.asset}, which lives on ${chainIdOf(row.asset as AssetId)}; ` +
          `collateral is only reachable by the settlement contract of its own chain`,
      );
    }
    if (typeof row.amount !== 'string' || !/^\d+$/.test(row.amount)) {
      throw new Error(
        `${where} (provider ${row.providerId}) has a non-integer amount ` +
          `${JSON.stringify(row.amount)}; amounts are atomic units as a decimal string`,
      );
    }
    if (!Number.isInteger(row.decimals) || row.decimals < 0) {
      throw new Error(
        `${where} (provider ${row.providerId}) has a malformed decimals ` +
          `${JSON.stringify(row.decimals)}`,
      );
    }

    const key = stakeKey(row.providerId, row.chainId);
    if (snapshot[key]) {
      throw new Error(
        `${where} repeats provider ${row.providerId} on ${row.chainId}; one reading per pair`,
      );
    }
    snapshot[key] = { amount: row.amount, asset: row.asset as AssetId, decimals: row.decimals };
  }

  return Object.freeze(snapshot);
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

/** The same two failure modes as {@link loadRecord}, for a file that is a list. */
function loadArray(path: string | undefined, variable: string): readonly unknown[] {
  if (!path) return Object.freeze([]);

  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error(
      `${variable} (${path}) must contain a JSON array of ` +
        `{ providerId, chainId, amount, asset, decimals } entries`,
    );
  }

  return Object.freeze(parsed);
}
