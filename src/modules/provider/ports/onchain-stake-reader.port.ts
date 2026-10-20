import { AccountId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';

/**
 * The chain half of the stake read, kept on the far side of the
 * `chains/` boundary.
 *
 * ## Why this port exists at all
 *
 * `OnChainProviderStakeSource` is a *provider* service: it knows about
 * `providers.stake_authority`, about Redis, and about how long a reading may
 * be trusted after the RPC stops answering. What it must not know is that the
 * number comes out of an Anchor account at `["stake", provider_pubkey]`, eight
 * discriminator bytes in. ESLint enforces exactly that — `@assay/settlement-client`
 * and `@solana/*` are importable only under `src/modules/chains/` — so the
 * account read has to be reachable through an interface rather than by calling
 * the decoder directly.
 *
 * This is the same shape `VerifierRegistryPort` already has: the port is
 * declared by the domain module that needs the fact, and
 * `src/modules/chains/solana/` supplies the one implementation that knows which
 * chain it is. Adding EVM stake later is another implementation, not a change
 * here.
 *
 * ## Why it is keyed by account rather than by provider
 *
 * The chain has never heard of an organization UUID. What it knows is a
 * pubkey, and the mapping from a provider to that pubkey is a *database* fact
 * that `providers.stake_authority` holds and that the challenge/prove flow
 * writes. Passing provider ids down here would put half of a provider-registry
 * lookup inside the chain module, and would make the reader untestable without
 * a database.
 *
 * ## The batch is the point
 *
 * `stakeOn` on `ProviderStakePort` takes an array because routing scores every
 * candidate for a tool at once; that reason survives one layer down unchanged.
 * An implementation is expected to issue as few round trips as the RPC's own
 * limits allow, never one per account.
 *
 * ## Failure is an exception here, and absence is not
 *
 * This port **throws** when the chain cannot be read. It does not swallow and
 * return an empty map, because "the RPC timed out" and "this provider never
 * bonded" are the two facts `ProviderStakePort` is explicit about not
 * conflating, and only the caller — which owns the cache and the staleness
 * budget — can decide what to do with the first one. An account absent from
 * the returned map means the chain answered and there is no stake account at
 * those seeds.
 *
 * ## Two readers, one account, two different questions
 *
 * This port was added for **routing**, which asks "how much is backing
 * traffic right now?" and is answered by `bonded` alone. There is a second
 * caller — `ProviderStakeAuthorityService.prove`, which asks "is this account
 * empty enough that its owner can walk away from it?" and is answered only by
 * both balances together. So the reading carries `unbonding` as well.
 *
 * The two must not be confused, and the field comments below say which is
 * which, because the failure mode of getting it wrong is silent in both
 * directions: fold `unbonding` into the routing gate and a provider serves paid
 * traffic for a fortnight on stake they have already asked to take out; leave
 * it out of the rotation gate and a defector re-points the platform's own slash
 * attestation at an empty PDA.
 */

/** One provider's stake account, as read from the chain. */
export interface OnChainStake {
  /** The CAIP-10 stake authority this reading is about. */
  readonly account: AccountId;
  /**
   * `bonded` **alone**, never `bonded + unbonding`.
   *
   * `ProviderStake::meets_minimum` in the settlement program is
   * `self.bonded >= minimum_stake`, and its doc comment settles the question:
   * stake the provider has already asked to take out is not backing anybody's
   * traffic, even though it is still slashable. Slashability is the base for
   * `at_risk()` and the slash cap — a different question from routing.
   *
   * Including `unbonding` would let a provider request a full unstake and keep
   * serving paid traffic for the entire 14-day unbonding period, which is the
   * exact hole the gate exists to close.
   */
  readonly bonded: Money;
  /**
   * Stake the provider has asked to take out, still inside the unbonding
   * period. **Never routing input** — see {@link bonded}.
   *
   * It is here for the one question `bonded` cannot answer: whether the account
   * can be abandoned. Unbonding stake is fully slashable for the entire period
   * — that is what the period is for — so an account with `unbonding > 0` is
   * precisely the account a defecting provider wants to leave behind while
   * pointing their stake authority at a fresh, empty PDA.
   */
  readonly unbonding: Money;
  /**
   * When the current unbonding period started, or `null` when nothing is
   * unbonding.
   *
   * `0` on the account means "nothing unbonding", not 1970, and it is
   * normalised to `null` here for that reason: a date that a screen would
   * render as a countdown must not be fabricated out of a zero.
   *
   * Added for the Capital screen, which has to show a
   * provider how long is left on an unstake they have already requested. It
   * comes out of a struct this reader already decodes in full, so carrying it
   * costs nothing.
   */
  readonly unbondingStartedAt: Date | null;
  /**
   * When the current unbonding period ends — {@link unbondingStartedAt} plus
   * `Config.unbonding_period_seconds` — or `null` when nothing is unbonding.
   *
   * Derived **on this side of the boundary**, deliberately. The period length
   * is a program parameter an admin can change with `update_config`, so a copy
   * of it in the domain module or an env var is a number that can silently
   * disagree with the one the withdrawal gate actually enforces.
   */
  readonly unbondingCompletesAt: Date | null;
  /** When the chain was read. Never when a cache of it was read. */
  readonly observedAt: Date;
}

export interface OnChainStakeReaderPort {
  /**
   * The stake accounts at the given stake authorities.
   *
   * An account absent from the result has no stake account on chain. A failure
   * to reach the chain throws — see the file header for why those two may not
   * be the same value.
   *
   * Still named for `bonded` because that is what the routing caller reads and
   * renaming it would churn `OnChainProviderStakeSource` and its spec for no
   * behavioural gain; {@link OnChainStake} is where the full contents are
   * declared.
   */
  bondedStakeOf(accounts: readonly AccountId[]): Promise<ReadonlyMap<AccountId, OnChainStake>>;
}

/** DI token for the bound {@link OnChainStakeReaderPort}. */
export const ONCHAIN_STAKE_READER = 'ONCHAIN_STAKE_READER';
