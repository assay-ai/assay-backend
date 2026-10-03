import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ChainNamespace } from '@modules/chains/ports/caip.types';

/**
 * Every namespace `ChainNamespace` declares has a contract spec, or this fails.
 *
 * ## What it is actually guarding
 *
 * The suite in `chain-adapter.contract.ts` is worthless if the next adapter
 * ships without being run through it — and nothing about adding a class to
 * `CHAIN_ADAPTERS` reminds anyone to. This is the reminder, and it fires at the
 * moment `ChainNamespace.EIP155` acquires an implementation rather than at
 * review time.
 *
 * ## Why it reads the enum and not CHAIN_ADAPTERS
 *
 * `CHAIN_ADAPTERS` is a DI token whose value depends on `ENABLED_CHAINS`, so a
 * check against it would pass on a deployment that simply has the second chain
 * switched off. The enum is the honest
 * subject: a namespace exists in the type system from the moment somebody adds
 * it, and that is when the spec is owed.
 */
describe('every chain namespace has a contract spec', () => {
  const specs = readdirSync(join(__dirname)).filter((file) =>
    file.endsWith('-adapter.contract.spec.ts'),
  );

  /**
   * Empty since the EVM adapter landed. Every namespace `ChainNamespace` declares now has a
   * contract spec, which is what this file existed to make true.
   *
   * The list stays rather than being deleted: the next namespace somebody adds
   * to the enum fails the check below on the day it is added, and an empty
   * exception list is what makes "there is nowhere to hide it" visible.
   */
  const AWAITING_AN_ADAPTER: readonly ChainNamespace[] = [];

  it('the scan finds the specs it is meant to find', () => {
    // Without this, a rename of the naming convention would empty `specs` and
    // every expectation below would be vacuously true for the namespaces on the
    // exception list — which is the whole file.
    expect(specs.length).toBeGreaterThan(0);
  });

  it.each(Object.values(ChainNamespace).filter((n) => !AWAITING_AN_ADAPTER.includes(n)))(
    '%s has an adapter contract spec',
    (namespace) => {
      expect(specs).toContain(`${namespace}-adapter.contract.spec.ts`);
    },
  );

  it('the awaiting list names only namespaces that genuinely have no adapter', () => {
    // Stops the exception list from outliving the exception: the day somebody
    // writes `eip155-adapter.contract.spec.ts` and leaves this line in place,
    // the exception is silently excusing a namespace that no longer needs it.
    for (const namespace of AWAITING_AN_ADAPTER) {
      expect(specs).not.toContain(`${namespace}-adapter.contract.spec.ts`);
    }
  });
});
