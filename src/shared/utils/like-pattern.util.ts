/**
 * A `%term%` pattern for `LIKE`/`ILIKE` that matches `term` literally.
 *
 * `%` and `_` are wildcards and `\` is PostgreSQL's default LIKE escape, so a
 * search for `50%` or `a_b` must escape them, or `_` matches any character and
 * a lone `%` matches every row.
 */
export function containsLikePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}
