import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One provider identity, N chain enrolments.
 *
 * ## What moves and what does not
 *
 * `providers` keeps everything that is a fact about BEHAVIOUR: legal identity,
 * tier, `ProviderStats`, SLA windows, strikes, dispute history, connectivity
 * checks, the verification profile. Those are properties of a *service*, and
 * the service is one service on both chains. Forking the identity would fork
 * reputation, and *"a provider slashed on Solana would enrol on 4663 with a
 * clean record and keep routing — that is not chain independence, it is a
 * laundering path"*.
 *
 * What moves here is the money: the payout address, its proof, and the stake
 * authority. Those are per chain because the chain that must pay, and the chain
 * that must slash, is the only chain that can see them.
 *
 * ## Keyed on organization_id, not providers(id)
 *
 * The obvious DDL would be `provider_id uuid references providers(id)`. This
 * codebase has `providerId === organizationId` — `tool_bindings` has no
 * `provider_id` column at all and `ToolBinding.providerId` is
 * `row.organizationId`. A foreign key to `providers.id` could not be joined to
 * a binding without a second lookup. `providers` carries
 * `uq_providers_organization_id`, so keying on `organization_id` is exactly as
 * strong and joins to everything else for free.
 *
 * ## The backfill takes the chain from the DATA
 *
 * Every existing provider with a proved payout address gets one enrolment, on
 * the chain that address's own CAIP-10 prefix names. Not from a config value: a
 * deployment-wide default would put a provider who proved a mainnet address
 * onto devnet, and the first symptom would be a payout to an account that does
 * not exist. Providers with no proved address get no row and lose nothing —
 * `evaluatePayoutGate` already refused them.
 *
 * `chk_providers_payout_proved_together` guarantees `payout_account_id` and
 * `payout_proof` are both-or-neither, so the backfill has no half-state to
 * handle.
 *
 * ## The CAIP-10 CHECK that `1757250000000` deferred
 *
 * That migration added the grammar CHECK to `stake_authority` and deliberately
 * left `payout_account_id` without one, because *"adding a CHECK to a populated
 * column is a data question ... and answering it belongs in a change that is
 * about payouts"*. This is that change. The column is being populated fresh by
 * a SELECT that can be filtered, so the question has an answer: rows that fail
 * the grammar are not copied, and the count of skipped rows is asserted to be
 * zero before the constraint is added.
 */
export class CreateProviderChainEnrolments1759300000001 implements MigrationInterface {
  name = 'CreateProviderChainEnrolments1759300000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `chk_providers_payout_proved_together` ties `payout_account_id` to
    // `payout_proof` and says NOTHING about `payout_proved_at`, so a provider
    // with an address, a proof and no timestamp is representable today. No code
    // path writes one — `ProviderPayoutAddressService` sets all three in one
    // statement — but `payout_proved_at` is NOT NULL here, so such a row would
    // abort the backfill with `null value in column "payout_proved_at"`:
    // loud and transactional, but naming a column instead of the data. This
    // names the data, and the providers, before anything is created.
    const undated = (await queryRunner.query(`
      SELECT "organization_id" FROM "providers"
      WHERE "payout_account_id" IS NOT NULL AND "payout_proved_at" IS NULL
    `)) as { organization_id: string }[];

    if (undated.length > 0) {
      throw new Error(
        `${undated.length} provider(s) have a payout_account_id with no payout_proved_at, and ` +
          `an enrolment must record when the address was proved: ` +
          `${undated.map((row) => row.organization_id).join(', ')}. Set payout_proved_at from ` +
          `the proof envelope's own provedAt before re-running.`,
      );
    }

    await queryRunner.query(`
      CREATE TABLE "provider_chain_enrolments" (
        "id"                         uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"                 timestamptz  NOT NULL DEFAULT now(),
        "updated_at"                 timestamptz  NOT NULL DEFAULT now(),
        "version"                    integer      NOT NULL DEFAULT 1,
        "organization_id"            uuid         NOT NULL,
        "chain_id"                   varchar(128) NOT NULL,
        "payout_account_id"          varchar(256) NOT NULL,
        "payout_proof"               jsonb        NOT NULL,
        "payout_proved_at"           timestamptz  NOT NULL,
        "stake_authority_account_id" varchar(256),
        "stake_proof"                jsonb,
        "stake_proved_at"            timestamptz,
        "status"                     varchar(16)  NOT NULL DEFAULT 'ACTIVE',
        "enrolled_at"                timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "pk_provider_chain_enrolments" PRIMARY KEY ("id"),
        CONSTRAINT "uq_provider_chain_enrolments_org_chain"
          UNIQUE ("organization_id", "chain_id"),
        CONSTRAINT "chk_provider_chain_enrolments_status"
          CHECK ("status" IN ('ACTIVE', 'SUSPENDED', 'UNBONDING')),
        CONSTRAINT "chk_provider_chain_enrolments_chain_caip2"
          CHECK ("chain_id" ~ '^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$'),
        -- The gap 1757250000000 documented and deferred. CAIP-10 grammar,
        -- exactly as caip.types.ts defines it.
        CONSTRAINT "chk_provider_chain_enrolments_payout_caip10"
          CHECK ("payout_account_id" ~ '^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}:[-.%a-zA-Z0-9]{1,128}$'),
        CONSTRAINT "chk_provider_chain_enrolments_stake_caip10"
          CHECK ("stake_authority_account_id" ~ '^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}:[-.%a-zA-Z0-9]{1,128}$'),
        -- §A.2: the account must be ON the chain the row names. SQL can see
        -- this and it is the half that stops a mainnet address being filed
        -- under devnet; canonical spelling of the chain reference is still
        -- toAccountId's job and only its job.
        CONSTRAINT "chk_provider_chain_enrolments_payout_on_chain"
          CHECK ("payout_account_id" LIKE "chain_id" || ':%'),
        CONSTRAINT "chk_provider_chain_enrolments_stake_on_chain"
          CHECK ("stake_authority_account_id" IS NULL
                 OR "stake_authority_account_id" LIKE "chain_id" || ':%'),
        CONSTRAINT "chk_provider_chain_enrolments_stake_proved_together"
          CHECK (("stake_authority_account_id" IS NULL) = ("stake_proof" IS NULL)
                 AND ("stake_proof" IS NULL) = ("stake_proved_at" IS NULL))
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_provider_chain_enrolments_organization_id"
        ON "provider_chain_enrolments" ("organization_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_provider_chain_enrolments_chain_status"
        ON "provider_chain_enrolments" ("chain_id", "status")
    `);
    // The uniqueness `uq_providers_stake_authority` used to guarantee, now per
    // chain: two providers must not name one stake account, because both would
    // then clear the stake gate on one pool of capital. Partial, because NULL
    // is the common state (see decision (a)).
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_provider_chain_enrolments_stake_authority"
        ON "provider_chain_enrolments" ("stake_authority_account_id")
        WHERE "stake_authority_account_id" IS NOT NULL
    `);

    await queryRunner.query(`
      INSERT INTO "provider_chain_enrolments" (
        "organization_id", "chain_id",
        "payout_account_id", "payout_proof", "payout_proved_at",
        "stake_authority_account_id", "stake_proof", "stake_proved_at",
        "status", "enrolled_at"
      )
      SELECT
        p."organization_id",
        -- The chain from the address's own prefix: everything up to the second
        -- colon. Never from config.
        split_part(p."payout_account_id", ':', 1) || ':' || split_part(p."payout_account_id", ':', 2),
        p."payout_account_id",
        p."payout_proof",
        p."payout_proved_at",
        p."stake_authority",
        p."stake_proof",
        p."stake_proved_at",
        -- Enrolment status starts as the provider's own status. A SUSPENDED
        -- provider must not become routable on a chain by being enrolled onto
        -- it, and copying the status is what makes the two agree on day one.
        p."status",
        -- Belt and braces, and deliberately kept as such: the pre-flight check
        -- at the top of up() aborts on ANY provider whose payout_account_id has
        -- no payout_proved_at, so the fallback to created_at is unreachable.
        -- It stays because the day somebody relaxes that guard, an enrolment
        -- with no enrolment date is a NOT NULL violation rather than a date,
        -- and this is the answer that was already right.
        COALESCE(p."payout_proved_at", p."created_at")
      FROM "providers" p
      WHERE p."payout_account_id" IS NOT NULL
        AND p."payout_account_id" ~ '^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}:[-.%a-zA-Z0-9]{1,128}$'
        -- A stake authority on a DIFFERENT chain from the payout address is not
        -- representable in one row and has never been possible to create: both
        -- came from \`ChainAdapter.toAccountId\` on the deployment's own chain.
        -- Asserted rather than assumed — see the guard below.
        AND (p."stake_authority" IS NULL
             OR p."stake_authority" LIKE
                split_part(p."payout_account_id", ':', 1) || ':' ||
                split_part(p."payout_account_id", ':', 2) || ':%')
    `);

    // Both guards fail the migration rather than silently dropping a provider.
    // A backfill that skipped rows would make live providers unroutable, which
    // is the one outcome decision (b) forbids.
    const [{ skipped }] = (await queryRunner.query(`
      SELECT count(*)::int AS skipped FROM "providers" p
      WHERE p."payout_account_id" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "provider_chain_enrolments" e
          WHERE e."organization_id" = p."organization_id"
        )
    `)) as { skipped: number }[];

    if (skipped > 0) {
      throw new Error(
        `${skipped} provider(s) have a payout_account_id that did not backfill into ` +
          `provider_chain_enrolments — a malformed CAIP-10, or a stake_authority on a ` +
          `different chain from the payout address. Inspect and fix the data before ` +
          `re-running; do not relax the backfill.`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The columns this backfilled FROM are still on `providers` at this point —
    // Tasks 6 and 7 drop them in later migrations — so dropping this table is a
    // complete revert with no data loss.
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_provider_chain_enrolments_stake_authority"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_provider_chain_enrolments_chain_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_provider_chain_enrolments_organization_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "provider_chain_enrolments"`);
  }
}
