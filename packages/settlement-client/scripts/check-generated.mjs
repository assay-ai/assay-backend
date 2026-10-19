/**
 * CI gate: `src/generated/` is what `idl/assay_payment.json` renders to.
 *
 *     yarn client:check              # from the backend root
 *
 * Renders the client again into a scratch directory and compares the two trees
 * file-by-file. Exits non-zero on any difference, including a file that exists
 * on one side and not the other — a deleted instruction has to reach the client
 * as a deletion, and a comparison that only walked the committed tree would miss
 * exactly that.
 *
 * This is the second of the three drift gates:
 *
 *     program source -> IDL          scripts/check-idl-sync.sh (assay-solana)
 *     IDL            -> client       this file
 *     contract IDL   -> vendored IDL an IDL pin check outside this repository
 *
 * One hop each, so a red pipeline names the hop that broke rather than telling
 * somebody that "the client is wrong".
 */
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';

import { GENERATED_DIR, PACKAGE_ROOT, render } from './codama.mjs';

function walk(root, prefix = '') {
  const files = new Map();
  let entries;
  try {
    entries = readdirSync(join(root, prefix), { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = join(prefix, entry.name);
    if (entry.isDirectory()) {
      for (const [key, value] of walk(root, rel)) {
        files.set(key, value);
      }
    } else {
      files.set(rel, readFileSync(join(root, rel), 'utf8'));
    }
  }
  return files;
}

function firstDifferingLine(a, b) {
  const left = a.split('\n');
  const right = b.split('\n');
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if (left[i] !== right[i]) {
      return {
        line: i + 1,
        committed: left[i] ?? '<end of file>',
        expected: right[i] ?? '<end of file>',
      };
    }
  }
  return null;
}

const { scratch, rendered, programAddress, instructionCount } = await render();

let committed;
let fresh;
try {
  committed = walk(GENERATED_DIR);
  fresh = walk(rendered);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (committed.size === 0) {
  console.error('FAIL: src/generated/ is empty or missing. Run `yarn client:generate`.');
  process.exit(1);
}

const problems = [];
for (const [path, expected] of fresh) {
  if (!committed.has(path)) {
    problems.push(`missing   src/generated/${path} — the IDL implies it, the tree does not have it`);
    continue;
  }
  const actual = committed.get(path);
  if (actual !== expected) {
    const at = firstDifferingLine(actual, expected);
    problems.push(
      `changed   src/generated/${path}\n` +
        `            line ${at.line}\n` +
        `            committed: ${at.committed.trim()}\n` +
        `            expected:  ${at.expected.trim()}`,
    );
  }
}
for (const path of committed.keys()) {
  if (!fresh.has(path)) {
    problems.push(`orphan    src/generated/${path} — nothing in the IDL renders to it any more`);
  }
}

const where = relative(process.cwd(), PACKAGE_ROOT) || '.';

if (problems.length === 0) {
  console.log(`OK: ${where}/src/generated matches ${where}/idl/assay_payment.json`);
  console.log(`    program ${programAddress}, ${instructionCount} instructions, ${fresh.size} files`);
  process.exit(0);
}

console.error(`FAIL: the generated client does not match the IDL it claims to come from.

The IDL was updated without regenerating the client, or the generated tree was
hand-edited. Either way the backend is now building instructions against an
interface the program does not have.

Fix:
    yarn client:generate
and commit ${where}/src/generated.

${problems.length} difference(s):
`);
for (const problem of problems.slice(0, 25)) {
  console.error(`  ${problem}`);
}
if (problems.length > 25) {
  console.error(`  ... and ${problems.length - 25} more`);
}
process.exit(1);
