import { ToolRegistrySeeder } from '@modules/tool/services/tool-registry.seeder';
import { buildTool } from './helpers/routing-fixtures';

/**
 * The seed is for local runs and tests only (design spec §13 D4): it upserts
 * version 1.0.0 of each seeded tool, and under NODE_ENV=production it is not
 * applied at all — the database is the only source of contracts there.
 */
describe('ToolRegistrySeeder', () => {
  const snapshot = {
    tools: [buildTool({ id: '00000000-0000-4000-8000-000000000001', name: 'get_example' })],
    bindings: [],
  };
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.NODE_ENV;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });

  it('upserts each seeded tool with its version 1.0.0 contract, then signals the change', async () => {
    process.env.NODE_ENV = 'test';
    const upserts: unknown[] = [];
    let changed = 0;
    const seeder = new ToolRegistrySeeder(
      snapshot,
      { upsertSeeded: async (rows: unknown[]) => void upserts.push(...rows) } as never,
      { contractsChanged: async () => void (changed += 1) },
    );
    await seeder.onApplicationBootstrap();
    expect(upserts).toEqual([
      expect.objectContaining({
        name: 'get_example',
        version: expect.objectContaining({
          summary: 'Returns web results for a query.',
          optionalOutputFields: [],
          examples: [],
        }),
      }),
    ]);
    expect(changed).toBe(1);
  });

  it('applies nothing under NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    const upserts: unknown[] = [];
    const seeder = new ToolRegistrySeeder(snapshot, {
      upsertSeeded: async (rows: unknown[]) => void upserts.push(...rows),
    } as never);
    await seeder.onApplicationBootstrap();
    expect(upserts).toEqual([]);
  });
});
