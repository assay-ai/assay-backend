import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One verifier signing key **per chain**.
 *
 * Four changes. Every one of them is invisible with a single chain and fatal
 * with two, and each was read out of the live schema before being written here
 * rather than copied from a plan:
 *
 * ```text
 * uniq_verifier_signing_keys_active         UNIQUE (state) WHERE state = 'ACTIVE'
 * chk_verifier_signing_keys_public_key_hex  CHECK (public_key ~ '^[0-9a-f]{64}$')
 * chk_verifier_signing_log_signature_hex    CHECK (signature IS NULL OR signature ~ '^[0-9a-f]{128}$')
 * ```
 *
 * 1. **The ACTIVE index is GLOBAL.** `UNIQUE (state) WHERE state = 'ACTIVE'` is
 *    a unique index on a constant, so it admits exactly one ACTIVE row in the
 *    whole table. Enrolling an EVM key would not fail — it would **retire the
 *    Solana one**, or fail depending on which order the operator did it in.
 *    Neither is what anybody wants. It becomes `UNIQUE (chain_id) WHERE state =
 *    'ACTIVE'`, which keeps the invariant that actually mattered — one active
 *    key per chain, so `findActive(chainId)`'s answer never depends on row
 *    order — while allowing the second chain.
 * 2. **The public-key CHECK is ed25519-shaped.** An earlier migration widened
 *    `public_key` to `varchar(256)` for exactly this and left the constraint at
 *    64 hex characters. An uncompressed secp256k1 key is 130. **Widening a
 *    column does not widen the CHECK over it** — the column has been ready
 *    since then and would still have refused every EVM key.
 * 3. **The journal's signature CHECK is 128 hex** — a 64-byte ed25519
 *    signature. A 65-byte EVM signature is 130, so every EVM signature would
 *    have failed to journal *after* it had already been produced.
 * 4. `verifier_signing_log.chain_id`, nullable. The first question of a
 *    compromise investigation — *what could this key have signed* — must be
 *    answerable by reading one column.
 *
 * ## The backfill does NOT parse `chain_address`
 *
 * The plan's backfill was
 * `split_part(chain_address, ':', 1) || ':' || split_part(chain_address, ':', 2)`,
 * on the belief that `chain_address` is CAIP-10. **It is not.** Measured on the
 * live table: every value is a bare base58 address
 * (`35errHuYW3D5EztWJsZM3eK3kimUiMFrqAuUu92k5hMr`), and `split_part` on a
 * string with no colon returns the whole string and then an empty string — so
 * that expression yields `35errHu…:`, 45 characters, which fits `varchar(64)`
 * and is accepted silently by `SET NOT NULL`. Eighteen rows would have been
 * stamped with a chain id that is not a chain id, and nothing would have said
 * so until `findActive('solana:EtWT…')` returned nothing.
 *
 * So the chain is taken from `ENABLED_CHAINS` — the one place this deployment
 * states which chains it serves — and only when there is exactly one `solana:`
 * entry there. Every row written before multichain support is a Solana key by
 * construction: this table predates the second namespace. If the variable
 * cannot answer, the migration **throws with the SQL to run by hand**, because
 * the alternative is inventing a value, and `solana:5eykt4Us…` and
 * `solana:EtWTRABZ…` differ by a mainnet. A fresh database has no rows and
 * needs no answer, which is why the lookup is conditional on the count rather
 * than unconditional.
 *
 * ## The CAIP-2 CHECK is new, and it is what would have caught the above
 *
 * `chk_verifier_signing_keys_chain_id` is added because the defect this
 * migration exists to avoid — a column that holds something chain-id-shaped but
 * is not one — is precisely a constraint's job, and the grammar is copied from
 * `CAIP_BOUNDS` in `caip.types.ts`. It refuses `35errHu…:` for two independent
 * reasons (an over-long namespace and an empty reference).
 *
 * ## `down()` is reversible only while the data still fits the old shape
 *
 * Restoring a global single-ACTIVE index over a table with one ACTIVE key per
 * chain fails, loudly, on the index build — and that is correct: reverting this
 * migration on a two-chain deployment is not a schema question, it is a "which
 * chain are you turning off" question, and a `down()` that silently retired a
 * key to make room would answer it for you. Same for the 130-hex keys and
 * signatures the widened CHECKs admitted.
 */
export class VerifierKeysPerChain1759400000000 implements MigrationInterface {
  name = 'VerifierKeysPerChain1759400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. chain_id on the key directory ─────────────────────────────────
    await queryRunner.query(
      `ALTER TABLE "verifier_signing_keys" ADD COLUMN "chain_id" varchar(64)`,
    );

    const [{ count }] = (await queryRunner.query(
      `SELECT count(*)::int AS count FROM "verifier_signing_keys"`,
    )) as [{ count: number }];
    if (count > 0) {
      await queryRunner.query(
        `UPDATE "verifier_signing_keys" SET "chain_id" = $1 WHERE "chain_id" IS NULL`,
        [solanaChainIdForBackfill(count)],
      );
    }

    await queryRunner.query(
      `ALTER TABLE "verifier_signing_keys" ALTER COLUMN "chain_id" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "verifier_signing_keys" ADD CONSTRAINT ` +
        `"chk_verifier_signing_keys_chain_id" CHECK ("chain_id" ~ '${CAIP2_RE}')`,
    );

    // ── 2. the public-key CHECK admits an uncompressed secp256k1 key ─────
    await queryRunner.query(
      `ALTER TABLE "verifier_signing_keys" DROP CONSTRAINT ` +
        `"chk_verifier_signing_keys_public_key_hex"`,
    );
    await queryRunner.query(
      `ALTER TABLE "verifier_signing_keys" ADD CONSTRAINT ` +
        `"chk_verifier_signing_keys_public_key_hex" CHECK (` +
        `"public_key" ~ '^[0-9a-f]{64}$' OR "public_key" ~ '^[0-9a-f]{130}$')`,
    );

    // ── 3. THE BLOCKER: one ACTIVE key per chain, not per table ──────────
    await queryRunner.query(`DROP INDEX "uniq_verifier_signing_keys_active"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uniq_verifier_signing_keys_active_per_chain" ` +
        `ON "verifier_signing_keys" ("chain_id") WHERE "state" = 'ACTIVE'`,
    );

    // ── 4. the journal ──────────────────────────────────────────────────
    await queryRunner.query(
      `ALTER TABLE "verifier_signing_log" DROP CONSTRAINT ` +
        `"chk_verifier_signing_log_signature_hex"`,
    );
    await queryRunner.query(
      `ALTER TABLE "verifier_signing_log" ADD CONSTRAINT ` +
        `"chk_verifier_signing_log_signature_hex" CHECK (` +
        `"signature" IS NULL OR "signature" ~ '^[0-9a-f]{128}$' ` +
        `OR "signature" ~ '^[0-9a-f]{130}$')`,
    );
    // Nullable, and it stays nullable: historical rows genuinely have no
    // answer, and inventing one would make the column an investigator reads
    // first into a column that lies.
    await queryRunner.query(`ALTER TABLE "verifier_signing_log" ADD COLUMN "chain_id" varchar(64)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "verifier_signing_log" DROP COLUMN "chain_id"`);
    await queryRunner.query(
      `ALTER TABLE "verifier_signing_log" DROP CONSTRAINT ` +
        `"chk_verifier_signing_log_signature_hex"`,
    );
    await queryRunner.query(
      `ALTER TABLE "verifier_signing_log" ADD CONSTRAINT ` +
        `"chk_verifier_signing_log_signature_hex" CHECK (` +
        `"signature" IS NULL OR "signature" ~ '^[0-9a-f]{128}$')`,
    );

    await queryRunner.query(`DROP INDEX "uniq_verifier_signing_keys_active_per_chain"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uniq_verifier_signing_keys_active" ` +
        `ON "verifier_signing_keys" ("state") WHERE "state" = 'ACTIVE'`,
    );

    await queryRunner.query(
      `ALTER TABLE "verifier_signing_keys" DROP CONSTRAINT ` +
        `"chk_verifier_signing_keys_public_key_hex"`,
    );
    await queryRunner.query(
      `ALTER TABLE "verifier_signing_keys" ADD CONSTRAINT ` +
        `"chk_verifier_signing_keys_public_key_hex" CHECK ("public_key" ~ '^[0-9a-f]{64}$')`,
    );

    await queryRunner.query(
      `ALTER TABLE "verifier_signing_keys" DROP CONSTRAINT "chk_verifier_signing_keys_chain_id"`,
    );
    await queryRunner.query(`ALTER TABLE "verifier_signing_keys" DROP COLUMN "chain_id"`);
  }
}

/**
 * CAIP-2, transcribed from `CAIP_BOUNDS` in
 * `src/modules/chains/ports/caip.types.ts`. Not imported: a migration is loaded
 * by the TypeORM CLI without `tsconfig-paths`, which is the same reason the
 * entity files use relative imports — and a relative import out of
 * `src/database/` into `src/modules/` would drag the chains module's whole
 * import graph into the migration runner.
 */
const CAIP2_RE = '^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$';

/**
 * The chain every pre-multichain key belongs to, from `ENABLED_CHAINS`.
 *
 * Throws rather than guessing. The message carries the exact statement to run
 * by hand, because an operator hitting this at 3am needs the fix and not the
 * reasoning.
 */
function solanaChainIdForBackfill(rows: number): string {
  const solana = (process.env.ENABLED_CHAINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.startsWith('solana:'));

  if (solana.length === 1) {
    return solana[0];
  }
  throw new Error(
    `verifier_signing_keys has ${rows} row(s) to backfill and ENABLED_CHAINS names ` +
      `${solana.length} solana chains, so which one they belong to cannot be derived. ` +
      `Set it, or run by hand:\n` +
      `  UPDATE verifier_signing_keys SET chain_id = '<solana:genesis-hash>' WHERE chain_id IS NULL;\n` +
      `then re-run this migration.`,
  );
}
