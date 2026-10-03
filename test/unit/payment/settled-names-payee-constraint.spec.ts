import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  HoldEffect,
  PAYMENT_INTENT_TRANSITIONS,
} from '@modules/payment/domain/payment-intent-transitions';
import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';

/**
 * `chk_payment_intents_settled_names_payee` against the state machine it was
 * derived from.
 *
 * ## Why a test reads SQL out of a migration file
 *
 * The constraint's status list was enumerated by hand from
 * `PAYMENT_INTENT_TRANSITIONS`, and hand-transcribed SQL with nothing checking
 * it is exactly how this class of bug survives — the missing-payee defect existed
 * because three call sites reasoned from a CHECK nobody had written, and
 * nothing anywhere compared the claim to the schema.
 *
 * So the derivation is expressed here as code and compared to the literal SQL.
 * A future `COMMIT` edge into a new status changes the derived set, this fails,
 * and whoever added the edge is told to write the migration rather than
 * discovering months later that a new terminal state settles to nobody.
 *
 * The migration is read as **text** rather than executed. That is the point:
 * running it would prove the database enforces whatever the file says, and what
 * needs checking is whether what the file says is right.
 */

const MIGRATION = join(
  __dirname,
  '../../../src/database/postgres/migrations/1758100000000-settled-intents-name-payee.ts',
);

/**
 * Every status that must name a payee, derived from the table.
 *
 * **Both ends of every `COMMIT` edge**, and nothing else:
 *
 * - the *target*, because that is the state the credit produces — an intent
 *   cannot be sitting in it having paid somebody unnamed;
 * - the *source*, because a `COMMIT` edge reads the payee off the row it starts
 *   from, so the value has to be there before the edge is taken. This is what
 *   puts `VERIFYING` on the list even though the edge *into* `VERIFYING` moves
 *   no money.
 *
 * `RELEASE` and `NONE` edges are excluded on purpose. They pay nobody, so a
 * constraint covering them would refuse a row for lacking a value that edge
 * never reads — which would turn a refund into a failure.
 */
function statusesThatMustNameAPayee(): ReadonlySet<PaymentIntentStatus> {
  const required = new Set<PaymentIntentStatus>();

  for (const rule of PAYMENT_INTENT_TRANSITIONS) {
    if (rule.holdEffect !== HoldEffect.COMMIT) continue;
    required.add(rule.from);
    required.add(rule.to);
  }

  return required;
}

/**
 * The migration with its prose removed.
 *
 * Every assertion here is about the SQL that runs, and this file's JSDoc
 * discusses `VALIDATE CONSTRAINT` and the status list at length. Matching
 * against the raw text would let a comment satisfy — or break — a check about
 * behaviour, which is the same confusion between what is written and what is
 * enforced that the missing-payee defect was.
 */
function executableSql(): string {
  return readFileSync(MIGRATION, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

/** The `status NOT IN (...)` list as the migration actually spells it. */
function statusesNamedInTheConstraint(): ReadonlySet<string> {
  const sql = executableSql();
  const match = /"status"\s+NOT\s+IN\s*\(([^)]*)\)/i.exec(sql);

  if (!match) {
    throw new Error(
      'could not find a `"status" NOT IN (...)` list in the migration — if the ' +
        'constraint was rewritten in another shape, rewrite this test with it',
    );
  }

  return new Set(
    match[1]
      .split(',')
      .map((entry) => entry.trim().replace(/^'|'$/g, ''))
      .filter(Boolean),
  );
}

describe('chk_payment_intents_settled_names_payee matches the transition table', () => {
  it('covers exactly the statuses on a COMMIT edge', () => {
    const derived = [...statusesThatMustNameAPayee()].sort();
    const declared = [...statusesNamedInTheConstraint()].sort();

    expect(declared).toEqual(derived);
  });

  it('derives VERIFYING and SETTLED today, so a change to either end is visible here', () => {
    // Pinned deliberately. Without it the test above would still pass if a
    // future edit removed the only COMMIT edge *and* emptied the constraint —
    // two wrongs agreeing with each other.
    expect([...statusesThatMustNameAPayee()].sort()).toEqual([
      PaymentIntentStatus.SETTLED,
      PaymentIntentStatus.VERIFYING,
    ]);
  });

  it('leaves every RELEASE and NONE target out', () => {
    const declared = statusesNamedInTheConstraint();

    const releaseOnlyTargets = PAYMENT_INTENT_TRANSITIONS.filter(
      (rule) => rule.holdEffect === HoldEffect.RELEASE,
    ).map((rule) => rule.to);

    // `REFUNDED`, `VOIDED`, `EXPIRED` — the outcomes where the money goes back
    // to the agent. `REFUNDED` is the one worth watching: the sibling
    // constraint on `provider_id` *does* include it, and copying that list
    // instead of deriving one is the mistake this file exists to catch.
    for (const target of releaseOnlyTargets) {
      const alsoOnACommitEdge = statusesThatMustNameAPayee().has(target);
      if (alsoOnACommitEdge) continue;
      expect(declared.has(target)).toBe(false);
    }

    expect(releaseOnlyTargets).toContain(PaymentIntentStatus.REFUNDED);
  });

  it('is added NOT VALID, and says so in SQL rather than only in prose', () => {
    const sql = executableSql();

    // The 4,879 pre-existing rows violate it. `NOT VALID` is what lets the
    // constraint bind every new insert and update without a table scan that
    // would refuse to install over them.
    expect(/ADD CONSTRAINT[\s\S]*NOT VALID/i.test(sql)).toBe(true);
    // And it must not be validated later: `VALIDATE CONSTRAINT` would fail on
    // exactly those rows, and passing would mean somebody back-filled a payee
    // onto calls that were never paid.
    expect(/VALIDATE CONSTRAINT/i.test(sql)).toBe(false);
  });
});
