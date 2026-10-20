import { randomUUID } from 'node:crypto';

import { BindingVersionEntity } from '@database/postgres/entities/binding-version.entity';
import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { staticToolContracts } from '@modules/tool/ports/tool-contracts.port';
import {
  BindingPauseReason,
  BindingStatus,
  PricingMode,
  Tool,
  ToolBinding,
} from '@modules/tool/ports/tool.types';
import { DatabaseToolCatalogue } from '@modules/tool/services/database-tool-catalogue';

import { BindingInvokerPort } from '@modules/tool/ports/binding-invoker.port';
import {
  BindingEditorTestContext,
  STAKE_CHAIN,
  TOOL,
  USDC_ASSET,
  createBindingEditorTestContext,
} from '../helpers/binding-editor-test-context';

/**
 * B3: `GET /providers/me/stake` used to read every binding of every tool on
 * the platform (`listTools` then `findBindings` per tool) and keep the
 * caller's. `DatabaseToolCatalogue.findBindingsOfProvider` reads only the
 * caller's rows. This proves the two give the same bindings, field for field,
 * over a world that has every case the old path handled: several tools, other
 * providers, a binding of a tool the catalogue does not list, a drifted
 * revision served from its snapshot, a drifted revision with no snapshot
 * (fails closed), and every status.
 */
const OTHER_TOOL: Tool = { ...TOOL, id: 'ais_lookup', name: 'AIS lookup' };
// One binding per (provider, tool) is a unique index, so each case gets a tool.
const MORE_TOOLS: Tool[] = ['free_tool', 'paused_tool', 'draft_tool', 'no_snapshot_tool'].map(
  (id) => ({ ...TOOL, id, name: id }),
);
const [FREE_TOOL, PAUSED_TOOL, DRAFT_TOOL, NO_SNAPSHOT_TOOL] = MORE_TOOLS;
const UNLISTED_TOOL_ID = 'retired_tool';

let context: BindingEditorTestContext;
let catalogue: DatabaseToolCatalogue;

beforeAll(async () => {
  // Nothing here dials a provider.
  context = await createBindingEditorTestContext({} as BindingInvokerPort);
  catalogue = new DatabaseToolCatalogue(
    staticToolContracts([TOOL, OTHER_TOOL, ...MORE_TOOLS]),
    context.bindings,
    context.versions,
  );
});

afterAll(async () => {
  await context?.close();
});

async function seedBinding(
  organizationId: string,
  toolId: string,
  overrides: Partial<ToolBindingEntity> = {},
): Promise<ToolBindingEntity> {
  const row = context.bindings.create({
    organizationId,
    toolId,
    endpoint: `https://${toolId}.provider.example.com/api`,
    requestMapping: { method: 'POST', path: '/x', body: { q: '$.query' } },
    responseMapping: { answer: '$.data.answer' },
    pricingMode: PricingMode.PAID,
    priceAmount: '50000',
    assetId: USDC_ASSET,
    settlementChains: [STAKE_CHAIN],
    slaFailureRate: '0.02',
    timeoutMs: 30_000,
    status: BindingStatus.ACTIVE,
    mappingVersion: 1,
    publishedVersion: 1,
    publishedAt: new Date(),
    ...overrides,
  } as Partial<ToolBindingEntity>);
  return context.bindings.save(row);
}

async function seedSnapshot(
  row: ToolBindingEntity,
  mappingVersion: number,
  overrides: Partial<BindingVersionEntity> = {},
): Promise<void> {
  const repo = context.versions;
  await repo.save(
    repo.create({
      organizationId: row.organizationId,
      bindingId: row.id,
      mappingVersion,
      toolId: row.toolId,
      endpoint: 'https://published.provider.example.com/api',
      requestMapping: { method: 'POST', path: '/published' },
      responseMapping: { answer: '$.published' },
      pricingMode: PricingMode.PAID,
      priceAmount: '70000',
      assetId: USDC_ASSET,
      timeoutMs: 20_000,
      authoredBy: 'cred-test',
      ...overrides,
    } as Partial<BindingVersionEntity>),
  );
}

/** The old read in `ProviderStakeService.findStakedBindings`, before the filters. */
async function everyToolScan(providerId: string): Promise<ToolBinding[]> {
  const tools = await catalogue.listTools();
  const perTool = await Promise.all(tools.map((tool) => catalogue.findBindings(tool.id)));
  return perTool.flat().filter((binding) => binding.providerId === providerId);
}

const byId = (bindings: readonly ToolBinding[]) =>
  [...bindings].sort((a, b) => a.id.localeCompare(b.id));

it('finds exactly the bindings the every-tool scan found, for every provider in the world', async () => {
  const provider = randomUUID();
  const other = randomUUID();

  await seedBinding(provider, TOOL.id);
  await seedBinding(provider, FREE_TOOL.id, { pricingMode: PricingMode.FREE, priceAmount: '0' });
  await seedBinding(provider, PAUSED_TOOL.id, {
    status: BindingStatus.PAUSED,
    pauseReason: BindingPauseReason.PROVIDER_REQUESTED,
    pausedAt: new Date(),
  });
  await seedBinding(provider, DRAFT_TOOL.id, {
    status: BindingStatus.DRAFT,
    publishedVersion: null,
    publishedAt: null,
  });
  // Drifted: the row says FREE, the published snapshot says PAID at 70000.
  const drifted = await seedBinding(provider, OTHER_TOOL.id, {
    mappingVersion: 3,
    publishedVersion: 2,
    pricingMode: PricingMode.FREE,
    priceAmount: '0',
  });
  await seedSnapshot(drifted, 2);
  await seedSnapshot(drifted, 3, { priceAmount: '1' });
  // Drifted with no snapshot: fails closed (not offered as ACTIVE).
  await seedBinding(provider, NO_SNAPSHOT_TOOL.id, { mappingVersion: 2, publishedVersion: 1 });
  // A tool the catalogue no longer lists: neither read may return it.
  await seedBinding(provider, UNLISTED_TOOL_ID);
  // Another provider on the same tools.
  await seedBinding(other, TOOL.id);
  await seedBinding(other, OTHER_TOOL.id, { mappingVersion: 2, publishedVersion: 1 });
  await seedBinding(other, FREE_TOOL.id, { status: BindingStatus.SUSPENDED });

  for (const providerId of [provider, other, randomUUID()]) {
    const scanned = byId(await everyToolScan(providerId));
    const scoped = byId(await catalogue.findBindingsOfProvider(providerId));
    expect(scoped).toEqual(scanned);
  }

  const mine = byId(await catalogue.findBindingsOfProvider(provider));
  expect(mine).toHaveLength(6);
  expect(mine.some((binding) => binding.toolId === UNLISTED_TOOL_ID)).toBe(false);
  const served = mine.find((binding) => binding.id === drifted.id);
  expect(served?.pricingMode).toBe(PricingMode.PAID);
  expect(served?.priceAmount).toBe('70000');
  expect(served?.version).toBe(2);
  const failedClosed = mine.find((binding) => binding.toolId === NO_SNAPSHOT_TOOL.id);
  expect(failedClosed?.status).not.toBe(BindingStatus.ACTIVE);
});
