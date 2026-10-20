import { parseProviderToolName } from '@modules/tool/domain/provider-tool-name';

/**
 * Which provider tools do the same job (design spec §7.5 "Promotion": "when
 * two or more provider tools do the same job, an operator drafts a standard
 * contract"). A deliberately simple heuristic, pure, that only suggests: the
 * operator decides.
 *
 * Two tools are compared only within one category, on three token sets:
 *
 * ```text
 * name      the {tool} half of `{handle}__{tool}`, split on "_"   weight 0.4
 * inputs    the input schema's property names                     weight 0.3
 * outputs   the output schema's property names                    weight 0.3
 * ```
 *
 * each scored by Jaccard similarity. Tokens are lowercased and singular
 * (a trailing "s" dropped), and words that say nothing about the job
 * (`get`, `the`, `by`, …) are left out of the name.
 */

export interface SimilarityInput {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly inputFields: readonly string[];
  readonly outputFields: readonly string[];
}

export interface SimilarityScore {
  readonly score: number;
  readonly name: number;
  readonly inputs: number;
  readonly outputs: number;
}

/** Suggested as similar from this score. */
export const SIMILARITY_THRESHOLD = 0.4;

const WEIGHTS = { name: 0.4, inputs: 0.3, outputs: 0.3 } as const;

const STOP_WORDS = new Set([
  'get',
  'fetch',
  'list',
  'find',
  'the',
  'a',
  'an',
  'by',
  'for',
  'of',
  'to',
  'v1',
  'v2',
  'api',
]);

/** `search_tweets` → `search`, `tweet`; `apiKey` → `api`, `key`. */
export function tokensOf(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase())
    .map((token) => (token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token));
}

/** The words of a tool's own name that say what it does. */
export function nameTokens(name: string): string[] {
  const local = parseProviderToolName(name)?.local ?? name;
  return tokensOf(local).filter((token) => !STOP_WORDS.has(token));
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 && right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** How alike two tools are, 0..1; 0 across categories. */
export function similarity(a: SimilarityInput, b: SimilarityInput): SimilarityScore {
  if (a.category !== b.category) return { score: 0, name: 0, inputs: 0, outputs: 0 };
  const name = jaccard(nameTokens(a.name), nameTokens(b.name));
  const inputs = jaccard(a.inputFields.flatMap(tokensOf), b.inputFields.flatMap(tokensOf));
  const outputs = jaccard(a.outputFields.flatMap(tokensOf), b.outputFields.flatMap(tokensOf));
  const score = WEIGHTS.name * name + WEIGHTS.inputs * inputs + WEIGHTS.outputs * outputs;
  return { score: round(score), name: round(name), inputs: round(inputs), outputs: round(outputs) };
}

/** Every other tool at or above the threshold, most similar first. */
export function similarTo(
  source: SimilarityInput,
  candidates: readonly SimilarityInput[],
  threshold = SIMILARITY_THRESHOLD,
): { readonly tool: SimilarityInput; readonly similarity: SimilarityScore }[] {
  return candidates
    .filter((candidate) => candidate.id !== source.id)
    .map((candidate) => ({ tool: candidate, similarity: similarity(source, candidate) }))
    .filter((entry) => entry.similarity.score >= threshold)
    .sort(
      (a, b) => b.similarity.score - a.similarity.score || a.tool.name.localeCompare(b.tool.name),
    );
}

/**
 * Groups of two or more similar tools (single-link within one category):
 * the operator's "these do the same job" list.
 */
export function similarGroups(
  tools: readonly SimilarityInput[],
  threshold = SIMILARITY_THRESHOLD,
): SimilarityInput[][] {
  const parent = new Map(tools.map((tool) => [tool.id, tool.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    parent.set(id, root);
    return root;
  };
  for (let i = 0; i < tools.length; i += 1) {
    for (let j = i + 1; j < tools.length; j += 1) {
      if (similarity(tools[i], tools[j]).score >= threshold) {
        parent.set(find(tools[i].id), find(tools[j].id));
      }
    }
  }
  const groups = new Map<string, SimilarityInput[]>();
  for (const tool of tools) {
    const root = find(tool.id);
    groups.set(root, [...(groups.get(root) ?? []), tool]);
  }
  return [...groups.values()]
    .filter((group) => group.length >= 2)
    .map((group) => [...group].sort((a, b) => a.name.localeCompare(b.name)))
    .sort((a, b) => b.length - a.length || a[0].name.localeCompare(b[0].name));
}

/** Top-level property names of a JSON schema. */
export function fieldsOf(schema: unknown): string[] {
  const properties = (schema as { properties?: unknown } | null)?.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return [];
  return Object.keys(properties as Record<string, unknown>);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
