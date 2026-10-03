import { Logger } from '@nestjs/common';

import { ProviderStakeGraceEntity } from '@database/postgres/entities/provider-stake-grace.entity';
import { ProviderStakeGraceRepository } from '@database/postgres/repositories/provider-stake-grace.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import {
  AccountId,
  AssetId,
  CHAIN_IDS,
  ChainId,
  chainIdOf,
} from '@modules/chains/ports/caip.types';
import {
  GetProviderStakeResponseDto,
  ProviderChainStakeDto,
} from '@modules/provider/dto/get-provider-stake.dto';
import {
  ChainEnrolmentPort,
  ChainEnrolmentStatus,
  enrolmentKey,
} from '@modules/provider/ports/chain-enrolment.port';
import {
  OnChainStake,
  OnChainStakeReaderPort,
} from '@modules/provider/ports/onchain-stake-reader.port';
import { ProviderRegistryPort } from '@modules/provider/ports/provider-registry.port';
import {
  ProviderStake,
  ProviderStakePort,
  stakeKey,
} from '@modules/provider/ports/provider-stake.port';
import { ProviderStatus, ProviderTier } from '@modules/provider/ports/provider.types';
import { MinimumStakeParameters } from '@modules/tool/domain/routing/routing.types';
import { ProviderStakeService } from '@modules/provider/services/provider-stake.service';
import { ToolCataloguePort } from '@modules/tool/ports/tool-catalogue.port';
import { BindingStatus, PricingMode } from '@modules/tool/ports/tool.types';

const PROVIDER = 'org-88888888-8888-4888-8888-888888888888';
const USDC = ASSET_IDS.USDC_SOLANA_MAINNET;
/** A real, registered asset that is simply not the one the stake floor is in. */
const OTHER_ASSET = ASSET_IDS.USDC_SOLANA_DEVNET;
const AUTHORITY =
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PQ' as AccountId;
const PARAMETERS = { floor: { amount: '50000000', asset: USDC, decimals: 6 }, priceMultiple: 1000 };

/**
 * The chain this endpoint is about, written as a LITERAL.
 *
 * Deliberately not `chainIdOf(PARAMETERS.floor.asset)`. Computing the expected
 * value with the same expression the code under test uses makes a hardcoded
 * chain indistinguishable from the derivation — the exact defect review found
 * in the publish gate earlier, whose fix
 * (`test/unit/provider/binding-publish-chain.spec.ts`) is in this same tree.
 * The pair of cases at the end of this file is the other half of that fix: a
 * literal here plus a mirrored case on a DIFFERENT floor, so any fixed chain
 * fails one of the two whichever chain it fixes on.
 */
const FLOOR_CHAIN = CHAIN_IDS.SOLANA_MAINNET;

function usdc(amount: string) {
  return { amount, asset: USDC, decimals: 6 };
}

/**
 * One chain's entry off the response.
 *
 * Throws rather than returning `undefined` so that a missing entry fails as a
 * missing entry, naming what did come back. `expect(undefined?.staked)` reads
 * as a value assertion and passes for the wrong reason on a `toBeNull()`.
 */
function entryOn(response: GetProviderStakeResponseDto, chainId: ChainId): ProviderChainStakeDto {
  const found = response.stake.find((entry) => entry.chainId === chainId);
  if (!found) {
    throw new Error(
      `the response carries no entry for ${chainId} — only ` +
        `[${response.stake.map((entry) => entry.chainId).join(', ') || 'nothing'}]`,
    );
  }
  return found;
}

function binding(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'bnd-1',
    toolId: 'search_web',
    providerId: PROVIDER,
    pricingMode: PricingMode.PAID,
    priceAmount: '10000',
    assetId: USDC,
    status: BindingStatus.ACTIVE,
    ...overrides,
  };
}

function graceRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'grc-1',
    organizationId: PROVIDER,
    bindingId: 'a',
    startedAt: new Date('2026-08-18T00:00:00.000Z'),
    expiresAt: new Date('2026-08-25T00:00:00.000Z'),
    requiredAmount: '50000000',
    observedAmount: '45000000',
    assetId: USDC,
    resolvedAt: null,
    resolution: null,
    ...overrides,
  } as unknown as ProviderStakeGraceEntity;
}

function build(options: {
  stake?: { staked: { amount: string; asset: string; decimals: number }; observedAt: Date };
  minimumStakeOverride?: { amount: string; asset: string; decimals: number };
  bindings?: Array<Record<string, unknown>>;
  grace?: ProviderStakeGraceEntity[];
  stakeAuthority?: string | null;
  providerRow?: boolean;
  onChain?: ReadonlyMap<AccountId, OnChainStake>;
  chainThrows?: boolean;
  /** Overrides the stake floor, so a case can move the chain the endpoint derives. */
  parameters?: MinimumStakeParameters;
  /**
   * Every chain this provider is enrolled on, with the authority proved on
   * each. Replaces the default single enrolment on the floor's chain.
   */
  enrolledOn?: ReadonlyArray<{ chainId: ChainId; stakeAuthority?: AccountId | null }>;
  /** `stakeKey(provider, chain)` → that chain's reading. Absent means "not known". */
  stakesByChain?: Readonly<
    Record<
      string,
      { staked: { amount: string; asset: string; decimals: number }; observedAt: Date }
    >
  >;
  /** Authorities whose chain read FAILS — the per-chain half of `chainThrows`. */
  chainThrowsFor?: readonly AccountId[];
}) {
  const parameters = options.parameters ?? PARAMETERS;
  // The chain the REQUIREMENT is about is the FLOOR's own chain — the
  // itemisation, `requirementTotal`, `headroom` and `shortfall` are all in the
  // floor's asset. This one IS derived, because the fixture has to file its
  // reading wherever the endpoint will look; the assertions that pin the
  // derivation use a literal.
  const CHAIN = chainIdOf(parameters.floor.asset as AssetId);

  const readings = new Map(
    Object.entries(options.stakesByChain ?? {}).map(([key, reading]) => [key, reading]),
  );
  if (options.stake) readings.set(stakeKey(PROVIDER, CHAIN), options.stake);

  // Answers only the keys it is ASKED about, like a real source. A service
  // that asked about one chain therefore gets one reading back, whatever the
  // fixture holds — which is what makes "reports every enrolled chain"
  // falsifiable rather than a property of the fixture.
  const stakes: ProviderStakePort = {
    stakeOn: jest.fn(async (keys: readonly { providerId: string; chainId: ChainId }[]) => {
      const found = new Map<string, ProviderStake>();
      for (const { providerId, chainId } of keys) {
        const reading = readings.get(stakeKey(providerId, chainId));
        if (reading) {
          found.set(stakeKey(providerId, chainId), {
            providerId,
            chainId,
            ...reading,
            staked: { ...reading.staked, asset: reading.staked.asset as AssetId },
          });
        }
      }
      return found;
    }),
  };

  const stateMap = new Map([
    [
      PROVIDER,
      {
        status: ProviderStatus.ACTIVE,
        tier: ProviderTier.ESTABLISHED,
        stats: {},
        minimumStakeOverride: options.minimumStakeOverride,
      },
    ],
  ]);
  const registry: ProviderRegistryPort = {
    findRoutingStates: jest.fn().mockResolvedValue(stateMap),
  };

  const bindings = options.bindings ?? [];
  const catalogue: ToolCataloguePort = {
    findTool: jest.fn(),
    listTools: jest.fn().mockResolvedValue([{ id: 'search_web' }]),
    findBindings: jest.fn().mockResolvedValue(bindings),
  };

  // Per ACCOUNT, so one chain's RPC can fail while another answers — the
  // isolation the endpoint's `chainReadable` claims to have. `chainThrows`
  // keeps its old meaning: every read fails.
  const throwing = new Set(options.chainThrowsFor ?? []);
  const bondedStakeOf = jest.fn(async (accounts: readonly AccountId[]) => {
    if (options.chainThrows || accounts.some((account) => throwing.has(account))) {
      throw new Error('rpc unreachable');
    }
    const all = options.onChain ?? new Map<AccountId, OnChainStake>();
    return new Map([...all].filter(([account]) => accounts.includes(account)));
  });
  const onChain: OnChainStakeReaderPort = { bondedStakeOf };

  // The stake authority is a column on the ENROLMENT. `providerRow:
  // false` now means "no enrolment on the floor's chain", which is the same
  // observable state this option always described: nothing to read the chain
  // against.
  const enrolled =
    options.enrolledOn ??
    (options.providerRow === false
      ? []
      : [{ chainId: CHAIN, stakeAuthority: (options.stakeAuthority ?? null) as AccountId | null }]);
  const enrolments: ChainEnrolmentPort = {
    enrolmentsOf: jest.fn().mockResolvedValue(
      new Map(
        enrolled.map((entry) => [
          enrolmentKey(PROVIDER, entry.chainId),
          {
            providerId: PROVIDER,
            chainId: entry.chainId,
            payoutAccountId: `${entry.chainId}:PayoutAccount` as AccountId,
            stakeAuthorityAccountId: (entry.stakeAuthority ?? null) as AccountId | null,
            status: ChainEnrolmentStatus.ACTIVE,
            enrolledAt: new Date(0),
          },
        ]),
      ),
    ),
  };

  const grace = {
    find: jest.fn().mockResolvedValue(options.grace ?? []),
  } as unknown as ProviderStakeGraceRepository;

  return {
    service: new ProviderStakeService(
      stakes,
      registry,
      catalogue,
      onChain,
      grace,
      parameters,
      enrolments,
    ),
    stakes,
    bondedStakeOf,
    grace,
    enrolments,
    chain: CHAIN,
  };
}

describe('ProviderStakeService — absent stake is not zero', () => {
  it('hasKnownStake is false and staked is null when the source has no entry', async () => {
    const entry = entryOn(await build({}).service.getStake(PROVIDER), FLOOR_CHAIN);

    expect(entry.hasKnownStake).toBe(false);
    expect(entry.staked).toBeNull();
    expect(entry.observedAt).toBeNull();
  });

  it('hasKnownStake is true and staked is the exact Money when the source answers zero', async () => {
    const observedAt = new Date('2026-08-10T00:00:00.000Z');
    const entry = entryOn(
      await build({ stake: { staked: usdc('0'), observedAt } }).service.getStake(PROVIDER),
      FLOOR_CHAIN,
    );

    expect(entry.hasKnownStake).toBe(true);
    expect(entry.staked).toEqual(usdc('0'));
    expect(entry.observedAt).toEqual(observedAt.toISOString());
  });
});

describe('ProviderStakeService — the requirement', () => {
  it('itemises the requirement per binding and names the rule as max', async () => {
    const res = await build({
      bindings: [
        // 1000 × 0.010000 = 10.000000 < floor 50.000000 → the floor wins
        binding({ id: 'a', toolId: 'search_web', priceAmount: '10000' }),
        // 1000 × 0.200000 = 200.000000 > floor → the price multiple wins
        binding({ id: 'b', toolId: 'ais_lookup', priceAmount: '200000' }),
      ],
    }).service.getStake(PROVIDER);

    expect(res.requirementRule).toBe('max');
    expect(res.requirement).toHaveLength(2);
    // Ordered by tool id, then binding id — see the service.
    expect(res.requirement[0]).toEqual({
      bindingId: 'b',
      toolId: 'ais_lookup',
      pricingMode: PricingMode.PAID,
      price: usdc('200000'),
      minimum: usdc('200000000'),
      derivation: expect.stringContaining('max('),
      grace: null,
    });
    expect(res.requirement[1].bindingId).toBe('a');

    // `max`, not `sum`: the sum would be 250.000000.
    expect(res.requirementTotal).toEqual(usdc('200000000'));
  });

  it('uses the negotiated override when the provider has one, without touching the catalogue formula', async () => {
    const res = await build({
      minimumStakeOverride: usdc('25000000'),
      bindings: [binding({ priceAmount: '999999999' })], // would blow the formula if it were used
    }).service.getStake(PROVIDER);

    expect(res.requirementTotal).toEqual(usdc('25000000'));
    expect(res.requirement[0].minimum).toEqual(usdc('25000000'));
    expect(res.requirement[0].derivation).toContain('override');
  });

  it('still itemises the PRICE under an override — the override moves `minimum`, not the price', async () => {
    // `price` and `minimum` are two columns answering two questions. An
    // override changes what a binding REQUIRES, not what it CHARGES, and a
    // same-asset binding's price is knowable either way. Blanking it would drop
    // the number the rest of the row is read against — and the DTO promises
    // `price` is null ONLY for an asset the stake floor is not denominated in.
    const res = await build({
      minimumStakeOverride: usdc('25000000'),
      bindings: [binding({ priceAmount: '200000' })],
    }).service.getStake(PROVIDER);

    expect(res.requirement[0].price).toEqual(usdc('200000'));
    expect(res.requirement[0].minimum).toEqual(usdc('25000000'));
  });

  it('leaves price null under an override only when the binding is in another asset', async () => {
    // The one case the DTO's `null` clause is actually about: rendering the
    // price would need that asset's scale, which is the same lookup the
    // no-FX refusal is about. `minimum` is still the override, exactly as the
    // gate resolves it — the override is checked before the asset test.
    const res = await build({
      minimumStakeOverride: usdc('25000000'),
      bindings: [binding({ assetId: OTHER_ASSET, priceAmount: '200000' })],
    }).service.getStake(PROVIDER);

    expect(res.requirement[0].price).toBeNull();
    expect(res.requirement[0].minimum).toEqual(usdc('25000000'));
  });

  it('excludes FREE bindings from the requirement', async () => {
    const res = await build({
      bindings: [binding({ pricingMode: PricingMode.FREE })],
    }).service.getStake(PROVIDER);

    expect(res.requirement).toEqual([]);
    expect(res.requirementTotal).toBeNull();
  });

  it('is null when the provider has no PAID/FREEMIUM bindings at all', async () => {
    const res = await build({ bindings: [] }).service.getStake(PROVIDER);
    expect(res.requirementTotal).toBeNull();
    expect(res.recommendedBuffer).toBeNull();
    expect(res.negotiatedMinimum).toBeNull();
  });

  it('is null with an override and no bindings — a total no itemised row explains', async () => {
    // A behaviour changed on purpose, and the case the empty test above
    // does not pin: an override provider with zero ACTIVE PAID/FREEMIUM
    // bindings used to get the override back as the total. `requirementTotal`
    // is DEFINED as `max` over `requirement[].minimum`, and `requirement` is
    // empty here — a total with no row under it is the inconsistency the old
    // code had, and a screen showing "$25 required" beside an empty table
    // cannot say what the $25 is for.
    const res = await build({
      minimumStakeOverride: usdc('25000000'),
      bindings: [],
    }).service.getStake(PROVIDER);

    expect(res.requirement).toEqual([]);
    expect(res.requirementTotal).toBeNull();
    expect(res.recommendedBuffer).toBeNull();
  });

  it('carries the negotiated floor on negotiatedMinimum even when requirementTotal is null', async () => {
    // The consequence of the ruling above, closed. Without this field a
    // negotiated $500 floor has NO representation on the response until the
    // first binding is published: the provider opens Capital, reads "nothing to
    // stake against", stakes nothing, publishes, and watches the requirement
    // appear at $500 with a grace clock already running.
    const res = await build({
      minimumStakeOverride: usdc('500000000'),
      bindings: [],
    }).service.getStake(PROVIDER);

    expect(res.requirementTotal).toBeNull();
    expect(res.negotiatedMinimum).toEqual(usdc('500000000'));
  });

  it('agrees with requirementTotal when the provider has both', async () => {
    const res = await build({
      minimumStakeOverride: usdc('25000000'),
      bindings: [binding()],
    }).service.getStake(PROVIDER);

    expect(res.negotiatedMinimum).toEqual(usdc('25000000'));
    expect(res.requirementTotal).toEqual(usdc('25000000'));
  });

  it('lists a binding priced in another asset, with no minimum and the reason', async () => {
    // A deliberate behaviour change: such bindings used to be filtered out
    // altogether. They are listed now because they are NOT routable, and a
    // provider owed that reason should not have to infer it from a gap in the
    // table. They contribute nothing to the `max`.
    const res = await build({
      bindings: [
        binding({ id: 'a', toolId: 't-a' }),
        binding({ id: 'b', toolId: 't-b', assetId: OTHER_ASSET, priceAmount: '900000000' }),
      ],
    }).service.getStake(PROVIDER);

    expect(res.requirement).toHaveLength(2);
    const mismatched = res.requirement.find((item) => item.bindingId === 'b');
    expect(mismatched?.price).toBeNull();
    expect(mismatched?.minimum).toBeNull();
    expect(mismatched?.derivation).toContain('STAKE_ASSET_MISMATCH');
    // Excluded from the `max` rather than treated as zero: the $50 floor of
    // binding `a` is the whole total, and the mismatched binding's 900,000×
    // price does not reach it.
    expect(res.requirementTotal).toEqual(usdc('50000000'));
  });

  it('is null when EVERY binding is priced in another asset', async () => {
    const res = await build({
      bindings: [binding({ assetId: OTHER_ASSET })],
    }).service.getStake(PROVIDER);

    expect(res.requirement).toHaveLength(1);
    expect(res.requirementTotal).toBeNull();
    expect(res.headroom).toBeNull();
  });

  it('excludes DRAFT, PAUSED and SUSPENDED bindings', async () => {
    // The filter matches `findActivePaidBindings`, which is what the stake
    // monitor opens grace rows from. A non-ACTIVE binding leaking in here would
    // put a requirement — and possibly a countdown — against a binding taking
    // no paid traffic and that the monitor never watches.
    const res = await build({
      stake: { staked: usdc('60000000'), observedAt: new Date('2026-08-20T00:00:00.000Z') },
      bindings: [
        binding({ id: 'draft', toolId: 't-a', status: BindingStatus.DRAFT }),
        binding({ id: 'paused', toolId: 't-b', status: BindingStatus.PAUSED }),
        binding({ id: 'suspended', toolId: 't-c', status: BindingStatus.SUSPENDED }),
        binding({ id: 'live', toolId: 't-d', status: BindingStatus.ACTIVE }),
      ],
    }).service.getStake(PROVIDER);

    expect(res.requirement.map((item) => item.bindingId)).toEqual(['live']);
    expect(res.requirementTotal).toEqual(usdc('50000000'));
  });

  it('recommends 1.5x the requirement', async () => {
    const res = await build({ bindings: [binding()] }).service.getStake(PROVIDER);
    expect(res.recommendedBuffer).toEqual(usdc('75000000'));
  });
});

describe('ProviderStakeService — grace', () => {
  /**
   * Grace is the one thing here measured against the wall clock: `expired` is
   * `expiresAt < now`. The fixtures name real dates because a grace window is
   * only legible as dates — so without a frozen clock these tests pass until
   * the calendar reaches `graceRow`'s `expiresAt` and then go red on a day
   * nobody changed any code. That happened: the suite was green on 2026-08-24
   * and red on 2026-08-25, and the failure lands on whoever runs it next.
   *
   * `T0` is day 2 of the default row's 7-day window (2026-08-18 → 2026-08-25),
   * which is what "in grace, not yet expired" means for these fixtures. The
   * 2020 row stays expired at any 2026 instant.
   */
  const T0 = new Date('2026-08-20T00:00:00.000Z');

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns grace PER BINDING, not one provider-level countdown', async () => {
    const res = await build({
      stake: { staked: usdc('45000000'), observedAt: new Date('2026-08-20T00:00:00.000Z') },
      bindings: [
        binding({ id: 'a', toolId: 't-a' }),
        binding({ id: 'b', toolId: 't-b' }),
        binding({ id: 'c', toolId: 't-c' }),
      ],
      grace: [graceRow({ bindingId: 'a' })],
    }).service.getStake(PROVIDER);

    expect(res.requirement.map((r) => r.grace)).toEqual([expect.anything(), null, null]);
    expect(res.graceSummary).toEqual({ bindingsInGrace: 1, earliestExpiresAt: expect.any(String) });
  });

  it('carries the frozen shortfall and the expiry the row was opened with', async () => {
    const res = await build({
      bindings: [binding({ id: 'a', toolId: 't-a' })],
      grace: [graceRow({ bindingId: 'a' })],
    }).service.getStake(PROVIDER);

    expect(res.requirement[0].grace).toEqual({
      startedAt: '2026-08-18T00:00:00.000Z',
      expiresAt: '2026-08-25T00:00:00.000Z',
      shortfall: usdc('5000000'),
      expired: false,
    });
  });

  it('marks a row past its deadline as expired, so the screen can say "cut" rather than "flowing"', async () => {
    const res = await build({
      bindings: [binding({ id: 'a', toolId: 't-a' })],
      grace: [
        graceRow({
          bindingId: 'a',
          startedAt: new Date('2020-01-01T00:00:00.000Z'),
          expiresAt: new Date('2020-01-08T00:00:00.000Z'),
        }),
      ],
    }).service.getStake(PROVIDER);

    expect(res.requirement[0].grace?.expired).toBe(true);
  });

  it('counts down the EARLIEST of several deadlines, whatever order the rows arrive in', async () => {
    // The only thing `earliestExpiresAt` does. Asserting `expect.any(String)`
    // proves a date was produced, not that it is the right one — and the wrong
    // one here is the banner counting down to a deadline that is not the next
    // traffic to stop. The rows are deliberately NOT in chronological order.
    const res = await build({
      bindings: [
        binding({ id: 'a', toolId: 't-a' }),
        binding({ id: 'b', toolId: 't-b' }),
        binding({ id: 'c', toolId: 't-c' }),
      ],
      grace: [
        graceRow({ bindingId: 'b', expiresAt: new Date('2026-08-27T00:00:00.000Z') }),
        graceRow({ bindingId: 'a', expiresAt: new Date('2026-08-23T09:30:00.000Z') }),
        graceRow({ bindingId: 'c', expiresAt: new Date('2026-08-25T00:00:00.000Z') }),
      ],
    }).service.getStake(PROVIDER);

    expect(res.graceSummary).toEqual({
      bindingsInGrace: 3,
      earliestExpiresAt: '2026-08-23T09:30:00.000Z',
    });
  });

  it('has no graceSummary when nothing is in grace', async () => {
    const res = await build({ bindings: [binding()] }).service.getStake(PROVIDER);
    expect(res.graceSummary).toBeNull();
  });
});

describe('ProviderStakeService — the chain-derived block', () => {
  it('returns the unbonding figures from the chain', async () => {
    const onChain = new Map<AccountId, OnChainStake>([
      [
        AUTHORITY,
        {
          account: AUTHORITY,
          bonded: usdc('50000000'),
          unbonding: usdc('10000000'),
          unbondingStartedAt: new Date('2026-08-15T00:00:00.000Z'),
          unbondingCompletesAt: new Date('2026-08-29T00:00:00.000Z'),
          observedAt: new Date('2026-08-20T00:00:00.000Z'),
        },
      ],
    ]);

    const res = await build({ stakeAuthority: AUTHORITY, onChain }).service.getStake(PROVIDER);
    const entry = entryOn(res, FLOOR_CHAIN);

    expect(entry.unbonding).toEqual(usdc('10000000'));
    expect(entry.unbondingStartedAt).toBe('2026-08-15T00:00:00.000Z');
    expect(entry.unbondingCompletesAt).toBe('2026-08-29T00:00:00.000Z');
    expect(entry.chainReadable).toBe(true);
  });

  it('returns stakeAuthority as null for a provider who has not proved one', async () => {
    const built = build({ stakeAuthority: null });
    const entry = entryOn(await built.service.getStake(PROVIDER), FLOOR_CHAIN);

    expect(entry.stakeAuthority).toBeNull();
    expect(entry.unbonding).toBeNull();
    // Nothing to read: the chain is not consulted at all, so nothing failed.
    expect(built.bondedStakeOf).not.toHaveBeenCalled();
    expect(entry.chainReadable).toBe(true);
  });

  it('survives the chain being unreadable without failing the whole screen', async () => {
    // Decided: the Capital screen does NOT 500 when the RPC is down. It renders
    // every database-derived fact — the requirement, the itemisation, the grace
    // countdowns — and marks the chain-derived fields unknown with
    // `chainReadable: false`. A provider checking their stake during an incident
    // is exactly who needs an answer, and this endpoint spends no money.
    const res = await build({
      stakeAuthority: AUTHORITY,
      chainThrows: true,
      stake: { staked: usdc('45000000'), observedAt: new Date('2026-08-20T00:00:00.000Z') },
      bindings: [binding({ id: 'a', toolId: 't-a' })],
      grace: [graceRow({ bindingId: 'a' })],
    }).service.getStake(PROVIDER);

    const entry = entryOn(res, FLOOR_CHAIN);
    expect(entry.chainReadable).toBe(false);
    expect(entry.unbonding).toBeNull();
    expect(entry.unbondingStartedAt).toBeNull();
    expect(entry.unbondingCompletesAt).toBeNull();

    // Everything the database knows is still there.
    expect(entry.staked).toEqual(usdc('45000000'));
    expect(res.requirementTotal).toEqual(usdc('50000000'));
    expect(res.requirement[0].grace).not.toBeNull();
    expect(res.graceSummary).toEqual({ bindingsInGrace: 1, earliestExpiresAt: expect.any(String) });
  });
});

describe('ProviderStakeService — a chain reading the stake source cannot see', () => {
  /**
   * The lockout this describe block exists for, in one sentence: the screen
   * answers "how much have you staked" out of `PROVIDER_STAKE_SOURCE`, and
   * `chainReadable` out of `ONCHAIN_STAKE_READER`, so under
   * `PROVIDER_STAKE_SOURCE_MODE=config` a provider with real collateral is
   * told `hasKnownStake: false` beside a `chainReadable: true` that says the
   * chain answered — which it did, with the balance, into the same response.
   *
   * The DTO is not the thing to change: `staked` has to be the number
   * `evaluateStakeGate` will actually compare, or the screen tells a provider
   * they are covered while the router refuses them. What must not stay is the
   * SILENCE. These tests pin the log line that names the variable.
   */
  function chainStake(bonded: string): ReadonlyMap<AccountId, OnChainStake> {
    return new Map<AccountId, OnChainStake>([
      [
        AUTHORITY,
        {
          account: AUTHORITY,
          bonded: usdc(bonded),
          unbonding: usdc('0'),
          unbondingStartedAt: null,
          unbondingCompletesAt: null,
          observedAt: new Date('2026-08-25T00:00:00.000Z'),
        },
      ],
    ]);
  }

  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('warns, naming the variable, when the chain holds stake the source has no reading for', async () => {
    const res = await build({
      stakeAuthority: AUTHORITY,
      onChain: chainStake('60000000'),
    }).service.getStake(PROVIDER);

    // Unchanged, deliberately — see the block comment.
    const entry = entryOn(res, FLOOR_CHAIN);
    expect(entry.hasKnownStake).toBe(false);
    expect(entry.staked).toBeNull();
    expect(entry.chainReadable).toBe(true);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('PROVIDER_STAKE_SOURCE_MODE');
    // The three facts an operator needs to act without opening a debugger.
    expect(message).toContain(PROVIDER);
    expect(message).toContain(AUTHORITY);
    expect(message).toContain('60.000000');
  });

  it('stays quiet when the source already has a reading', async () => {
    await build({
      stakeAuthority: AUTHORITY,
      onChain: chainStake('60000000'),
      stake: { staked: usdc('60000000'), observedAt: new Date('2026-08-25T00:00:00.000Z') },
    }).service.getStake(PROVIDER);

    expect(warn).not.toHaveBeenCalled();
  });

  it('stays quiet when the chain has no account at those seeds either', async () => {
    // Absent from both is an ordinary state — a provider who proved an
    // authority and has not staked yet. Warning here would fire on every
    // Capital screen of every provider mid-onboarding.
    await build({ stakeAuthority: AUTHORITY }).service.getStake(PROVIDER);

    expect(warn).not.toHaveBeenCalled();
  });

  it('stays quiet when the chain account exists but is empty', async () => {
    await build({
      stakeAuthority: AUTHORITY,
      onChain: chainStake('0'),
    }).service.getStake(PROVIDER);

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('ProviderStakeService — headroom', () => {
  it('reports headroom against the MAX requirement, not the sum', async () => {
    // Two bindings, each requiring the $50 floor. `sum` would be $100 and would
    // report this provider $40 short; `max` is $50 and they are $10 clear.
    const res = await build({
      stake: { staked: usdc('60000000'), observedAt: new Date('2026-08-20T00:00:00.000Z') },
      bindings: [binding({ id: 'a', toolId: 't-a' }), binding({ id: 'b', toolId: 't-b' })],
    }).service.getStake(PROVIDER);

    expect(res.requirementTotal).toEqual(usdc('50000000'));
    expect(res.headroom).toEqual(usdc('10000000'));
    expect(res.shortfall).toEqual(usdc('0'));
  });

  it('reports a shortfall rather than a negative headroom', async () => {
    const res = await build({
      stake: { staked: usdc('45000000'), observedAt: new Date('2026-08-20T00:00:00.000Z') },
      bindings: [binding()],
    }).service.getStake(PROVIDER);

    expect(res.headroom).toEqual(usdc('0'));
    expect(res.shortfall).toEqual(usdc('5000000'));
  });

  it('is null, not zero, when the stake is unknown', async () => {
    const res = await build({ bindings: [binding()] }).service.getStake(PROVIDER);
    expect(res.headroom).toBeNull();
    expect(res.shortfall).toBeNull();
  });
});

/**
 * Which chain this endpoint asks about.
 *
 * Two mirrored cases, and the pair is the point: a hardcoded chain fails one of
 * them whichever chain it hardcodes. `binding-publish-chain.spec.ts` is the
 * same shape, and its own header records that hardcoding
 * a chain there passed the entire unit tree before it existed.
 *
 * The consequence of getting it wrong is not subtle and is not deferred to a
 * second chain: on this deployment `PLATFORM_STAKE_ASSET_ID` resolves to devnet
 * USDC, so a literal mainnet here would make the Capital screen answer
 * `hasKnownStake: false` and `stakeAuthority: null` for every provider on the
 * platform, today, with nothing red.
 */
describe('GET /providers/me/stake takes the chain from the FLOOR, not from a default', () => {
  it('asks the stake source about the mainnet floor’s chain, and reads the mainnet enrolment', async () => {
    const { service, stakes, enrolments } = build({ stakeAuthority: AUTHORITY });

    const stake = await service.getStake(PROVIDER);

    // `FLOOR_CHAIN` is a literal, so this cannot be satisfied by re-deriving.
    expect(stakes.stakeOn).toHaveBeenCalledWith([{ providerId: PROVIDER, chainId: FLOOR_CHAIN }]);
    expect(enrolments.enrolmentsOf).toHaveBeenCalledWith([PROVIDER]);
    // And the authority it reports is the one on THAT chain's enrolment.
    expect(entryOn(stake, FLOOR_CHAIN).stakeAuthority).toBe(AUTHORITY);
  });

  it('follows the floor to devnet when the floor is denominated there — the mirror case', async () => {
    // The same provider, the same code, one different environment value. A
    // literal `SOLANA_MAINNET` in the service passes the case above and fails
    // this one; a literal `SOLANA_DEVNET` does the reverse.
    const devnetFloor: MinimumStakeParameters = {
      floor: { amount: '50000000', asset: OTHER_ASSET as AssetId, decimals: 6 },
      priceMultiple: 1000,
    };
    const { service, stakes } = build({ parameters: devnetFloor });

    await service.getStake(PROVIDER);

    expect(stakes.stakeOn).toHaveBeenCalledWith([
      { providerId: PROVIDER, chainId: CHAIN_IDS.SOLANA_DEVNET },
    ]);
  });
});

/**
 * The stake is per chain — a list, never a sum.
 *
 * Every fixture here has **two chains with different values**, and the second
 * chain is `eip155:46630`, whose id sorts BEFORE `solana:…`. Both halves are
 * load-bearing:
 *
 * - one chain, or two chains with the same amount, cannot tell "the entry for
 *   this chain" apart from "the first entry", "the last entry" or "the sum";
 * - with the second chain sorting first, `stake[0]` is NOT the floor's chain,
 *   so an implementation that reads a position instead of a chain id fails the
 *   `headroom` case rather than passing it by luck.
 *
 * `requirementTotal`, `headroom`, `shortfall` and `recommendedBuffer` stay
 * single-chain on purpose — they are denominated in the stake floor's asset —
 * and the last case pins that they are about the FLOOR's chain specifically.
 */
describe('GET /providers/me/stake reports stake PER CHAIN', () => {
  /** A real second chain, in a different namespace, whose id sorts first. */
  const SECOND_CHAIN = CHAIN_IDS.ROBINHOOD_TESTNET;
  const SECOND_ASSET = ASSET_IDS.USDG_ROBINHOOD_TESTNET;
  const SECOND_AUTHORITY =
    `${SECOND_CHAIN}:0x00000000000000000000000000000000000000ab` as AccountId;

  function usdg(amount: string) {
    return { amount, asset: SECOND_ASSET, decimals: 6 };
  }

  /** Enrolled on both, with a proved authority on each. */
  const BOTH_CHAINS = [
    { chainId: FLOOR_CHAIN, stakeAuthority: AUTHORITY },
    { chainId: SECOND_CHAIN, stakeAuthority: SECOND_AUTHORITY },
  ];

  const OBSERVED = new Date('2026-08-20T00:00:00.000Z');

  it('asks the stake source about EVERY enrolled chain, not just the floor’s', async () => {
    const { service, stakes } = build({ enrolledOn: BOTH_CHAINS });

    await service.getStake(PROVIDER);

    // Order-insensitive: what matters is that both chains were asked about. A
    // service that asked about one satisfies only one of the two.
    const asked = (stakes.stakeOn as jest.Mock).mock.calls[0][0];
    expect(asked).toContainEqual({ providerId: PROVIDER, chainId: FLOOR_CHAIN });
    expect(asked).toContainEqual({ providerId: PROVIDER, chainId: SECOND_CHAIN });
  });

  it('renders two chains as TWO entries, each carrying its own chain’s amount', async () => {
    const res = await build({
      enrolledOn: BOTH_CHAINS,
      stakesByChain: {
        [stakeKey(PROVIDER, FLOOR_CHAIN)]: { staked: usdc('90000000'), observedAt: OBSERVED },
        [stakeKey(PROVIDER, SECOND_CHAIN)]: { staked: usdg('40000000'), observedAt: OBSERVED },
      },
    }).service.getStake(PROVIDER);

    expect(res.stake).toHaveLength(2);
    // Each amount is asserted against the chain it belongs to, so swapping the
    // two rows fails — which "two entries exist" alone would not.
    expect(entryOn(res, FLOOR_CHAIN).staked).toEqual(usdc('90000000'));
    expect(entryOn(res, SECOND_CHAIN).staked).toEqual(usdg('40000000'));
    expect(entryOn(res, FLOOR_CHAIN).stakeAuthority).toBe(AUTHORITY);
    expect(entryOn(res, SECOND_CHAIN).stakeAuthority).toBe(SECOND_AUTHORITY);
  });

  it('never presents the two as one figure — no sum, and no response-level `staked`', async () => {
    // A list, never a sum, with teeth. $90 of USDC plus $40 of USDG is $130 of nothing: no
    // single call is backed by it, and the two are different CAIP-19 assets so
    // they cannot be compared to pick the lower either. The response must
    // therefore carry NO provider-wide stake figure at all — not a total, and
    // not one chain's number wearing the provider's name.
    const res = await build({
      enrolledOn: BOTH_CHAINS,
      stakesByChain: {
        [stakeKey(PROVIDER, FLOOR_CHAIN)]: { staked: usdc('90000000'), observedAt: OBSERVED },
        [stakeKey(PROVIDER, SECOND_CHAIN)]: { staked: usdg('40000000'), observedAt: OBSERVED },
      },
    }).service.getStake(PROVIDER);

    expect(res).not.toHaveProperty('staked');
    expect(res).not.toHaveProperty('hasKnownStake');
    expect(res).not.toHaveProperty('stakeAuthority');
    expect(res).not.toHaveProperty('chainReadable');
    expect(res.stake.map((entry) => entry.staked?.amount)).not.toContain('130000000');
  });

  it('orders the entries by chain id, so two loads do not reorder the rows', async () => {
    const res = await build({ enrolledOn: BOTH_CHAINS }).service.getStake(PROVIDER);

    // `eip155:46630` before `solana:5eykt…`. Written as the literal order
    // rather than as `[...].sort()`, which would be the implementation again.
    expect(res.stake.map((entry) => entry.chainId)).toEqual([SECOND_CHAIN, FLOOR_CHAIN]);
  });

  it('tells a chain that READ ZERO apart from a chain nobody could read', async () => {
    // The distinction the whole screen turns on, and the one a single flag
    // destroys. Zero is fixed by staking; absent is not, and absent is what an
    // RPC outage and an unbonded provider both look like.
    const res = await build({
      enrolledOn: BOTH_CHAINS,
      stakesByChain: {
        [stakeKey(PROVIDER, FLOOR_CHAIN)]: { staked: usdc('0'), observedAt: OBSERVED },
        // Nothing filed for SECOND_CHAIN: the source has no reading for it.
      },
    }).service.getStake(PROVIDER);

    expect(entryOn(res, FLOOR_CHAIN).hasKnownStake).toBe(true);
    expect(entryOn(res, FLOOR_CHAIN).staked).toEqual(usdc('0'));

    expect(entryOn(res, SECOND_CHAIN).hasKnownStake).toBe(false);
    expect(entryOn(res, SECOND_CHAIN).staked).toBeNull();
  });

  it('marks ONLY the chain whose RPC failed unreadable, and reads the other one', async () => {
    // A batched read across both chains would throw once and set
    // `chainReadable: false` on every entry — including the chain whose answer
    // is sitting in the same result. That is a fabricated incident on the one
    // screen a provider opens *during* an incident to find out which chain is
    // affected.
    const res = await build({
      enrolledOn: BOTH_CHAINS,
      chainThrowsFor: [SECOND_AUTHORITY],
      onChain: new Map<AccountId, OnChainStake>([
        [
          AUTHORITY,
          {
            account: AUTHORITY,
            bonded: usdc('50000000'),
            unbonding: usdc('10000000'),
            unbondingStartedAt: new Date('2026-08-15T00:00:00.000Z'),
            unbondingCompletesAt: new Date('2026-08-29T00:00:00.000Z'),
            observedAt: OBSERVED,
          },
        ],
      ]),
    }).service.getStake(PROVIDER);

    expect(entryOn(res, SECOND_CHAIN).chainReadable).toBe(false);
    expect(entryOn(res, SECOND_CHAIN).unbonding).toBeNull();

    expect(entryOn(res, FLOOR_CHAIN).chainReadable).toBe(true);
    expect(entryOn(res, FLOOR_CHAIN).unbonding).toEqual(usdc('10000000'));
    expect(entryOn(res, FLOOR_CHAIN).unbondingCompletesAt).toBe('2026-08-29T00:00:00.000Z');
  });

  it('lists a chain the provider enrolled on and never funded', async () => {
    // "Enrolled, not yet funded" is `ChainEnrolment`'s own documented state and
    // is exactly the per-chain gap a provider needs to see. Under one figure it
    // appeared as nothing at all.
    const res = await build({
      enrolledOn: [
        { chainId: FLOOR_CHAIN, stakeAuthority: AUTHORITY },
        { chainId: SECOND_CHAIN, stakeAuthority: null },
      ],
      stakesByChain: {
        [stakeKey(PROVIDER, FLOOR_CHAIN)]: { staked: usdc('90000000'), observedAt: OBSERVED },
      },
    }).service.getStake(PROVIDER);

    const unfunded = entryOn(res, SECOND_CHAIN);
    expect(unfunded.stakeAuthority).toBeNull();
    expect(unfunded.hasKnownStake).toBe(false);
    // Nothing to read is not a failure to read.
    expect(unfunded.chainReadable).toBe(true);
  });

  it('carries the FLOOR’s chain even when the provider is enrolled only elsewhere', async () => {
    // Every figure denominated in the floor's asset — `requirementTotal`,
    // `headroom`, `shortfall` — is about this chain, so a response that omitted
    // it could not be read. It also keeps the seed-file reading of a provider
    // with no enrolment row, which is the ordinary state under
    // PROVIDER_STAKE_SOURCE_MODE=config.
    const res = await build({
      enrolledOn: [{ chainId: SECOND_CHAIN, stakeAuthority: SECOND_AUTHORITY }],
      stake: { staked: usdc('60000000'), observedAt: OBSERVED },
      bindings: [binding()],
    }).service.getStake(PROVIDER);

    expect(res.stake.map((entry) => entry.chainId)).toEqual([SECOND_CHAIN, FLOOR_CHAIN]);
    expect(entryOn(res, FLOOR_CHAIN).staked).toEqual(usdc('60000000'));
    expect(entryOn(res, FLOOR_CHAIN).stakeAuthority).toBeNull();
  });

  it('computes headroom from the FLOOR chain’s reading, never from another chain’s', async () => {
    // The floor chain is SHORT ($45 against a $50 requirement) while the other
    // chain is flush ($500). An implementation reading `stake[0]` — which is
    // the OTHER chain here, because `eip155:` sorts first — or a max, or a sum,
    // reports headroom to a provider whose paid traffic is about to stop.
    const res = await build({
      enrolledOn: BOTH_CHAINS,
      bindings: [binding()],
      stakesByChain: {
        [stakeKey(PROVIDER, FLOOR_CHAIN)]: { staked: usdc('45000000'), observedAt: OBSERVED },
        [stakeKey(PROVIDER, SECOND_CHAIN)]: { staked: usdg('500000000'), observedAt: OBSERVED },
      },
    }).service.getStake(PROVIDER);

    expect(res.requirementTotal).toEqual(usdc('50000000'));
    expect(res.shortfall).toEqual(usdc('5000000'));
    expect(res.headroom).toEqual(usdc('0'));
  });
});
