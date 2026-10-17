import { DataSource } from 'typeorm';

/**
 * Official (platform) tool sets for local and e2e stacks, so the catalogue's
 * "Tool sets" tab is not empty (design spec §7.10, §7.12). Served at
 * `/@assay/{slug}`.
 *
 * Idempotent: a set that already exists is left as it is — an operator's or a
 * test's later edits are never undone by a re-run. Tools missing from `tools`
 * (a catalogue seed without them) are skipped, and a set left with no tool is
 * not created.
 */
export interface OfficialToolsetSeed {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly icon: string;
  readonly tags: readonly string[];
  readonly tools: readonly string[];
  readonly pinned: readonly string[];
}

export const OFFICIAL_TOOLSETS: readonly OfficialToolsetSeed[] = [
  {
    slug: 'weather-and-places',
    name: 'Weather and places',
    description: 'Current weather for any place, and the coordinates of a place name.',
    category: 'weather',
    icon: 'weather',
    tags: ['weather', 'maps'],
    tools: ['get_weather', 'geocode_place'],
    pinned: ['get_weather'],
  },
  {
    slug: 'crypto-research',
    name: 'Crypto research',
    description: 'Token market data, Solana balances and the USD/EUR rate.',
    category: 'crypto',
    icon: 'crypto',
    tags: ['crypto', 'finance'],
    tools: ['get_token_market', 'solana_get_balance', 'get_usd_eur_rate'],
    pinned: ['get_token_market'],
  },
  {
    slug: 'web-research',
    name: 'Web research',
    description: 'Read the text of a web page and search Wikipedia.',
    category: 'knowledge',
    icon: 'search',
    tags: ['web', 'knowledge'],
    tools: ['extract_page_text', 'search_wikipedia'],
    pinned: [],
  },
];

/** Returns how many sets were created by this run. */
export async function seedOfficialToolsets(
  dataSource: DataSource,
  seeds: readonly OfficialToolsetSeed[] = OFFICIAL_TOOLSETS,
): Promise<number> {
  let created = 0;
  for (const seed of seeds) {
    const exists = (await dataSource.query(
      `SELECT 1 FROM toolsets WHERE owner_org_id IS NULL AND slug = $1 LIMIT 1`,
      [seed.slug],
    )) as unknown[];
    if (exists.length > 0) continue;

    const tools = (await dataSource.query(
      `SELECT id, name FROM tools WHERE name = ANY($1) AND visibility = 'LISTED' AND status = 'ACTIVE'`,
      [[...seed.tools]],
    )) as { id: string; name: string }[];
    const ordered = seed.tools.flatMap((name) => tools.filter((tool) => tool.name === name));
    if (ordered.length === 0) continue;
    const names = new Set(ordered.map((tool) => tool.name));
    const pinned = seed.pinned.filter((name) => names.has(name));

    await dataSource.transaction(async (manager) => {
      const [toolset] = (await manager.query(
        `INSERT INTO toolsets (owner_org_id, publisher_kind, slug, name, description, category,
                               tags, icon, visibility, listing_status, discovery, pinned_tools,
                               latest_version, last_shared_version, last_public_version, first_shared_at)
         VALUES (NULL, 'PLATFORM', $1, $2, $3, $4, $5, $6, 'PUBLIC', 'LISTED', 'AUTO', $7,
                 1, 1, 1, now())
         RETURNING id`,
        [seed.slug, seed.name, seed.description, seed.category, [...seed.tags], seed.icon, pinned],
      )) as { id: string }[];
      for (const [position, tool] of ordered.entries()) {
        await manager.query(
          `INSERT INTO toolset_entries (toolset_id, position, tool_id) VALUES ($1, $2, $3)`,
          [toolset.id, position, tool.id],
        );
      }
      const entries = ordered.map((tool) => ({
        toolId: tool.id,
        toolName: tool.name,
        providerMode: 'BEST',
        providerIds: [],
        minTier: null,
        maxPrice: null,
        minQuality: null,
        requireOutputFields: [],
        onEmpty: 'FAIL',
      }));
      await manager.query(
        `INSERT INTO toolset_versions (toolset_id, version, entries, tool_ids, discovery,
                                       search_threshold, pinned_tools, name, description, icon,
                                       changelog, shared_as)
         VALUES ($1, 1, $2::jsonb, $3::uuid[], 'AUTO', 25, $4, $5, $6, $7, $8, 'PUBLIC')`,
        [
          toolset.id,
          JSON.stringify(entries),
          ordered.map((tool) => tool.id),
          pinned,
          seed.name,
          seed.description,
          seed.icon,
          `First version: ${ordered.length} tools.`,
        ],
      );
    });
    created += 1;
  }
  return created;
}
