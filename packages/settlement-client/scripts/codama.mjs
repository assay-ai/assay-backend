/**
 * The one place the client is rendered from the IDL.
 *
 * `generate.mjs` writes the result into `src/generated/`; `check-generated.mjs`
 * renders it again and compares. Both call `render()` here so the CI gate and
 * the fixer cannot disagree about *how* the client is produced — if they could,
 * a red pipeline would be fixable by running a slightly different command, which
 * is the failure mode a drift gate exists to prevent.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { rootNodeFromAnchor } from '@codama/nodes-from-anchor';
import { renderVisitor } from '@codama/renderers-js';
import { createFromRoot } from 'codama';

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const IDL_PATH = join(PACKAGE_ROOT, 'idl', 'x402_payment.json');
export const GENERATED_DIR = join(PACKAGE_ROOT, 'src', 'generated');

/**
 * This repo's Prettier config, restated.
 *
 * Codama formats what it emits, so it has to be told the same rules as
 * `.prettierrc` — otherwise every generated file is one `yarn format` away from
 * a diff, and the drift gate starts firing on quote style instead of on the
 * program interface. Kept in sync by `check-generated.mjs`, which formats
 * nothing itself and would fail the moment these two drift apart.
 */
const PRETTIER_OPTIONS = {
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 100,
  tabWidth: 2,
  semi: true,
};

/**
 * Render the client into a scratch directory and return the path of the
 * `src/generated` tree inside it.
 *
 * Codama treats the path it is given as a package root — it writes
 * `<root>/src/generated/**` and a `<root>/package.json` of its own. Rendering
 * into the real package would therefore overwrite this package's manifest with
 * a stub called `js-client`. So it renders into a temp directory and the caller
 * takes only the subtree it wants.
 */
export async function render() {
  const idl = JSON.parse(readFileSync(IDL_PATH, 'utf8'));
  const scratch = mkdtempSync(join(tmpdir(), 'x402-client-'));

  const codama = createFromRoot(rootNodeFromAnchor(idl));
  await codama.accept(
    renderVisitor(scratch, { formatCode: true, prettierOptions: PRETTIER_OPTIONS }),
  );

  return {
    scratch,
    rendered: join(scratch, 'src', 'generated'),
    programAddress: idl.address,
    instructionCount: idl.instructions.length,
    accountCount: (idl.accounts ?? []).length,
  };
}
