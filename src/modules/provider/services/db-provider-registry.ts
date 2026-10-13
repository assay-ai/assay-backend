import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';

import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';
import { AccountId, ChainId } from '@modules/chains/ports/caip.types';

import {
  CHAIN_ENROLMENT_SOURCE,
  ChainEnrolmentPort,
  ChainEnrolmentStatus,
} from '../ports/chain-enrolment.port';
import { ProviderRegistryPort } from '../ports/provider-registry.port';
import {
  ProviderRoutingState,
  ProviderStats,
  ProviderStatus,
  ProviderTier,
} from '../ports/provider.types';

/**
 * The provider registry, from `providers`.
 *
 * ## Why this arrives with the publish gate
 *
 * Open registration shipped against a real table and initially left
 * `PROVIDER_REGISTRY` bound to `ConfigProviderRegistry`, which reads a seed
 * file. The consequence was recorded at the time and is blunt: **a provider
 * who registered, proved a wallet and passed the connectivity check was
 * invisible to the router**, so open registration was only half true — the
 * other half was an operator editing JSON.
 *
 * The publish gate is where that stops being tolerable, because the publish gate's whole
 * job is to decide whether a binding may take traffic. Letting a provider
 * publish into a registry that has never heard of them would produce the worst
 * available outcome: a green console, a live binding, and no traffic ever,
 * with nothing anywhere saying why.
 *
 * ## What it does *not* fix
 *
 * `stats` is returned empty, always. Nothing in this codebase computes
 * `availabilityRate`, `paidQualityRate` or a latency percentile from observed
 * calls — the router reads reputation and nothing writes it yet; that belongs
 * to whatever builds the observation pipeline. Empty is the honest answer and
 * the safe one: every field on `ProviderStats` is optional precisely so that
 * "not measured" is expressible, and `NEUTRAL_PRIOR` in
 * `domain/routing/score.ts` gives an unmeasured provider the benefit of the
 * doubt rather than a zero that reads as "measured, and terrible".
 *
 * `minimumStakeOverride` is likewise absent: the per-provider negotiated
 * floor has no column on `providers`, and inventing one here would put an
 * economic parameter in a place no parameter change goes through.
 *
 * ## Two reads, one round trip
 *
 * Since multichain support the payout address is not a column on `providers` any more —
 * it belongs to the per-chain enrolment, because one provider has one answer
 * *per chain* to "where do I get paid". So a routing state is assembled from
 * two reads rather than one. They are issued together under `Promise.all` and
 * both are keyed on `organizationId` over the same candidate set, which is the
 * shape `gatherCandidates` already uses for its own four reads: one extra
 * statement per routing decision, batched over every candidate, not one per
 * provider.
 */
@Injectable()
export class DbProviderRegistry implements ProviderRegistryPort {
  constructor(
    private readonly providers: ProviderRepository,
    @Inject(CHAIN_ENROLMENT_SOURCE) private readonly enrolments: ChainEnrolmentPort,
    private readonly blocklist: AccountBlocklistService,
  ) {}

  async findRoutingStates(
    providerIds: readonly string[],
  ): Promise<ReadonlyMap<string, ProviderRoutingState>> {
    const found = new Map<string, ProviderRoutingState>();
    if (providerIds.length === 0) return found;

    // `providerId === organizationId`, the equivalence the whole provider
    // surface rests on — so this is an ordinary scoped read over a set of
    // organizations rather than a cross-tenant one, and it stays inside the
    // scope guard.
    const [rows, enrolments] = await Promise.all([
      this.providers.find({ where: { organizationId: In([...providerIds]) } }),
      this.enrolments.enrolmentsOf(providerIds),
    ]);

    const payoutsByProvider = new Map<string, Map<ChainId, AccountId>>();
    const chainsByProvider = new Map<string, Set<ChainId>>();
    for (const enrolment of enrolments.values()) {
      // Recorded for EVERY status, before the ACTIVE filter below. This set
      // never admits a candidate — `evaluatePayoutGate`'s pass branch reads the
      // address map and nothing else — it only lets the refusal say `PAYOUT_
      // ENROLMENT_NOT_ACTIVE` instead of accusing a provider who has proved an
      // address of not having proved one.
      const chains = chainsByProvider.get(enrolment.providerId) ?? new Set<ChainId>();
      chains.add(enrolment.chainId);
      chainsByProvider.set(enrolment.providerId, chains);

      // Only `ACTIVE`. A `SUSPENDED` enrolment is a provider removed from the
      // market *on that chain* and an `UNBONDING` one is a provider on the way
      // out of it — carrying either into the routable map would make the gate
      // pass on a chain the platform has already decided not to route, and the
      // per-chain lifecycle is the whole reason the enrolment has a
      // status of its own rather than reusing the provider's.
      if (enrolment.status !== ChainEnrolmentStatus.ACTIVE) continue;

      // A blocked payout wallet is not an address anybody may be paid at, so
      // that chain leaves the routable map exactly as an unproved one would.
      // The provider still serves its other chains, unless the organization
      // itself is blocked — below.
      if (this.blocklist.walletBlock(enrolment.payoutAccountId)) continue;

      const byChain = payoutsByProvider.get(enrolment.providerId) ?? new Map<ChainId, AccountId>();
      byChain.set(enrolment.chainId, enrolment.payoutAccountId);
      payoutsByProvider.set(enrolment.providerId, byChain);
    }

    for (const row of rows) {
      found.set(row.organizationId, {
        providerId: row.organizationId,
        // A blocked provider reads as `SUSPENDED` to routing, so every path
        // that routes — `tools/call`, `tools/list` and the catalogue's quotes —
        // refuses it with the reason it already gives a suspended one, and no
        // router code has to know the blocklist exists.
        status: this.blocklist.organizationBlock(row.organizationId)
          ? ProviderStatus.SUSPENDED
          : (row.status as ProviderStatus),
        tier: row.tier as ProviderTier,
        stats: NO_OBSERVATIONS,
        // Empty when this provider has enrolled nowhere, which
        // `evaluatePayoutGate` turns into a refusal on every chain rather than
        // a default.
        payoutAccountByChain: payoutsByProvider.get(row.organizationId) ?? NO_ENROLMENTS,
        payoutEnrolmentChains: chainsByProvider.get(row.organizationId) ?? NO_CHAINS,
      });
    }

    return found;
  }
}

/** Shared, frozen, and empty — a provider who has enrolled on no chain at all. */
const NO_ENROLMENTS: ReadonlyMap<ChainId, AccountId> = new Map<ChainId, AccountId>();

/** The same, for the status-blind chain set. */
const NO_CHAINS: ReadonlySet<ChainId> = new Set<ChainId>();

/**
 * Not `{ availabilityRate: 1 }`, and not zeros.
 *
 * A provider nobody has measured has no rates. Asserting perfect ones would
 * route real traffic on a number we made up; asserting zeros would starve every
 * new provider of the traffic it needs to earn a real score, which is the
 * cold-start inversion `score.ts` exists to avoid.
 */
const NO_OBSERVATIONS: ProviderStats = Object.freeze({});
