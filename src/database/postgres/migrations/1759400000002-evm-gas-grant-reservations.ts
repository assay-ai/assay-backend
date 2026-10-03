import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The durable reservation the once-ever gas grant never had.
 *
 * ## What was wrong
 *
 * `uniq_evm_gas_grants_account` bounds the grant to one row per address, ever —
 * but a row only exists once a transaction hash does, and the hash only exists
 * once the money has left. So two API processes could both pass
 * `hasGranted` and both call `sendValue`: one row survived the index, the float
 * paid twice, and the ledger was not even wrong. `evm-gas-grants.integration.spec.ts`
 * measured exactly that, with a barrier forcing the interleave.
 *
 * While `grantWithdrawGas` had no production caller the trigger was manual and
 * the window was theoretical. It now sits in `WithdrawalService.buildIntent`,
 * so **any buyer asking for a withdraw intent opens it**, and the window is as
 * wide as the API's replica count.
 *
 * ## Why a second table rather than a column
 *
 * The obvious fix is to insert the grant row first and fill the hash in later.
 * That requires `transaction_hash` to become nullable, and a nullable hash on
 * `evm_gas_grants` is a row asserting "the relayer sent gas to this address"
 * while nothing has been sent. That table is the platform's audit trail for
 * money that left; every row in it must be true when it is written, and the
 * `NOT NULL` is what says so.
 *
 * A reservation is a different claim — *"an attempt for this address started at
 * `reserved_at` and has not finished"* — which IS true when it is written. It
 * gets its own table so that neither statement has to be weakened to fit the
 * other, and so a stuck attempt is visible as a row rather than inferred from
 * an absence.
 *
 * ## `uniq_evm_gas_grant_reservations_account` is the ordering, not the bound
 *
 * The bound is still `uniq_evm_gas_grants_account`. This index only decides
 * **who sends**: the claim is one `INSERT … ON CONFLICT (account_id) DO UPDATE
 * … WHERE reserved_at < now() - lease`, so of two racing processes exactly one
 * gets a row back and the other is refused `GRANT_IN_FLIGHT` before it can
 * spend anything. Not scoped to `organization_id`, for the same reason the
 * grants index is not: the bound is on the ADDRESS, and an attacker who can
 * create organizations would otherwise get one in-flight attempt per
 * organization to the same address.
 *
 * ## The lease, and what it does not prove
 *
 * A reservation whose holder crashed between claiming and recording would lock
 * that buyer out of the grant forever, which is a worse failure than the one
 * being fixed. So the claim can take over a reservation older than the lease
 * (`EVM_GAS_GRANT_RESERVATION_LEASE_MS`). That bounds a crash; it does not prove
 * a send is over. `EvmRelayer` serialises sends per chain and
 * `waitForTransactionReceipt` carries no timeout, so a send still in flight when
 * the lease expires can be taken over and the float can still pay twice — now
 * requiring a fifteen-minute stall rather than a millisecond of concurrency, and
 * still bounded by the per-grant and daily caps. The takeover logs at `error`
 * because it is always worth looking at.
 *
 * ## No entity, deliberately
 *
 * This table is a lock, not a business record. It is cross-tenant by
 * construction, so `OrganizationScopedRepository`'s guarantees cannot apply to
 * it, and it is only ever touched by two statements that must stay atomic. An
 * entity would invite `find()`-shaped access to something no caller may read
 * and then act on. `organization_id` is carried as EVIDENCE of who triggered
 * the attempt — never as scope.
 */
export class EvmGasGrantReservations1759400000002 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "evm_gas_grant_reservations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "organization_id" uuid NOT NULL,
        "chain_id" varchar(64) NOT NULL,
        "account_id" varchar(256) NOT NULL,
        "reserved_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_evm_gas_grant_reservations" PRIMARY KEY ("id"),
        CONSTRAINT "uniq_evm_gas_grant_reservations_account" UNIQUE ("account_id"),
        CONSTRAINT "chk_evm_gas_grant_reservations_account_on_chain"
          CHECK ("account_id" LIKE "chain_id" || ':%')
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "evm_gas_grant_reservations"`);
  }
}
