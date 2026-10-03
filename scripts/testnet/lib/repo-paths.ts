/// <reference types="node" />
// ^ REQUIRED, and it is not decoration. `tsconfig.json` sets `"types": []`, so ts-node loads no
// ambient @types at all; every other script under `scripts/` gets node's globals by accident,
// through a `/// <reference types="node" />` inside some .d.ts of Nest or TypeORM that it
// happens to import. This file imports nothing but its own siblings, so it gets none — and
// `yarn testnet:acceptance` dies at compile time with eleven "Cannot find name 'process'".
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** The backend repository root, from this file. */
export const BACKEND_DIR = resolve(__dirname, '../../..');

/**
 * A checkout of the `assay-evm` repository (the Foundry project), which the testnet
 * acceptance suite runs `forge` in and reads `deployments/<chainId>.json` from.
 *
 * Set `X402_EVM_DIR` to it. Without it this tries `../assay-evm` and `../evm` next to the
 * backend, and **throws naming every candidate** rather than returning a guess: a check that
 * passes when it cannot find its input is the failure this harness exists to refuse.
 */
export function evmDir(): string {
  const override = process.env.X402_EVM_DIR;
  const candidates = [
    ...(override ? [resolve(override)] : []),
    resolve(BACKEND_DIR, '../assay-evm'),
    resolve(BACKEND_DIR, '../evm'),
  ];
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, 'foundry.toml'))) return candidate;
  }
  throw new Error(
    'could not locate the assay-evm checkout. Tried:\n  ' +
      candidates.join('\n  ') +
      '\nSet X402_EVM_DIR to it. This is thrown rather than skipped on purpose: a check ' +
      'that passes when it cannot find its input is the failure this harness exists to ' +
      'refuse.',
  );
}

/** The acceptance criteria document, which lives in this repository. */
export function specPath(): string {
  return resolve(BACKEND_DIR, 'docs/acceptance-criteria.md');
}
