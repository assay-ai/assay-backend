import { ChainId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';

/**
 * Where the router learns how much a provider has at stake, **on one chain**.
 *
 * The stake **gate** — `stake >= minimumStake` or the binding is not routable —
 * is the part with the behaviour; the read behind this port
 * (`OnChainProviderStakeSource`, settlement program account state) is the part
 * with the RPC. The router does not import the implementation and has no
 * branch that depends on it.
 *
 * The chain is authoritative and the cached value is a read optimisation. That
 * statement is about which source wins during reconciliation, not about who calls
 * it — from the router's side there is exactly one source, whichever one is
 * bound.
 *
 * ## One reading per (provider, chain), never per provider
 *
 * Slashing happens in the settlement contract of the chain the call was paid
 * on, and collateral on Solana is invisible and unreachable to a contract on
 * `eip155:4663`. An enrolment whose chain has no stake is an enrolment that
 * cannot be held to account, and routing to it is the one thing the stake gate
 * exists to prevent. The commercial half: the full minimum
 * on every chain, no bootstrap discount, because a discount would mean calls on
 * one chain are backed by collateral the chain enforcing them cannot see.
 */

/** One provider's stake **on one chain**, as observed by whichever source is bound. */
export interface ProviderStake {
  readonly providerId: string;
  /**
   * The chain this reading is about.
   *
   * On the reading, not merely in the map key, so a reading filed under the
   * wrong chain is *detectable* rather than merely wrong — `evaluateStakeGate`
   * checks the two agree and refuses when they do not. A key alone is a claim
   * made by whoever built the map; this is a claim made by whoever read the
   * chain.
   */
  readonly chainId: ChainId;
  readonly staked: Money;
  /**
   * When the value was read.
   *
   * Carried because a cached stake is a claim about the past, and the gate is
   * about to make a money decision with it. Nothing reads this today; it is
   * needed the moment the source becomes a cache of chain state, and adding
   * it later would mean changing the port — the one thing this design promises
   * not to do.
   */
  readonly observedAt: Date;
}

/** One thing to look up: this provider's stake on this chain. */
export interface ProviderChainStakeKey {
  readonly providerId: string;
  readonly chainId: ChainId;
}

export interface ProviderStakePort {
  /**
   * Stake for the given `(provider, chain)` pairs, keyed by {@link stakeKey}.
   *
   * Batched, not per-pair: routing scores every candidate binding for a tool at
   * once, and a per-pair call would turn one routing decision into N sequential
   * chain reads on the path an agent is blocked on.
   *
   * A pair absent from the returned map has **no known stake on that chain**.
   * That is not the same as zero and must not be rounded to it — an RPC that
   * failed and a provider that never bonded on that chain both produce
   * "absent", and the gate refuses both (fail closed) while the receipt can
   * still tell them apart.
   *
   * It is also not the same as "no stake anywhere". A provider bonded on Solana
   * and absent on `eip155:4663` is exactly the case per-chain readings exist for, and an
   * implementation that answered a missing chain from another chain's reading
   * would route a 4663 call against collateral no contract on 4663 can see.
   */
  stakeOn(keys: readonly ProviderChainStakeKey[]): Promise<ReadonlyMap<string, ProviderStake>>;
}

/**
 * The map key, and the only place its shape is written.
 *
 * Both halves are load-bearing, exactly as in `enrolmentKey`. Keyed on the
 * provider alone, a provider's mainnet reading would overwrite their devnet
 * one; keyed on the chain alone, one provider's reading would overwrite every
 * other provider's on that chain — and the router asks about many providers at
 * once, so the second collision is the likelier one. `|` cannot appear in a
 * CAIP-2 id or a UUID, so the two halves cannot run together into an ambiguous
 * key.
 */
export function stakeKey(providerId: string, chainId: ChainId): string {
  return `${providerId}|${chainId}`;
}

/** DI token for the bound {@link ProviderStakePort}. */
export const PROVIDER_STAKE_SOURCE = 'PROVIDER_STAKE_SOURCE';
