import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LEDGER_ENTRY_EFFECTS } from '@modules/ledger/domain/ledger-entry-effect';
import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';

/**
 * `uq_ledger_entries_deposit_resolution` against the entry types it has to
 * cover, derived from `LEDGER_ENTRY_EFFECTS` rather than retyped.
 *
 * ## Why this index exists at all
 *
 * Until the Helius watcher landed, exactly one writer resolved a deposit — the
 * five-minute sweep — and its guard was a `readJournal` check inside
 * `DepositFinalityService`. That guard is read-then-write, and its own comment
 * conceded the gap: *"nothing in the database would stop it if this check went
 * away"*. One writer made the race unreachable; it was never absent.
 *
 * The watcher is a second writer on the same rows. Two triggers landing
 * together both read "not yet resolved" and both write `DEPOSIT_CONFIRM` — the
 * buyer is credited twice for one transfer. A read cannot fix a read-then-write
 * race; only the database can, so the invariant moves into the schema:
 *
 * > **one resolution per on-chain signature**, whichever writer gets there
 * > first and whichever way it resolves.
 *
 * ## Why it is keyed on the signature, not the intent
 *
 * `chain_tx_ref` is a Solana signature, which is globally unique — so this
 * refuses a second credit even if the same transfer were somehow reached
 * through two different intents or two different organizations. Keying on
 * `(organization_id, intent_id)` would police only the narrower claim.
 *
 * ## Why the predicate names the entry types
 *
 * `DEPOSIT_PENDING` carries the *same* `chain_tx_ref` as the resolution that
 * follows it — the settle path writes it there. An index over the signature
 * alone would refuse the confirm because the pending row already holds that
 * value, which is why the partial predicate is load-bearing rather than an
 * optimisation.
 */
const MIGRATION = join(
  __dirname,
  '../../../src/database/postgres/migrations/1758200000000-deposit-resolution-uniqueness.ts',
);

/**
 * The entry types that *resolve* a deposit, derived from the effect table:
 * a deposit entry that moves `pending` off the account and is not the one that
 * put it there.
 */
const RESOLVING_TYPES = Object.entries(LEDGER_ENTRY_EFFECTS)
  .filter(
    ([type, effect]) =>
      type.startsWith('DEPOSIT_') && type !== LedgerEntryType.DEPOSIT_PENDING && effect.pending < 0,
  )
  .map(([type]) => type)
  .sort();

describe('uq_ledger_entries_deposit_resolution', () => {
  const sql = readFileSync(MIGRATION, 'utf8');

  it('covers every entry type that resolves a deposit, and no other', () => {
    // Guards the derivation itself: an empty set would make every assertion
    // below vacuously true.
    expect(RESOLVING_TYPES).toEqual(['DEPOSIT_CONFIRM', 'DEPOSIT_REJECT']);

    const predicate = sql.slice(sql.indexOf('CREATE UNIQUE INDEX'));
    for (const type of RESOLVING_TYPES) {
      expect(predicate).toContain(`'${type}'`);
    }
    expect(predicate).not.toContain(`'${LedgerEntryType.DEPOSIT_PENDING}'`);
  });

  it('is keyed on the signature alone, so one transfer can resolve once', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "uq_ledger_entries_deposit_resolution"\s+ON "ledger_entries" \("chain_tx_ref"\)/,
    );
  });

  it('excludes rows with no signature, which carry no claim to be unique about', () => {
    expect(sql).toContain('"chain_tx_ref" IS NOT NULL');
  });
});
