import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { EvidenceBodyEntity } from '@database/postgres/entities/evidence-body.entity';
import { EvidencePackEntity } from '@database/postgres/entities/evidence-pack.entity';
import { VerificationPolicyEntity } from '@database/postgres/entities/verification-policy.entity';
import { VerificationRecordEntity } from '@database/postgres/entities/verification-record.entity';
import { CreateVerificationPolicies1755700000000 } from '@database/postgres/migrations/1755700000000-create-verification-policies';
import { CreateVerificationRecords1755800000000 } from '@database/postgres/migrations/1755800000000-create-verification-records';
import { TimestamptzTimestamps1755900000000 } from '@database/postgres/migrations/1755900000000-timestamptz-timestamps';
import { CreateEvidencePacks1757400000000 } from '@database/postgres/migrations/1757400000000-create-evidence-packs';

import { ensureTestDatabase, testConnectionOptions } from './test-database';

/**
 * A real Postgres carrying `verification_records` and the two evidence tables
 * and nothing else.
 *
 * Three migrations, in this order, and each is here for a reason:
 *
 * - `CreateVerificationRecords` — the FK target. `evidence_packs.verdict_id`
 *   points at it with `ON DELETE RESTRICT`.
 * - `TimestamptzTimestamps` — **not optional scenery.** It converts `created_at`
 *   from `timestamp` to `timestamptz`, and the retention sweep's predicate is
 *   `created_at < now() - interval`. Skipping it would test that query against a
 *   column type production does not have, in exactly the dimension where the
 *   codebase has already been bitten (naive timestamps shifted by the host
 *   offset). It
 *   skips tables that do not exist here, so a partial list is safe.
 * - `CreateEvidencePacks` — the subject.
 */
export interface EvidenceTestContext {
  readonly dataSource: DataSource;
  /** Rotated by `reset()` — one organization per test, so no cleanup step. */
  organizationId: string;
  /** A second tenant, for the cross-organization refusals. */
  otherOrganizationId: string;
  reset(): Promise<void>;
  close(): Promise<void>;
  /** A `PENDING` verification record, which is what a pack gets sealed against. */
  insertVerdict(organizationId?: string): Promise<string>;
  /** A pack written by raw SQL — the subject of a constraint test is the schema. */
  insertPack(input: InsertPackInput): Promise<string>;
}

export interface InsertPackInput {
  readonly organizationId?: string;
  readonly verdictId: string;
  readonly seq: number;
  readonly prevHash: string | null;
  readonly contentHash?: string;
  readonly providerId?: string | null;
  readonly withBody?: boolean;
  readonly bodyExpiresAt?: Date;
}

/** 64 lower-case hex, deterministic from a label, so a test can name its hashes. */
export function hashFromLabel(label: string): string {
  const hex = Buffer.from(label).toString('hex').padEnd(64, '0');
  return hex.slice(0, 64);
}

export async function createEvidenceTestContext(): Promise<EvidenceTestContext> {
  const database = await ensureTestDatabase(
    process.env.EVIDENCE_TEST_DATABASE || `${process.env.DATABASE_NAME || 'app'}_evidence_test`,
  );

  const dataSource = new DataSource({
    type: 'postgres',
    ...testConnectionOptions(),
    database,
    entities: [
      VerificationRecordEntity,
      VerificationPolicyEntity,
      EvidencePackEntity,
      EvidenceBodyEntity,
    ],
    migrations: [
      // The sealer pins the policy documents a verdict was judged under.
      CreateVerificationPolicies1755700000000,
      CreateVerificationRecords1755800000000,
      TimestamptzTimestamps1755900000000,
      CreateEvidencePacks1757400000000,
    ],
    synchronize: false,
    logging: false,
  });

  await dataSource.initialize();
  await dataSource.runMigrations();

  const context: EvidenceTestContext = {
    dataSource,
    organizationId: randomUUID(),
    otherOrganizationId: randomUUID(),

    async reset() {
      // `evidence_packs` refuses DELETE by trigger, so a truncate is the only
      // way to clear it — and TRUNCATE does not fire row triggers, which is
      // exactly why the append-only guard is a row trigger and not a rule.
      await dataSource.query(
        `TRUNCATE "evidence_bodies", "evidence_packs", "verification_records", ` +
          `"verification_policies" CASCADE`,
      );
      context.organizationId = randomUUID();
      context.otherOrganizationId = randomUUID();
    },

    async close() {
      await dataSource.destroy();
    },

    async insertVerdict(organizationId?: string) {
      const [row] = (await dataSource.query(
        `INSERT INTO "verification_records"
           ("organization_id", "intent_id", "tool_id", "state", "request", "response")
         VALUES ($1, $2, $3, 'PENDING', '{"city":"Paris"}'::jsonb, '{"tempC":31}'::jsonb)
         RETURNING "id"`,
        [organizationId ?? context.organizationId, randomUUID(), randomUUID()],
      )) as Array<{ id: string }>;
      return row.id;
    },

    async insertPack(input: InsertPackInput) {
      const organizationId = input.organizationId ?? context.organizationId;
      const [row] = (await dataSource.query(
        `INSERT INTO "evidence_packs"
           ("organization_id", "provider_id", "verdict_id", "intent_id", "seq", "core",
            "request_sha256", "response_sha256", "content_hash", "prev_hash",
            "sealed_at", "body_expires_at")
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $7, $8, $9, now(), $10)
         RETURNING "id"`,
        [
          organizationId,
          input.providerId ?? null,
          input.verdictId,
          randomUUID(),
          input.seq,
          JSON.stringify({ schema: 'x402/evidence-pack/v1', seq: input.seq }),
          `sha256:${hashFromLabel('body')}`,
          input.contentHash ?? hashFromLabel(`pack-${input.seq}`),
          input.prevHash,
          input.bodyExpiresAt ?? new Date(Date.now() + 72 * 3600 * 1000),
        ],
      )) as Array<{ id: string }>;

      if (input.withBody !== false) {
        await dataSource.query(
          `INSERT INTO "evidence_bodies"
             ("organization_id", "pack_id", "request", "response", "expires_at")
           VALUES ($1, $2, '{"city":"Paris"}'::jsonb, '{"tempC":31}'::jsonb, $3)`,
          [organizationId, row.id, input.bodyExpiresAt ?? new Date(Date.now() + 72 * 3600 * 1000)],
        );
      }

      return row.id;
    },
  };

  return context;
}
