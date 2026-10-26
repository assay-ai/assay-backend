import { FindOperator } from 'typeorm';

import { ToolEntity } from '@database/postgres/entities/tool.entity';
import { ToolVersionEntity } from '@database/postgres/entities/tool-version.entity';
import { ToolsetEntryEntity } from '@database/postgres/entities/toolset-entry.entity';
import { ToolsetVersionEntity } from '@database/postgres/entities/toolset-version.entity';
import { ToolsetEntity } from '@database/postgres/entities/toolset.entity';
import { ToolsetErrorCode } from '@modules/toolset/errors/toolset.errors';
import {
  OfficialToolsetsService,
  officialDraftHash,
} from '@modules/toolset/services/official-toolsets.service';
import { snapshotOfDraft } from '@modules/toolset/services/version-writer';

/**
 * The official (platform) tool sets (plan B): Drafts, the slug rules, which
 * tools may sit in one, and publish v1 → v2 through the shared version writer.
 * The manager is an in-memory fake of the few `EntityManager` calls the
 * service makes, so every write goes through the transaction handle it is given.
 */
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

type Row = Record<string, unknown>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (cond instanceof FindOperator) {
      const operand = cond.value as unknown;
      if (cond.type === 'isNull') return value === null || value === undefined;
      if (cond.type === 'in') return (operand as unknown[]).includes(value);
      if (cond.type === 'moreThanOrEqual') return (value as Date) >= (operand as Date);
      throw new Error(`fake manager: unsupported operator ${cond.type}`);
    }
    return value === cond;
  });
}

function fakeManager() {
  const tables = new Map<unknown, Row[]>([
    [ToolsetEntity, []],
    [ToolsetEntryEntity, []],
    [ToolsetVersionEntity, []],
    [ToolEntity, []],
    [ToolVersionEntity, []],
  ]);
  const table = (entity: unknown) => tables.get(entity) as Row[];
  let ids = 100;
  const manager = {
    tables,
    find: async (
      entity: unknown,
      options: { where?: Row; order?: Record<string, string> } = {},
    ) => {
      const rows = table(entity).filter((row) => matches(row, options.where));
      const [key] = Object.keys(options.order ?? {});
      return key ? [...rows].sort((a, b) => Number(a[key]) - Number(b[key])) : rows;
    },
    findOne: async (entity: unknown, options: { where?: Row }) =>
      table(entity).find((row) => matches(row, options.where)) ?? null,
    count: async (entity: unknown, options: { where?: Row }) =>
      table(entity).filter((row) => matches(row, options.where)).length,
    save: async (entity: unknown, value: Row) => {
      const row: Row = {
        id: uuid((ids += 1)),
        listingStatus: null,
        graceVisibility: null,
        graceUntil: null,
        unlistedToken: null,
        removedAt: null,
        deletedAt: null,
        delistedAt: null,
        firstSharedAt: null,
        latestVersion: null,
        lastSharedVersion: null,
        lastPublicVersion: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...value,
      };
      table(entity).push(row);
      return row;
    },
    insert: async (entity: unknown, value: Row | Row[]) => {
      table(entity).push(...(Array.isArray(value) ? value : [value]).map((row) => ({ ...row })));
    },
    update: async (entity: unknown, where: Row, patch: Row) => {
      for (const row of table(entity).filter((candidate) => matches(candidate, where))) {
        Object.assign(row, patch);
      }
    },
    delete: async (entity: unknown, where: Row) => {
      tables.set(
        entity,
        table(entity).filter((row) => !matches(row, where)),
      );
    },
    query: async () => [],
  };
  return manager;
}

function build() {
  const manager = fakeManager();
  const tools: Row[] = [
    tool(1, 'get_weather', 'weather'),
    tool(2, 'geocode_place', 'maps'),
    tool(3, 'get_forecast', 'weather'),
    tool(4, 'unlisted_tool', 'weather', { visibility: 'UNLISTED' }),
    tool(5, 'draft_tool', 'weather', { status: 'DRAFT' }),
    tool(6, 'taken_down_tool', 'weather', { takenDownAt: new Date() }),
  ];
  manager.tables.get(ToolEntity)!.push(...tools);
  manager.tables
    .get(ToolVersionEntity)!
    .push(
      { toolId: uuid(1), version: 3, major: 2 },
      { toolId: uuid(2), version: 1, major: 1 },
      { toolId: uuid(3), version: 1, major: 1 },
    );
  const toolsets = manager.tables.get(ToolsetEntity)!;
  const repo = {
    findHolderOfSlug: async (owner: string | null, slug: string) =>
      toolsets.find(
        (row) =>
          row.ownerOrgId === owner &&
          row.slug === slug &&
          (row.deletedAt === null || row.firstSharedAt !== null),
      ) ?? null,
    slugsLike: async (owner: string | null, prefix: string) =>
      toolsets
        .filter((row) => row.ownerOrgId === owner && String(row.slug).startsWith(prefix))
        .map((row) => row.slug as string),
  };
  const epochs = { bumpShared: jest.fn(async () => undefined) };
  const notices = { onPublished: jest.fn(async () => 0) };
  let now = new Date('2026-10-26T12:00:00Z');
  const service = new OfficialToolsetsService(
    repo as never,
    epochs as never,
    { manager } as never,
    { mcpPublicUrl: 'https://mcp.example.com', webAppUrl: 'https://app.example.com' } as never,
    notices as never,
    () => now,
  );
  const m = manager as never;
  return {
    service,
    manager,
    m,
    epochs,
    notices,
    tick: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

function tool(n: number, name: string, category: string, extra: Row = {}): Row {
  return {
    id: uuid(n),
    name,
    category,
    kind: 'STANDARD',
    visibility: 'LISTED',
    status: 'ACTIVE',
    currentVersion: n === 1 ? 3 : 1,
    takenDownAt: null,
    handleRemovedAt: null,
    ...extra,
  };
}

const errorOf = async (work: () => Promise<unknown>) =>
  work().then(
    () => null,
    (error: { errorCode?: string; statusCode?: number; context?: Record<string, unknown> }) => ({
      code: error.errorCode,
      status: error.statusCode,
      context: error.context,
    }),
  );

const DRAFT = {
  slug: 'weather',
  name: 'Weather',
  toolIds: [uuid(1), uuid(2)],
  pinnedTools: ['get_weather'],
};

describe('OfficialToolsetsService — drafts', () => {
  it('creates a PRIVATE draft with no version: BEST entries on each tool’s current major', async () => {
    const { service, m } = build();
    const id = await service.createDraft(m, DRAFT);
    const dto = await service.get(id);

    expect(dto).toMatchObject({
      slug: 'weather',
      visibility: 'PRIVATE',
      latestVersion: null,
      publicUrl: null,
      draftChanged: true,
      slugLocked: false,
      // Inferred: the first of the most common categories.
      category: 'weather',
      pinnedTools: ['get_weather'],
    });
    expect(dto.entries.map((entry) => [entry.toolName, entry.toolVersionRange])).toEqual([
      ['get_weather', '^2'],
      ['geocode_place', '^1'],
    ]);
    expect(dto.entries[0].bindingCount).toBe(0);
  });

  it('answers 409 on a taken slug, with a free suggestion', async () => {
    const { service, m } = build();
    await service.createDraft(m, DRAFT);
    expect(await errorOf(() => service.createDraft(m, DRAFT))).toEqual({
      code: ToolsetErrorCode.TOOLSET_SLUG_TAKEN,
      status: 409,
      context: expect.objectContaining({ slug: 'weather', suggestion: 'weather-2' }),
    });
  });

  it.each([
    ['an unlisted tool', uuid(4)],
    ['a tool that is not active', uuid(5)],
    ['a taken-down tool', uuid(6)],
    ['an unknown tool', uuid(99)],
  ])('refuses %s', async (_label, toolId) => {
    const { service, m } = build();
    expect(
      await errorOf(() => service.createDraft(m, { ...DRAFT, toolIds: [uuid(1), toolId] })),
    ).toMatchObject({
      code: ToolsetErrorCode.TOOLSET_INVALID,
      status: 400,
      context: { toolIds: [toolId] },
    });
  });

  it('refuses an empty set and a tool listed twice', async () => {
    const { service, m } = build();
    expect(await errorOf(() => service.createDraft(m, { ...DRAFT, toolIds: [] }))).toMatchObject({
      code: ToolsetErrorCode.TOOLSET_INVALID,
    });
    expect(
      await errorOf(() => service.createDraft(m, { ...DRAFT, toolIds: [uuid(1), uuid(1)] })),
    ).toMatchObject({ code: ToolsetErrorCode.TOOLSET_INVALID });
  });

  it('pins at most 5 tools, and only tools of the set', async () => {
    const { service, m } = build();
    expect(
      await errorOf(() =>
        service.createDraft(m, { ...DRAFT, pinnedTools: ['a', 'b', 'c', 'd', 'e', 'f'] }),
      ),
    ).toMatchObject({ code: ToolsetErrorCode.TOOLSET_LIMIT_EXCEEDED, status: 429 });
    expect(
      await errorOf(() => service.createDraft(m, { ...DRAFT, pinnedTools: ['get_forecast'] })),
    ).toMatchObject({ code: ToolsetErrorCode.TOOLSET_INVALID, status: 400 });
  });

  it('updates the draft; a tool it drops stops being pinned, a kept one keeps its range', async () => {
    const { service, manager, m } = build();
    const id = await service.createDraft(m, DRAFT);
    // The tool's current major moved since it was added: the entry keeps ^2.
    manager.tables.get(ToolEntity)!.find((row) => row.id === uuid(1))!.currentVersion = 9;

    await service.updateDraft(m, id, { toolIds: [uuid(3), uuid(1)], name: 'Weather plus' });
    const dto = await service.get(id);
    expect(dto.name).toBe('Weather plus');
    expect(dto.entries.map((entry) => [entry.toolName, entry.toolVersionRange])).toEqual([
      ['get_forecast', '^1'],
      ['get_weather', '^2'],
    ]);

    await service.updateDraft(m, id, { toolIds: [uuid(3)] });
    expect((await service.get(id)).pinnedTools).toEqual([]);
  });
});

describe('OfficialToolsetsService — publish', () => {
  it('publishes v1 PUBLIC and LISTED at /@assay/{slug}; a v1 sends no update notice', async () => {
    const { service, manager, m, epochs, notices } = build();
    const id = await service.createDraft(m, DRAFT);
    const result = await service.publish(m, id);
    await service.afterPublish(result);

    expect(result).toMatchObject({ version: 1, changelog: 'First version: 2 tools.' });
    expect(await service.get(id)).toMatchObject({
      visibility: 'PUBLIC',
      listingStatus: 'LISTED',
      latestVersion: 1,
      draftChanged: false,
      slugLocked: true,
      publicUrl: 'https://mcp.example.com/@assay/weather',
    });
    const row = manager.tables.get(ToolsetEntity)!.find((t) => t.id === id)!;
    expect(row).toMatchObject({ lastPublicVersion: 1, lastSharedVersion: 1 });
    expect(manager.tables.get(ToolsetVersionEntity)).toEqual([
      expect.objectContaining({ toolsetId: id, version: 1, sharedAs: 'PUBLIC' }),
    ]);
    expect(epochs.bumpShared).toHaveBeenCalledTimes(1);
    expect(notices.onPublished).not.toHaveBeenCalled();
  });

  it('keeps serving v1 while the draft changes, then publishes v2 with a generated changelog', async () => {
    const { service, manager, m, notices } = build();
    const id = await service.createDraft(m, DRAFT);
    await service.publish(m, id);

    await service.updateDraft(m, id, { toolIds: [uuid(1), uuid(2), uuid(3)] });
    expect(await service.get(id)).toMatchObject({ latestVersion: 1, draftChanged: true });
    expect(manager.tables.get(ToolsetVersionEntity)).toHaveLength(1);

    const v2 = await service.publish(m, id, { changelog: '  ' });
    await service.afterPublish(v2);
    expect(v2).toMatchObject({ version: 2, changelog: 'Added get_forecast.' });
    expect(notices.onPublished).toHaveBeenCalledWith(id, 2);
  });

  it('locks the slug after the first publish', async () => {
    const { service, m } = build();
    const id = await service.createDraft(m, DRAFT);
    await service.updateDraft(m, id, { slug: 'weather-tools' });
    expect((await service.get(id)).slug).toBe('weather-tools');
    await service.publish(m, id);
    expect(await errorOf(() => service.updateDraft(m, id, { slug: 'other' }))).toEqual({
      code: ToolsetErrorCode.TOOLSET_SLUG_LOCKED,
      status: 409,
      context: undefined,
    });
  });

  it('refuses a publish whose draft changed after it was requested (P-13 hash)', async () => {
    const { service, m } = build();
    const id = await service.createDraft(m, DRAFT);
    const requested = await service.contentHash(m, id);

    await service.updateDraft(m, id, { name: 'Changed after the request' });
    expect(await errorOf(() => service.publish(m, id, { expectedHash: requested }))).toMatchObject({
      code: ToolsetErrorCode.TOOLSET_STATE,
      status: 409,
    });

    const now = await service.contentHash(m, id);
    expect(now).not.toBe(requested);
    expect((await service.publish(m, id, { expectedHash: now })).contentHash).toBe(now);
  });

  it('hashes the slug and the snapshot, nothing else', async () => {
    const { service, manager, m } = build();
    const id = await service.createDraft(m, DRAFT);
    const row = manager.tables.get(ToolsetEntity)!.find((t) => t.id === id)! as never;
    const snapshot = await snapshotOfDraft(m, row);
    expect(await service.contentHash(m, id)).toBe(officialDraftHash('weather', snapshot));
    // Tags change the live row at once and are not part of a version.
    await service.updateDraft(m, id, { tags: ['weather'] });
    expect(await service.contentHash(m, id)).toBe(officialDraftHash('weather', snapshot));
  });

  it('refuses a publish with nothing new, and one holding a tool no longer listed', async () => {
    const { service, manager, m } = build();
    const id = await service.createDraft(m, DRAFT);
    await service.publish(m, id);
    expect(await errorOf(() => service.publish(m, id))).toMatchObject({
      code: ToolsetErrorCode.TOOLSET_STATE,
      status: 409,
    });

    await service.updateDraft(m, id, { name: 'Renamed' });
    manager.tables.get(ToolEntity)!.find((row) => row.id === uuid(2))!.status = 'DEPRECATED';
    expect(await errorOf(() => service.assertPublishableNow(m, id))).toMatchObject({
      code: ToolsetErrorCode.TOOLSET_NOT_PUBLISHABLE,
      status: 400,
      context: { toolIds: [uuid(2)] },
    });
  });

  it('stays DELISTED when a delist stands: publishing is no way back into the catalogue', async () => {
    const { service, manager, m } = build();
    const id = await service.createDraft(m, DRAFT);
    await service.publish(m, id);
    Object.assign(manager.tables.get(ToolsetEntity)!.find((t) => t.id === id)!, {
      listingStatus: 'DELISTED',
      delistedAt: new Date(),
      graceVisibility: 'PUBLIC',
      graceUntil: new Date(Date.now() + 1000),
    });
    await service.updateDraft(m, id, { name: 'Fixed' });
    await service.publish(m, id);
    expect(await service.get(id)).toMatchObject({
      latestVersion: 2,
      listingStatus: 'DELISTED',
      delisted: true,
    });
  });

  it('is a 404 for an organization’s tool set', async () => {
    const { service, manager, m } = build();
    manager.tables
      .get(ToolsetEntity)!
      .push({ id: uuid(50), ownerOrgId: uuid(51), deletedAt: null });
    expect(await errorOf(() => service.publish(m, uuid(50)))).toMatchObject({
      code: ToolsetErrorCode.TOOLSET_NOT_FOUND,
      status: 404,
    });
    expect(await errorOf(() => service.get(uuid(50)))).toMatchObject({ status: 404 });
  });
});
