/**
 * Tool topics: the `category` a tool is filed under (`/c/{topic}`, the
 * catalogue's topic filter, `?category=` on an MCP URL). Pure.
 *
 * A provider tool picks one of {@link TOOL_TOPICS}, or a category a tool
 * already uses (so a tool filed before this list keeps saving). The list is
 * also every category name a handle may not take (`RESERVED_CATEGORY_NAMES`),
 * so a topic URL can never be pre-empted by a public name.
 *
 * ```text
 * weather · finance · maps · crypto · web · knowledge · search · news · social
 * data · code · chat · ai · media · commerce · travel · sports · health-care
 * other    the neutral topic: for an API that fits none of the above
 * ```
 */
export const TOOL_TOPICS: readonly string[] = Object.freeze([
  'weather',
  'finance',
  'maps',
  'crypto',
  'web',
  'knowledge',
  'search',
  'news',
  'social',
  'data',
  'code',
  'chat',
  'ai',
  'media',
  'commerce',
  'travel',
  'sports',
  'health-care',
  'other',
]);

/** The topic to suggest when none of the others fits. */
export const NEUTRAL_TOPIC = 'other';

/**
 * Every topic a tool may take: the fixed list first, in its order, then any
 * other category already in use (sorted), without duplicates.
 */
export function acceptedTopics(inUse: Iterable<string>): string[] {
  const fixed = new Set(TOOL_TOPICS);
  const extra = [...new Set(inUse)].filter((category) => !fixed.has(category)).sort();
  return [...TOOL_TOPICS, ...extra];
}

/** Null when `category` is accepted; otherwise the problem, naming the choices. */
export function topicProblem(category: string, inUse: Iterable<string>): string | null {
  const accepted = acceptedTopics(inUse);
  if (accepted.includes(category)) return null;
  return `category must be one of: ${accepted.join(', ')}`;
}
