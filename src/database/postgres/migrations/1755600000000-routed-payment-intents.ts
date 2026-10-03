import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The provider becomes known *after* the intent exists.
 *
 * `provider_id` and `provider_account` were first declared `NOT NULL`, which
 * was correct for the flow it was written against: an x402 `402` quote names
 * one provider, the agent signs a voucher for that provider, and the intent
 * records it. The MCP server is not that flow.
 *
 * An MCP agent calls a **tool**. Which provider serves it is picked by the
 * router at call time, by a weighted draw, and may change *during* the call — a
 * `SYSTEM_ERROR` fails over to a second operator, and the third attempt is the
 * one that answers. The intent, meanwhile, has to exist before any of that: it
 * is what the ledger hold references, and reserving the agent's money before
 * spending a provider call is the entire point of the hold.
 *
 * So there is a real window — from `CREATED` until the router returns — in
 * which the intent is a genuine financial record and there is genuinely no
 * provider to name. `NOT NULL` can only be honoured there by inventing one, and
 * every way of inventing one (a nil uuid, the first candidate, the last
 * provider that served this tool) writes a false statement about who is owed
 * money into the row that decides who is paid.
 *
 * Two CHECKs replace the two `NOT NULL`s, and between them they are stricter
 * than what they replace:
 *
 *  - an account without an id is half a payee. The reverse is allowed, and is
 *    the normal case: a provider's **payout account** is proven separately and
 *    read when a payout is batched. Committing the agent's hold does not need
 *    it — that debits the agent — so requiring it here would block settlement
 *    on a fact settlement does not use;
 *  - **an intent may not reach a state that pays anybody without naming who.**
 *    `VERIFYING`, `SETTLED` and `REFUNDED` are exactly the states downstream of
 *    a provider having actually served the call.
 *
 * `VOIDED` and `EXPIRED` are deliberately *not* on that list: "no provider was
 * eligible" and "the agent never funded it" are both real outcomes with no
 * payee, and they are the outcomes where the money goes back to the agent.
 *
 * Both CHECKs are safe to apply retroactively — every existing row was written
 * under `NOT NULL` and therefore satisfies both — so unlike the rail-B nonce
 * rule in `AddVoucherNonce…` these can be plain CHECKs rather than triggers.
 */
export class RoutedPaymentIntents1755600000000 implements MigrationInterface {
  name = 'RoutedPaymentIntents1755600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payment_intents" ALTER COLUMN "provider_id" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_intents" ALTER COLUMN "provider_account" DROP NOT NULL`,
    );

    await queryRunner.query(`
      ALTER TABLE "payment_intents" ADD CONSTRAINT "chk_payment_intents_payee_is_whole" CHECK (
        "provider_account" IS NULL OR "provider_id" IS NOT NULL
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "payment_intents" ADD CONSTRAINT "chk_payment_intents_paying_states_name_payee" CHECK (
        "status" NOT IN ('VERIFYING', 'SETTLED', 'REFUNDED') OR "provider_id" IS NOT NULL
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payment_intents" ` +
        `DROP CONSTRAINT IF EXISTS "chk_payment_intents_paying_states_name_payee"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_intents" DROP CONSTRAINT IF EXISTS "chk_payment_intents_payee_is_whole"`,
    );

    // Reverting is only possible if no unrouted intent survives. Deleting one
    // to make the column NOT NULL again would delete a payment record, so the
    // ALTER is allowed to fail loudly instead.
    await queryRunner.query(
      `ALTER TABLE "payment_intents" ALTER COLUMN "provider_account" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_intents" ALTER COLUMN "provider_id" SET NOT NULL`,
    );
  }
}
