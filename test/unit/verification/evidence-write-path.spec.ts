import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SRC = resolve(__dirname, '../../../src');

/**
 * There is exactly one way to mark a verdict judged, and it seals.
 *
 * The invariant `state = JUDGED ⟹ an evidence pack exists` is enforced today by
 * one transaction in one method. Nothing in the type system stops a second
 * caller appearing — a repair script, a backfill, an admin endpoint — and such
 * a caller would produce judged verdicts with no evidence *silently*, since
 * nothing reads the pack until someone disputes a charge weeks later.
 *
 * A database constraint cannot express this: the pack is inserted after the
 * UPDATE inside the same transaction, so any deferred check would have to run
 * at COMMIT, and Postgres has no deferred constraint spanning two tables that
 * would fire on the row's *state* rather than on a key.
 *
 * So the rule is executable here instead. Adding a second write path is
 * allowed; adding one without sealing is what this fails on, and the failure
 * is the conversation.
 */
describe('the only path that marks a verdict judged also seals its evidence', () => {
  const callers = sourceFiles(SRC).filter((file) =>
    readFileSync(file, 'utf8').includes('markJudgedIfPending('),
  );

  it('has exactly one production caller, in the settlement service', () => {
    const production = callers
      .map((file) => relative(SRC, file))
      .filter((file) => !file.startsWith('database/postgres/repositories'));

    expect(production).toEqual([
      'modules/verification/services/verification-settlement.service.ts',
    ]);
  });

  it('makes that call inside a transaction that also seals', () => {
    const source = readFileSync(
      join(SRC, 'modules/verification/services/verification-settlement.service.ts'),
      'utf8',
    );

    const block = transactionBlockAround(source, 'markJudgedIfPending(');
    expect(block).not.toBeNull();
    expect(block).toContain('sealer.seal(');
  });
});

/**
 * The text between `runInTransaction(` and the matching close paren, when the
 * needle is inside it.
 *
 * Brace-counting rather than a regex because the block spans lines and contains
 * its own parentheses; a regex here would either stop at the first `)` or match
 * the rest of the file.
 */
function transactionBlockAround(source: string, needle: string): string | null {
  const start = source.indexOf('runInTransaction(');
  if (start === -1) return null;

  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        const block = source.slice(start, i + 1);
        return block.includes(needle) ? block : null;
      }
    }
  }
  return null;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}
