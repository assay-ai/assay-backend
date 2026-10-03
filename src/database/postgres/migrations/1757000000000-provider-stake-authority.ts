import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The column that finally connects an organization to the stake
 * account the settlement program will slash on its behalf.
 *
 * ## The two keyspaces that have never been joined
 *
 * The settlement program keys a provider's collateral by a Solana pubkey — the
 * `ProviderStake` PDA is derived from `["stake", provider_pubkey]`. The backend
 * keys a provider by an organization UUID, because that is what an API key
 * resolves to and what every other table is scoped by. Nothing in either system
 * knows about the other's identifier, so the router's stake gate has been
 * reading a configured stand-in rather than a chain balance (see the router's
 * own memory note). This is the row where the join lives.
 *
 * ## Why the key has to be proved, and not merely typed in
 *
 * If a provider could name any pubkey, they could name *another provider's*.
 * They would then clear the stake gate on collateral that is not theirs, take
 * paid traffic on it, and — when they defect — the slash attestation this
 * platform signs would point at the other provider's PDA. The victim is not
 * the party who lied; they are the party who staked. Self-declaration is not a
 * weak form of proof here, it is a direct transfer of loss to a third party.
 *
 * So `stake_authority` is written only together with the signature that proved
 * it, exactly as `payout_account_id` has been. The challenge/verify path that
 * produces that signature is a later task; this migration is only the place for
 * its result.
 *
 * ## The three constraints
 *
 * **`chk_providers_stake_proved_together`** — the same shape as
 * `chk_providers_payout_proved_together`, for the same reason: there is no
 * column that can hold a key which has *not* been proved, and the CHECK is what
 * stops the trio being written apart. An unproved key is therefore
 * unrepresentable rather than merely discouraged, which matters because "we
 * only ever write these together" is a property of code that has not been
 * written yet. `num_nonnulls(...) IN (0, 3)` rather than the payout row's
 * pairwise `IS NULL = IS NULL` because there are three columns here, and
 * spelling three pairwise equalities is how one of them gets dropped later.
 *
 * **`uq_providers_stake_authority`** — partial, so the unproved majority (every
 * row today) stays outside it. Two providers pointing at one stake account is
 * one pool of capital backing two sets of bindings, with both clearing the gate
 * on the same money and the exposure the program tracks understating the real
 * liability by a factor of two. It stops that in Postgres rather than in a
 * read-then-write that two concurrent proofs can interleave through.
 *
 * What it does **not** do on its own — and an earlier version of this comment
 * claimed otherwise — is stop the same account being named twice under two
 * spellings. It is a unique index over a free-form string, so it collides only
 * on identical bytes, and a bare base58 pubkey written without the CAIP prefix
 * is a different string naming the same account. Two things close that, and
 * both arrived with the stake-authority proof flow rather than here:
 * `ChainAdapter.toAccountId` canonicalises at the single write path, and
 * `chk_providers_stake_authority_caip10` (migration `1757250000000`) refuses
 * anything that is not CAIP-10-shaped so the guarantee does not rest on the
 * write path alone. Read the three constraints as one mechanism.
 *
 * ## No `NOT NULL`, and no backfill
 *
 * Every existing provider row predates the proof flow and cannot be given a key
 * by this migration — there is no signature to derive one from, and inventing
 * one would be exactly the self-declaration that is refused. The column is
 * nullable and stays nullable; "no proved stake authority" is a real, permanent
 * state for a provider who never posts collateral.
 */
export class ProviderStakeAuthority1757000000000 implements MigrationInterface {
  name = 'ProviderStakeAuthority1757000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `varchar(256)`, matching `payout_account_id`: both hold a CAIP-10
    // account id, not a bare base58 pubkey, so the chain namespace travels
    // with the key and a devnet proof can never be read as a mainnet one.
    await queryRunner.query(`
      ALTER TABLE "providers"
        ADD COLUMN "stake_authority" varchar(256),
        ADD COLUMN "stake_proof"     jsonb,
        ADD COLUMN "stake_proved_at" timestamptz
    `);

    await queryRunner.query(`
      ALTER TABLE "providers" ADD CONSTRAINT "chk_providers_stake_proved_together" CHECK (
        num_nonnulls("stake_authority", "stake_proof", "stake_proved_at") IN (0, 3)
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_providers_stake_authority"
        ON "providers" ("stake_authority") WHERE "stake_authority" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_providers_stake_authority"`);
    await queryRunner.query(
      `ALTER TABLE "providers" DROP CONSTRAINT IF EXISTS "chk_providers_stake_proved_together"`,
    );
    await queryRunner.query(`ALTER TABLE "providers" DROP COLUMN IF EXISTS "stake_proved_at"`);
    await queryRunner.query(`ALTER TABLE "providers" DROP COLUMN IF EXISTS "stake_proof"`);
    await queryRunner.query(`ALTER TABLE "providers" DROP COLUMN IF EXISTS "stake_authority"`);
  }
}
