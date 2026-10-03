import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `X-X402-Call-Id` on every upstream request, plus the intrinsic
 * classification a per-call export needs and cannot recover after the fact.
 *
 * ## `call_id`: independent of `id`, not a rename of it
 *
 * The obvious shortcut is to send the intent's own `id` upstream and skip the
 * column. Two things rule it out:
 *
 *  - **A call id must be attachable before an intent exists, and sometimes with
 *    no intent at all.** The registration-time connectivity check and the
 *    sandbox mapping tester both dial a provider endpoint with nothing behind
 *    them financially — no hold, no ledger, no row in this table — and the
 *    reconciliation promise to providers ("every request in their log maps to a
 *    … call") has to cover those too, or a provider's access log grows an
 *    unexplained line the day someone runs a connectivity check.
 *  - **The invoker must not need to know about payments.**
 *    `EgressBindingInvoker` sits behind `BindingInvokerPort` precisely so a
 *    provider call can be made with nothing but a tool, a binding and an input
 *    — see its own doc comment. Sending `intent.id` upstream would mean either
 *    the invoker reaches into the payment domain for it, or the router does,
 *    and both wire in a dependency the router deliberately kept out.
 *
 * So `call_id` is minted once per tool call, independent of `id`, and both are
 * written to the same row: `id` is this platform's key for the money, `call_id`
 * is the provider's key for the request. The per-call export carries both,
 * which is what lets a provider's finance team join their own log — keyed on
 * `call_id`, the only thing they ever saw — back to this platform's payment
 * record without the platform first deciding which of the two the provider
 * "really" meant.
 *
 * **`UNIQUE`, unscoped to `organization_id`** — same reasoning as
 * `voucher_nonce` (`AddVoucherNonce…`): the platform mints this value itself,
 * so a collision is never a legitimate replay from two tenants, it is a bug in
 * the minting path, and an index scoped per tenant would hide exactly that.
 *
 * `NOT NULL` from the start, unlike `voucher_nonce` — every intent, on every
 * rail, gets a call id at creation from this migration onward; there is no
 * historical shape of `payment_intents` that identified a call some other way,
 * the way rail-B intents predate the voucher nonce. Existing rows are
 * backfilled with a freshly minted id purely so the column can be `NOT NULL`
 * immediately — nothing downstream should read meaning into a backfilled value;
 * it corresponds to no header that was ever actually sent, because this column
 * did not exist when those calls were made.
 *
 * ## `call_class`: `PAID` | `FREE` | `TEST` | `EXPLORATION`
 *
 * Two of the four members — `TEST` (the sandbox mapping tester) and
 * `EXPLORATION` (the router's exploration floor, still unimplemented) — have
 * **no producer yet**. They are declared anyway, in this migration rather than a
 * later one, because both are decided *at call time*, by information a
 * settlement outcome recorded afterwards can never reconstruct: which policy
 * routed this call, whether the binding was under its exploration floor.
 * Leaving the column out until a producer exists would mean re-deriving
 * history retroactively from data that was never recorded.
 *
 * **`CANARY` is deliberately not a member, anywhere** — not here, and not in
 * `CallReconciliationClass`
 * (`src/modules/provider/domain/call-reconciliation.ts`). A canary call is, by
 * definition, a real paid call at the normal rate; labelling it differently in
 * a per-call export a provider can read would let that provider fingerprint the
 * canary generator, which is the one thing canary sampling exists to prevent.
 * The monthly aggregate canary count is the surface that reconciles the totals
 * instead.
 *
 * `NOT NULL DEFAULT 'PAID'` for the backfill — every row before this migration
 * was, definitionally, a call the platform charged for or refunded, because
 * nothing before this migration could produce a free, test or exploration call.
 */
export class CallIdAndCallClass1756800000000 implements MigrationInterface {
  name = 'CallIdAndCallClass1756800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    // The default is volatile (`gen_random_uuid()`), so this ADD COLUMN
    // rewrites the table and backfills every existing row in one statement —
    // exactly what a `NOT NULL` column with no meaningful historical value
    // needs. Dropped immediately after: every writer supplies `call_id`
    // explicitly, and a lingering default would let a future insert that
    // forgot to set it succeed silently instead of failing loudly at the
    // application layer where `CreatePaymentIntentInput.callId` is required.
    await queryRunner.query(`
      ALTER TABLE "payment_intents"
        ADD COLUMN "call_id" character varying(64) NOT NULL DEFAULT gen_random_uuid()::text
    `);
    await queryRunner.query(`ALTER TABLE "payment_intents" ALTER COLUMN "call_id" DROP DEFAULT`);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_payment_intents_call_id" ON "payment_intents" ("call_id")
    `);

    await queryRunner.query(`
      ALTER TABLE "payment_intents"
        ADD COLUMN "call_class" character varying(16) NOT NULL DEFAULT 'PAID'
    `);
    await queryRunner.query(`ALTER TABLE "payment_intents" ALTER COLUMN "call_class" DROP DEFAULT`);

    await queryRunner.query(`
      ALTER TABLE "payment_intents" ADD CONSTRAINT "chk_payment_intents_call_class" CHECK (
        "call_class" IN ('PAID', 'FREE', 'TEST', 'EXPLORATION')
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payment_intents" DROP CONSTRAINT IF EXISTS "chk_payment_intents_call_class"`,
    );
    await queryRunner.query(`ALTER TABLE "payment_intents" DROP COLUMN IF EXISTS "call_class"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_payment_intents_call_id"`);
    await queryRunner.query(`ALTER TABLE "payment_intents" DROP COLUMN IF EXISTS "call_id"`);
  }
}
