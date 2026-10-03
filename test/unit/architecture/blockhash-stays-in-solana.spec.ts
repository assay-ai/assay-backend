import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../../..');
const TREES = ['src', 'test', 'scripts'].map((tree) => join(ROOT, tree));
const SOLANA_DIR = join(ROOT, 'src/modules/chains/solana');

/**
 * The two directories allowed to spell these names, and no others.
 *
 * The second is the unit-test mirror of the first. `SolanaDepositRequirementsBuilder`
 * is the port's one injector and it has a test; that test constructs it with a
 * stub and therefore has to name the port's type. Excluding the mirror is not a
 * widening of the rule — a spec cannot wire a provider into an application —
 * and it is narrower than the alternative, which would be exempting `test/`.
 *
 * The vacuity half below deliberately anchors on {@link SOLANA_DIR} alone, so
 * deleting the port from `src/` cannot be masked by a test file that still
 * mentions it.
 */
const ALLOWED_DIRS = [SOLANA_DIR, join(ROOT, 'test/unit/chains/solana')];

/** This file itself. It names the forbidden identifiers, in prose and in fixtures. */
const SELF = join(ROOT, 'test/unit/architecture/blockhash-stays-in-solana.spec.ts');

/**
 * The forbidden names, assembled from parts.
 *
 * Spelled out, this file would match itself on every rule and would need an
 * exemption per rule — and an exemption is a hole somebody later widens. Built
 * from fragments, the guard's own source contains none of the strings it looks
 * for, so the self-path exclusion above is belt as well as braces: the prose in
 * this file deliberately says "the blockhash reader port" rather than spelling
 * the identifier, so removing either protection alone still leaves the scan
 * honest.
 */
const NAMES = [
  ['Blockhash', 'ReaderPort'].join(''),
  ['BLOCKHASH', 'READER'].join('_'),
  ['Blockhash', 'Reading'].join(''),
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/**
 * The blockhash reader port stays a Solana port under `chains/solana/` and is
 * not a domain concept. Nothing outside `chains/solana/` names it.
 *
 * ## Why a source lock and not a type
 *
 * There is no input that makes a MISPLACED port observable. A blockhash reader
 * injected into a controller compiles, passes every unit test, and serves
 * correct responses — it is wrong architecturally and in no other way. The
 * defect becomes visible the day an EVM deposit path has to implement
 * `getLatestBlockhash()` by returning `null`, which is the day it costs the
 * most. A source-level guard is the only one that reaches code nobody has
 * written yet.
 *
 * ## Why it scans three trees
 *
 * `yarn lint` globs `{src,test}` and `eslint.config.mjs` ignores `scripts/**`;
 * `nest build` compiles `src/` only. `scripts/devnet/deposit.ts` reads the
 * deposit response and is exactly the kind of file that would reach for this
 * port. Three times during multichain work a rename left `scripts/` unbuildable with no gate
 * noticing. This one notices.
 */
describe('the blockhash port stays inside chains/solana', () => {
  const files = TREES.flatMap(walk).filter(
    (file) => (file.endsWith('.ts') || file.endsWith('.mts')) && file !== SELF,
  );

  it('the scan reads the real trees', () => {
    // `walk` returning `[]` — a moved directory, a renamed `src` — would leave
    // every rule below trivially satisfied and silent about it.
    expect(files.length).toBeGreaterThan(400);
    expect(files).toContain(join(ROOT, 'src/modules/payment/controllers/deposits.controller.ts'));
    expect(files).toContain(join(ROOT, 'scripts/devnet/deposit.ts'));
  });

  it.each(NAMES)('no file outside chains/solana names %s', (name) => {
    const offenders = files
      .filter((file) => !ALLOWED_DIRS.some((dir) => file.startsWith(dir)))
      .filter((file) => readFileSync(file, 'utf8').includes(name))
      .map((file) => relative(ROOT, file));

    expect(offenders).toEqual([]);
  });

  it.each(NAMES)('%s is present inside chains/solana, so the scan is not vacuous', (name) => {
    // The other half. A rule satisfied by the absence of its subject is not a
    // rule: if the port were deleted outright, every assertion above would pass
    // and this suite would say the architecture holds.
    const inside = files
      .filter((file) => file.startsWith(SOLANA_DIR))
      .filter((file) => readFileSync(file, 'utf8').includes(name));

    expect(inside.length).toBeGreaterThan(0);
  });

  it('the port file is under chains/solana, and the old one is gone', () => {
    expect(files).toContain(join(SOLANA_DIR, 'blockhash.port.ts'));
    expect(files).not.toContain(join(ROOT, 'src/modules/payment/ports/blockhash.types.ts'));
  });
});
