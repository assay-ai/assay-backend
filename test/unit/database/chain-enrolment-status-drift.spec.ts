import { readFileSync } from 'fs';
import { join } from 'path';

import { ChainEnrolmentStatus } from '@modules/provider/ports/chain-enrolment.port';
import { ProviderStatus } from '@modules/provider/ports/provider.types';

/**
 * The chain-enrolment status vocabulary exists in **three** places, and nothing
 * derives any of them from the others.
 *
 * ```text
 * ChainEnrolmentStatus                    chain-enrolment.port.ts        TypeScript
 * chk_provider_chain_enrolments_status    1759300000001-…                DDL
 * ProviderStatus / chk_providers_status   provider.types.ts, 1756600000000  the SOURCE the backfill copies
 * ```
 *
 * They cannot be reduced to one: a CHECK constraint is SQL text inside a
 * migration that has already run in production and must never be edited, and a
 * TypeScript enum cannot be read by Postgres. So the agreement is asserted
 * instead, and it is asserted in **both** directions because the two ways of
 * breaking it fail differently and neither one is loud:
 *
 * - Widen `ProviderStatus` (and `chk_providers_status`) alone, and the
 *   enrolment backfill copies the new word into a column whose own CHECK refuses it —
 *   the migration dies on the next fresh environment, long after the change.
 * - Widen `chk_provider_chain_enrolments_status` alone, and
 *   `DbChainEnrolmentSource` stops recognising the new word: every provider
 *   carrying it is dropped from `enrolmentsOf`, which the router reads as "not
 *   enrolled on this chain". They stop being routed and stop earning. That path
 *   now raises a `CRITICAL` alert, but an alert about a market exit is a worse
 *   outcome than a red test before the deploy.
 *
 * The migrations are parsed rather than re-typed, for the reason
 * `column-widths.spec.ts` parses its own: a second hand-written list would be
 * kept in step by the same person who forgot to keep the first one in step.
 * `readFileSync` throwing is the point — delete or rename a migration and this
 * fails rather than passing vacuously.
 */
const MIGRATIONS = join(__dirname, '../../../src/database/postgres/migrations');

/** The `IN ('A', 'B', …)` list of a named CHECK constraint, out of a migration's own text. */
function checkVocabulary(migrationFile: string, constraint: string): string[] {
  const source = readFileSync(join(MIGRATIONS, migrationFile), 'utf8');
  const clause = new RegExp(
    `CONSTRAINT\\s+"${constraint}"\\s*(?:--[^\\n]*\\n\\s*)*CHECK\\s*\\(\\s*"[a-z_]+"\\s+IN\\s*\\(([^)]*)\\)`,
    'i',
  ).exec(source);

  if (!clause) {
    throw new Error(`${constraint} not found as an IN-list CHECK in ${migrationFile}`);
  }

  return [...clause[1].matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
}

describe('status vocabularies stay in step', () => {
  const enrolmentCheck = () =>
    checkVocabulary(
      '1759300000001-create-provider-chain-enrolments.ts',
      'chk_provider_chain_enrolments_status',
    );

  const providersCheck = () =>
    checkVocabulary('1756600000000-create-provider-registration-tables.ts', 'chk_providers_status');

  it('parses a real vocabulary out of each migration — the parser is not vacuous', () => {
    // Without this, a regex that silently matched nothing would make every
    // assertion below compare two empty lists and pass.
    expect(enrolmentCheck().length).toBeGreaterThan(0);
    expect(providersCheck().length).toBeGreaterThan(0);
  });

  it('ChainEnrolmentStatus is exactly chk_provider_chain_enrolments_status', () => {
    expect(Object.values(ChainEnrolmentStatus).sort()).toEqual(enrolmentCheck());
  });

  it('every ProviderStatus the backfill can copy is accepted by the enrolment CHECK', () => {
    // Subset, not equality: the enrolment's lifecycle is allowed to grow words
    // a provider never has. What it must never do is be NARROWER than the
    // column the backfill reads from — `SELECT p."status"` writes that value
    // straight into this column.
    const accepted = new Set(enrolmentCheck());
    expect(Object.values(ProviderStatus).filter((value) => !accepted.has(value))).toEqual([]);
  });

  it('ProviderStatus is exactly chk_providers_status — the source of the copy is itself pinned', () => {
    // Otherwise the subset check above could be satisfied by a TypeScript enum
    // that has drifted from the column it claims to describe.
    expect(Object.values(ProviderStatus).sort()).toEqual(providersCheck());
  });
});
