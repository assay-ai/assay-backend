/**
 * Where the router learns that a binding is inside an open grace period.
 *
 * ```text
 * PROVIDER_STAKE_SOURCE   how much is staked      →  evaluateStakeGate
 * STAKE_GRACE_SOURCE      is a grace row open     →  applyStakeGrace
 * ```
 *
 * Two ports rather than one, because the two answers have different owners and
 * different lifetimes. The stake reading is chain state, it moves without
 * anyone here doing anything, and it was migrated from a config file to an
 * RPC without the router noticing. A grace row is a **platform record** — the
 * promise, written down, that this binding keeps taking paid traffic for seven
 * more days — and it is opened and resolved by a job of ours (the stake monitor) against a
 * table of ours. Folding the second into `ProviderStake` would put a row we
 * write inside the type whose whole point is that we do not.
 *
 * ## Why it is keyed by binding and still needs the provider
 *
 * The floor is `max(floor, priceMultiple × price)`, so it is per binding: one
 * provider is simultaneously above it for a cheap binding and below it for an
 * expensive one, and `provider_stake_grace` is keyed on `binding_id` for
 * exactly that reason. The provider id travels alongside because
 * `providerId === organizationId` platform-wide, which is what lets the
 * implementation stay inside the organization scope guard instead of joining
 * the cross-tenant allowlist — the candidate set already names every
 * organization whose rows it is about.
 *
 * ## What it must not do
 *
 * **It must not filter out expired rows.** A row that is open and past its
 * `expires_at` is the window between the deadline and the sweeper's next tick,
 * and in that window the correct answer is `STAKE_GRACE_EXPIRED` — the
 * provider is being cut *because their grace ran out*, which is a different
 * sentence from "you are below the minimum" and the only one that tells them
 * the clock they were watching has stopped. Filtering here would make that
 * verdict unreachable and would report the shortfall as though the grace period
 * had never existed. The expiry comparison belongs to `applyStakeGrace`, which
 * is pure and takes `now` as a parameter so the decision replays.
 *
 * It must also not consult the stake. The date returned is a fact about the
 * grace row and nothing else — see `RoutingCandidate.stakeGraceUntil` for why a
 * loader that nulled it whenever stake was sufficient would make the gate read
 * its own answer back as an input.
 */

/**
 * One binding to ask about, and the organization that owns it.
 *
 * A bare list of binding ids would compile and would force the implementation
 * into an unscoped read — see the port's doc comment. Carrying the provider is
 * the cheaper half of that trade.
 */
export interface StakeGraceLookup {
  readonly bindingId: string;
  readonly providerId: string;
}

export interface StakeGracePort {
  /**
   * When each binding's open grace period expires, keyed by binding id.
   *
   * Batched for the reason `ProviderStakePort.stakeOn` is batched: routing
   * scores every candidate binding for a tool at once, and a per-binding call
   * would put N sequential round-trips on the path an agent is blocked on.
   *
   * A binding absent from the map has **no open grace row**, which the router
   * must keep distinct from "a row that has expired" — the first is
   * `STAKE_BELOW_MINIMUM` and the second is `STAKE_GRACE_EXPIRED`.
   */
  openGraceUntil(bindings: readonly StakeGraceLookup[]): Promise<ReadonlyMap<string, Date>>;
}

/** DI token for the bound {@link StakeGracePort}. */
export const STAKE_GRACE_SOURCE = 'STAKE_GRACE_SOURCE';
