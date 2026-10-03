import {
  EvidenceTestContext,
  createEvidenceTestContext,
  hashFromLabel,
} from '../helpers/evidence-test-context';

/**
 * The schema-level guarantees behind the evidence pack, exercised against a
 * real Postgres.
 *
 * `yarn test` is jest-unit and never runs a migration, so a trigger or a CHECK
 * is invisible to every suite under `test/unit`. **A constraint nothing has
 * ever seen reject anything is indistinguishable from a constraint written
 * wrong** — and here the constraint *is* the feature: if we can edit the
 * evidence pack, it is not evidence.
 *
 * Every write below is raw SQL, deliberately. The subject is the database's own
 * refusal; going through TypeORM would let a repository method that does not
 * exist, or an entity mapping, satisfy something the schema would have caught —
 * and the test would then be measuring the ORM instead of the guarantee.
 */
describe('evidence pack constraints', () => {
  let context: EvidenceTestContext;

  beforeAll(async () => {
    context = await createEvidenceTestContext();
  });

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
  });

  describe('a sealed pack cannot be changed', () => {
    it('refuses UPDATE, even by raw SQL', async () => {
      const verdictId = await context.insertVerdict();
      const packId = await context.insertPack({ verdictId, seq: 1, prevHash: null });

      await expect(
        context.dataSource.query(
          `UPDATE "evidence_packs" SET "content_hash" = $1 WHERE "id" = $2`,
          [hashFromLabel('rewritten'), packId],
        ),
      ).rejects.toThrow(/append-only/);
    });

    it('refuses DELETE, even by raw SQL', async () => {
      const verdictId = await context.insertVerdict();
      const packId = await context.insertPack({ verdictId, seq: 1, prevHash: null });

      await expect(
        context.dataSource.query(`DELETE FROM "evidence_packs" WHERE "id" = $1`, [packId]),
      ).rejects.toThrow(/append-only/);
    });

    it('refuses an UPDATE that touches no evidence column either', async () => {
      // The trigger fires on the statement, not on which columns moved. A
      // carve-out for "harmless" updates is how the guarantee erodes.
      const verdictId = await context.insertVerdict();
      const packId = await context.insertPack({ verdictId, seq: 1, prevHash: null });

      await expect(
        context.dataSource.query(`UPDATE "evidence_packs" SET "version" = 2 WHERE "id" = $1`, [
          packId,
        ]),
      ).rejects.toThrow(/append-only/);
    });
  });

  describe('the chain cannot fork', () => {
    it('refuses a second pack claiming the same predecessor', async () => {
      const first = hashFromLabel('pack-1');
      await context.insertPack({
        verdictId: await context.insertVerdict(),
        seq: 1,
        prevHash: null,
        contentHash: first,
      });
      await context.insertPack({
        verdictId: await context.insertVerdict(),
        seq: 2,
        prevHash: first,
        contentHash: hashFromLabel('pack-2'),
      });

      await expect(
        context.insertPack({
          verdictId: await context.insertVerdict(),
          seq: 3,
          prevHash: first, // the fork: two packs, one parent
          contentHash: hashFromLabel('pack-3'),
        }),
      ).rejects.toThrow(/uq_evidence_packs_prev/);
    });

    it('refuses two packs at the same position', async () => {
      await context.insertPack({
        verdictId: await context.insertVerdict(),
        seq: 1,
        prevHash: null,
        contentHash: hashFromLabel('pack-1'),
      });

      await expect(
        context.insertPack({
          verdictId: await context.insertVerdict(),
          seq: 1,
          prevHash: null,
          contentHash: hashFromLabel('other'),
        }),
      ).rejects.toThrow(/uq_evidence_packs_seq|uq_evidence_packs_prev/);
    });

    it('lets a second organization start its own genesis', async () => {
      // Postgres treats NULLs as distinct in a unique constraint, which is what
      // makes one chain per tenant possible under a single constraint.
      await context.insertPack({
        verdictId: await context.insertVerdict(),
        seq: 1,
        prevHash: null,
        contentHash: hashFromLabel('org-a-genesis'),
      });

      await expect(
        context.insertPack({
          organizationId: context.otherOrganizationId,
          verdictId: await context.insertVerdict(context.otherOrganizationId),
          seq: 1,
          prevHash: null,
          contentHash: hashFromLabel('org-b-genesis'),
        }),
      ).resolves.toEqual(expect.any(String));
    });

    it('refuses a genesis row that names a predecessor, and a linked row that does not', async () => {
      await expect(
        context.insertPack({
          verdictId: await context.insertVerdict(),
          seq: 1,
          prevHash: hashFromLabel('from-nowhere'),
        }),
      ).rejects.toThrow(/chk_evidence_packs_genesis/);

      await expect(
        context.insertPack({ verdictId: await context.insertVerdict(), seq: 2, prevHash: null }),
      ).rejects.toThrow(/chk_evidence_packs_genesis/);
    });
  });

  describe('one pack per verdict', () => {
    it('refuses a second pack for the same verdict', async () => {
      const verdictId = await context.insertVerdict();
      await context.insertPack({ verdictId, seq: 1, prevHash: null });

      await expect(
        context.insertPack({
          verdictId,
          seq: 2,
          prevHash: hashFromLabel('pack-1'),
          contentHash: hashFromLabel('second-opinion'),
        }),
      ).rejects.toThrow(/uq_evidence_packs_verdict/);
    });
  });

  describe('a body can be deleted but never edited', () => {
    it('refuses UPDATE on a body', async () => {
      const verdictId = await context.insertVerdict();
      const packId = await context.insertPack({ verdictId, seq: 1, prevHash: null });

      await expect(
        context.dataSource.query(
          `UPDATE "evidence_bodies" SET "response" = '{"tempC":0}'::jsonb WHERE "pack_id" = $1`,
          [packId],
        ),
      ).rejects.toThrow(/append-only/);
    });

    it('allows DELETE on a body, which is the retention policy working', async () => {
      const verdictId = await context.insertVerdict();
      const packId = await context.insertPack({ verdictId, seq: 1, prevHash: null });

      await expect(
        context.dataSource.query(`DELETE FROM "evidence_bodies" WHERE "pack_id" = $1`, [packId]),
      ).resolves.not.toThrow();

      const rows = (await context.dataSource.query(
        `SELECT count(*)::int AS remaining FROM "evidence_bodies" WHERE "pack_id" = $1`,
        [packId],
      )) as Array<{ remaining: number }>;
      expect(rows[0].remaining).toBe(0);
    });

    it('keeps the pack, and its digests, after the body is gone', async () => {
      const verdictId = await context.insertVerdict();
      const packId = await context.insertPack({ verdictId, seq: 1, prevHash: null });
      await context.dataSource.query(`DELETE FROM "evidence_bodies" WHERE "pack_id" = $1`, [
        packId,
      ]);

      const rows = (await context.dataSource.query(
        `SELECT "content_hash", "response_sha256" FROM "evidence_packs" WHERE "id" = $1`,
        [packId],
      )) as Array<{ content_hash: string; response_sha256: string }>;

      expect(rows[0].content_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0].response_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
  });

  describe('a hash column cannot hold something that is not a hash', () => {
    it('refuses a content hash that is not 64 lower-case hex', async () => {
      await expect(
        context.insertPack({
          verdictId: await context.insertVerdict(),
          seq: 1,
          prevHash: null,
          contentHash: 'NOT-A-HASH'.padEnd(64, 'X'),
        }),
      ).rejects.toThrow(/chk_evidence_packs_content_hash/);
    });
  });
});
