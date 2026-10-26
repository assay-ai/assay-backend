import { DataSource } from 'typeorm';

import { OfficialToolsetsService } from '@modules/toolset/services/official-toolsets.service';

/**
 * Official (platform) tool sets for local and e2e stacks, so the catalogue's
 * "Tool sets" tab is not empty (design spec §7.10, §7.12). Served at
 * `/@assay/{slug}`.
 *
 * Written through `OfficialToolsetsService`, the one writer of official sets
 * (the operator console's P-13 publishes through it too): a Draft, then its
 * first version, in one transaction. The seed skips the two-person approval
 * the console requires, so it refuses to run with `NODE_ENV=production`.
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
  official: OfficialToolsetsService,
  seeds: readonly OfficialToolsetSeed[] = OFFICIAL_TOOLSETS,
): Promise<number> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'official tool sets are published by operators in production (P-13, two-person); ' +
        'this seed does not run there',
    );
  }
  let created = 0;
  for (const seed of seeds) {
    if (await official.idOfSlug(seed.slug)) continue;

    // Only tools an official set may hold; the service checks again.
    const tools = (await dataSource.query(
      `SELECT id, name FROM tools
        WHERE name = ANY($1) AND visibility = 'LISTED' AND status = 'ACTIVE'
          AND taken_down_at IS NULL AND handle_removed_at IS NULL`,
      [[...seed.tools]],
    )) as { id: string; name: string }[];
    const ordered = seed.tools.flatMap((name) => tools.filter((tool) => tool.name === name));
    if (ordered.length === 0) continue;
    const names = new Set(ordered.map((tool) => tool.name));

    const published = await dataSource.transaction(async (manager) => {
      const id = await official.createDraft(manager, {
        slug: seed.slug,
        name: seed.name,
        description: seed.description,
        category: seed.category,
        tags: seed.tags,
        icon: seed.icon,
        toolIds: ordered.map((tool) => tool.id),
        pinnedTools: seed.pinned.filter((name) => names.has(name)),
      });
      return official.publish(manager, id);
    });
    await official.afterPublish(published);
    created += 1;
  }
  return created;
}
