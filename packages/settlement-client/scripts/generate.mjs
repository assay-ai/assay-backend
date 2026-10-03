/**
 * Regenerate `src/generated/` from `idl/x402_payment.json`.
 *
 *     yarn client:generate            # from the backend root
 *
 * ## Why Codama and not @coral-xyz/anchor
 *
 * The backend is built on `@solana/kit` v7 and the `@solana-program/*` family,
 * which are themselves Codama output. Codama emits the same shape: tree-shakable
 * functions, `Address` rather than `PublicKey`, codecs rather than a `BorshCoder`,
 * and no `Provider`/`Wallet` object anywhere. `@coral-xyz/anchor` would bring a
 * second, incompatible key type and a transaction builder that wants to hold a
 * signer — into a codebase whose `SignerPort` exists precisely so that nothing
 * outside the port holds one.
 *
 * ## Why the output is committed
 *
 * The backend's CI has no Rust toolchain, so "generate at install time" would
 * mean the backend cannot build without a checkout of the contract repo and a
 * working `anchor`. Committing it also puts the program's interface into review:
 * a renamed account or a reordered argument shows up in the diff of the merge
 * request that caused it. `check-generated.mjs` is what keeps the committed copy
 * honest.
 */
import { cpSync, rmSync } from 'node:fs';

import { GENERATED_DIR, render } from './codama.mjs';

const { scratch, rendered, programAddress, instructionCount, accountCount } = await render();

try {
  // Removed rather than overwritten. Codama writes the files an IDL implies and
  // does not delete the ones it no longer implies, so an instruction dropped
  // from the program would leave its builder behind — still compiling, still
  // importable, and still encoding a discriminator the deployed program no
  // longer answers to. A removal has to reach the client as a removal.
  rmSync(GENERATED_DIR, { recursive: true, force: true });
  cpSync(rendered, GENERATED_DIR, { recursive: true });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`program      ${programAddress}`);
console.log(`instructions ${instructionCount}`);
console.log(`accounts     ${accountCount}`);
console.log(`written to   ${GENERATED_DIR}`);
console.log('');
console.log('Commit the result. `yarn client:check` is the CI gate that requires it.');
