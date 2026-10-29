import { randomUUID } from 'node:crypto';
import { DataSource, DataSourceOptions } from 'typeorm';

import { PostgresDataSource } from '@database/postgres/postgres.data-source';
import { PublicReceiptReadRepository } from '@database/postgres/repositories/public-receipt-read.repository';
import { ReceiptPrivacyService } from '@modules/account/services/receipt-privacy.service';
import { AuditLogWriter } from '@shared/audit';
import { PublicReceiptService } from '@modules/verification/public-receipt/public-receipt.service';

import { ensureTestDatabase } from '../helpers/test-database';

/**
 * The public receipt's SQL against the real schema (every migration applied),
 * with canary strings planted in every column that must never be public.
 */
describe('public receipt: real Postgres', () => {
  let ds: DataSource;
  let repo: PublicReceiptReadRepository;
  const ASSET = 'eip155:4663/erc20:0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
  const CANARY = 'CANARY-DO-NOT-LEAK';
  const org = randomUUID();
  const providerId = randomUUID();
  const toolId = randomUUID();
  let seq = Math.floor(Math.random() * 1_000_000_000);

  beforeAll(async () => {
    const database = await ensureTestDatabase(
      `${process.env.DATABASE_NAME || 'app'}_public_receipt_test`,
    );
    ds = new DataSource({ ...PostgresDataSource.options, database } as DataSourceOptions);
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });
    repo = new PublicReceiptReadRepository(ds);
    await ds.query(
      `INSERT INTO organizations (id, name) VALUES ($1, 'buyer') ON CONFLICT DO NOTHING`,
      [org],
    );
  }, 300_000);

  afterAll(async () => {
    await ds?.destroy();
  });

  /** One intent with every sensitive column set to a canary, plus a verification record with request and response. */
  async function call(opts: {
    status?: string;
    callClass?: string;
    lastError?: string | null;
    stages?: unknown;
    withRecord?: boolean;
    orgId?: string;
  }): Promise<string> {
    const id = randomUUID();
    const orgId = opts.orgId ?? org;
    await ds.query(
      `INSERT INTO payment_intents
        (id, organization_id, status, status_reason, agent_id, agent_account, provider_id, provider_account, tool_id,
         rail, asset_id, decimals, price_amount, provider_amount, platform_fee, request_hash, chain_id, expires_at,
         call_id, call_class, redemption_last_error, hold_id, voucher_signature, voucher_resource, credential_id,
         idempotency_key, redemption_tx_refs, voucher_seq)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'RAIL_B_VOUCHER',$10,6,20000,18000,2000,$11,'eip155:4663', now() + interval '1 day',
         $12,$13,$14,$15,$16,$17,$18,$19,ARRAY[$20],$21)`,
      [
        id,
        orgId,
        opts.status ?? 'SETTLED',
        `${CANARY}-status-reason`,
        randomUUID(),
        `eip155:4663:0x${'ab'.repeat(20)}`,
        providerId,
        `eip155:4663:0x${'cd'.repeat(20)}`,
        toolId,
        ASSET,
        `${CANARY}-request-hash`,
        `call-${id}`,
        opts.callClass ?? 'PAID',
        opts.lastError === undefined ? `${CANARY}-redemption-error` : opts.lastError,
        randomUUID(),
        `${CANARY}-voucher-signature`,
        `/mcp/tools/${CANARY}-resource`,
        randomUUID(),
        `${CANARY}-idempotency`,
        `${CANARY}-tx-ref`,
        String(++seq),
      ],
    );
    if (opts.withRecord !== false) {
      await ds.query(
        `INSERT INTO verification_records
          (id, organization_id, intent_id, tool_id, state, request, response, reason, stages, last_error, label_note, sample_display,
           verdict_status, decision_policy_id, decision_policy_version, evaluated_at, settled_at, settlement_outcome,
           lifecycle, label, labelled_by, labelled_at)
         VALUES ($1,$2,$3,$4,'SETTLED',$5::jsonb,$6::jsonb,$7,$8::jsonb,$9,$10,'1 in 125 calls at this price',
           'PASS', 'default', 1, now(), now(), 'SETTLE',
           'SHADOW', 'POLICY_RIGHT', $11, now())`,
        [
          randomUUID(),
          orgId,
          id,
          toolId,
          JSON.stringify({ args: `${CANARY}-request` }),
          JSON.stringify({ body: `${CANARY}-response` }),
          `${CANARY}-reason`,
          JSON.stringify(
            opts.stages ?? [
              {
                stage: 'SCHEMA',
                status: 'PASSED',
                detail: `${CANARY}-detail-1`,
                code: `${CANARY}-code`,
                score: 1,
              },
              {
                stage: 'DETERMINISTIC_RULES',
                status: 'FAILED',
                detail: `${CANARY}-detail-2`,
                note: `${CANARY}-note`,
              },
            ],
          ),
          `${CANARY}-last-error`,
          `${CANARY}-label-note`,
          `${CANARY}-labelled-by`,
        ],
      );
    }
    return id;
  }

  const EXPECTED_KEYS = [
    'asset',
    'classification',
    'collectionCause',
    'createdAt',
    'decimals',
    'hasHold',
    'holdReleased',
    'lapsed',
    'priceAmount',
    'providerId',
    'sampleDisplay',
    'settledAt',
    'stages',
    'status',
    'toolId',
    'verificationVerdict',
  ];

  it('reads one fixed set of columns, and no planted canary comes back', async () => {
    const id = await call({});
    const row = await repo.findPublicReceiptRow(id);
    expect(row).not.toBeNull();
    expect(Object.keys(row ?? {}).sort()).toEqual([...EXPECTED_KEYS].sort());
    expect(JSON.stringify(row)).not.toContain(CANARY);
    // The planted buyer and provider wallets are not in the row (the token's own asset id is public).
    expect(JSON.stringify(row)).not.toContain('ab'.repeat(20));
    expect(JSON.stringify(row)).not.toContain('cd'.repeat(20));
    // The stage text is dropped inside the query: only stage and status remain.
    expect(row?.stages).toEqual([
      { stage: 'SCHEMA', status: 'PASSED' },
      { stage: 'DETERMINISTIC_RULES', status: 'FAILED' },
    ]);
    expect(row?.priceAmount).toBe('20000');
  });

  it('the whole service answer for the same call carries no canary either', async () => {
    const id = await call({});
    const catalogue = {
      listProviders: async () => ({ providers: [{ providerId, name: 'Chainlook' }] }),
      listTools: async () => ({ tools: [{ id: toolId, name: 'check_token_risk' }] }),
    };
    const out = await new PublicReceiptService(repo, catalogue as never).read(id);
    expect(JSON.stringify(out)).not.toContain(CANARY);
    expect(out.status).toBe('CHARGED');
    expect(out.provider?.name).toBe('Chainlook');
  });

  it('a call whose organization hides receipts, a free call and an unknown id are all simply not found', async () => {
    const hiddenOrg = randomUUID();
    await ds.query(
      `INSERT INTO organizations (id, name, receipts_public) VALUES ($1, 'hidden', false)`,
      [hiddenOrg],
    );
    const hidden = await call({ orgId: hiddenOrg });
    const free = await call({ callClass: 'FREE' });
    expect(await repo.findPublicReceiptRow(hidden)).toBeNull();
    expect(await repo.findPublicReceiptRow(free)).toBeNull();
    expect(await repo.findPublicReceiptRow(randomUUID())).toBeNull();
    // Turning the switch back on makes the same call readable again.
    await ds.query(`UPDATE organizations SET receipts_public = true WHERE id = $1`, [hiddenOrg]);
    expect(await repo.findPublicReceiptRow(hidden)).not.toBeNull();
  });

  it('the cause text becomes a fixed label, and any other text becomes nothing', async () => {
    const cases: [string | null, string | null][] = [
      ['provider_forfeit:STAKE_BELOW_MINIMUM', 'FORFEITED'],
      ['uncollected:DEBT_WRITTEN_OFF', 'WRITTEN_OFF'],
      ['voided:REFUND', 'VOIDED_REFUND'],
      ['voided:DISPUTE_UPHELD', 'VOIDED_VOID'],
      ['voided:VOID', 'VOIDED_VOID'],
      [`${CANARY}-something-else`, null],
      // starts_with, not LIKE: `_` and `%` are plain characters, never wildcards.
      ['providerXforfeit:STAKE_BELOW_MINIMUM', null],
      ['uncollected%', null],
      ['xvoided:REFUND', null],
      [null, null],
    ];
    for (const [lastError, label] of cases) {
      const id = await call({ lastError });
      const row = await repo.findPublicReceiptRow(id);
      expect(row?.collectionCause).toBe(label);
      expect(JSON.stringify(row)).not.toContain(CANARY);
    }
  });

  it('a call with no verification record, or with malformed stages, still reads cleanly', async () => {
    const none = await call({ withRecord: false });
    expect((await repo.findPublicReceiptRow(none))?.stages).toEqual([]);
    expect((await repo.findPublicReceiptRow(none))?.sampleDisplay).toBeNull();
    const weird = await call({ stages: { not: 'an array', detail: CANARY } });
    const row = await repo.findPublicReceiptRow(weird);
    expect(row?.stages).toEqual([]);
    expect(JSON.stringify(row)).not.toContain(CANARY);
  });

  it('the id is a bound parameter: an injection string finds nothing and changes nothing', async () => {
    await expect(
      repo.findPublicReceiptRow("00000000-0000-0000-0000-000000000000' OR '1'='1"),
    ).rejects.toThrow();
    const count = Number((await ds.query(`SELECT count(*)::int AS n FROM payment_intents`))[0].n);
    expect(count).toBeGreaterThan(0);
  });

  it('the owner switch hides and shows receipts, and every real change is audited once', async () => {
    const owner = randomUUID();
    await ds.query(`INSERT INTO organizations (id, name) VALUES ($1, 'owner')`, [owner]);
    const privacy = new ReceiptPrivacyService(ds, new AuditLogWriter(ds));
    const actor = { type: 'user' as const, id: 'tester' };
    const id = await call({ orgId: owner });

    expect(await privacy.get(owner)).toEqual({ receiptsPublic: true });
    expect(await repo.findPublicReceiptRow(id)).not.toBeNull();

    await privacy.set(owner, false, actor);
    expect(await privacy.get(owner)).toEqual({ receiptsPublic: false });
    expect(await repo.findPublicReceiptRow(id)).toBeNull();

    await privacy.set(owner, false, actor); // no change: no second entry
    await privacy.set(owner, true, actor);
    expect(await repo.findPublicReceiptRow(id)).not.toBeNull();

    const entries: Array<{ before: unknown; after: unknown }> = await ds.query(
      `SELECT before, after FROM audit_log_entries WHERE organization_id = $1 AND action = 'receipt_privacy.updated' ORDER BY created_at`,
      [owner],
    );
    expect(entries).toEqual([
      { before: { receipts_public: true }, after: { receipts_public: false } },
      { before: { receipts_public: false }, after: { receipts_public: true } },
    ]);
  });

  it('setting the switch for an organization that does not exist is a 404 and writes nothing', async () => {
    const ghost = randomUUID();
    const privacy = new ReceiptPrivacyService(ds, new AuditLogWriter(ds));
    const error = await privacy
      .set(ghost, false, { type: 'user' as const, id: 'tester' })
      .catch((e: unknown) => e);
    expect((error as { statusCode: number }).statusCode).toBe(404);
    const entries: unknown[] = await ds.query(
      `SELECT 1 FROM audit_log_entries WHERE organization_id = $1`,
      [ghost],
    );
    expect(entries).toHaveLength(0);
  });
});
