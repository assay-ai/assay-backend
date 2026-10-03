import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ChainNamespace } from '@modules/chains/ports/caip.types';

/**
 * Every namespace has a **behaviour** spec, not only a contract spec.
 *
 * ## Why this file exists beside `registry-coverage.spec.ts`
 *
 * That file demands `<ns>-adapter.contract.spec.ts` per namespace and stops
 * there — and the shared contract suite, by construction, cannot see
 * cryptography, a signed binding, a real vault derivation or real address
 * validation. It is forbidden from naming `0x`, EIP-55, a memo or a `Deposited`
 * event, because it is the one file that must be true of every chain.
 *
 * That is not a theory. A review wrote a degenerate adapter — keyless
 * `sha256(tag | JSON | signer)` for signing, `payload.bound === true` for the
 * binding, an identity vault, a constant `observeTransfer` — and it passed
 * **22/22 assertions and 92/92 cases on its first run**; hardened, the suite
 * killed 17 of 114 and a *weaker* degenerate still passed everything. Measured
 * again against the `eip155` adapter: 115/115 and 22/22, first try.
 *
 * So the contract spec is the floor, and the behaviour spec is the second half
 * of one requirement. Until this file existed, nothing kept the second half
 * alive: the next refactor could delete every behaviour spec in the tree and
 * all of `registry-coverage.spec.ts`, `chain-adapter.contract.ts` and
 * `nest build` would stay green.
 *
 * ## What it can and cannot check
 *
 * It checks that a behaviour spec **exists**, is named by the convention, and
 * actually exercises the namespace's adapter. It cannot check that the spec is
 * *good* — no file-system gate can. What it buys is that deleting the spec, or
 * hollowing it into a stub, is a red test rather than a silent widening of the
 * gap this whole file documents.
 *
 * ## The naming convention is deliberately different from the contract one
 *
 * `*-chain.adapter.spec.ts` — beside the implementation's own name, so a reader
 * looking at `evm-chain.adapter.ts` finds `evm-chain.adapter.spec.ts` without
 * being told it exists. A namespace may split its behaviour spec across several
 * files (`eip155` has four); the roof file is the one this convention names,
 * and it is required to point at the rest.
 */
describe('every chain namespace has a behaviour spec', () => {
  /**
   * Where each namespace's behaviour specs live.
   *
   * Typed as an exhaustive `Record` on purpose: adding a member to
   * `ChainNamespace` fails to compile here until somebody says where its
   * behaviour spec is, which is the same moment `registry-coverage.spec.ts`
   * starts demanding its contract spec.
   */
  const ROOTS: Readonly<Record<ChainNamespace, string>> = {
    [ChainNamespace.SOLANA]: __dirname,
    [ChainNamespace.EIP155]: join(__dirname, 'evm'),
  };

  /** The class each namespace's behaviour spec has to be exercising. */
  const ADAPTERS: Readonly<Record<ChainNamespace, string>> = {
    [ChainNamespace.SOLANA]: 'SolanaChainAdapter',
    [ChainNamespace.EIP155]: 'EvmChainAdapter',
  };

  const behaviourSpecsIn = (root: string): readonly string[] =>
    readdirSync(root).filter((file) => file.endsWith('-chain.adapter.spec.ts'));

  it('the scan finds the specs it is meant to find', () => {
    // Without this, a directory rename empties every listing and every
    // expectation below is vacuously true — the exact shape that made
    // `registry-coverage.spec.ts` grow the same guard.
    for (const root of Object.values(ROOTS)) {
      expect(readdirSync(root).length).toBeGreaterThan(0);
    }
  });

  it.each(Object.values(ChainNamespace))('%s has a behaviour spec', (namespace) => {
    expect(behaviourSpecsIn(ROOTS[namespace]).length).toBeGreaterThan(0);
  });

  it.each(Object.values(ChainNamespace))(
    '%s’s behaviour spec exercises the adapter itself',
    (namespace) => {
      // A file named by the convention that imports nothing satisfies the case
      // above. This one asks for the adapter class by name and for at least one
      // assertion — the cheapest floor that a stub cannot clear, and the most
      // this gate can honestly claim.
      const files = behaviourSpecsIn(ROOTS[namespace]);
      const sources = files.map((file) => readFileSync(join(ROOTS[namespace], file), 'utf8'));

      expect(sources.some((source) => source.includes(ADAPTERS[namespace]))).toBe(true);
      expect(sources.some((source) => source.includes('expect('))).toBe(true);
    },
  );
});
