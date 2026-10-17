/**
 * BM25 over tool documents, for `search_tools` (design spec §7.4).
 *
 * Pure and per request: the index is built over the tools the caller's view ∩
 * access already admitted, so nothing outside that set can ever score, and no
 * index outlives the request that built it.
 *
 * A document is a set of weighted fields. A field's weight repeats its terms,
 * the standard BM25F simplification: a query word in a tool's name counts for
 * more than the same word deep in an argument description.
 */

export interface SearchField {
  readonly text: string;
  /** How many times the field's terms count. At least 1. */
  readonly weight: number;
}

export interface SearchDocument<T> {
  readonly item: T;
  /** Breaks ties deterministically, so paging never repeats or skips a tool. */
  readonly key: string;
  readonly fields: readonly SearchField[];
}

export interface Ranked<T> {
  readonly item: T;
  readonly key: string;
  /** Rounded to 4 decimals for display; `0` when the query had no terms. */
  readonly score: number;
}

/** The usual BM25 constants. */
const K1 = 1.2;
const B = 0.75;

/**
 * Lowercased alphanumeric terms. `snake_case` and `kebab-case` split into
 * words, a short plural `s` is dropped (`prices` → `price`), and one-letter
 * terms are noise.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 1)
    .map(stem);
}

function stem(term: string): string {
  if (term.length > 3 && term.endsWith('s') && !term.endsWith('ss')) return term.slice(0, -1);
  return term;
}

/**
 * Every document that matches at least one query term, best first, ties by
 * `key`. An empty query (no terms) matches every document with score 0, in
 * `key` order: browsing a category is a search with no words.
 */
export function rankBm25<T>(query: string, documents: readonly SearchDocument<T>[]): Ranked<T>[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) {
    return [...documents]
      .sort((a, b) => compare(a.key, b.key))
      .map((doc) => ({ item: doc.item, key: doc.key, score: 0 }));
  }

  const bags = documents.map((doc) => termBag(doc.fields));
  const lengths = bags.map((bag) => bag.length);
  const averageLength = lengths.reduce((sum, length) => sum + length, 0) / (bags.length || 1) || 1;

  const documentFrequency = new Map<string, number>();
  for (const term of terms) {
    documentFrequency.set(term, bags.filter((bag) => bag.counts.has(term)).length);
  }

  const total = documents.length;
  const ranked: Ranked<T>[] = [];
  documents.forEach((doc, index) => {
    const bag = bags[index];
    let score = 0;
    for (const term of terms) {
      const frequency = bag.counts.get(term) ?? 0;
      if (frequency === 0) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      const norm = frequency + K1 * (1 - B + (B * bag.length) / averageLength);
      score += idf * ((frequency * (K1 + 1)) / norm);
    }
    if (score > 0) ranked.push({ item: doc.item, key: doc.key, score: round(score) });
  });

  return ranked.sort((a, b) => b.score - a.score || compare(a.key, b.key));
}

function termBag(fields: readonly SearchField[]): {
  counts: Map<string, number>;
  length: number;
} {
  const counts = new Map<string, number>();
  let length = 0;
  for (const field of fields) {
    const weight = Math.max(1, Math.floor(field.weight));
    for (const term of tokenize(field.text)) {
      counts.set(term, (counts.get(term) ?? 0) + weight);
      length += weight;
    }
  }
  return { counts, length };
}

function round(score: number): number {
  return Math.round(score * 10_000) / 10_000;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
