import { MinimumStakeByChain, ScoreWeights } from '../domain/routing/routing.types';
import { DEFAULT_SCORE_WEIGHTS } from '../domain/routing/score';
import { MAX_PROVIDER_SHARE } from '../domain/routing/weights';

/**
 * Everything the router is allowed to be tuned by.
 *
 * One injected value rather than a scatter of constants, for the reason that
 * applies to economic parameters generally: a number that is compiled
 * in is a number that needs a deploy to change, and half of these are numbers
 * an operator will want to change during an incident. The scoring weights are
 * also meant to be declared per tool category, which a constant cannot express
 * at all.
 */
export interface RouterConfig {
  readonly weights: ScoreWeights;
  /** The diversity floor. See `MAX_PROVIDER_SHARE`. */
  readonly maxProviderShare: number;

  /**
   * How many providers one tool call may be tried against.
   *
   * A cap, not a target — most calls use one attempt. It is small on purpose:
   * an agent is blocked on this call, so the useful question is not "how many
   * providers exist" but "how long is a caller willing to wait to be told we
   * could not serve them". Three attempts against three separate operators is
   * already strong evidence the fault is not one provider's.
   */
  readonly maxAttempts: number;

  /**
   * Wall-clock ceiling for the whole call, every failover included.
   *
   * Without it the worst case is `maxAttempts × timeoutMs` and nothing says so
   * anywhere — three 30s bindings would make a 90s tool call, which no agent
   * framework will wait for. Each attempt's budget is clipped to whatever is
   * left of this, so the total is what it says it is.
   */
  readonly totalDeadlineMs: number;

  /**
   * The stake floor, per chain. Replaces `minimumStake`.
   *
   * A map rather than one value because the gate is now asked about a chain,
   * and one value would have to answer every chain with the same floor
   * *denominated in one chain's asset* — which `evaluateStakeGate` would then
   * refuse as `STAKE_ASSET_MISMATCH` on every other chain, i.e. an outage
   * wearing the wrong name. Built in `ToolModule` by keying
   * `loadMinimumStakeParameters(config)` under `chainIdOf(floor.asset)`: the
   * floor is a `Money`, a `Money.asset` is CAIP-19, so it already names its
   * chain.
   */
  readonly minimumStakeByChain: MinimumStakeByChain;
}

/** DI token for the bound {@link RouterConfig}. */
export const ROUTER_CONFIG = 'ROUTER_CONFIG';

/** DI token for the router's source of randomness. Production binds `Math.random`. */
export const ROUTING_RANDOM = 'ROUTING_RANDOM';

/** The parts of {@link RouterConfig} that are not deployment-specific. */
export const DEFAULT_ROUTER_TUNING = Object.freeze({
  weights: DEFAULT_SCORE_WEIGHTS,
  maxProviderShare: MAX_PROVIDER_SHARE,
  maxAttempts: 3,
  totalDeadlineMs: 30_000,
});
