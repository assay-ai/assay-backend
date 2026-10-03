import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  CHAIN_ENROLMENT_SOURCE,
  ChainEnrolmentPort,
  enrolmentKey,
} from '../ports/chain-enrolment.port';
import {
  ProviderChainStakeKey,
  ProviderStake,
  ProviderStakePort,
  stakeKey,
} from '../ports/provider-stake.port';
import { ConfigProviderStakeSource } from './config-provider-stake.source';
import { OnChainProviderStakeSource } from './onchain-provider-stake.source';

/** The env var an operator sets to move {@link ProviderStakeSourceMode}. */
export const PROVIDER_STAKE_SOURCE_MODE_ENV = 'PROVIDER_STAKE_SOURCE_MODE';

/** DI token carrying the raw value of {@link PROVIDER_STAKE_SOURCE_MODE_ENV}. */
export const PROVIDER_STAKE_SOURCE_MODE = 'PROVIDER_STAKE_SOURCE_MODE';

/**
 * Which source speaks for a provider's stake, per provider.
 *
 * These are three points on one cutover, not three configurations somebody
 * might reasonably prefer. The intended path is
 * `config` → `chain_with_config_fallback` → `chain`, forwards only, with the
 * middle step held until `ProviderRepository.findProvidersWithoutStakeAuthority()`
 * comes back empty.
 */
export enum ProviderStakeSourceMode {
  /**
   * Config only. The chain is never consulted, and neither are the enrolments.
   * **The default**, so that deploying this class changes no behaviour at all.
   */
  CONFIG = 'config',
  /**
   * Chain for a `(provider, chain)` pair whose enrolment carries a proved stake
   * authority; config for one that does not. The transition mode, and the only
   * one that is safe to turn on while providers are still signing challenges.
   */
  CHAIN_WITH_CONFIG_FALLBACK = 'chain_with_config_fallback',
  /**
   * Chain only. A pair whose enrolment has no proved stake authority is absent,
   * which `evaluateStakeGate` turns into `STAKE_UNKNOWN` and refuses. The end
   * state, and an outage for anybody who has not signed yet.
   */
  CHAIN = 'chain',
}

const MODES: readonly string[] = Object.values(ProviderStakeSourceMode);

/**
 * The staged swap of the router's stake source from configuration to the chain.
 *
 * ## The one-line version of this change is a platform-wide outage
 *
 * Switching to the chain looks like it should be a single edit in `ProviderModule`:
 *
 * ```typescript
 * { provide: PROVIDER_STAKE_SOURCE, useExisting: OnChainProviderStakeSource }
 * ```
 *
 * It is not, and the reason is a fact about the data rather than about the
 * code. `OnChainProviderStakeSource` starts from the enrolment's
 * `stake_authority_account_id` (it was `providers.stake_authority` until
 * `1759300000003`), which is written only by the challenge/prove flow — a flow
 * that shipped days ago and that **no existing provider has been through**. A
 * pair with a null stake authority has no PDA to derive, so the chain source
 * cannot produce a reading and leaves it out of its result map entirely.
 *
 * Absent is not zero, and the port is emphatic about that — but the gate
 * refuses both. `evaluateStakeGate` reads an absent provider as
 * `STAKE_UNKNOWN` and fails closed, and the grace window does not cover it
 * either: grace opens for a provider who is *below the minimum*, never for one
 * whose stake is *unreadable*. So the one-line swap would take every
 * PAID/FREEMIUM binding of every already-registered provider out of routing in
 * the same instant, and each provider would get it back only by individually
 * signing a challenge. That is an availability incident caused by a migration,
 * which is the one kind that is entirely avoidable.
 *
 * ## What this class does instead
 *
 * ```text
 *  mode = config                     ─▶ ConfigProviderStakeSource   (every pair)
 *  mode = chain_with_config_fallback ─▶ proved   → OnChainProviderStakeSource
 *                                       unproved → ConfigProviderStakeSource
 *  mode = chain                      ─▶ OnChainProviderStakeSource  (every pair)
 * ```
 *
 * The partition is per **(provider, chain) pair**, not per deployment, which is
 * what makes the middle mode a migration rather than a compromise: a pair that
 * has been signed for is served off the chain from that moment, and one that
 * has not keeps being served off the number an operator typed — the arrangement
 * they are already living under. The cutover finishes pair by pair, and
 * `mode = chain` becomes a formality once
 * `findProvidersWithoutStakeAuthority()` is empty.
 *
 * The **mode itself is not per chain**, and does not need to be while one chain
 * is enabled: `PROVIDER_STAKE_SOURCE_MODE` is one env var for the deployment,
 * and the per-pair partition above is what makes a second chain safe under it —
 * a pair that has not been signed for falls back whatever the other chain has
 * done. A per-chain mode would be a second dial for a decision the partition
 * already takes correctly.
 *
 * ## Why `config` is the default and not `chain_with_config_fallback`
 *
 * Because the safest-looking mode is still a change, and this file ships into a
 * running system. `chain_with_config_fallback` puts an RPC read on the routing
 * path for anybody who has proved an authority, changes which number the gate
 * compares, and does both at deploy time rather than at a moment somebody
 * chose. Promotion is a decision a human makes after reading the gap report —
 * not a default that drifts into production behind an unrelated release.
 *
 * ## A proved authority is a one-way door
 *
 * The sharp edge, and the reason it is stated here explicitly: in
 * `chain_with_config_fallback`, a provider who *has* proved an authority but
 * whom the chain source cannot answer for is **absent**, not fallen back.
 *
 * `OnChainProviderStakeSource` returns absent for a proved provider in two
 * situations it deliberately does not distinguish — the chain answered and
 * there is no stake account at those seeds, and the RPC has been failing for
 * longer than `STAKE_STALE_MAX_MS`. Falling back to config for either would let
 * an operator-typed number outrank a chain that said "no", which is precisely
 * the substitution reading the chain exists to remove; a provider who closed or lost their
 * stake account would go on taking paid traffic for as long as the config file
 * still named them. So once a provider has signed for a stake account, the
 * chain is the only thing that speaks for them, and when it cannot, the gate
 * refuses. Fail closed is the correct outcome when the collateral behind a paid
 * call cannot be established.
 *
 * The 15-minute staleness budget inside the chain source is what keeps that
 * from being brittle: an RPC blip costs freshness, not availability, and only a
 * sustained outage reaches this rule.
 *
 * ## The router does not change
 *
 * Nothing here is visible to `ProviderRouterService`. It injects
 * `PROVIDER_STAKE_SOURCE`, gets a `ProviderStakePort`, and has no branch that
 * could behave differently under one implementation or another — the same
 * property that let the provider registry move onto Postgres by editing
 * one `useExisting`. This class is a third implementation of that port, and the
 * router's tests still run against `ConfigProviderStakeSource` directly.
 */
@Injectable()
export class CompositeProviderStakeSource implements ProviderStakePort {
  private readonly logger = new Logger(CompositeProviderStakeSource.name);

  /** The resolved mode. Public so wiring tests can assert the default. */
  readonly mode: ProviderStakeSourceMode;

  constructor(
    @Inject(PROVIDER_STAKE_SOURCE_MODE) mode: string | null,
    @Inject(ConfigProviderStakeSource) private readonly configSource: ProviderStakePort,
    @Inject(OnChainProviderStakeSource) private readonly chainSource: ProviderStakePort,
    @Inject(CHAIN_ENROLMENT_SOURCE) private readonly enrolments: ChainEnrolmentPort,
  ) {
    this.mode = parseMode(mode);
    this.logger.log(`Provider stake source mode: ${this.mode}`);
  }

  async stakeOn(
    keys: readonly ProviderChainStakeKey[],
  ): Promise<ReadonlyMap<string, ProviderStake>> {
    if (keys.length === 0) {
      return new Map();
    }

    // Both of these delegate wholesale, and neither needs the enrolment
    // lookup: in `config` there is nothing to partition, and in `chain` the
    // chain source already drops a pair with no proved authority — which is
    // exactly this mode's definition of absent. Paying for a query whose answer
    // could not change the outcome would put a round trip on the routing path
    // for nothing.
    if (this.mode === ProviderStakeSourceMode.CONFIG) {
      return this.configSource.stakeOn(keys);
    }
    if (this.mode === ProviderStakeSourceMode.CHAIN) {
      return this.chainSource.stakeOn(keys);
    }

    // The partition is per `(provider, chain)` pair, not per provider, and that
    // is the per-chain stake rule landing on the cutover: a provider who has proved a stake
    // authority on Solana and not on `eip155:4663` is served off the chain for
    // the first and off configuration for the second. A per-provider partition
    // would let one signature move BOTH chains onto a source that can only
    // answer for one of them, and the other would go dark.
    const proved = await this.provedAuthorities(keys);
    const onChain = keys.filter((key) => proved.has(stakeKey(key.providerId, key.chainId)));
    const unproved = keys.filter((key) => !proved.has(stakeKey(key.providerId, key.chainId)));

    const result = new Map<string, ProviderStake>();

    if (onChain.length > 0) {
      // Absent from this map stays absent. See "A proved authority is a
      // one-way door" above — there is no second attempt against config here, and
      // adding one would be the bug this class was written to avoid.
      for (const [key, stake] of await this.chainSource.stakeOn(onChain)) {
        result.set(key, stake);
      }
    }

    if (unproved.length > 0) {
      // One line naming every pair still on the old source, rather than a
      // silent substitution. A fallback nobody can see is a fallback that lives
      // forever: the gap report says who is left to sign, and this says they
      // are being served off an operator-typed number *right now*, on traffic
      // that is being paid for. Bounded in length by the candidate set for one
      // tool, which is small by construction.
      this.logger.warn(
        `Provider stake fell back to configuration for ${unproved.length} ` +
          `(provider, chain) pair(s) with no proved stake authority: ` +
          `${unproved.map((key) => stakeKey(key.providerId, key.chainId)).join(', ')}. ` +
          `They cannot move to ${ProviderStakeSourceMode.CHAIN} until they sign a ` +
          `stake-authority challenge on that chain.`,
      );

      for (const [key, stake] of await this.configSource.stakeOn(unproved)) {
        result.set(key, stake);
      }
    }

    return result;
  }

  /**
   * The subset of `keys` whose enrolment carries a proved stake authority,
   * as a set of {@link stakeKey}s.
   *
   * `providerId === organizationId` is the equivalence the whole provider
   * surface rests on, so this is an ordinary scoped read over a set of
   * organizations and stays inside the scope guard.
   *
   * This repeats the enrolment read `OnChainProviderStakeSource` makes
   * internally, and
   * that duplication is deliberate rather than overlooked. The chain source
   * does not expose its partition — and must not, because the whole point of
   * the port is that a caller cannot tell which implementation it holds — while
   * the *composition* is the one place that needs the answer before deciding
   * whom to ask. One extra indexed primary-key-ish read on the routing path, in
   * one transitional mode, is the price of not putting a "why did you leave
   * this provider out" method on a port that has to survive an EVM
   * implementation.
   *
   * A pair with no enrolment at all is treated exactly as one whose enrolment
   * has a null `stake_authority_account_id`: there is nothing to derive a PDA
   * from, so there is nothing for the chain to answer, and a third behaviour
   * here would be a third thing to reason about during a cutover.
   */
  private async provedAuthorities(
    keys: readonly ProviderChainStakeKey[],
  ): Promise<ReadonlySet<string>> {
    const enrolments = await this.enrolments.enrolmentsOf([
      ...new Set(keys.map((key) => key.providerId)),
    ]);

    const proved = new Set<string>();
    for (const { providerId, chainId } of keys) {
      const enrolment = enrolments.get(enrolmentKey(providerId, chainId));
      if (enrolment?.stakeAuthorityAccountId) proved.add(stakeKey(providerId, chainId));
    }
    return proved;
  }
}

/**
 * Resolves the configured mode, and refuses anything it does not recognise.
 *
 * Unset, empty and whitespace all mean `config` — the default has to survive an
 * `.env` that simply does not mention the variable, which is every environment
 * on the day this ships.
 *
 * An unrecognised value **throws at construction**, which is to say at boot.
 * The alternative is what makes this worth a paragraph: falling back to a
 * default on a typo means `PROVIDER_STAKE_SOURCE_MODE=chain_with_fallback`
 * silently runs `config`, so an operator who believes they promoted the
 * platform to the chain is still routing on numbers they typed months ago —
 * and nothing in the logs disagrees with them. The two modes differ by an
 * outage in one direction and by unbacked paid traffic in the other. Neither is
 * a reasonable thing to inherit from a misspelling.
 *
 * Trimmed and lower-cased first: `.env` files collect trailing spaces and
 * capitals, and neither of those is a different decision.
 */
function parseMode(raw: string | null | undefined): ProviderStakeSourceMode {
  const configured = raw?.trim().toLowerCase();
  if (!configured) {
    return ProviderStakeSourceMode.CONFIG;
  }
  if (!MODES.includes(configured)) {
    throw new Error(
      `${PROVIDER_STAKE_SOURCE_MODE_ENV}="${configured}" is not a recognised provider stake ` +
        `source mode. Supported: ${MODES.join(', ')}.`,
    );
  }
  return configured as ProviderStakeSourceMode;
}
