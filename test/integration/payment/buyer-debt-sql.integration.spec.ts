import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import {
  DEBT_REFUSING_SQL,
  LapsedVoucherReplacement,
  OpenVoucherTotals,
  PaymentIntentRepository,
  VoucherAdmissionScope,
} from '@database/postgres/repositories/payment-intent.repository';
import { UNCOLLECTED_PREFIX } from '@modules/payment/constants/voucher-redemption.constants';
import { PaymentIntentStatus, PaymentRail } from '@modules/payment/ports/payment.types';

import { freshMigratedDatabase } from '../helpers/slash-prorata-context';

/**
 * Buyer debt's raw SQL against a real Postgres built from every migration:
 * `lapseRedemption`, the debt reads and counts, `replaceLapsedVoucher`,
 * `markWrittenOff` and `idx_payment_intents_open_debt`. The unit suite mocks
 * the repository; the predicates, the advisory lock and the partial index are
 * properties of the database and are only proven here.
 */
const DATABASE = 'assay_buyer_debt_sql_test';
const MIGRATION_DATABASE = 'assay_buyer_debt_migrations_test';
const CHAIN = 'eip155:84532';
const ASSET = `${CHAIN}/erc20:0x036cbd53842c5426634e7929541ec2318f3dcf7e`;
const PAYEE = `${CHAIN}:0x5555555555555555555555555555555555555555`;
const DAY_MS = 24 * 3_600_000;

describe('buyer debt SQL, against a real database', () => {
  let dataSource: DataSource;
  let payments: PaymentIntentRepository;
  let org: string;
  let payer: string;

  beforeAll(async () => {
    dataSource = await freshMigratedDatabase(DATABASE);
    payments = new PaymentIntentRepository(dataSource);
    // Seeded as rows, not through the voucher path: the foreign keys are what
    // the voucher path satisfies, and these tests are about the queries. Only
    // the foreign keys' (system) triggers are off: every trigger the
    // migrations define — the voucher_seq one above all (BUG-R17f-01) — runs.
    await dataSource.query(`ALTER TABLE payment_intents DISABLE TRIGGER ALL`);
    await dataSource.query(`ALTER TABLE payment_intents ENABLE TRIGGER USER`);
  }, 300_000);
  afterAll(async () => dataSource?.destroy());

  beforeEach(() => {
    org = randomUUID();
    const suffix = randomUUID().replace(/-/g, '').slice(0, 40).padStart(40, '0');
    payer = `${CHAIN}:0x${suffix}`;
  });

  /**
   * A served, settled rail-B call whose hold is still open: awaiting
   * redemption. Its voucher expired three hours ago — past its on-chain
   * deadline on eip155 (`expires_at` + 7,200 s grace + 120 s skew, D-24), as a
   * debt's voucher is by the time it can be replaced — unless `expiresIn` says
   * otherwise.
   */
  async function seedSettled(
    seq: number,
    expiresIn = `-3 hours`,
  ): Promise<{ id: string; holdId: string }> {
    const id = randomUUID();
    const holdId = randomUUID();
    await dataSource.query(
      `INSERT INTO payment_intents (
         id, organization_id, status, agent_id, agent_account, provider_id, provider_account,
         tool_id, rail, call_id, call_class, asset_id, decimals, price_amount, provider_amount,
         platform_fee, request_hash, chain_id, expires_at, voucher_seq, voucher_signature,
         voucher_resource_hash, voucher_issued_at, hold_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PAID', $11, 6, 1000, 800, 200,
               $12, $13, now() + $19::interval, $14, $15, $16, $17, $18)`,
      [
        id,
        org,
        PaymentIntentStatus.SETTLED,
        randomUUID(),
        payer,
        randomUUID(),
        PAYEE,
        randomUUID(),
        PaymentRail.RAIL_B_VOUCHER,
        randomUUID(),
        ASSET,
        `sha256:${'ab'.repeat(32)}`,
        CHAIN,
        String(seq),
        `0x${'12'.repeat(65)}`,
        `sha256:${'cd'.repeat(32)}`,
        String(Math.floor(Date.now() / 1000)),
        holdId,
        expiresIn,
      ],
    );
    return { id, holdId };
  }

  function scope(): VoucherAdmissionScope {
    return {
      payer,
      assetId: ASSET,
      delegate: null,
      escrowSince: new Date(),
      organizationId: org,
    };
  }

  /** The debt count a NEW voucher's admission reads under the payer's lock. Inserts nothing. */
  async function admissionDebts(): Promise<number | undefined> {
    let seen: OpenVoucherTotals | undefined;
    const refused = new Error('admission read only');
    await expect(
      payments.insertAdmittedVoucherIntent({ organizationId: org }, scope(), (open) => {
        seen = open;
        throw refused;
      }),
    ).rejects.toBe(refused);
    return seen?.debts;
  }

  function replacement(seq: number): LapsedVoucherReplacement {
    return {
      seq: String(seq),
      signature: `0x${'34'.repeat(65)}`,
      issuedAt: Math.floor(Date.now() / 1000),
      delegate: null,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      resource: '/mcp/tools/get_weather',
      resourceHash: `sha256:${'ef'.repeat(32)}`,
    };
  }

  const replace = (id: string, seq: number, reopenHoldId: string | null = null) =>
    payments.replaceLapsedVoucher(
      org,
      id,
      payer,
      replacement(seq),
      { scope: scope(), admit: () => undefined },
      reopenHoldId,
    );

  const awaiting = async () =>
    (
      await payments.findAwaitingRedemption(
        ASSET,
        PaymentIntentStatus.SETTLED,
        PaymentRail.RAIL_B_VOUCHER,
        100,
      )
    ).filter((row) => row.agentAccount === payer);

  async function row(id: string) {
    const [found] = (await dataSource.query(
      `SELECT "hold_id", "hold_released_at", "redemption_lapsed_at", "redemption_replaced_at",
              "redemption_last_error", "voucher_seq"::text AS "voucher_seq", "voucher_resource",
              "redemption_tx_refs"
         FROM payment_intents WHERE "id" = $1`,
      [id],
    )) as Array<Record<string, unknown>>;
    return found;
  }

  /** Moves a debt's first lapse into the past, so the write-off window has passed. */
  async function age(id: string, days: number): Promise<void> {
    await dataSource.query(
      `UPDATE payment_intents SET "redemption_lapsed_at" = now() - make_interval(days => $2)
        WHERE "id" = $1`,
      [id, days],
    );
  }

  /** `markWrittenOff` in its own transaction, as `releaseHoldIf` runs it. */
  async function writeOff(id: string, holdId: string, before: Date): Promise<boolean> {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const marked = await payments.markWrittenOff(
        runner,
        { organizationId: org, id, payer, holdId },
        `${UNCOLLECTED_PREFIX}VoucherExpired`,
        before,
      );
      await runner.commitTransaction();
      return marked;
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  it('lapse -> debt refused -> replace -> collected', async () => {
    const { id } = await seedSettled(1);
    expect(await awaiting()).toHaveLength(1);
    expect(await admissionDebts()).toBe(0);

    await payments.lapseRedemption(org, id, 'VoucherExpired');

    // Debt: out of the redemption queue, refusing paid calls.
    expect(await awaiting()).toHaveLength(0);
    expect(await admissionDebts()).toBe(1);
    const [debt] = await payments.findOutstandingDebts(org, payer);
    expect(debt).toMatchObject({
      id,
      cause: 'VoucherExpired',
      replacedAt: null,
      writtenOff: false,
      voucherSeq: '1',
    });
    expect(await payments.findOutstandingDebt(payer, id)).toMatchObject({ id });
    const lapsedAt = (await row(id)).redemption_lapsed_at as Date;

    // Replaced: back in the queue under the new seq, still refusing.
    expect(await replace(id, 2)).toBe(true);
    expect(await replace(id, 3)).toBe(false);
    expect((await awaiting()).map((r) => r.voucherSeq)).toEqual(['2']);
    expect(await admissionDebts()).toBe(1);
    const replaced = await row(id);
    expect(replaced.redemption_lapsed_at).toEqual(lapsedAt);
    expect(replaced.redemption_replaced_at).not.toBeNull();
    expect(replaced.redemption_last_error).toBeNull();
    expect(replaced.voucher_resource).toBe('/mcp/tools/get_weather');
    expect(replaced.redemption_tx_refs).toEqual([]);
    expect((await payments.findOutstandingDebts(org, payer))[0].replacedAt).not.toBeNull();

    // Collected: `commitRedeemedHold` closes the hold; the refusal ends.
    await dataSource.query(
      `UPDATE payment_intents SET "hold_released_at" = now() WHERE "id" = $1`,
      [id],
    );
    expect(await payments.findOutstandingDebts(org, payer)).toEqual([]);
    expect(await payments.findOutstandingDebt(payer, id)).toBeNull();
    expect(await admissionDebts()).toBe(0);
    expect(await awaiting()).toHaveLength(0);
  });

  it('a replacement that lapses again is plain debt and keeps its first lapse', async () => {
    const { id } = await seedSettled(1);
    await payments.lapseRedemption(org, id, 'VoucherExpired');
    await age(id, 10);
    const first = (await row(id)).redemption_lapsed_at as Date;

    expect(await replace(id, 2)).toBe(true);
    await payments.lapseRedemption(org, id, 'DelegateIsRevoked');

    const again = await row(id);
    expect(again.redemption_lapsed_at).toEqual(first);
    expect(again.redemption_replaced_at).toBeNull();
    expect(await awaiting()).toHaveLength(0);
    expect(await payments.findDueForWriteOff(new Date(Date.now() - 5 * DAY_MS), 100)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id })]),
    );
  });

  describe('BUG-R17f-01: the voucher_seq trigger, with the real triggers on', () => {
    const IMMUTABLE = /voucher_seq is immutable/;
    const setSeq = (id: string, seq: number, replacedAt: 'now()' | 'NULL' = 'now()') =>
      dataSource.query(
        `UPDATE payment_intents
            SET "voucher_seq" = $2, "redemption_replaced_at" = ${replacedAt}
          WHERE "id" = $1`,
        [id, String(seq)],
      );
    const seqOf = async (id: string) => (await row(id)).voucher_seq;

    it('is installed by 1760900000000, made per chain by 1762400000070, and enabled', async () => {
      const [trigger] = (await dataSource.query(
        `SELECT t.tgenabled, p.prosrc
           FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE t.tgname = 'trg_payment_intents_voucher_seq_immutable'`,
      )) as Array<{ tgenabled: string; prosrc: string }>;
      expect(trigger.tgenabled).toBe('O');
      expect(trigger.prosrc).toContain('redemption_lapsed_at');
      // eip155: grace 7,200 s + skew 120 s (D-24); Solana keeps 1,800 + 120.
      expect(trigger.prosrc).toContain("interval '7320 seconds'");
      expect(trigger.prosrc).toContain("interval '1920 seconds'");
    });

    it('refuses a seq change on a voucher that is not a lapsed debt', async () => {
      const { id } = await seedSettled(1);
      await expect(setSeq(id, 2)).rejects.toThrow(IMMUTABLE);
      await expect(setSeq(id, 2, 'NULL')).rejects.toThrow(IMMUTABLE);
      expect(await seqOf(id)).toBe('1');
    });

    it('refuses a seq change on a debt outside the replacement UPDATE', async () => {
      const { id } = await seedSettled(1);
      await payments.lapseRedemption(org, id, 'VoucherExpired');
      // Not marked as a replacement.
      await expect(setSeq(id, 2, 'NULL')).rejects.toThrow(IMMUTABLE);
      // Clearing the seq.
      await expect(
        dataSource.query(`UPDATE payment_intents SET "voucher_seq" = NULL WHERE "id" = $1`, [id]),
      ).rejects.toThrow(IMMUTABLE);
      expect(await seqOf(id)).toBe('1');
    });

    it('refuses a lower or equal replacement seq', async () => {
      const { id } = await seedSettled(5);
      await payments.lapseRedemption(org, id, 'VoucherExpired');
      await expect(setSeq(id, 4)).rejects.toThrow(IMMUTABLE);
      await expect(replace(id, 3)).rejects.toThrow(IMMUTABLE);
      expect(await seqOf(id)).toBe('5');
      expect((await row(id)).redemption_replaced_at).toBeNull();
    });

    it('refuses to change the seq of a debt already being replaced', async () => {
      const { id } = await seedSettled(1);
      await payments.lapseRedemption(org, id, 'VoucherExpired');
      expect(await replace(id, 2)).toBe(true);
      await expect(setSeq(id, 3)).rejects.toThrow(IMMUTABLE);
      expect(await seqOf(id)).toBe('2');
    });

    it('refuses to replace a debt whose old voucher is still inside its on-chain window', async () => {
      // Lapsed early (e.g. a permanent refusal) — expired ten minutes ago, so
      // redeemable on chain (eip155, D-24) for another 110 minutes: a
      // replacement would let the buyer be charged twice.
      const { id } = await seedSettled(1, '-10 minutes');
      await payments.lapseRedemption(org, id, 'EscrowWindowLimitExceeded');
      await expect(replace(id, 2)).rejects.toMatchObject({ driverError: { code: '23514' } });
      expect(await seqOf(id)).toBe('1');
      expect((await row(id)).redemption_replaced_at).toBeNull();

      // Past Solana's expires_at + 1,920 s it is still refused on eip155 ...
      await dataSource.query(
        `UPDATE payment_intents SET "expires_at" = now() - interval '1921 seconds' WHERE "id" = $1`,
        [id],
      );
      await expect(replace(id, 2)).rejects.toMatchObject({ driverError: { code: '23514' } });

      // ... and past expires_at + 7,320 s it goes through.
      await dataSource.query(
        `UPDATE payment_intents SET "expires_at" = now() - interval '7321 seconds' WHERE "id" = $1`,
        [id],
      );
      expect(await replace(id, 2)).toBe(true);
      expect(await seqOf(id)).toBe('2');
    });
  });

  it('counts the debts of the payer account and of the organization, nobody else', async () => {
    const { id } = await seedSettled(1);
    await payments.lapseRedemption(org, id, 'VoucherExpired');
    const ownOrg = org;
    const ownPayer = payer;

    // Another payer account of the same organization sees the organization's debt.
    payer = `${CHAIN}:0x${randomUUID().replace(/-/g, '').padStart(40, '7')}`;
    expect(await admissionDebts()).toBe(1);
    expect((await payments.findOutstandingDebts(org, payer)).map((d) => d.id)).toEqual([id]);

    // Another organization paying from the same account sees the account's debt.
    org = randomUUID();
    payer = ownPayer;
    expect(await admissionDebts()).toBe(1);

    // An unrelated organization and account see nothing.
    payer = `${CHAIN}:0x${randomUUID().replace(/-/g, '').padStart(40, '8')}`;
    expect(await admissionDebts()).toBe(0);
    expect(await payments.findOutstandingDebts(org, payer)).toEqual([]);
    expect(await payments.findOutstandingDebts(ownOrg, ownPayer)).toHaveLength(1);
  });

  it('two write-offs racing for one debt: exactly one marks it', async () => {
    const { id, holdId } = await seedSettled(1);
    await payments.lapseRedemption(org, id, 'VoucherExpired');
    await age(id, 31);
    const before = new Date(Date.now() - 30 * DAY_MS);
    expect((await payments.findDueForWriteOff(before, 100)).map((d) => d.id)).toContain(id);

    const results = await Promise.all([writeOff(id, holdId, before), writeOff(id, holdId, before)]);
    expect(results.filter(Boolean)).toHaveLength(1);

    const closed = await row(id);
    expect(closed.hold_released_at).not.toBeNull();
    expect(closed.redemption_last_error).toBe(`${UNCOLLECTED_PREFIX}VoucherExpired`);
    expect((await payments.findDueForWriteOff(before, 100)).map((d) => d.id)).not.toContain(id);
    // H1 interim: a written-off debt still refuses paid calls.
    expect(await admissionDebts()).toBe(1);
    expect(await payments.findOutstandingDebts(org, payer)).toEqual([
      expect.objectContaining({ id, writtenOff: true }),
    ]);
  });

  it('does not write off a debt younger than the window, nor one with another hold', async () => {
    const { id, holdId } = await seedSettled(1);
    await payments.lapseRedemption(org, id, 'VoucherExpired');
    await age(id, 5);
    const before = new Date(Date.now() - 30 * DAY_MS);

    expect(await writeOff(id, holdId, before)).toBe(false);
    await age(id, 31);
    expect(await writeOff(id, randomUUID(), before)).toBe(false);
    expect((await row(id)).hold_released_at).toBeNull();
    expect(await writeOff(id, holdId, before)).toBe(true);
  });

  it('a write-off never closes a debt the buyer replaced', async () => {
    const { id, holdId } = await seedSettled(1);
    await payments.lapseRedemption(org, id, 'VoucherExpired');
    await age(id, 31);
    const before = new Date(Date.now() - 30 * DAY_MS);

    expect(await replace(id, 2)).toBe(true);
    expect(await payments.findDueForWriteOff(before, 100)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id })]),
    );
    expect(await writeOff(id, holdId, before)).toBe(false);
    const kept = await row(id);
    expect(kept.hold_released_at).toBeNull();
    expect(kept.redemption_last_error).toBeNull();
  });

  it('a replacement waits for a write-off holding the lock, then re-signs only with a new hold', async () => {
    const { id, holdId } = await seedSettled(1);
    await payments.lapseRedemption(org, id, 'VoucherExpired');
    await age(id, 31);
    const before = new Date(Date.now() - 30 * DAY_MS);

    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    let replaced: Promise<boolean>;
    try {
      expect(
        await payments.markWrittenOff(
          runner,
          { organizationId: org, id, payer, holdId },
          `${UNCOLLECTED_PREFIX}VoucherExpired`,
          before,
        ),
      ).toBe(true);
      // The replacement takes the same admission lock and must wait.
      let settled = false;
      replaced = replace(id, 2).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      await runner.commitTransaction();
    } finally {
      await runner.release();
    }

    // It then sees a written-off row: refused without a new hold to take.
    expect(await replaced).toBe(false);
    expect((await row(id)).redemption_last_error).toBe(`${UNCOLLECTED_PREFIX}VoucherExpired`);

    // Re-signed with a reopened hold: the row takes it and leaves debt behind on collection.
    const reopened = randomUUID();
    expect(await replace(id, 3, reopened)).toBe(true);
    const resigned = await row(id);
    expect(resigned.hold_id).toBe(reopened);
    expect(resigned.hold_released_at).toBeNull();
    expect(resigned.redemption_last_error).toBeNull();
    expect((await awaiting()).map((r) => r.voucherSeq)).toEqual(['3']);
    expect(await admissionDebts()).toBe(1);
    // A reopened hold is refused for an open (not written-off) debt.
    expect(await replace(id, 4, randomUUID())).toBe(false);
  });

  it('the debt reads use idx_payment_intents_open_debt, whose predicate is DEBT_REFUSING_SQL', async () => {
    const [index] = (await dataSource.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_payment_intents_open_debt'`,
    )) as Array<{ indexdef: string }>;
    expect(index.indexdef).toContain('redemption_lapsed_at IS NOT NULL');
    expect(index.indexdef).toContain("'uncollected:%'");

    const plan = await dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL enable_seqscan = off`);
      const rows = (await manager.query(
        `EXPLAIN SELECT "id" FROM "payment_intents"
          WHERE "organization_id" IS NOT NULL AND ${DEBT_REFUSING_SQL}
            AND ("agent_account" = $1 OR "organization_id" = $2)`,
        [payer, org],
      )) as Array<{ 'QUERY PLAN': string }>;
      return rows.map((line) => line['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain('idx_payment_intents_open_debt');
  });
});

describe('buyer debt migrations, down and up again', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = await freshMigratedDatabase(MIGRATION_DATABASE);
  }, 300_000);
  afterAll(async () => dataSource?.destroy());

  const columns = async () =>
    (
      (await dataSource.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'payment_intents'
            AND column_name IN ('redemption_last_error', 'redemption_lapsed_at',
                                'redemption_replaced_at', 'voucher_resource')
          ORDER BY column_name`,
      )) as Array<{ column_name: string }>
    ).map((c) => c.column_name);

  const indexDef = async () =>
    (
      (await dataSource.query(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_payment_intents_open_debt'`,
      )) as Array<{ indexdef: string }>
    )[0]?.indexdef ?? null;

  const last = async () =>
    (
      (await dataSource.query(`SELECT name FROM migrations ORDER BY id DESC LIMIT 1`)) as Array<{
        name: string;
      }>
    )[0].name;

  const seqTriggerSource = async () =>
    (
      (await dataSource.query(
        `SELECT prosrc FROM pg_proc WHERE proname = 'assert_voucher_seq_is_immutable'`,
      )) as Array<{ prosrc: string }>
    )[0].prosrc;

  it('reverts the migrations after 1760900000000, then 1760900000000 … 1760600000000, and reapplies them', async () => {
    // The migrations after these sit on top of them and touch none of their
    // objects: undo those first, newest first.
    const later = [
      'OperatorApprovalResult1793318400010',
      'OrganizationReceiptsPublic1793318400000',
      'ProtocolAnalyticsReadIndexes1793232000000',
      'WithdrawalBookingUniqueness1762400000150',
      'ProviderOwnerContactOptional1762400000140',
      'VerificationRecordLabels1762400000130',
      'EvmChainStateParamsChanged1762400000120',
      'DepositPendingUniqueness1762400000110',
      'EvmSlashRecordsBackfill1762400000100',
      'EvmSlashRecords1762400000090',
      'PaymentIntentRedemptionRetry1762400000080',
      'VoucherSeqDebtReplacementPerChain1762400000070',
      'AgentCredentialTokenLast41762400000062',
      'AgentCredentialPendingDelegate1762400000061',
      'AgentCredentialScopes1762400000060',
      'BindingTestRunAuthMode1762400000050',
      'PaymentIntentsCreatedIndex1762400000040',
      'ConnectUrlServerName1762400000030',
      'PaymentKeySpendIndexes1762400000020',
      'OAuthAuditSignalIndex1762400000014',
      'OAuthCodeReuseDetected1762400000013',
      'OAuthExpiryIndexes1762400000012',
      'OAuth1762400000010',
      'DropUnwrittenSlashColumns1762400000003',
      'DropDeadDisputeSchema1762400000002',
      'DropOffChainSlashObjection1762400000001',
      'DropLegacyPaymentSchema1762400000000',
      'EscrowWithdrawalEvents1762300000000',
      'ModerationCutoffPublicReason1762200000000',
      'CreateVaultKekChecks1762000000003',
      'ToolBindingAuthMode1762000000002',
      'CreateBindingCredentials1762000000001',
      'DropConnectivityEgressIps1762000000000',
      'ProviderTools1761900000000',
      'CallDisputes1761800000002',
      'VerificationRecordDisputeOutcome1761800000001',
      'PaymentIntentDisputeHold1761800000000',
      'ToolDraftIntegrity1761600000000',
      'BindingContractTerms1761500000001',
      'ToolVersions1761500000000',
      'ToolsetPublishing1761400000001',
      'OrgHandles1761400000000',
      'ReserveMetaToolNames1761300000000',
      'CallAttributionAndConnectUrls1761200000003',
      'CreateToolsets1761200000002',
      'AccessPolicyAndAgentRules1761200000001',
      'CreateTools1761200000000',
      'BindingObservations1761100000000',
      'IdempotencyKeyLiveIntents1761000000000',
    ];
    const CONCURRENT_INDEX_MIGRATIONS = new Set([
      'ProtocolAnalyticsReadIndexes1793232000000',
      'PaymentKeySpendIndexes1762400000020',
      'IdempotencyKeyLiveIntents1761000000000',
    ]);
    for (const name of later) {
      expect(await last()).toBe(name);
      // No wrapping transaction where a down() rebuilds an index CONCURRENTLY.
      await dataSource.undoLastMigration({
        transaction: CONCURRENT_INDEX_MIGRATIONS.has(name) ? 'none' : 'each',
      });
    }

    expect(await last()).toBe('VoucherSeqDebtReplacement1760900000000');
    expect(await seqTriggerSource()).toContain('redemption_lapsed_at');

    await dataSource.undoLastMigration({ transaction: 'each' });
    expect(await last()).toBe('PaymentIntentDebtReplacing1760800000000');
    expect(await seqTriggerSource()).not.toContain('redemption_lapsed_at');

    expect(await columns()).toEqual([
      'redemption_lapsed_at',
      'redemption_last_error',
      'redemption_replaced_at',
      'voucher_resource',
    ]);
    expect(await indexDef()).toContain("'uncollected:%'");

    await dataSource.undoLastMigration({ transaction: 'each' });
    expect(await last()).toBe('PaymentIntentRedemptionLapsed1760700000000');
    expect(await columns()).toEqual(['redemption_lapsed_at', 'redemption_last_error']);
    const restored = await indexDef();
    expect(restored).toContain('hold_released_at IS NULL');
    expect(restored).not.toContain('uncollected');

    await dataSource.undoLastMigration({ transaction: 'each' });
    expect(await last()).toBe('PaymentIntentRedemptionLastError1760600000000');
    expect(await columns()).toEqual(['redemption_last_error']);
    expect(await indexDef()).toBeNull();

    await dataSource.undoLastMigration({ transaction: 'each' });
    expect(await columns()).toEqual([]);

    const applied = await dataSource.runMigrations({ transaction: 'each' });
    expect(applied.map((m) => m.name)).toEqual([
      'PaymentIntentRedemptionLastError1760600000000',
      'PaymentIntentRedemptionLapsed1760700000000',
      'PaymentIntentDebtReplacing1760800000000',
      'VoucherSeqDebtReplacement1760900000000',
      ...[...later].reverse(),
    ]);
    expect(await seqTriggerSource()).toContain('redemption_lapsed_at');
    expect(await columns()).toEqual([
      'redemption_lapsed_at',
      'redemption_last_error',
      'redemption_replaced_at',
      'voucher_resource',
    ]);
    expect(await indexDef()).toContain("'uncollected:%'");
  });
});
