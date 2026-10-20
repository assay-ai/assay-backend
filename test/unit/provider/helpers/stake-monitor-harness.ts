import { ProviderEntity } from '@database/postgres/entities/provider.entity';
import { ProviderStakeGraceEntity } from '@database/postgres/entities/provider-stake-grace.entity';
import { BindingVersionEntity } from '@database/postgres/entities/binding-version.entity';
import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { BindingVersionRepository } from '@database/postgres/repositories/binding-version.repository';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { ProviderStakeGraceRepository } from '@database/postgres/repositories/provider-stake-grace.repository';
import { StakeSnapshotRepository } from '@database/postgres/repositories/stake-snapshot.repository';
import { ToolBindingRepository } from '@database/postgres/repositories/tool-binding.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, AssetId, ChainId, chainIdOf } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { NotificationPort } from '@modules/notification/ports/notification.port';
import {
  STAKE_GRACE_PERIOD_MS,
  STAKE_HEADROOM_WARNING_RATIO,
} from '@modules/provider/constants/stake-monitor.constants';
import {
  OnChainStake,
  OnChainStakeReaderPort,
} from '@modules/provider/ports/onchain-stake-reader.port';
import {
  ChainEnrolment,
  ChainEnrolmentPort,
  ChainEnrolmentStatus,
  enrolmentKey,
} from '@modules/provider/ports/chain-enrolment.port';
import { ProviderRegistryPort } from '@modules/provider/ports/provider-registry.port';
import {
  ProviderStake,
  ProviderStakePort,
  stakeKey,
} from '@modules/provider/ports/provider-stake.port';
import {
  ProviderRoutingState,
  ProviderStatus,
  ProviderTier,
} from '@modules/provider/ports/provider.types';
import { StakeMonitorService } from '@modules/provider/services/stake-monitor.service';
import { MinimumStakeParameters } from '@modules/tool/domain/routing/routing.types';
import { BindingStatus, PricingMode } from '@modules/tool/ports/tool.types';
import { AlertPort } from '@shared/alerting';
import { MoneyUtil } from '@shared/utils/money.util';

/**
 * The stake monitor under test, with every port faked.
 *
 * Extracted from `stake-monitor.service.spec.ts` so a second suite can be written
 * against the same wiring. Two suites over **one** harness is the point: a
 * monitor whose new behaviour was proved against a differently-wired fake could
 * pass while contradicting the grace suite, which is precisely the failure this
 * shared constructor makes impossible.
 *
 * No chain, no network, no Redis, no database. What these suites are about —
 * when a grace row opens, what the fleet had bonded when it was read — are
 * decisions made from numbers, and a test that needed a validator to observe
 * them would be measuring the validator.
 */

export const ASSET = ASSET_IDS.USDC_SOLANA_DEVNET as AssetId;

export const PARAMETERS: MinimumStakeParameters = {
  // $50 floor, 1000× price — the platform's minimum-stake parameters.
  floor: MoneyUtil.of('50000000', ASSET, 6),
  priceMultiple: 1000,
};

export const PROVIDER_A = '11111111-1111-4111-8111-111111111111';
export const PROVIDER_B = '22222222-2222-4222-8222-222222222222';
export const BINDING_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const BINDING_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const ACCOUNT_A = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:StakeAuthorityAAAA' as AccountId;
export const ACCOUNT_B = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:StakeAuthorityBBBB' as AccountId;

/**
 * The chain every fixture here is about, derived from {@link ASSET}.
 *
 * The monitor now asks for stake per `(provider, chain)` and resolves the chain
 * from each binding's own `assetId`, so the fixtures' chain has to be
 * that asset's chain or every reading would be filed where nothing looks.
 */
export const CHAIN: ChainId = chainIdOf(ASSET);

export const NOW = new Date('2026-08-20T12:00:00.000Z');

export function usdc(amount: string): Money {
  return MoneyUtil.of(amount, ASSET, 6);
}

/**
 * A `providers` row plus the stake authority its {@link CHAIN} enrolment
 * carries.
 *
 * The authority is no longer a column on this row (`1759300000003`), but every
 * caller of this helper is saying one thing — "this provider has proved this
 * account" — so it stays one argument, and {@link harness} routes it into the
 * enrolment port where the monitor now reads it.
 */
export function provider(organizationId: string, stakeAuthority: string | null): ProviderEntity {
  return { organizationId, stakeAuthority } as unknown as ProviderEntity;
}

export function binding(
  id: string,
  organizationId: string,
  priceAmount: string,
  pricingMode: PricingMode = PricingMode.PAID,
  /** The asset — and therefore the CHAIN — this binding settles on. */
  assetId: AssetId = ASSET,
): ToolBindingEntity {
  return {
    id,
    organizationId,
    toolId: 'search_web',
    priceAmount,
    assetId,
    pricingMode,
    status: BindingStatus.ACTIVE,
  } as unknown as ToolBindingEntity;
}

export function openGraceRow(
  overrides: Partial<ProviderStakeGraceEntity> = {},
): ProviderStakeGraceEntity {
  return {
    id: 'grace-1',
    organizationId: PROVIDER_A,
    bindingId: BINDING_A,
    startedAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
    expiresAt: new Date(NOW.getTime() + 6 * 24 * 60 * 60 * 1000),
    requiredAmount: '50000000',
    observedAt: null,
    observedAmount: '40000000',
    assetId: ASSET,
    resolvedAt: null,
    resolution: null,
    ...overrides,
  } as unknown as ProviderStakeGraceEntity;
}

export function onChainStake(account: AccountId, bonded: Money = usdc('50000000')): OnChainStake {
  return {
    account,
    bonded,
    unbonding: usdc('0'),
    unbondingStartedAt: null,
    unbondingCompletesAt: null,
    observedAt: NOW,
  };
}

/**
 * `providerId` → staked amount **on {@link CHAIN}**, keyed the way the port
 * keys it.
 *
 * The pair key is built here rather than written out at 20 call sites, all of
 * which are about one chain; a suite that is about two passes the map directly.
 */
export function stakeMap(entries: [string, string][]): ReadonlyMap<string, ProviderStake> {
  return new Map(
    entries.map(([providerId, amount]) => [
      stakeKey(providerId, CHAIN),
      { providerId, chainId: CHAIN, staked: usdc(amount), observedAt: NOW },
    ]),
  );
}

export interface Harness {
  readonly service: StakeMonitorService;
  readonly providers: { findAllProviders: jest.Mock };
  readonly bindings: { findActiveBindings: jest.Mock; findOneBy: jest.Mock };
  readonly versions: { find: jest.Mock };
  readonly grace: { find: jest.Mock; insert: jest.Mock; update: jest.Mock };
  readonly stakes: { stakeOn: jest.Mock };
  readonly enrolments: { enrolmentsOf: jest.Mock };
  readonly registry: { findRoutingStates: jest.Mock };
  readonly onChain: { bondedStakeOf: jest.Mock };
  readonly snapshots: { insertSnapshot: jest.Mock };
  readonly alerts: { emit: jest.Mock };
  readonly notifications: { notify: jest.Mock };
}

export function harness(
  overrides: {
    providers?: ProviderEntity[];
    bindings?: ToolBindingEntity[];
    /** Published `binding_versions` snapshots, for bindings carrying an unpublished draft. */
    versions?: BindingVersionEntity[];
    graceRows?: ProviderStakeGraceEntity[];
    stakes?: ReadonlyMap<string, ProviderStake>;
    onChain?: ReadonlyMap<AccountId, OnChainStake>;
    /** Per provider, `ProviderRoutingState.minimumStakeOverride` — the negotiated floor. */
    overrides?: ReadonlyMap<string, Money>;
    /** Tool id → name, for the notices; absent = no tool lookup wired. */
    toolNames?: ReadonlyMap<string, string>;
    /** The headroom band store; share one between harnesses to model later sweeps. */
    redis?: FakeBandStore;
    /** The sweep's clock; defaults to `NOW`. */
    now?: Date;
  } = {},
): Harness {
  const providers = { findAllProviders: jest.fn().mockResolvedValue(overrides.providers ?? []) };
  // The ACTIVE rows in every pricing mode — the monitor filters `FREE` itself,
  // after mapping each row to its published revision.
  const bindings = {
    findActiveBindings: jest.fn().mockResolvedValue(overrides.bindings ?? []),
    findOneBy: jest.fn(({ id }: { id: string }) =>
      Promise.resolve((overrides.bindings ?? []).find((row) => row.id === id) ?? null),
    ),
  };
  const tools = overrides.toolNames
    ? {
        findByIds: jest.fn((ids: readonly string[]) =>
          Promise.resolve(
            ids
              .filter((id) => overrides.toolNames!.has(id))
              .map((id) => ({ id, name: overrides.toolNames!.get(id) })),
          ),
        ),
      }
    : null;
  // Answers `toServedToolBindings`' batched lookup: one OR'd `where` entry per
  // drifted row, matched field by field.
  const versions = {
    find: jest.fn(({ where }: { where: Partial<BindingVersionEntity>[] }) =>
      Promise.resolve(
        (overrides.versions ?? []).filter((snapshot) =>
          where.some((clause) =>
            Object.entries(clause).every(
              ([key, value]) => snapshot[key as keyof BindingVersionEntity] === value,
            ),
          ),
        ),
      ),
    ),
  };
  const grace = {
    find: jest.fn().mockResolvedValue(overrides.graceRows ?? []),
    insert: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const stakes = {
    stakeOn: jest.fn().mockResolvedValue(overrides.stakes ?? new Map()),
  };
  // The stake authority moved onto the enrolment, so the fleet snapshot
  // reads it here rather than off the `providers` row. Built from the same
  // `provider(org, account)` fixtures, so a suite that declares an authority
  // gets one enrolment carrying it and nothing has to be said twice.
  const enrolments = {
    enrolmentsOf: jest.fn().mockImplementation((providerIds: readonly string[]) => {
      const found = new Map<string, ChainEnrolment>();
      for (const row of overrides.providers ?? []) {
        if (!providerIds.includes(row.organizationId)) continue;
        found.set(enrolmentKey(row.organizationId, CHAIN), {
          providerId: row.organizationId,
          chainId: CHAIN,
          payoutAccountId: `${CHAIN}:PayoutAccount` as AccountId,
          stakeAuthorityAccountId:
            (row as unknown as { stakeAuthority: AccountId | null }).stakeAuthority ?? null,
          status: ChainEnrolmentStatus.ACTIVE,
          enrolledAt: NOW,
        });
      }
      return Promise.resolve(found);
    }),
  };
  // The SAME port `evaluateStakeGate` reads `minimumStakeOverride` off. Faked
  // at the port rather than at the monitor, so a monitor that resolved the
  // override from anywhere else would not see these values at all.
  const registry = {
    findRoutingStates: jest.fn().mockImplementation((providerIds: readonly string[]) =>
      Promise.resolve(
        new Map<string, ProviderRoutingState>(
          providerIds.map((providerId) => [
            providerId,
            {
              providerId,
              status: ProviderStatus.ACTIVE,
              tier: ProviderTier.ESTABLISHED,
              stats: {},
              payoutAccountByChain: new Map(),
              payoutEnrolmentChains: new Set(),
              minimumStakeOverride: overrides.overrides?.get(providerId),
            },
          ]),
        ),
      ),
    ),
  };
  const onChain = {
    bondedStakeOf: jest.fn().mockResolvedValue(overrides.onChain ?? new Map()),
  };
  const snapshots = { insertSnapshot: jest.fn().mockResolvedValue(undefined) };
  const alerts = { emit: jest.fn().mockResolvedValue(undefined) };
  const notifications = { notify: jest.fn().mockResolvedValue(undefined) };

  const service = new StakeMonitorService(
    providers as unknown as ProviderRepository,
    bindings as unknown as ToolBindingRepository,
    versions as unknown as BindingVersionRepository,
    grace as unknown as ProviderStakeGraceRepository,
    stakes as unknown as ProviderStakePort,
    registry as unknown as ProviderRegistryPort,
    onChain as unknown as OnChainStakeReaderPort,
    enrolments as unknown as ChainEnrolmentPort,
    snapshots as unknown as StakeSnapshotRepository,
    PARAMETERS,
    alerts as unknown as AlertPort,
    notifications as unknown as NotificationPort,
    {
      gracePeriodMs: STAKE_GRACE_PERIOD_MS,
      headroomWarningRatio: STAKE_HEADROOM_WARNING_RATIO,
      now: () => (overrides.now ?? NOW).getTime(),
    },
    tools as never,
    (overrides.redis ?? null) as never,
  );

  return {
    service,
    providers,
    bindings,
    versions,
    grace,
    stakes,
    enrolments,
    registry,
    onChain,
    snapshots,
    alerts,
    notifications,
  };
}

/** The few Redis calls the headroom band uses: `SET … NX`, `GET`, `DEL`. */
export class FakeBandStore {
  readonly values = new Map<string, string>();
  async set(key: string, value: string, ..._options: unknown[]): Promise<'OK' | null> {
    if (this.values.has(key)) return null;
    this.values.set(key, value);
    return 'OK';
  }
  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async del(key: string): Promise<number> {
    return this.values.delete(key) ? 1 : 0;
  }
}
