import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `slash_proposal_parts` — the per-agent judgements a window-level slash case
 * is made of on EVM.
 *
 * The product rule: a window-level SLA penalty compensates the agents that
 * had DATA_FAIL calls in the window **pro rata**, weighted by the price of
 * their failed calls, and the contract pays them directly. A
 * `SlashAttestation` names one beneficiary, so the case is executed as one
 * attestation per harmed agent. `slash_proposals` stays the one case the
 * dispute flow arbitrates; these rows are its on-chain parts. See
 * `SlashProposalPartEntity` and `slash/domain/prorata-slash.ts`.
 *
 * ## The constraints, and what each refuses
 *
 * - `uq_slash_proposal_parts_agent` — one part per agent per case epoch. It is
 *   the idempotency of planning: a retried or raced plan inserts nothing new
 *   (`ON CONFLICT DO NOTHING`) and reads the first plan back.
 * - `uq_slash_proposal_parts_request` — one row per on-chain request id, ever,
 *   mirroring the contract's own one-record-per-id rule.
 * - `chk_…_penalty_positive` — `proposeSlash` reverts `ZeroAmount` on zero; a
 *   zero part is a judgement that can never exist.
 * - `chk_…_within_plan` — no part exceeds the total the plan signed for.
 * - `chk_…_applied_within_penalty` / `…_split_within_applied` — the chain can
 *   take less than signed, never more, and the 60/30 shares never exceed what
 *   was taken.
 * - `chk_…_landed_is_whole` — a PENDING or EXECUTED mirror has both chain
 *   clocks, and an EXECUTED one has its amounts; the same rule
 *   `chk_slash_proposals_chain_pending_is_whole` keeps on the case.
 * - `fk_…_proposal` — RESTRICT, never cascade: a part names money that moved.
 */
export class SlashProposalParts1759500000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "slash_proposal_parts" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "version" integer NOT NULL DEFAULT 1,
        "organization_id" uuid NOT NULL,
        "proposal_id" uuid NOT NULL,
        "chain_epoch" integer NOT NULL,
        "window_id" uuid NOT NULL,
        "agent_account" varchar(256) NOT NULL,
        "beneficiary_account" varchar(256) NOT NULL,
        "weight_amount" numeric(78,0) NOT NULL,
        "uncapped_share_amount" numeric(78,0) NOT NULL,
        "penalty_amount" numeric(78,0) NOT NULL,
        "plan_penalty_amount" numeric(78,0) NOT NULL,
        "plan_capped_total" numeric(78,0) NOT NULL,
        "cap_binding" varchar(16) NOT NULL,
        "chain_request_id" char(64) NOT NULL,
        "chain_status" varchar(16) NOT NULL DEFAULT 'NONE',
        "chain_proposed_at" timestamptz,
        "chain_executable_at" timestamptz,
        "chain_reserved" numeric(78,0),
        "chain_proposal_signature" varchar(256),
        "applied_amount" numeric(78,0),
        "agent_amount" numeric(78,0),
        "platform_amount" numeric(78,0),
        "executed_at" timestamptz,
        "execution_signature" varchar(256),
        "cancelled_at" timestamptz,
        "chain_last_error" varchar(64),
        "propose_attempts" integer NOT NULL DEFAULT 0,
        CONSTRAINT "pk_slash_proposal_parts" PRIMARY KEY ("id"),
        CONSTRAINT "fk_slash_proposal_parts_proposal"
          FOREIGN KEY ("proposal_id") REFERENCES "slash_proposals" ("id") ON DELETE RESTRICT,
        CONSTRAINT "chk_slash_proposal_parts_chain_epoch" CHECK ("chain_epoch" >= 0),
        CONSTRAINT "chk_slash_proposal_parts_propose_attempts" CHECK ("propose_attempts" >= 0),
        CONSTRAINT "chk_slash_proposal_parts_chain_status" CHECK (
          "chain_status" IN ('NONE', 'PENDING', 'EXECUTED', 'CANCELLED', 'REFUSED')
        ),
        CONSTRAINT "chk_slash_proposal_parts_cap_binding" CHECK (
          "cap_binding" IN ('NONE', 'TOTAL_CEILING', 'PART_CEILING', 'DUST_FLOOR')
        ),
        CONSTRAINT "chk_slash_proposal_parts_request_hex" CHECK ("chain_request_id" ~ '^[0-9a-f]{64}$'),
        CONSTRAINT "chk_slash_proposal_parts_weight_positive" CHECK ("weight_amount" > 0),
        CONSTRAINT "chk_slash_proposal_parts_penalty_positive" CHECK ("penalty_amount" > 0),
        CONSTRAINT "chk_slash_proposal_parts_within_plan" CHECK (
          "penalty_amount" <= "plan_capped_total" AND "plan_capped_total" <= "plan_penalty_amount"
          AND "uncapped_share_amount" <= "plan_penalty_amount"
        ),
        CONSTRAINT "chk_slash_proposal_parts_applied_within_penalty" CHECK (
          "applied_amount" IS NULL OR ("applied_amount" >= 0 AND "applied_amount" <= "penalty_amount")
        ),
        CONSTRAINT "chk_slash_proposal_parts_split_within_applied" CHECK (
          "agent_amount" IS NULL OR "platform_amount" IS NULL OR "applied_amount" IS NULL
          OR ("agent_amount" >= 0 AND "platform_amount" >= 0
              AND "agent_amount" + "platform_amount" <= "applied_amount")
        ),
        CONSTRAINT "chk_slash_proposal_parts_landed_is_whole" CHECK (
          ("chain_status" NOT IN ('PENDING', 'EXECUTED')
            OR ("chain_proposed_at" IS NOT NULL AND "chain_executable_at" IS NOT NULL))
          AND ("chain_status" <> 'EXECUTED'
            OR ("executed_at" IS NOT NULL AND "applied_amount" IS NOT NULL
                AND "agent_amount" IS NOT NULL AND "platform_amount" IS NOT NULL))
        )
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_slash_proposal_parts_agent"
         ON "slash_proposal_parts" ("proposal_id", "chain_epoch", "agent_account")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_slash_proposal_parts_request"
         ON "slash_proposal_parts" ("chain_request_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_slash_proposal_parts_proposal"
         ON "slash_proposal_parts" ("proposal_id", "chain_epoch")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_slash_proposal_parts_organization"
         ON "slash_proposal_parts" ("organization_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_slash_proposal_parts_organization"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_slash_proposal_parts_proposal"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_slash_proposal_parts_request"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_slash_proposal_parts_agent"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "slash_proposal_parts"`);
  }
}
