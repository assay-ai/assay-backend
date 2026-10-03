import { Inject, Injectable, Logger } from '@nestjs/common';

import { AccountId, AssetId, ChainId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { CacheService } from '@shared/cache/redis-cache/cache.service';

import {
  STAKE_CACHE_KEY_PREFIX,
  STAKE_CACHE_TTL_MS,
  STAKE_STALE_MAX_MS,
} from '../constants/onchain-stake.constants';
import {
  CHAIN_ENROLMENT_SOURCE,
  ChainEnrolmentPort,
  enrolmentKey,
} from '../ports/chain-enrolment.port';
import {
  ONCHAIN_STAKE_READER,
  OnChainStake,
  OnChainStakeReaderPort,
} from '../ports/onchain-stake-reader.port';
import {
  ProviderChainStakeKey,
  ProviderStake,
  ProviderStakePort,
  stakeKey,
} from '../ports/provider-stake.port';

/**
 * The slice of `CacheService` this source uses.
 *
 * Declared structurally, like the RPC clients under `chains/solana/`, so the
 * unit suite fakes three methods instead of standing up Redis. `CacheService`
 * satisfies it as written.
 */
export interface StakeReadingCache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttl?: number): Promise<void>;
  del(key: string): Promise<void>;
}

/** DI token for {@link OnChainProviderStakeConfig}. */
export const ONCHAIN_PROVIDER_STAKE_CONFIG = 'ONCHAIN_PROVIDER_STAKE_CONFIG';

export interface OnChainProviderStakeConfig {
  /** Inside this age a cached reading is served without touching the RPC. */
  readonly freshTtlMs: number;
  /** Beyond this age a reading is not served at all. See the constants file. */
  readonly staleMaxMs: number;
  /** Injected so a test can age a reading without waiting for it. */
  readonly now: () => number;
}

export const DEFAULT_ONCHAIN_PROVIDER_STAKE_CONFIG: Omit<OnChainProviderStakeConfig, 'now'> =
  Object.freeze({
    freshTtlMs: STAKE_CACHE_TTL_MS,
    staleMaxMs: STAKE_STALE_MAX_MS,
  });

/** One `(provider, chain)` pair resolved to the account whose PDA holds the collateral. */
interface ResolvedAuthority {
  readonly providerId: string;
  readonly chainId: ChainId;
  readonly account: AccountId;
}

/** What goes into Redis. `Date` does not survive JSON, so the stamp is ISO-8601. */
interface CachedReading {
  readonly amount: string;
  readonly asset: string;
  readonly decimals: number;
  /** The moment the **chain** was read. Never the moment this entry was read. */
  readonly observedAt: string;
}

/**
 * Stake read from the settlement program, cached, and degrading
 * rather than failing when the RPC does.
 *
 * ```text
 *  (provider, chain) ─▶ enrolment.stake_authority_account_id ─▶ Redis ─fresh?─▶ done
 *                            (one batched query)                  │
 *                                                                 └─stale/miss─▶ reader
 *                                                                   (one getMultipleAccounts)
 * ```
 *
 * ## What multichain support changed, and what it deliberately did not
 *
 * The lookup is now per `(providerId, chainId)`, resolved through the
 * enrolment's `stake_authority_account_id`. The CACHE is untouched: its key was
 * always the stake authority, and a stake authority is a CAIP-10 account, which
 * names its own chain. So no new staleness is introduced and no per-call chain
 * read is added — the freshness window is still 30s and the fail-closed ceiling
 * still 15 minutes, for the reasons `onchain-stake.constants.ts` gives.
 *
 * This is the class `ProviderStakePort` was written to make possible: the
 * router does not import it, cannot tell it apart from `ConfigProviderStakeSource`,
 * and has no branch that behaves differently under one. Swapping them is a
 * `useClass` in `ProviderModule` — not this file's job.
 *
 * ## Why the cache is not an optimisation
 *
 * `evaluateStakeGate` **fails closed**: a provider with no known stake is not
 * routable for paid traffic. Reading straight through to the RPC would
 * therefore make one RPC timeout take *every* paid binding out of routing at
 * once, and every agent call would get a 503 — an outage in the payment path
 * caused by a monitoring dependency being slow. The cache exists so that a
 * chain we cannot reach costs us freshness rather than availability.
 *
 * That tolerance has a hard end. Past `staleMaxMs` the reading is dropped and
 * the provider becomes absent, which the gate turns into `STAKE_UNKNOWN` and
 * refuses. Both halves are load-bearing: a degrade with no upper bound is not a
 * degrade, it is a cache that never expires, and it would keep a slashed or
 * fully-unbonded provider routable for as long as the RPC stayed down.
 *
 * ## Absent, in four different ways, all of which mean the same to the gate
 *
 * A pair is missing from the result when the provider has no enrolment on that
 * chain, when the enrolment has no proven stake authority, when the chain says
 * there is no stake account at those seeds, and when the RPC is unreachable and
 * nothing recent is cached.
 * The port is explicit that absent is **not** zero, and this class never
 * substitutes one for the other — the difference is what lets a receipt say
 * "our source is down" rather than "they never bonded".
 *
 * ## A successful read that finds nothing beats a cached reading
 *
 * If the chain answers and there is no account, the cached entry is **deleted**
 * rather than kept as a fallback. Otherwise a provider who closed their stake
 * account would go on being routable through the next RPC blip, on a number the
 * chain has already contradicted.
 *
 * ## Keyed by stake authority, not by provider
 *
 * The cached fact is a property of the pubkey. Keying by provider id would let
 * a provider who re-proves a different stake wallet inherit the previous
 * wallet's balance for the rest of the TTL — and, with stake per chain, would also let
 * one chain's balance answer for another's, because a provider id says nothing
 * about which chain is being asked about.
 */
@Injectable()
export class OnChainProviderStakeSource implements ProviderStakePort {
  private readonly logger = new Logger(OnChainProviderStakeSource.name);

  constructor(
    @Inject(ONCHAIN_STAKE_READER) private readonly reader: OnChainStakeReaderPort,
    @Inject(CHAIN_ENROLMENT_SOURCE) private readonly enrolments: ChainEnrolmentPort,
    @Inject(CacheService) private readonly cache: StakeReadingCache,
    @Inject(ONCHAIN_PROVIDER_STAKE_CONFIG) private readonly config: OnChainProviderStakeConfig,
  ) {}

  async stakeOn(
    keys: readonly ProviderChainStakeKey[],
  ): Promise<ReadonlyMap<string, ProviderStake>> {
    const result = new Map<string, ProviderStake>();
    if (keys.length === 0) {
      return result;
    }

    const authorities = await this.stakeAuthorities(keys);
    if (authorities.size === 0) {
      return result;
    }

    const distinct = [...new Set([...authorities.values()].map((entry) => entry.account))];
    const cached = await this.readCache(distinct);
    const now = this.config.now();

    // Anything not cached, or cached longer ago than the freshness window, is
    // asked of the chain. Everything else is answered without a round trip —
    // this is the whole reason routing does not pay for an RPC per call.
    const toRead = distinct.filter((account) => {
      const reading = cached.get(account);
      return !reading || now - reading.observedAt.getTime() >= this.config.freshTtlMs;
    });

    const asked = new Set(toRead);
    let live: ReadonlyMap<AccountId, OnChainStake> = new Map();
    let readSucceeded = false;
    if (toRead.length > 0) {
      try {
        live = await this.reader.bondedStakeOf(toRead);
        readSucceeded = true;
        await this.writeCache(toRead, live);
      } catch (error) {
        // Deliberately not rethrown. The caller is the router, and the gate it
        // feeds fails closed — an exception here would be an outage, where a
        // stale-but-recent reading is the far smaller compromise. Beyond
        // `staleMaxMs` the loop below refuses anyway.
        this.logger.warn(
          `On-chain stake read failed for ${toRead.length} stake authorities; ` +
            `falling back to readings up to ${this.config.staleMaxMs}ms old: ${String(error)}`,
        );
      }
    }

    for (const [key, { providerId, chainId, account }] of authorities) {
      const fresh = live.get(account);
      if (fresh) {
        result.set(key, {
          providerId,
          chainId,
          staked: fresh.bonded,
          observedAt: fresh.observedAt,
        });
        continue;
      }

      // The chain answered and had no account at those seeds. Authoritative,
      // and it outranks anything cached — see the class comment.
      if (readSucceeded && asked.has(account)) {
        continue;
      }

      const reading = cached.get(account);
      if (!reading) {
        continue;
      }
      if (now - reading.observedAt.getTime() > this.config.staleMaxMs) {
        continue;
      }

      result.set(key, {
        providerId,
        chainId,
        staked: reading.staked,
        // The chain read's stamp, carried through the cache untouched. A
        // cached value is a claim about the past and the gate is about to make
        // a money decision with it.
        observedAt: reading.observedAt,
      });
    }

    return result;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * `stakeKey(providerId, chainId)` → the stake authority proved on THAT chain,
   * in one query.
   *
   * `providerId === organizationId` is the equivalence the whole provider
   * surface rests on, so this is an ordinary scoped read over a set of
   * organizations and stays inside the scope guard.
   *
   * A pair with no enrolment, or an enrolment with a null
   * `stake_authority_account_id`, is dropped here rather than carried and
   * filtered later: there is no PDA to derive and nothing to ask the chain. It
   * is deliberately **not** answered from the provider's enrolment on some
   * other chain — that substitution is precisely what per-chain stake exists to forbid,
   * and it would compare one chain's floor against another chain's collateral.
   *
   * Enrolment **status** is not consulted. A `SUSPENDED` enrolment still names
   * an account holding slashable collateral, and the reason a provider is not
   * routable on a withdrawn chain is `PAYOUT_ENROLMENT_NOT_ACTIVE` from the
   * payout gate — a reason that says what happened. Filtering here would
   * relabel it `STAKE_UNKNOWN`, which reads as "our source is down".
   */
  private async stakeAuthorities(
    keys: readonly ProviderChainStakeKey[],
  ): Promise<ReadonlyMap<string, ResolvedAuthority>> {
    const providerIds = [...new Set(keys.map((key) => key.providerId))];
    const enrolments = await this.enrolments.enrolmentsOf(providerIds);

    const authorities = new Map<string, ResolvedAuthority>();
    for (const { providerId, chainId } of keys) {
      const enrolment = enrolments.get(enrolmentKey(providerId, chainId));
      const account = enrolment?.stakeAuthorityAccountId;
      if (!account) continue;
      authorities.set(stakeKey(providerId, chainId), { providerId, chainId, account });
    }
    return authorities;
  }

  private async readCache(
    accounts: readonly AccountId[],
  ): Promise<ReadonlyMap<AccountId, { staked: Money; observedAt: Date }>> {
    const readings = new Map<AccountId, { staked: Money; observedAt: Date }>();

    // One GET per authority rather than an MGET: `CacheService` is the seam
    // this codebase caches through, and the number of candidates for one tool
    // is small. Issued together so they pipeline rather than queue.
    const entries = await Promise.all(
      accounts.map(async (account) => {
        try {
          return [account, await this.cache.get<CachedReading>(this.cacheKey(account))] as const;
        } catch (error) {
          // An unreachable Redis must not be an unreachable stake source; it
          // just means every authority is read from the chain this time.
          this.logger.warn(`Stake cache read failed for ${account}: ${String(error)}`);
          return [account, null] as const;
        }
      }),
    );

    for (const [account, reading] of entries) {
      if (!reading) continue;
      const observedAt = new Date(reading.observedAt);
      if (Number.isNaN(observedAt.getTime())) continue;
      readings.set(account, {
        staked: {
          amount: reading.amount,
          asset: reading.asset as AssetId,
          decimals: reading.decimals,
        },
        observedAt,
      });
    }

    return readings;
  }

  private async writeCache(
    read: readonly AccountId[],
    live: ReadonlyMap<AccountId, OnChainStake>,
  ): Promise<void> {
    // The TTL is the *staleness* budget, not the freshness window: an entry
    // older than `freshTtlMs` is still wanted, as the fallback for an RPC that
    // has stopped answering. Redis dropping it at `staleMaxMs` and the age
    // check in `stakeOn` are the same rule enforced twice, on purpose — one of
    // them survives a wrong clock and the other survives a wrong TTL.
    const ttlSeconds = Math.ceil(this.config.staleMaxMs / 1000);

    await Promise.all(
      read.map(async (account) => {
        const stake = live.get(account);
        try {
          if (!stake) {
            // No account on chain. Drop any previous reading so a later RPC
            // failure cannot resurrect it.
            await this.cache.del(this.cacheKey(account));
            return;
          }
          const reading: CachedReading = {
            amount: stake.bonded.amount,
            asset: stake.bonded.asset,
            decimals: stake.bonded.decimals,
            observedAt: stake.observedAt.toISOString(),
          };
          await this.cache.set(this.cacheKey(account), reading, ttlSeconds);
        } catch (error) {
          // A cache we cannot write is a slower source, not a broken one.
          this.logger.warn(`Stake cache write failed for ${account}: ${String(error)}`);
        }
      }),
    );
  }

  private cacheKey(account: AccountId): string {
    return `${STAKE_CACHE_KEY_PREFIX}:${account}`;
  }
}
