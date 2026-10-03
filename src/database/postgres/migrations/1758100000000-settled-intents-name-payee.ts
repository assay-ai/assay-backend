import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * An intent that pays somebody must name **where**, not just **who**.
 *
 * ## What was wrong
 *
 * `RoutedPaymentIntents1755600000000` dropped both `NOT NULL`s and replaced
 * them with two CHECKs, one of which constrains `provider_id` in the paying
 * states. It deliberately left `provider_account` unconstrained, and said why:
 *
 * > *a provider's **payout account** is proven separately and read when a
 * > payout is batched. Committing the agent's hold does not need it —
 * > that debits the agent — so requiring it here would block settlement on a
 * > fact settlement does not use*
 *
 * That was true when it was written and stopped being true with provider
 * earnings, when `PaymentIntentService.resolve()`'s COMMIT branch moved from
 * `commitHold` to `commitHoldAndCredit`. Committing the hold now *does* need
 * the account: it is the `providerAccountId` the credit entry is written
 * against. Nobody revisited the migration, so for every rail-A call the row
 * reached `SETTLED` — or rather tried to, threw `PAYMENT_PROVIDER_NOT_ASSIGNED`
 * after the status had already moved, and left the agent's money reserved with
 * the provider paid nothing.
 *
 * Three call sites reason from a CHECK that did not exist —
 * `payment-intent.service.ts`'s COMMIT guard, `payment.types.ts` on
 * `providerId`, and `verification-settlement.service.ts`'s `repairHoldEffect`,
 * which *silently gives up* repairing a hold in a state it believes the schema
 * makes unreachable. This is that CHECK.
 *
 * ## Which statuses, and why exactly these two
 *
 * Enumerated from `payment-intent-transitions.ts`, edge by edge, not copied
 * from the sibling constraint:
 *
 * | edge | holdEffect | needs a payee? |
 * |---|---|---|
 * | `CREATED → FUNDS_SECURED` | `CREATE` | no — the router has not run |
 * | `CREATED → EXPIRED` | `NONE` | no |
 * | `FUNDS_SECURED → PROVIDER_EXECUTING` | `NONE` | no — still routing |
 * | `FUNDS_SECURED → EXPIRED` | `RELEASE` | no |
 * | `PROVIDER_EXECUTING → VERIFYING` | `NONE` | **yes** |
 * | `PROVIDER_EXECUTING → VOIDED` | `RELEASE` | no — nobody served it |
 * | `VERIFYING → SETTLED` | `COMMIT` | **yes** |
 * | `VERIFYING → REFUNDED` | `RELEASE` | no |
 *
 * - **`VERIFYING`** because that is the state the payee is written *into*. The
 *   edge into it moves no money, but it is the last moment at which the answer
 *   is knowable for free: the provider has just served the call, and the
 *   address they had proved *then* is the one that call owes. Constraining the
 *   later state instead would let a call be recorded, verified and disputed
 *   without ever fixing who it was for.
 * - **`SETTLED`** because that is what the `COMMIT` edge produces, and `COMMIT`
 *   is the only effect that credits anybody.
 *
 * `REFUNDED` is **not** on the list, and that is a departure from the sibling
 * constraint on `provider_id`, which does include it. A `RELEASE` edge makes
 * the agent whole and pays nobody, so a payee is a value that edge does not
 * use — and a constraint that refuses a row for lacking a value nothing reads
 * turns a refund into a failure. Today it would never fire (`REFUNDED` is
 * reachable only from `VERIFYING`, which this constraint already covers, so the
 * value is present anyway); the reason to leave it off is the day some future
 * edge refunds a call no provider served. `VOIDED` and `EXPIRED` are off the
 * list for the reason the original migration gives — real outcomes with no
 * payee, where the money goes back to the agent.
 *
 * ## Why `NOT VALID`, which nothing else in this repository uses
 *
 * 4,879 rail-A rows are already `SETTLED` with a null account and a hold that
 * was never released. They are the defect, recorded. A plain `ADD CONSTRAINT`
 * scans the table and refuses to install over them, so the choice is between
 * repairing history and constraining the future.
 *
 * **History is deliberately not repaired.** Back-filling `provider_account`
 * from `providers.payout_account_id` today would make each of those rows
 * *assert* a payee — at whatever address is proved now, not the one proved when
 * the call was served — while the ledger still shows nobody credited and the
 * agent's money still `held`. A row that claims a payment that did not happen
 * is worse than a row that is honestly incomplete, and the incompleteness is
 * what makes them findable. They are devnet rows; the forward fix plus this
 * constraint stops new ones.
 *
 * `NOT VALID` is exactly that split. Postgres enforces a `NOT VALID` CHECK on
 * every **insert and update** from the moment it is added — the guarantee that
 * matters here — and only skips the one-time scan of existing rows. It is not
 * validated later on purpose: `VALIDATE CONSTRAINT` would fail on those 4,879
 * rows, and it must not be run until they are either repaired against the
 * ledger or aged out.
 *
 * Two consequences to know about.
 *
 * The planner will not use a `NOT VALID` constraint for constraint exclusion.
 * Nothing here queries on it, so that costs nothing.
 *
 * **A `NOT VALID` CHECK still fires on UPDATE, not only on INSERT** — Postgres
 * skips the existing rows *once*, at install; it does not exempt them
 * afterwards. So any future job that touches one of those 4,879 rows must set
 * `provider_account` **in the same statement** as whatever else it changes, or
 * it takes a `23514` on a row it did not think it was constraining. A repair
 * that stamps `hold_released_at` and leaves the payee for a second pass fails
 * on the first. That is the correct behaviour — a repair which cannot say who
 * was paid has not repaired anything — but it will surprise whoever writes it,
 * so it is written down here rather than discovered against production.
 *
 * `VALIDATE CONSTRAINT` is deliberately never run, and `settled-names-payee-constraint.spec.ts`
 * asserts this file does not contain it.
 */
export class SettledIntentsNamePayee1758100000000 implements MigrationInterface {
  name = 'SettledIntentsNamePayee1758100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "payment_intents"
        ADD CONSTRAINT "chk_payment_intents_settled_names_payee" CHECK (
          "status" NOT IN ('VERIFYING', 'SETTLED') OR "provider_account" IS NOT NULL
        ) NOT VALID
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payment_intents" ` +
        `DROP CONSTRAINT IF EXISTS "chk_payment_intents_settled_names_payee"`,
    );
  }
}
