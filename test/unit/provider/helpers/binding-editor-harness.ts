import { DataSource, EntityManager } from 'typeorm';

import { BindingVersionEntity } from '@database/postgres/entities/binding-version.entity';
import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { ToolBindingRepository } from '@database/postgres/repositories/tool-binding.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AssetId, ChainId, chainIdOf } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import {
  ChainEnrolment,
  ChainEnrolmentPort,
  ChainEnrolmentStatus,
  enrolmentKey,
} from '@modules/provider/ports/chain-enrolment.port';
import { SaveToolBindingBodyDto } from '@modules/provider/dto/save-tool-binding.dto';
import { BindingEditorService } from '@modules/provider/services/binding-editor.service';
import {
  InMemoryProviderStakeSource,
  ProviderStakeSnapshot,
} from '../../helpers/in-memory-provider-stake.source';
import { MinimumStakeByChain } from '@modules/tool/domain/routing/routing.types';
import { ToolCataloguePort } from '@modules/tool/ports/tool-catalogue.port';
import { BindingStatus, PricingMode } from '@modules/tool/ports/tool.types';
import { MoneyUtil } from '@utils/money.util';

import { buildTool } from '../../tool/helpers/routing-fixtures';

/**
 * A hand-assembled {@link BindingEditorService}, for the write-time chain gate.
 *
 * Modelled on `test/unit/tool/helpers/routing-fixtures.ts`'s `buildRouter`: no
 * Nest testing module, an in-memory repository, an in-memory stake source
 * keyed the production way, and a stub
 * {@link ChainEnrolmentPort} over the enrolments the test declares. Standing up
 * a DI graph would answer "does the module wire" and the subject here is what
 * the gate refuses.
 */

export const STAKE_ASSET: AssetId = ASSET_IDS.USDC_SOLANA_DEVNET;
const USDC_DECIMALS = 6;

/** USDC from a raw minor-unit string: `usdc('1000000000')`. */
export function usdc(amount: string): Money {
  return MoneyUtil.of(amount, STAKE_ASSET, USDC_DECIMALS);
}

export interface BindingEditorHarnessOptions {
  /** `ENABLED_CHAINS`, by name — the gate's first question. */
  readonly enabledChains: readonly ChainId[];
  /** ACTIVE unless the entry says otherwise. */
  readonly enrolments: readonly {
    readonly providerId: string;
    readonly chainId: ChainId;
    readonly status?: ChainEnrolmentStatus;
  }[];
  /** `stakeKey(providerId, chainId)` → raw minor units. Absent means "no known stake". */
  readonly stakes: Readonly<Record<string, string>>;
}

export interface BindingEditorHarness {
  readonly editor: BindingEditorService;
  /** A body that passes every check the gate is not about. */
  readonly validBody: SaveToolBindingBodyDto;
  /** Every row the editor wrote, in order. */
  readonly rows: ToolBindingEntity[];
}

const account = (chainId: ChainId) =>
  `${chainId}:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM` as never;

/**
 * The floor, keyed on **every** chain the harness enables, all denominated in
 * {@link STAKE_ASSET}.
 *
 * Deliberately not the production shape, and the divergence is the point. In
 * production a floor's `Money.asset` is CAIP-19 and therefore names its own
 * chain, so a second chain's floor is a second asset — and `evaluateStakeGate`
 * would then refuse a binding priced in the first asset with
 * `STAKE_ASSET_MISMATCH` before it ever compared a number. A fixture built that
 * way would make the *under-staked* case pass for the wrong reason: green on a
 * gate that never performed the comparison the test claims to be about. Keying
 * one asset's floor under both chains keeps the shortfall a genuine shortfall,
 * and the spec asserts on the detail so an asset mismatch would still fail.
 */
function minimumStakeByChain(enabled: readonly ChainId[]): MinimumStakeByChain {
  const parameters = { floor: usdc('50000000'), priceMultiple: 1000 };
  return new Map(enabled.map((chainId) => [chainId, parameters]));
}

export function buildBindingEditorHarness(
  options: BindingEditorHarnessOptions,
): BindingEditorHarness {
  const tool = buildTool();
  const rows: ToolBindingEntity[] = [];
  const versions: BindingVersionEntity[] = [];

  const manager = {
    save: jest.fn(async (entity: unknown, value: unknown) => {
      // Keyed on the entity CLASS, not on a field: `BindingVersionEntity`
      // carries `toolId` too, so a shape test would file a snapshot as a
      // binding and `update()` would then find the wrong row.
      if ((entity as { name?: string })?.name === ToolBindingEntity.name) {
        const row = value as ToolBindingEntity;
        // The insert assigns an id, which `update()` then looks the row up by.
        if (!row.id) row.id = `binding-${rows.length + 1}`;
        if (!rows.includes(row)) rows.push(row);
      }
      if ((entity as { name?: string })?.name === BindingVersionEntity.name) {
        versions.push(value as BindingVersionEntity);
      }
      return value;
    }),
    findOne: jest.fn(
      async (
        entity: unknown,
        {
          where,
        }: {
          where: { bindingId: string; mappingVersion: number; organizationId: string; id: string };
        },
      ) =>
        // The save's locked re-read of the binding row, else a stored revision.
        (entity as { name?: string })?.name === ToolBindingEntity.name
          ? (rows.find(
              (row) => row.organizationId === where.organizationId && row.id === where.id,
            ) ?? null)
          : (versions.find(
              (version) =>
                version.bindingId === where.bindingId &&
                version.mappingVersion === where.mappingVersion,
            ) ?? null),
    ),
    maximum: jest.fn(async (_entity: unknown, _column: string, where: { bindingId: string }) => {
      const stored = versions.filter((version) => version.bindingId === where.bindingId);
      return stored.length === 0 ? null : Math.max(...stored.map((v) => v.mappingVersion));
    }),
  } as unknown as EntityManager;

  const dataSource = {
    transaction: jest.fn(async (work: (m: EntityManager) => Promise<unknown>) => work(manager)),
  } as unknown as DataSource;

  const bindings = {
    findOne: jest.fn(
      async ({ where }: { where: { organizationId: string; id: string } }) =>
        rows.find((row) => row.organizationId === where.organizationId && row.id === where.id) ??
        null,
    ),
  } as unknown as ToolBindingRepository;

  const catalogue: ToolCataloguePort = {
    findTool: jest.fn(async (id: string) => (id === tool.id ? tool : null)),
    listTools: jest.fn(),
    findBindings: jest.fn(),
  };

  const enrolled = new Map<string, ChainEnrolment>(
    options.enrolments.map((entry) => [
      enrolmentKey(entry.providerId, entry.chainId),
      {
        providerId: entry.providerId,
        chainId: entry.chainId,
        payoutAccountId: account(entry.chainId),
        stakeAuthorityAccountId: null,
        status: entry.status ?? ChainEnrolmentStatus.ACTIVE,
        enrolledAt: new Date(0),
      },
    ]),
  );

  /**
   * Answers with **every** declared enrolment, whoever was asked about.
   *
   * Deliberately more permissive than `DbChainEnrolmentSource`, which filters
   * by provider in SQL. A fake that filtered too would make the gate's lookup
   * key unobservable: reaching into the map for *any* row on the right chain
   * would pass every case in this file, because the map would only ever hold
   * rows the caller asked for. Handing it a stranger's row is the only input
   * that tells `enrolmentKey(providerId, chainId)` from `chainId`.
   */
  const enrolments: ChainEnrolmentPort = {
    enrolmentsOf: async () => new Map(enrolled),
  };

  const snapshot: ProviderStakeSnapshot = Object.fromEntries(
    Object.entries(options.stakes).map(([key, amount]) => [key, usdc(amount)]),
  );

  const editor = new BindingEditorService(
    bindings,
    catalogue,
    dataSource,
    enrolments,
    new InMemoryProviderStakeSource(snapshot),
    options.enabledChains,
    minimumStakeByChain(options.enabledChains),
    null,
    { list: async () => [], pruneExcept: async () => [] } as never,
  );

  const validBody = {
    toolId: tool.id,
    endpoint: 'https://provider.example.com/api',
    requestMapping: { method: 'POST', path: '/search', body: { q: '$.query' } },
    responseMapping: { answer: '$.data.answer' },
    pricingMode: PricingMode.PAID,
    // $0.05 → a computed minimum of exactly $50, which is also the floor.
    priceAmount: '50000',
    assetId: STAKE_ASSET,
    settlementChains: [chainIdOf(STAKE_ASSET)],
    slaFailureRate: 0.02,
    timeoutMs: 8_000,
  } as unknown as SaveToolBindingBodyDto;

  return { editor, validBody, rows };
}

/** Re-exported so a spec can assert on a stored row without a second import path. */
export { BindingStatus };
