import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { AccountId, CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import {
  ChainEnrolment,
  ChainEnrolmentPort,
  ChainEnrolmentStatus,
  enrolmentKey,
} from '@modules/provider/ports/chain-enrolment.port';
import { ProviderStatus, ProviderTier } from '@modules/provider/ports/provider.types';
import { DbProviderRegistry } from '@modules/provider/services/db-provider-registry';
import { BlockSubjectKind } from '@modules/blocklist/domain/account-block';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';

import { blocklistOf, noBlocks } from '../helpers/blocklist';

/**
 * `DbProviderRegistry` since per-chain enrolments — the routing state is assembled from
 * **two** reads, because the payout address is no longer a column on
 * `providers`.
 *
 * ## What this file is defending
 *
 * The interesting half is not "does the map get built". It is the three ways a
 * map can be built wrongly and still look right:
 *
 * 1. **Ignoring the enrolment's status.** A `SUSPENDED` enrolment carried into
 *    the map makes `evaluatePayoutGate` pass on a chain the platform has
 *    already decided not to route — and the per-chain lifecycle is the whole
 *    reason the enrolment has a status of its own.
 * 2. **Collapsing the key.** Keyed on the provider alone, one provider's
 *    mainnet enrolment overwrites their devnet one; keyed on the chain alone,
 *    one provider's overwrites every other provider's.
 * 3. **Answering `undefined`.** `filterEligible` calls `.get()` on this map on
 *    every routing decision. A provider with no enrolments must arrive with an
 *    empty map, not with no field.
 */
describe('DbProviderRegistry', () => {
  const DEVNET = CHAIN_IDS.SOLANA_DEVNET;
  const MAINNET = CHAIN_IDS.SOLANA_MAINNET;
  const BASE = CHAIN_IDS.BASE_MAINNET;

  const PROVIDER_A = 'org-a';
  const PROVIDER_B = 'org-b';

  function address(chainId: ChainId, tail: string): AccountId {
    return `${chainId}:${tail}` as AccountId;
  }

  function enrolment(
    providerId: string,
    chainId: ChainId,
    overrides: Partial<ChainEnrolment> = {},
  ): ChainEnrolment {
    return {
      providerId,
      chainId,
      payoutAccountId: address(chainId, `payout-${providerId}`),
      stakeAuthorityAccountId: null,
      status: ChainEnrolmentStatus.ACTIVE,
      enrolledAt: new Date('2026-03-01T00:00:00Z'),
      ...overrides,
    };
  }

  function providerRow(organizationId: string): Record<string, unknown> {
    return { organizationId, status: 'ACTIVE', tier: 'ESTABLISHED' };
  }

  function build(
    options: {
      rows?: string[];
      enrolments?: ChainEnrolment[];
      blocklist?: AccountBlocklistService;
    } = {},
  ) {
    const find = jest
      .fn()
      .mockResolvedValue((options.rows ?? [PROVIDER_A]).map((id) => providerRow(id)));
    const providers = { find } as unknown as ProviderRepository;

    const enrolmentsOf = jest.fn(async (providerIds: readonly string[]) => {
      const found = new Map<string, ChainEnrolment>();
      for (const row of options.enrolments ?? []) {
        if (!providerIds.includes(row.providerId)) continue;
        found.set(enrolmentKey(row.providerId, row.chainId), row);
      }
      return found;
    });
    const enrolments = { enrolmentsOf } as unknown as ChainEnrolmentPort;

    return {
      registry: new DbProviderRegistry(providers, enrolments, options.blocklist ?? noBlocks()),
      find,
      enrolmentsOf,
    };
  }

  it('carries the provider’s standing slash holds onto the routing state', async () => {
    const heldSince = new Date('2026-10-15T00:00:00Z');
    const findHeld = jest.fn(async () => [
      { providerId: PROVIDER_A, chainId: DEVNET, reasons: ['BONDED_BELOW_MINIMUM'], heldSince },
    ]);
    const { find } = build();
    const registry = new DbProviderRegistry(
      { find } as unknown as ProviderRepository,
      { enrolmentsOf: async () => new Map() } as unknown as ChainEnrolmentPort,
      noBlocks(),
      { findHeld } as never,
    );
    const states = await registry.findRoutingStates([PROVIDER_A]);
    expect(states.get(PROVIDER_A)?.slashHolds).toEqual([
      { chainId: DEVNET, reasons: ['BONDED_BELOW_MINIMUM'], heldSince },
    ]);
    expect(findHeld).toHaveBeenCalledWith([PROVIDER_A]);
  });

  it('carries every ACTIVE enrolment onto the routing state, keyed by its chain', async () => {
    const { registry } = build({
      enrolments: [enrolment(PROVIDER_A, DEVNET), enrolment(PROVIDER_A, MAINNET)],
    });

    const states = await registry.findRoutingStates([PROVIDER_A]);
    const byChain = states.get(PROVIDER_A)?.payoutAccountByChain;

    // Both, under their own chains. A map built with the provider as the key
    // would have one entry here, and it would be whichever row came last.
    expect(byChain?.get(DEVNET)).toBe(address(DEVNET, `payout-${PROVIDER_A}`));
    expect(byChain?.get(MAINNET)).toBe(address(MAINNET, `payout-${PROVIDER_A}`));
    expect(byChain?.size).toBe(2);
  });

  it('answers null for a chain the provider is not enrolled on — never another chain’s address', async () => {
    const { registry } = build({ enrolments: [enrolment(PROVIDER_A, DEVNET)] });

    const states = await registry.findRoutingStates([PROVIDER_A]);
    const byChain = states.get(PROVIDER_A)?.payoutAccountByChain;

    // The property this whole suite exists for. `get` on an absent chain must be
    // undefined, not the one entry that happens to be in the map.
    expect(byChain?.get(BASE)).toBeUndefined();
    expect(byChain?.get(MAINNET)).toBeUndefined();
  });

  it.each([[ChainEnrolmentStatus.SUSPENDED], [ChainEnrolmentStatus.UNBONDING]])(
    'leaves a %s enrolment out of the map — it is not a chain this provider may be paid on',
    async (status) => {
      const { registry } = build({
        enrolments: [
          enrolment(PROVIDER_A, DEVNET, { status }),
          enrolment(PROVIDER_A, MAINNET, { status: ChainEnrolmentStatus.ACTIVE }),
        ],
      });

      const states = await registry.findRoutingStates([PROVIDER_A]);
      const byChain = states.get(PROVIDER_A)?.payoutAccountByChain;

      // The ACTIVE one is present, so this is a status filter and not a read
      // that lost the row.
      expect(byChain?.get(MAINNET)).toBeDefined();
      expect(byChain?.get(DEVNET)).toBeUndefined();

      // …and the closed chain is still REPORTED as enrolled, which is what
      // lets `evaluatePayoutGate` say `PAYOUT_ENROLMENT_NOT_ACTIVE` instead of
      // telling a provider who has proved an address that they have not.
      expect(states.get(PROVIDER_A)?.payoutEnrolmentChains.has(DEVNET)).toBe(true);
      expect(states.get(PROVIDER_A)?.payoutEnrolmentChains.has(MAINNET)).toBe(true);
    },
  );

  it('reports payoutEnrolmentChains for EVERY status, and only for chains that have a row', async () => {
    const { registry } = build({
      enrolments: [
        enrolment(PROVIDER_A, DEVNET, { status: ChainEnrolmentStatus.UNBONDING }),
        enrolment(PROVIDER_A, MAINNET),
      ],
    });

    const states = await registry.findRoutingStates([PROVIDER_A]);
    const chains = states.get(PROVIDER_A)?.payoutEnrolmentChains;

    expect([...(chains ?? [])].sort()).toEqual([DEVNET, MAINNET].sort());
    // Not a set of "every chain that exists" — a chain with no row must stay
    // out, or the gate would report a closed enrolment for a provider who
    // simply never enrolled, which is the opposite lie.
    expect(chains?.has(BASE)).toBe(false);
  });

  it('gives a provider with no enrolment an EMPTY chain set, not an absent field', async () => {
    const { registry } = build({ enrolments: [] });

    const states = await registry.findRoutingStates([PROVIDER_A]);
    const chains = states.get(PROVIDER_A)?.payoutEnrolmentChains;

    // `evaluatePayoutGate` calls `.has()` on this on every refusal. `undefined`
    // is a TypeError on the path that is already going wrong.
    expect(chains).toBeDefined();
    expect(chains?.size).toBe(0);
  });

  it('does not let one provider’s CLOSED chain reach another provider', async () => {
    const { registry } = build({
      rows: [PROVIDER_A, PROVIDER_B],
      enrolments: [enrolment(PROVIDER_A, DEVNET, { status: ChainEnrolmentStatus.SUSPENDED })],
    });

    const states = await registry.findRoutingStates([PROVIDER_A, PROVIDER_B]);

    expect(states.get(PROVIDER_A)?.payoutEnrolmentChains.has(DEVNET)).toBe(true);
    // B never enrolled. A set keyed on the chain alone would tell B they have a
    // closed enrolment on devnet — and send them to ask an operator to reopen
    // something that does not exist.
    expect(states.get(PROVIDER_B)?.payoutEnrolmentChains.size).toBe(0);
  });

  it('gives a provider with no enrolment an EMPTY map, not an absent field', async () => {
    const { registry } = build({ enrolments: [] });

    const states = await registry.findRoutingStates([PROVIDER_A]);
    const byChain = states.get(PROVIDER_A)?.payoutAccountByChain;

    // `filterEligible` calls `.get()` on this on every routing decision. An
    // `undefined` here is a TypeError on the hot path, not a refusal.
    expect(byChain).toBeDefined();
    expect(byChain?.size).toBe(0);
    expect(byChain?.get(DEVNET)).toBeUndefined();
  });

  it('does not let one provider’s enrolment reach another provider on the same chain', async () => {
    const { registry } = build({
      rows: [PROVIDER_A, PROVIDER_B],
      enrolments: [enrolment(PROVIDER_A, DEVNET)],
    });

    const states = await registry.findRoutingStates([PROVIDER_A, PROVIDER_B]);

    expect(states.get(PROVIDER_A)?.payoutAccountByChain.get(DEVNET)).toBe(
      address(DEVNET, `payout-${PROVIDER_A}`),
    );
    // B has no enrolment. A map keyed on the chain alone would hand B the
    // address A proved — one provider paid at another's wallet.
    expect(states.get(PROVIDER_B)?.payoutAccountByChain.size).toBe(0);
  });

  it('reads the enrolments once, for every provider asked about at once', async () => {
    const { registry, enrolmentsOf } = build({
      rows: [PROVIDER_A, PROVIDER_B],
      enrolments: [enrolment(PROVIDER_A, DEVNET), enrolment(PROVIDER_B, DEVNET)],
    });

    await registry.findRoutingStates([PROVIDER_A, PROVIDER_B]);

    // One statement per routing decision, not one per candidate provider —
    // this runs on the MCP hot path over every binding behind a tool.
    expect(enrolmentsOf).toHaveBeenCalledTimes(1);
    expect([...enrolmentsOf.mock.calls[0][0]]).toEqual([PROVIDER_A, PROVIDER_B]);
  });

  it('invents no routing state for a provider that has an enrolment but no providers row', async () => {
    const { registry } = build({ rows: [], enrolments: [enrolment(PROVIDER_A, DEVNET)] });

    const states = await registry.findRoutingStates([PROVIDER_A]);

    // `providers` remains the identity. An enrolment is money on a chain, not
    // a provider — building a state from one would route to a company the
    // registry has never heard of.
    expect(states.size).toBe(0);
  });

  it('issues neither read when asked about nobody', async () => {
    const { registry, find, enrolmentsOf } = build();

    const states = await registry.findRoutingStates([]);

    expect(states.size).toBe(0);
    expect(find).not.toHaveBeenCalled();
    expect(enrolmentsOf).not.toHaveBeenCalled();
  });

  it('still reports status and tier off the providers row, not off the enrolment', async () => {
    const { registry } = build({
      enrolments: [enrolment(PROVIDER_A, DEVNET, { status: ChainEnrolmentStatus.SUSPENDED })],
    });

    const states = await registry.findRoutingStates([PROVIDER_A]);

    // The two lifecycles are independent: a suspended enrolment
    // does not suspend the provider, it only removes that one chain.
    expect(states.get(PROVIDER_A)?.status).toBe(ProviderStatus.ACTIVE);
    expect(states.get(PROVIDER_A)?.tier).toBe(ProviderTier.ESTABLISHED);
    expect(states.get(PROVIDER_A)?.payoutAccountByChain.size).toBe(0);
    // The chain is still known to be enrolled, which is the whole difference
    // between "withdrawn from this chain" and "never signed".
    expect(states.get(PROVIDER_A)?.payoutEnrolmentChains.has(DEVNET)).toBe(true);
  });

  describe('with the account blocklist', () => {
    const BLOCKED = '5c0b3b4e-0d8a-4f6e-9a51-6f1d2b7c9e10';

    it('reads a blocked provider as SUSPENDED, so routing refuses it with its own reason', async () => {
      const { registry } = build({
        rows: [BLOCKED, PROVIDER_A],
        enrolments: [enrolment(BLOCKED, DEVNET), enrolment(PROVIDER_A, DEVNET)],
        blocklist: blocklistOf({ kind: BlockSubjectKind.ORGANIZATION, subject: BLOCKED }),
      });

      const states = await registry.findRoutingStates([BLOCKED, PROVIDER_A]);

      expect(states.get(BLOCKED)?.status).toBe(ProviderStatus.SUSPENDED);
      expect(states.get(PROVIDER_A)?.status).toBe(ProviderStatus.ACTIVE);
    });

    it('drops a blocked payout wallet from the routable map, and only that chain', async () => {
      const blockedPayout = address(DEVNET, 'leaked-payout');
      const { registry } = build({
        enrolments: [
          enrolment(PROVIDER_A, DEVNET, { payoutAccountId: blockedPayout }),
          enrolment(PROVIDER_A, MAINNET),
        ],
        blocklist: blocklistOf({ kind: BlockSubjectKind.WALLET, subject: blockedPayout }),
      });

      const state = (await registry.findRoutingStates([PROVIDER_A])).get(PROVIDER_A);

      expect(state?.payoutAccountByChain.has(DEVNET)).toBe(false);
      expect(state?.payoutAccountByChain.get(MAINNET)).toBe(
        address(MAINNET, `payout-${PROVIDER_A}`),
      );
      expect(state?.status).toBe(ProviderStatus.ACTIVE);
    });

    it('blocks one key on every chain of its namespace', async () => {
      const { registry } = build({
        enrolments: [enrolment(PROVIDER_A, DEVNET), enrolment(PROVIDER_A, MAINNET)],
        blocklist: blocklistOf({
          kind: BlockSubjectKind.WALLET,
          subject: address(DEVNET, `payout-${PROVIDER_A}`),
        }),
      });

      const state = (await registry.findRoutingStates([PROVIDER_A])).get(PROVIDER_A);

      expect(state?.payoutAccountByChain.size).toBe(0);
    });
  });

  describe('with observed stats (binding_stats)', () => {
    function statsRow(bindingId: string, overrides: Record<string, unknown> = {}) {
      return {
        bindingId,
        providerId: PROVIDER_A,
        attempts: 200,
        availableAttempts: 150,
        latencySamples: 150,
        p50LatencyMs: 300,
        p95LatencyMs: 2_000,
        verdicts: 100,
        passedVerdicts: 90,
        ...overrides,
      };
    }

    function withStats(rows: Record<string, unknown>[], minSampleSize = 50) {
      const { find } = build();
      const findByProviders = jest.fn(async () => rows);
      const registry = new DbProviderRegistry(
        { find } as unknown as ProviderRepository,
        { enrolmentsOf: async () => new Map() } as unknown as ChainEnrolmentPort,
        noBlocks(),
        null,
        { findByProviders } as never,
        { windowSize: 1000, minSampleSize, maxPerBuyer: 20, maxAgeMs: 1 },
      );
      return { registry, findByProviders };
    }

    it('returns the measured stats, per binding and pooled per provider, in the same batch', async () => {
      const { registry, findByProviders } = withStats([
        statsRow('binding-a'),
        statsRow('binding-b', {
          attempts: 800,
          availableAttempts: 800,
          latencySamples: 0,
          p50LatencyMs: null,
          p95LatencyMs: null,
          verdicts: 0,
          passedVerdicts: 0,
        }),
      ]);

      const state = (await registry.findRoutingStates([PROVIDER_A])).get(PROVIDER_A);

      expect(findByProviders).toHaveBeenCalledWith([PROVIDER_A]);
      expect(state?.bindingStats?.get('binding-a')).toEqual({
        availabilityRate: 0.75,
        paidQualityRate: 0.9,
        p50LatencyMs: 300,
        p95LatencyMs: 2_000,
      });
      expect(state?.bindingStats?.get('binding-b')).toEqual({ availabilityRate: 1 });
      // Pooled by counts: (150 + 800) / (200 + 800).
      expect(state?.stats.availabilityRate).toBe(0.95);
      expect(state?.stats.paidQualityRate).toBe(0.9);
      expect(state?.stats.p95LatencyMs).toBe(2_000);
    });

    it('keeps the neutral prior below the minimum sample — empty stats, no binding entry', async () => {
      const { registry } = withStats([statsRow('binding-a')], 500);

      const state = (await registry.findRoutingStates([PROVIDER_A])).get(PROVIDER_A);

      expect(state?.stats).toEqual({});
      expect(state?.bindingStats?.has('binding-a')).toBe(false);
    });

    it('returns empty stats when no stats source is wired, as before the pipeline', async () => {
      const { registry } = build();
      const state = (await registry.findRoutingStates([PROVIDER_A])).get(PROVIDER_A);
      expect(state?.stats).toEqual({});
      expect(state?.bindingStats?.size).toBe(0);
    });
  });
});
