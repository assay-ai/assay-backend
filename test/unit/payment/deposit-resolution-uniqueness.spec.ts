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

  it('was first keyed on the signature alone', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "uq_ledger_entries_deposit_resolution"\s+ON "ledger_entries" \("chain_tx_ref"\)/,
    );
  });

  it('excludes rows with no signature, which carry no claim to be unique about', () => {
    expect(sql).toContain('"chain_tx_ref" IS NOT NULL');
  });
});

/**
 * The claim unit since `DepositClaimPerAccount1793491200000`: (transaction,
 * buyer account). A batch transaction funding two buyers lets each resolve its
 * own credit once; the same buyer still resolves once.
 */
describe('uq_ledger_entries_deposit_*_account (claim per transaction and buyer)', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '../../../src/database/postgres/migrations/1793491200000-deposit-claim-per-account.ts',
    ),
    'utf8',
  );

  it('keys both deposit indexes on (chain_tx_ref, account_id)', () => {
    expect(sql).toContain('uq_ledger_entries_deposit_pending_account');
    expect(sql).toContain('uq_ledger_entries_deposit_resolution_account');
    expect(sql).toMatch(/ON "ledger_entries" \("chain_tx_ref", "account_id"\)/);
  });

  it('keeps the same entry-type predicates', () => {
    expect(sql).toContain(`"entry_type" = 'DEPOSIT_PENDING' AND "chain_tx_ref" IS NOT NULL`);
    expect(sql).toContain(
      `"entry_type" IN ('DEPOSIT_CONFIRM', 'DEPOSIT_REJECT') AND "chain_tx_ref" IS NOT NULL`,
    );
  });

  it('builds both new indexes before dropping either old one, so the guarantee never lapses', () => {
    const up = sql.slice(sql.indexOf('async up('), sql.indexOf('async down('));
    const create = up.indexOf('CREATE UNIQUE INDEX CONCURRENTLY');
    const drop = up.indexOf('DROP INDEX CONCURRENTLY IF EXISTS "${index.old}"');
    expect(create).toBeLessThan(drop);
    // The drops run in their own loop, after the loop that creates both.
    const loops = [...up.matchAll(/for \(const index of UNIQUE_INDEXES\)/g)].map((m) => m.index);
    expect(loops).toHaveLength(2);
    expect(loops[0]).toBeLessThan(create);
    expect(create).toBeLessThan(loops[1]!);
    expect(loops[1]!).toBeLessThan(drop);
  });

  it('indexes the claim lookup over legacy DEPOSIT rows and the time-bound read', () => {
    expect(sql).toContain('idx_ledger_entries_deposit_legacy_account');
    expect(sql).toContain(`"entry_type" = 'DEPOSIT' AND "chain_tx_ref" IS NOT NULL`);
    expect(sql).toContain('ON "deposit_intents" ("agent_account", "created_at")');
  });
});
