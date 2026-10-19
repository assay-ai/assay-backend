import { randomUUID } from 'node:crypto';

import { CreateProviderChainEnrolments1759300000001 } from '@database/postgres/migrations/1759300000001-create-provider-chain-enrolments';
import { DropProviderPayoutColumns1759300000002 } from '@database/postgres/migrations/1759300000002-drop-provider-payout-columns';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { ChainEnrolmentStatus, enrolmentKey } from '@modules/provider/ports/chain-enrolment.port';
import { DbChainEnrolmentSource } from '@modules/provider/services/db-chain-enrolment.source';

import {
  ProviderLedgerTestContext,
  createProviderLedgerTestContext,
} from '../helpers/provider-ledger-test-context';

/**
 * `provider_chain_enrolments`, against a real Postgres.
 *
 * Three things are only true here and nowhere in `test/unit`:
 *
 * 1. **The constraints.** `yarn test` is jest-unit and never runs a migration,
 *    so a CHECK and a partial unique index are invisible to every suite there.
 *    A constraint nothing has seen reject anything is indistinguishable from
 *    one written backwards — and `chk_..._payout_on_chain` is what stands
 *    between a mainnet address and a devnet payout.
 * 2. **The column names.** The unit spec builds rows in TypeScript and hands
 *    them to a hand-written `findByProviders`, so it would pass with every
 *    `@Column({ name })` on the entity misspelled. Here the rows are written by
 *    raw SQL naming the migration's own snake_case columns and read back
 *    through the repository, so the entity's mapping is the thing under test.
 * 3. **The backfill.** It is one statement over `providers`, and its whole job
 *    is to not lose a live provider.
 *
 * Every write below that is about a refusal is raw SQL, deliberately: going
 * through TypeORM would let an entity default satisfy a constraint the schema
 * would have rejected, and the test would then be measuring the ORM.
 */
describe('provider_chain_enrolments', () => {
  let context: ProviderLedgerTestContext;

  beforeAll(async () => {
    context = await createProviderLedgerTestContext();
  });

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
  });

  const DEVNET = CHAIN_IDS.SOLANA_DEVNET;
  const MAINNET = CHAIN_IDS.SOLANA_MAINNET;
  const PAYOUT = '85nsFusdnvbdcCyYsVLRa6v8iFMWG9oreN9htgHyuLuT';
  const STAKE = 'D9D6eF7LdSTf5PjDFpc2L6mUk1yVBoHFxk1xgbFAb1Bt';

  const proof = (): string =>
    JSON.stringify({
      challengeId: randomUUID(),
      signature: 'test-signature',
      messageVersion: 'assay-payout-proof/v1',
      provedAt: new Date().toISOString(),
    });

  interface EnrolmentRow {
    organizationId?: string;
    chainId?: string;
    payoutAccountId?: string;
    payoutProof?: string | null;
    payoutProvedAt?: Date | null;
    stakeAuthorityAccountId?: string | null;
    stakeProof?: string | null;
    stakeProvedAt?: Date | null;
    status?: string;
    enrolledAt?: Date;
  }

  /**
   * One INSERT, naming every column exactly as the migration spells it.
   *
   * This is the round trip the unit spec cannot make: if the entity's
   * `@Column({ name: … })` and these names ever disagree, `findByProviders`
   * below comes back with `undefined` fields and the assertions fail.
   */
  async function insertEnrolment(row: EnrolmentRow = {}): Promise<string> {
    const organizationId = row.organizationId ?? randomUUID();
    await context.dataSource.query(
      `INSERT INTO provider_chain_enrolments
         (organization_id, chain_id, payout_account_id, payout_proof, payout_proved_at,
          stake_authority_account_id, stake_proof, stake_proved_at, status, enrolled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        organizationId,
        row.chainId ?? DEVNET,
        row.payoutAccountId ?? `${row.chainId ?? DEVNET}:${PAYOUT}`,
        row.payoutProof === undefined ? proof() : row.payoutProof,
        row.payoutProvedAt === undefined ? new Date('2026-03-01T00:00:00Z') : row.payoutProvedAt,
        row.stakeAuthorityAccountId ?? null,
        row.stakeProof ?? null,
        row.stakeProvedAt ?? null,
        row.status ?? 'ACTIVE',
        row.enrolledAt ?? new Date('2026-03-01T00:00:00Z'),
      ],
    );
    return organizationId;
  }

  /**
   * Inserts, and then proves the row is **in the table**.
   *
   * `await expect(insertEnrolment(...)).resolves.toBeDefined()` — which is what
   * these acceptance cases used to say — is satisfied by the helper's own
   * freshly generated uuid, so it can only ever fail on a rejection. That is
   * the intended meaning ("this INSERT is accepted") but it is not what the
   * assertion reads as, and a helper that started returning a constant would
   * keep it green. This counts the row instead.
   */
  async function insertAccepted(row: EnrolmentRow = {}): Promise<string> {
    const organizationId = await insertEnrolment(row);

    const [landed] = (await context.dataSource.query(
      `SELECT count(*)::int AS rows FROM provider_chain_enrolments
        WHERE organization_id = $1 AND chain_id = $2`,
      [organizationId, row.chainId ?? DEVNET],
    )) as { rows: number }[];

    expect(landed.rows).toBe(1);
    return organizationId;
  }

  // ── The constraints, each proved by the database refusing something ───────

  describe('the CHECKs refuse what their names claim', () => {
    it('chk_provider_chain_enrolments_payout_on_chain — a mainnet address filed under devnet', async () => {
      await expect(
        insertEnrolment({ chainId: DEVNET, payoutAccountId: `${MAINNET}:${PAYOUT}` }),
      ).rejects.toThrow(/chk_provider_chain_enrolments_payout_on_chain/);
    });

    it('chk_provider_chain_enrolments_payout_caip10 — an address past the 128-char bound', async () => {
      // Deliberately NOT a bare base58 address, which is the obvious fixture:
      // that one violates `chk_..._payout_on_chain` as well, so the test would
      // still go red with this CHECK deleted — measured, and it is how the
      // first draft of this test was wrong. This address DOES start with the
      // row's own chain id, so `payout_on_chain` is satisfied and only the
      // grammar refuses it.
      await expect(
        insertEnrolment({ payoutAccountId: `${DEVNET}:${'z'.repeat(129)}` }),
      ).rejects.toThrow(/chk_provider_chain_enrolments_payout_caip10/);
    });

    it('chk_provider_chain_enrolments_chain_caip2 — a namespace with no reference', async () => {
      // Same isolation problem, same fix: `solana:<base58>` as the payout would
      // fail the CAIP-10 grammar too. A full CAIP-10 devnet address still
      // starts with `solana:`, so `payout_on_chain` and `payout_caip10` are
      // both satisfied and only the chain's own grammar refuses.
      await expect(
        insertEnrolment({ chainId: 'solana', payoutAccountId: `${DEVNET}:${PAYOUT}` }),
      ).rejects.toThrow(/chk_provider_chain_enrolments_chain_caip2/);
    });

    it('chk_provider_chain_enrolments_status — a status outside the three', async () => {
      await expect(insertEnrolment({ status: 'APPROVED' })).rejects.toThrow(
        /chk_provider_chain_enrolments_status/,
      );
    });

    it('chk_provider_chain_enrolments_stake_on_chain — a stake authority on the OTHER chain', async () => {
      await expect(
        insertEnrolment({
          chainId: DEVNET,
          stakeAuthorityAccountId: `${MAINNET}:${STAKE}`,
          stakeProof: proof(),
          stakeProvedAt: new Date(),
        }),
      ).rejects.toThrow(/chk_provider_chain_enrolments_stake_on_chain/);
    });

    it('chk_provider_chain_enrolments_stake_caip10 — right chain, address past the 128-char bound', async () => {
      await expect(
        insertEnrolment({
          stakeAuthorityAccountId: `${DEVNET}:${'a'.repeat(129)}`,
          stakeProof: proof(),
          stakeProvedAt: new Date(),
        }),
      ).rejects.toThrow(/chk_provider_chain_enrolments_stake_caip10/);
    });

    it.each([
      ['authority alone', { stakeAuthorityAccountId: `${DEVNET}:${STAKE}` }],
      ['proof alone', { stakeProof: '{}' }],
      ['timestamp alone', { stakeProvedAt: new Date() }],
      [
        'authority + proof, no timestamp',
        { stakeAuthorityAccountId: `${DEVNET}:${STAKE}`, stakeProof: '{}' },
      ],
    ])(
      'chk_provider_chain_enrolments_stake_proved_together — refuses %s',
      async (_label, values) => {
        await expect(insertEnrolment(values)).rejects.toThrow(
          /chk_provider_chain_enrolments_stake_proved_together/,
        );
      },
    );

    it('accepts the two whole states: no stake at all, and all three together', async () => {
      await insertAccepted();
      await insertAccepted({
        stakeAuthorityAccountId: `${DEVNET}:${STAKE}`,
        stakeProof: proof(),
        stakeProvedAt: new Date(),
      });

      const [total] = (await context.dataSource.query(
        `SELECT count(*)::int AS rows FROM provider_chain_enrolments`,
      )) as { rows: number }[];
      expect(total.rows).toBe(2);
    });
  });

  describe('the unique constraints', () => {
    it('uq_..._org_chain — refuses a second enrolment for one provider on one chain', async () => {
      const organizationId = await insertEnrolment({ chainId: DEVNET });

      await expect(insertEnrolment({ organizationId, chainId: DEVNET })).rejects.toThrow(
        /uq_provider_chain_enrolments_org_chain/,
      );
    });

    it('uq_..._org_chain — and permits the SAME provider on the other chain, which is the point', async () => {
      const organizationId = await insertEnrolment({ chainId: DEVNET });

      await insertAccepted({ organizationId, chainId: MAINNET });

      const [both] = (await context.dataSource.query(
        `SELECT count(*)::int AS rows FROM provider_chain_enrolments WHERE organization_id = $1`,
        [organizationId],
      )) as { rows: number }[];
      expect(both.rows).toBe(2);
    });

    it('uq_..._stake_authority — refuses two providers naming one stake account', async () => {
      const stake = {
        stakeAuthorityAccountId: `${DEVNET}:${STAKE}`,
        stakeProof: proof(),
        stakeProvedAt: new Date(),
      };
      await insertEnrolment(stake);

      // One pool of capital clearing the stake gate twice is the failure this
      // index exists to prevent.
      await expect(insertEnrolment(stake)).rejects.toThrow(
        /uq_provider_chain_enrolments_stake_authority/,
      );
    });

    it('uq_..._stake_authority is PARTIAL — any number of enrolments hold no stake authority', async () => {
      // Decision (a): null is the ORDINARY state. A plain unique index would
      // let exactly one un-funded enrolment exist in the whole deployment.
      await insertAccepted();
      await insertAccepted();
      await insertAccepted();

      const [nulls] = (await context.dataSource.query(
        `SELECT count(*)::int AS rows FROM provider_chain_enrolments
          WHERE stake_authority_account_id IS NULL`,
      )) as { rows: number }[];
      expect(nulls.rows).toBe(3);
    });

    it('uq_..._stake_authority is per CHAIN — the same base58 key on two chains is two accounts', async () => {
      await insertEnrolment({
        chainId: DEVNET,
        stakeAuthorityAccountId: `${DEVNET}:${STAKE}`,
        stakeProof: proof(),
        stakeProvedAt: new Date(),
      });

      await insertAccepted({
        chainId: MAINNET,
        payoutAccountId: `${MAINNET}:${PAYOUT}`,
        stakeAuthorityAccountId: `${MAINNET}:${STAKE}`,
        stakeProof: proof(),
        stakeProvedAt: new Date(),
      });

      const [keys] = (await context.dataSource.query(
        `SELECT count(*)::int AS rows FROM provider_chain_enrolments
          WHERE stake_authority_account_id LIKE '%' || $1`,
        [`:${STAKE}`],
      )) as { rows: number }[];
      expect(keys.rows).toBe(2);
    });
  });

  /**
   * The indexes, and `down()`.
   *
   * Both were degenerate-shaped holes: a migration that created **neither**
   * non-unique index passed 29/29 of this file and 83/83 of the unit specs that
   * touch this table (measured), because an index changes no answer — only how
   * long it takes. `idx_..._organization_id` is the access path for
   * `findByProviders`, which runs once per routing decision over every
   * candidate provider, so its absence is a sequential scan on the hot path.
   * And nothing exercised `down()` at all outside a human running
   * `yarn migration:revert` by hand.
   */
  describe('the indexes, and the revert', () => {
    async function indexNames(): Promise<string[]> {
      const rows = (await context.dataSource.query(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'provider_chain_enrolments'
          ORDER BY indexname`,
      )) as { indexname: string }[];
      return rows.map((row) => row.indexname);
    }

    it('creates exactly the five the migration declares — no more, no fewer', async () => {
      expect(await indexNames()).toEqual([
        'idx_provider_chain_enrolments_chain_status',
        'idx_provider_chain_enrolments_organization_id',
        'pk_provider_chain_enrolments',
        'uq_provider_chain_enrolments_org_chain',
        'uq_provider_chain_enrolments_stake_authority',
      ]);
    });

    it("the entity's declared @Index name is one Postgres actually has", async () => {
      // `@Index('idx_provider_chain_enrolments_chain_status', ['chainId','status'])`
      // is decorator metadata: TypeORM would happily carry a name no migration
      // ever created, and with `synchronize: false` nothing would say so.
      expect(await indexNames()).toContain('idx_provider_chain_enrolments_chain_status');
    });

    it('down() removes the table and every index with it, and up() puts them back', async () => {
      const runner = context.dataSource.createQueryRunner();
      try {
        await new CreateProviderChainEnrolments1759300000001().down(runner);

        const [gone] = (await context.dataSource.query(
          `SELECT to_regclass('provider_chain_enrolments') IS NULL AS absent`,
        )) as { absent: boolean }[];
        expect(gone.absent).toBe(true);
        expect(await indexNames()).toEqual([]);

        await new CreateProviderChainEnrolments1759300000001().up(runner);
      } finally {
        await runner.release();
      }

      expect(await indexNames()).toHaveLength(5);
    });
  });

  /**
   * The status vocabulary, read out of the LIVE constraint.
   *
   * `test/unit/database/chain-enrolment-status-drift.spec.ts` pins
   * `ChainEnrolmentStatus` against the migration's own text and runs
   * everywhere. This is the other half: it asks the database what it will
   * actually accept, so a constraint edited by hand on a deployed environment
   * — or a migration that ran differently from how it reads — is caught too.
   */
  describe('the status vocabulary the database actually enforces', () => {
    async function checkVocabulary(): Promise<string[]> {
      const [row] = (await context.dataSource.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'chk_provider_chain_enrolments_status'`,
      )) as { def: string }[];

      expect(row?.def).toBeTruthy();
      return [...row.def.matchAll(/'([A-Z_]+)'::character varying/g)].map((m) => m[1]).sort();
    }

    it('is exactly ChainEnrolmentStatus', async () => {
      const accepted = await checkVocabulary();

      expect(accepted.length).toBeGreaterThan(0);
      expect(accepted).toEqual(Object.values(ChainEnrolmentStatus).sort());
    });

    it('accepts each of those three and nothing else — asked of the table, not of the catalogue', async () => {
      for (const status of Object.values(ChainEnrolmentStatus)) {
        await insertAccepted({ status });
      }

      await expect(insertEnrolment({ status: 'RETIRED' })).rejects.toThrow(
        /chk_provider_chain_enrolments_status/,
      );
    });
  });

  // ── The mapping, over the real columns ───────────────────────────────────

  describe('findByProviders, and the source over it', () => {
    it('round-trips every column the entity maps', async () => {
      // Written by raw SQL naming the migration's columns; read back through
      // the entity. A misspelled `@Column({ name })` fails here and nowhere
      // else in the suite.
      const organizationId = await insertEnrolment({
        chainId: DEVNET,
        payoutAccountId: `${DEVNET}:${PAYOUT}`,
        stakeAuthorityAccountId: `${DEVNET}:${STAKE}`,
        stakeProof: JSON.stringify({ signature: 'k' }),
        stakeProvedAt: new Date('2026-04-05T06:07:08Z'),
        status: 'UNBONDING',
        enrolledAt: new Date('2026-02-03T04:05:06Z'),
        payoutProvedAt: new Date('2026-02-03T04:05:06Z'),
      });

      const [found] = await context.chainEnrolments.findByProviders([organizationId]);

      expect(found).toBeDefined();
      expect(found.organizationId).toBe(organizationId);
      expect(found.chainId).toBe(DEVNET);
      expect(found.payoutAccountId).toBe(`${DEVNET}:${PAYOUT}`);
      expect(found.payoutProvedAt).toEqual(new Date('2026-02-03T04:05:06Z'));
      expect(found.payoutProof).toBeTruthy();
      expect(found.stakeAuthorityAccountId).toBe(`${DEVNET}:${STAKE}`);
      expect(found.stakeProof).toEqual({ signature: 'k' });
      expect(found.stakeProvedAt).toEqual(new Date('2026-04-05T06:07:08Z'));
      expect(found.status).toBe('UNBONDING');
      expect(found.enrolledAt).toEqual(new Date('2026-02-03T04:05:06Z'));
    });

    it('carries a NULL stake authority back as null, rather than dropping the row', async () => {
      // The null case, exercised against the column that is actually nullable.
      const organizationId = await insertEnrolment();

      const [found] = await context.chainEnrolments.findByProviders([organizationId]);

      expect(found.stakeAuthorityAccountId).toBeNull();
      expect(found.stakeProof).toBeNull();
      expect(found.stakeProvedAt).toBeNull();
    });

    it('returns only the providers asked for, across organizations', async () => {
      const wanted = await insertEnrolment();
      const alsoWanted = await insertEnrolment();
      await insertEnrolment();

      const found = await context.chainEnrolments.findByProviders([wanted, alsoWanted]);

      expect(found.map((r) => r.organizationId).sort()).toEqual([wanted, alsoWanted].sort());
    });

    it('DbChainEnrolmentSource maps the real rows into the port type', async () => {
      const organizationId = await insertEnrolment({ chainId: DEVNET });
      await insertEnrolment({ organizationId, chainId: MAINNET, status: 'SUSPENDED' });

      const source = new DbChainEnrolmentSource(context.chainEnrolments, {
        emit: async () => undefined,
      });
      const found = await source.enrolmentsOf([organizationId]);

      expect([...found.keys()].sort()).toEqual(
        [enrolmentKey(organizationId, DEVNET), enrolmentKey(organizationId, MAINNET)].sort(),
      );
      expect(found.get(enrolmentKey(organizationId, DEVNET))?.status).toBe(
        ChainEnrolmentStatus.ACTIVE,
      );
      expect(found.get(enrolmentKey(organizationId, MAINNET))?.status).toBe(
        ChainEnrolmentStatus.SUSPENDED,
      );
      expect(found.get(enrolmentKey(organizationId, DEVNET))?.stakeAuthorityAccountId).toBeNull();
    });
  });

  // ── The backfill ─────────────────────────────────────────────────────────

  /**
   * The migration's `up()` re-run over seeded `providers` rows.
   *
   * The context creates the table before any provider exists, so the backfill
   * it ran was a no-op. Here the table is dropped, providers are seeded, and
   * `up()` is invoked directly — which is the only way to see the statement
   * that decides whether a live provider survives the change.
   */
  describe('the backfill', () => {
    /**
     * **`up()` here is NOT transactional, and a test added to this block must
     * account for that.**
     *
     * `backfill()` calls the migration class directly rather than going through
     * TypeORM's migration executor, which is what normally wraps `up()` in a
     * transaction. So a guard that throws part-way leaves whatever ran before
     * it committed: the malformed-address test leaves the table CREATED with
     * the row-count guard unmet, while the undated test throws before
     * `CREATE TABLE` and leaves nothing at all. The `afterEach` below
     * compensates by clearing `providers` and rebuilding the table from
     * scratch; do not write a test in this block that assumes a rolled-back
     * state, because there is none.
     */
    async function backfill(): Promise<void> {
      const runner = context.dataSource.createQueryRunner();
      try {
        await new CreateProviderChainEnrolments1759300000001().up(runner);
      } finally {
        await runner.release();
      }
    }

    beforeEach(async () => {
      await context.dataSource.query('DROP TABLE IF EXISTS provider_chain_enrolments');
    });

    afterEach(async () => {
      // Leave the table behind for whichever spec runs next, rebuilt over an
      // empty `providers` so the two tests that make the backfill THROW do not
      // make it throw again here. `up()` is invoked directly, outside the
      // migration executor, so it carries no transaction of its own: the
      // malformed-address test leaves the table created and the row-count guard
      // unmet, and the undated test leaves nothing at all.
      await context.dataSource.query('DELETE FROM providers');
      await context.dataSource.query('DROP TABLE IF EXISTS provider_chain_enrolments');
      await backfill();
    });

    async function seed(input: {
      organizationId: string;
      payoutAccountId: string | null;
      status?: string;
      stakeAuthority?: string | null;
    }): Promise<void> {
      await context.registerProvider({
        organizationId: input.organizationId,
        payoutAccountId: input.payoutAccountId,
      });
      if (input.status !== undefined) {
        await context.dataSource.query(
          `UPDATE providers SET status = $2 WHERE organization_id = $1`,
          [input.organizationId, input.status],
        );
      }
      if (input.stakeAuthority) {
        await context.dataSource.query(
          `UPDATE providers SET stake_authority = $2, stake_proof = $3, stake_proved_at = now()
             WHERE organization_id = $1`,
          [input.organizationId, input.stakeAuthority, proof()],
        );
      }
    }

    it('takes the chain from the ADDRESS, not from a deployment default', async () => {
      // The one that matters: a config-derived chain would file a mainnet
      // address under devnet, and the first symptom would be a payout to an
      // account that does not exist.
      const onMainnet = randomUUID();
      const onDevnet = randomUUID();
      await seed({ organizationId: onMainnet, payoutAccountId: `${MAINNET}:${PAYOUT}` });
      await seed({ organizationId: onDevnet, payoutAccountId: `${DEVNET}:${PAYOUT}` });

      await backfill();

      const rows = (await context.dataSource.query(
        `SELECT organization_id, chain_id FROM provider_chain_enrolments ORDER BY chain_id`,
      )) as { organization_id: string; chain_id: string }[];

      expect(rows).toEqual([
        { organization_id: onMainnet, chain_id: MAINNET },
        { organization_id: onDevnet, chain_id: DEVNET },
      ]);
    });

    it('gives every provider with a proved payout exactly one row, and no one else any', async () => {
      // Decision (b): the migration must not make a live provider unroutable.
      const withPayout = randomUUID();
      const without = randomUUID();
      await seed({ organizationId: withPayout, payoutAccountId: `${DEVNET}:${PAYOUT}` });
      await seed({ organizationId: without, payoutAccountId: null });

      await backfill();

      const [counts] = (await context.dataSource.query(
        `SELECT (SELECT count(*)::int FROM providers WHERE payout_account_id IS NOT NULL) AS with_payout,
                (SELECT count(*)::int FROM provider_chain_enrolments) AS enrolments`,
      )) as { with_payout: number; enrolments: number }[];

      expect(counts.enrolments).toBe(counts.with_payout);
      expect(counts.enrolments).toBe(1);
    });

    it('copies the provider status, so a SUSPENDED provider is not made routable by enrolling', async () => {
      const suspended = randomUUID();
      await seed({
        organizationId: suspended,
        payoutAccountId: `${DEVNET}:${PAYOUT}`,
        status: 'SUSPENDED',
      });

      await backfill();

      const [row] = (await context.dataSource.query(
        `SELECT status FROM provider_chain_enrolments WHERE organization_id = $1`,
        [suspended],
      )) as { status: string }[];

      expect(row.status).toBe('SUSPENDED');
    });

    it('carries the stake trio across intact', async () => {
      const staked = randomUUID();
      await seed({
        organizationId: staked,
        payoutAccountId: `${DEVNET}:${PAYOUT}`,
        stakeAuthority: `${DEVNET}:${STAKE}`,
      });

      await backfill();

      const [row] = (await context.dataSource.query(
        `SELECT stake_authority_account_id, stake_proof IS NOT NULL AS has_proof,
                stake_proved_at IS NOT NULL AS has_timestamp
           FROM provider_chain_enrolments WHERE organization_id = $1`,
        [staked],
      )) as { stake_authority_account_id: string; has_proof: boolean; has_timestamp: boolean }[];

      expect(row.stake_authority_account_id).toBe(`${DEVNET}:${STAKE}`);
      expect(row.has_proof).toBe(true);
      expect(row.has_timestamp).toBe(true);
    });

    it('dates the enrolment from when the address was PROVED, not from the clock', async () => {
      // `enrolled_at` has `DEFAULT now()`, so a backfill that simply omitted the
      // column would produce rows that all claim to have enrolled at migration
      // time — plausible-looking, and wrong by however long the provider has
      // been live. Nothing else in this file reads the column.
      const provider = randomUUID();
      await seed({ organizationId: provider, payoutAccountId: `${DEVNET}:${PAYOUT}` });
      await context.dataSource.query(
        `UPDATE providers SET payout_proved_at = $2 WHERE organization_id = $1`,
        [provider, new Date('2025-06-07T08:09:10Z')],
      );

      await backfill();

      const [row] = (await context.dataSource.query(
        `SELECT enrolled_at, payout_proved_at, created_at FROM provider_chain_enrolments
          WHERE organization_id = $1`,
        [provider],
      )) as { enrolled_at: Date; payout_proved_at: Date; created_at: Date }[];

      expect(row.enrolled_at).toEqual(new Date('2025-06-07T08:09:10Z'));
      expect(row.payout_proved_at).toEqual(new Date('2025-06-07T08:09:10Z'));
      // `created_at` records when this TABLE learned about the enrolment, and is
      // therefore the one column that should be recent. Pinned so the two can
      // never be collapsed into each other.
      expect(row.created_at.getTime()).toBeGreaterThan(row.enrolled_at.getTime());
    });

    it('FAILS rather than silently skipping a provider whose payout address is malformed', async () => {
      // The guard is the whole reason the backfill is allowed to filter. A
      // migration that dropped this row would report success and leave a live
      // provider with no enrolment — unroutable, and nobody told.
      const malformed = randomUUID();
      await seed({ organizationId: malformed, payoutAccountId: null });
      await context.dataSource.query(
        `UPDATE providers SET payout_account_id = $2, payout_proof = $3, payout_proved_at = now()
           WHERE organization_id = $1`,
        [malformed, PAYOUT, proof()],
      );

      await expect(backfill()).rejects.toThrow(/did not backfill into provider_chain_enrolments/);
    });

    it('FAILS, naming the provider, when a payout address has no payout_proved_at', async () => {
      // `chk_providers_payout_proved_together` ties the address to the proof and
      // says nothing about the timestamp, so this row is representable — and
      // `payout_proved_at` is NOT NULL on the enrolment. Without the pre-flight
      // check the abort reads `null value in column "payout_proved_at"`, which
      // names a column rather than the provider that has to be fixed.
      const undated = randomUUID();
      await seed({ organizationId: undated, payoutAccountId: `${DEVNET}:${PAYOUT}` });
      await context.dataSource.query(
        `UPDATE providers SET payout_proved_at = NULL WHERE organization_id = $1`,
        [undated],
      );

      await expect(backfill()).rejects.toThrow(
        new RegExp(`payout_account_id with no payout_proved_at.*${undated}`, 's'),
      );
    });
  });
  /**
   * `1759300000002-drop-provider-payout-columns`, both directions.
   *
   * ## Why it lives in *this* file
   *
   * `ProviderLedgerTestContext` is the one context that deliberately stops
   * short of `…002`, so it is the only place where `providers` still has the
   * three columns and the migration therefore has something to drop and
   * something to restore. Everywhere else in the suite they are already gone.
   *
   * ## What it is defending
   *
   * A `down()` that only re-added the columns would leave every provider with
   * `payout_account_id = NULL`, and the revert would report success while
   * making every one of them unpayable. And the CHECK it recreates is
   * **tightened** — `num_nonnulls(...) IN (0, 3)` rather than the original
   * two-column form — because the loose one permits an address with a proof and
   * no `payout_proved_at`, which is a state the enrolment backfill aborts on while
   * naming a *column* instead of the provider. Until now both facts were proved
   * only by a human running psql.
   *
   * ## The class is invoked directly, so nothing here is transactional
   *
   * Same caveat as the backfill block above: `migration:run`'s executor is not
   * involved, so the `migrations` table is untouched and a failure part-way
   * leaves whatever ran before it committed. The `afterEach` restores the
   * schema this context's other suites expect — the three columns present and
   * the ORIGINAL loose constraint — unconditionally, because a tightened
   * constraint left behind would break the two backfill tests above on the next
   * run of this file (they set `payout_proved_at = NULL` on purpose).
   */
  describe('the drop migration, up and down', () => {
    const LOOSE_CONSTRAINT = 'CHECK (("payout_account_id" IS NULL) = ("payout_proof" IS NULL))';

    async function payoutColumns(): Promise<string[]> {
      const rows = (await context.dataSource.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'providers' AND column_name LIKE 'payout%'
          ORDER BY column_name`,
      )) as { column_name: string }[];
      return rows.map((row) => row.column_name);
    }

    async function payoutConstraint(): Promise<string | null> {
      const rows = (await context.dataSource.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'providers'::regclass
            AND conname = 'chk_providers_payout_proved_together'`,
      )) as { def: string }[];
      return rows[0]?.def ?? null;
    }

    async function run(direction: 'up' | 'down'): Promise<void> {
      const runner = context.dataSource.createQueryRunner();
      try {
        await new DropProviderPayoutColumns1759300000002()[direction](runner);
      } finally {
        await runner.release();
      }
    }

    afterEach(async () => {
      // Put the context back exactly as the rest of this file expects it: the
      // three columns present, and the LOOSE constraint the earlier migration
      // created. Written as drop-then-recreate rather than conditionally,
      // because the failure mode being guarded against is a half-applied
      // migration and a conditional would inherit its uncertainty.
      await context.dataSource.query(`
        ALTER TABLE "providers"
          ADD COLUMN IF NOT EXISTS "payout_account_id" varchar(256),
          ADD COLUMN IF NOT EXISTS "payout_proof"      jsonb,
          ADD COLUMN IF NOT EXISTS "payout_proved_at"  timestamptz
      `);
      await context.dataSource.query(
        `ALTER TABLE "providers" DROP CONSTRAINT IF EXISTS "chk_providers_payout_proved_together"`,
      );
      await context.dataSource.query(
        `ALTER TABLE "providers" ADD CONSTRAINT "chk_providers_payout_proved_together" ` +
          LOOSE_CONSTRAINT,
      );
    });

    it('up() removes all three columns and the constraint that spanned them', async () => {
      await run('up');

      expect(await payoutColumns()).toEqual(['payout_threshold_override']);
      // The CHECK names all three columns, so it cannot outlive them — and
      // dropping it explicitly rather than relying on the cascade is what keeps
      // `down()` able to recreate it by name.
      expect(await payoutConstraint()).toBeNull();
    });

    it('down() RE-BACKFILLS from the enrolment, rather than restoring three empty columns', async () => {
      const organizationId = randomUUID();
      await context.registerProvider({ organizationId, payoutAccountId: null });
      await insertEnrolment({
        organizationId,
        chainId: DEVNET,
        payoutAccountId: `${DEVNET}:${PAYOUT}`,
        payoutProvedAt: new Date('2025-06-07T08:09:10Z'),
        enrolledAt: new Date('2025-06-07T08:09:10Z'),
      });

      await run('up');
      await run('down');

      const [row] = (await context.dataSource.query(
        `SELECT payout_account_id, payout_proved_at, payout_proof IS NOT NULL AS has_proof
           FROM providers WHERE organization_id = $1`,
        [organizationId],
      )) as { payout_account_id: string; payout_proved_at: Date; has_proof: boolean }[];

      // A `down()` that only re-added the columns leaves this null, reports
      // success, and makes every provider on the platform unpayable.
      expect(row.payout_account_id).toBe(`${DEVNET}:${PAYOUT}`);
      expect(row.payout_proved_at).toEqual(new Date('2025-06-07T08:09:10Z'));
      expect(row.has_proof).toBe(true);
    });

    it('down() picks the EARLIEST enrolment when a provider has two — lossy, but deterministic', async () => {
      const organizationId = randomUUID();
      await context.registerProvider({ organizationId, payoutAccountId: null });
      // Deliberately inserted newest-first, so a `down()` that took whatever the
      // scan returned would come back with the mainnet row.
      await insertEnrolment({
        organizationId,
        chainId: MAINNET,
        payoutAccountId: `${MAINNET}:${PAYOUT}`,
        enrolledAt: new Date('2026-01-01T00:00:00Z'),
      });
      await insertEnrolment({
        organizationId,
        chainId: DEVNET,
        payoutAccountId: `${DEVNET}:${PAYOUT}`,
        enrolledAt: new Date('2025-01-01T00:00:00Z'),
      });

      await run('up');
      await run('down');

      const [row] = (await context.dataSource.query(
        `SELECT payout_account_id FROM providers WHERE organization_id = $1`,
        [organizationId],
      )) as { payout_account_id: string }[];

      // A single-column model cannot hold two chains, so the revert is lossy by
      // construction. `DISTINCT ON … ORDER BY enrolled_at ASC` makes it lossy
      // the *same way every time*, and the earliest is the one that was there
      // before this plan ran — so a revert on a database that never gained a
      // second chain is exact.
      expect(row.payout_account_id).toBe(`${DEVNET}:${PAYOUT}`);
    });

    it('down() recreates the TIGHTENED constraint, and the database refuses the half-state', async () => {
      const organizationId = randomUUID();
      await context.registerProvider({ organizationId, payoutAccountId: null });
      await insertEnrolment({ organizationId, chainId: DEVNET });

      await run('up');
      await run('down');

      expect(await payoutConstraint()).toMatch(/num_nonnulls/);

      // The mutation violates exactly ONE thing: `num_nonnulls` goes 3 → 2. The
      // row keeps a valid CAIP-10 address and its proof, there is no unique
      // index on the column, and no other constraint on `providers` mentions
      // it — so a pass here could only mean this constraint is missing or
      // written loose. Under the ORIGINAL two-column form this UPDATE succeeds,
      // which is the trap being closed: such a row aborts the enrolment backfill
      // naming `payout_proved_at` instead of naming the provider.
      await expect(
        context.dataSource.query(
          `UPDATE providers SET payout_proved_at = NULL WHERE organization_id = $1`,
          [organizationId],
        ),
      ).rejects.toThrow(/chk_providers_payout_proved_together/);

      // And the whole state is still accepted, so this is a three-column
      // all-or-nothing rule and not a column that became NOT NULL.
      await expect(
        context.dataSource.query(
          `UPDATE providers SET payout_account_id = NULL, payout_proof = NULL,
                                payout_proved_at = NULL
             WHERE organization_id = $1`,
          [organizationId],
        ),
      ).resolves.toBeDefined();
    });
  });
});
