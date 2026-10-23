import { DataSource } from 'typeorm';
import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';

/**
 * Renders `findAwaitingRedemption`'s SQL without a database, the way
 * `payment-intent-summary-sql.spec.ts` does for the receipts summary.
 *
 * REGRESSION (review 2026-10-15 P-4): the queue read SETTLED rows only, so seq
 * n+1 was redeemed while seq n of the same payer was still being verified —
 * and seq n then died on `VoucherSeqNotIncreasing` and was paid by the
 * platform. A row now waits while a LOWER seq of its payer is still open.
 */
async function rendered(
  exclude?: Parameters<PaymentIntentRepository['findAwaitingRedemption']>[4],
  options?: Parameters<PaymentIntentRepository['findAwaitingRedemption']>[5],
): Promise<{ sql: string; params: Record<string, unknown> }> {
  const dataSource = new DataSource({ type: 'postgres', entities: [PaymentIntentEntity] });
  await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();

  const repo = new PaymentIntentRepository(dataSource);
  let captured = { sql: '', params: {} as Record<string, unknown> };
  const original = dataSource.createQueryBuilder.bind(dataSource);
  jest.spyOn(dataSource, 'createQueryBuilder').mockImplementation(((...args: unknown[]) => {
    const qb = (original as (...a: unknown[]) => any)(...args);
    qb.getRawMany = async function () {
      captured = { sql: this.getQuery(), params: this.getParameters() };
      return [];
    };
    return qb;
  }) as never);
  jest
    .spyOn(repo, 'createQueryBuilder')
    .mockImplementation(((alias: string) =>
      dataSource.createQueryBuilder(PaymentIntentEntity, alias)) as never);
  // A chain that admits any order wraps the built query in the fair ordering
  // and sends it raw (review 2026-10-23 I-1).
  jest.spyOn(repo.manager, 'query').mockImplementation((async (text: string, values: unknown[]) => {
    captured = { sql: text, params: { ...values } };
    return [];
  }) as never);

  await repo.findAwaitingRedemption(
    'eip155:46630/erc20:0xabc',
    'SETTLED',
    'RAIL_B_VOUCHER',
    100,
    exclude,
    options,
  );
  return captured;
}

describe('PaymentIntentRepository.findAwaitingRedemption — seq order', () => {
  it('holds a row back while a lower seq of the same payer is still open', async () => {
    const { sql, params } = await rendered();
    const guard = sql.replace(/\s+/g, ' ');
    expect(guard).toMatch(
      /NOT EXISTS \( SELECT 1 FROM payment_intents earlier WHERE .*earlier\.agent_account = "?intent"?\.agent_account.*earlier\.voucher_seq < "?intent"?\.voucher_seq/,
    );
    expect(guard).toMatch(/earlier\.status IN \(/);
    expect(guard).toMatch(/earlier\.status = 'CREATED' AND earlier\.expires_at > now\(\)/);
    expect(Object.values(params)).toContainEqual([
      'FUNDS_SECURED',
      'PROVIDER_EXECUTING',
      'VERIFYING',
    ]);
    expect(sql).not.toMatch(/intent\.[a-z]+[A-Z]/);
  });

  /**
   * Final review N-1: a lower seq stuck in PROVIDER_EXECUTING/VERIFYING held
   * every later voucher back until the 24 h backstop, by which time each had
   * expired on chain and was absorbed. A lower voucher past its own
   * redemption window can never land, so it stops holding anything back.
   */
  it('stops holding back once the lower seq is past its own redemption window', async () => {
    const { sql } = await rendered();
    const guard = sql.replace(/\s+/g, ' ');
    // Per the lower row's OWN chain (D-24): 7,200 s on eip155, 1,800 s on Solana.
    expect(guard).toContain(
      "earlier.expires_at > now() - (CASE WHEN split_part(earlier.chain_id, ':', 1) = 'eip155' " +
        "THEN interval '7200 seconds' ELSE interval '1800 seconds' END)",
    );
  });
});

describe('PaymentIntentRepository.findAwaitingRedemption — blocked parties', () => {
  it('leaves out payer-side blocks only; a provider or payee block reaches the pass to forfeit', async () => {
    const { sql } = await rendered({
      organizationIds: ['11111111-1111-4111-8111-111111111111'],
      walletKeys: ['eip155:0xabc'],
      chainAccounts: ['eip155:46630:0xabc'],
    });
    const guard = sql.replace(/\s+/g, ' ');
    expect(guard).toMatch(/held\.organization_id::text = ANY\(/);
    expect(guard).toMatch(/held\.agent_account/);
    expect(guard).toMatch(/held\.voucher_delegate/);
    expect(guard).not.toMatch(/held\.provider_id/);
    expect(guard).not.toMatch(/held\.provider_account/);
  });
});

/**
 * D-23: on a chain that admits each `(payer, seq)` once in any order, a lower
 * seq never dies of a higher one landing first, so neither hold-back applies.
 */
describe('PaymentIntentRepository.findAwaitingRedemption — a chain that redeems any order', () => {
  const BLOCKS = {
    organizationIds: ['11111111-1111-4111-8111-111111111111'],
    walletKeys: ['eip155:0xabc'],
    chainAccounts: ['eip155:46630:0xabc'],
  };

  it('does not hold a row back behind a lower open seq of its payer', async () => {
    const { sql } = await rendered(undefined, { orderedBySeq: false });
    expect(sql).not.toMatch(/payment_intents earlier/);
  });

  it('leaves a row out for its OWN blocked parties only, not an earlier seq’s', async () => {
    const { sql } = await rendered(BLOCKS, { orderedBySeq: false });
    const guard = sql.replace(/\s+/g, ' ');
    expect(guard).toMatch(/held\.voucher_seq = "?intent"?\.voucher_seq/);
    expect(guard).not.toMatch(/held\.voucher_seq <= /);
  });

  it('keeps both hold-backs by default', async () => {
    const { sql } = await rendered(BLOCKS);
    const guard = sql.replace(/\s+/g, ' ');
    expect(guard).toMatch(/payment_intents earlier/);
    expect(guard).toMatch(/held\.voucher_seq <= "?intent"?\.voucher_seq/);
  });

  /**
   * Review 2026-10-23 I-1: with no hold-back, one payer or one provider could
   * fill the LIMIT with rows the chain keeps refusing as retryable. The SQL is
   * also run against Postgres in `redemption-fair-queue.integration.spec.ts`.
   */
  it('leaves out a row in its retry back-off', async () => {
    const { sql } = await rendered(undefined, { orderedBySeq: false });
    expect(sql.replace(/\s+/g, ' ')).toMatch(
      /\("intent"\."redemption_retry_at" IS NULL OR "intent"\."redemption_retry_at" <= now\(\)\)/,
    );
  });

  it('fills the batch round-robin by payer and by provider, never-refused rows first', async () => {
    const { sql, params } = await rendered(undefined, { orderedBySeq: false });
    const flat = sql.replace(/\s+/g, ' ');
    expect(flat).toContain('row_number() OVER (PARTITION BY queue."agentAccount"');
    expect(flat).toContain('row_number() OVER (PARTITION BY queue."providerAccount"');
    expect(flat).toMatch(
      /ORDER BY GREATEST\(ranked\."payerRound", ranked\."providerRound"\) ASC, \(ranked\."redemptionLastError" IS NOT NULL\) ASC, ranked\."expiresAt" ASC/,
    );
    // The batch size is the last parameter, after the inner query's own.
    const values = Object.values(params);
    expect(flat).toContain(`LIMIT $${values.length}`);
    expect(values[values.length - 1]).toBe(100);
  });

  it('keeps Solana’s queue as it was: seq order, no back-off', async () => {
    const { sql } = await rendered();
    expect(sql).not.toMatch(/redemption_retry_at/);
    expect(sql).not.toMatch(/row_number/);
  });
});

describe('PaymentIntentRepository.recordRedemptionRetry — the back-off (I-1)', () => {
  it('backs off 60 s doubling to at most 600 s, and never past the last pass', async () => {
    const dataSource = new DataSource({ type: 'postgres', entities: [PaymentIntentEntity] });
    await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
    const repo = new PaymentIntentRepository(dataSource);
    let sql = '';
    jest.spyOn(repo.manager, 'query').mockImplementation((async (text: string) => {
      sql = text.replace(/\s+/g, ' ');
      return [];
    }) as never);
    await repo.recordRedemptionRetry('org', 'id');
    expect(sql).toContain('"redemption_attempts" = "redemption_attempts" + 1');
    expect(sql).toContain(
      "now() + LEAST(interval '600 seconds', interval '60 seconds' * power(2, LEAST(\"redemption_attempts\", 4)))",
    );
    expect(sql).toContain(
      `GREATEST(now(), "expires_at" + (CASE WHEN split_part("chain_id", ':', 1) = 'eip155' ` +
        `THEN interval '7200 seconds' ELSE interval '1800 seconds' END) - interval '60 seconds')`,
    );
  });
});

describe('PaymentIntentRepository.findAwaitingRedemption — buyer debt', () => {
  it('M4: takes back a debt whose replacement was accepted, and no other debt', async () => {
    const { sql } = await rendered();
    const flat = sql.replace(/\s+/g, ' ');
    expect(flat).toMatch(
      /\("intent"\."redemption_lapsed_at" IS NULL OR "intent"\."redemption_replaced_at" IS NOT NULL\)/,
    );
  });

  it('L2: never redeems a row closed for good (forfeit, write-off, void), released or not', async () => {
    const { sql } = await rendered();
    const flat = sql.replace(/\s+/g, ' ');
    expect(flat).toMatch(
      /"intent"\."redemption_last_error" IS NULL OR NOT \("intent"\."redemption_last_error" LIKE 'provider_forfeit:%' OR "intent"\."redemption_last_error" LIKE 'uncollected:%' OR "intent"\."redemption_last_error" LIKE 'voided:%'\)/,
    );
  });
});

/**
 * D-24: `AssayEscrow` redeems until `expiresAt + 7200`, the Solana program
 * until `expiresAt + 1800`. The unsettled-voucher read decides "still
 * redeemable" and the redeemable-until instant per row, on the row's own
 * `chain_id`, rather than with one grace for both chains.
 */
describe('PaymentIntentRepository.unsettledVouchers — the per-chain grace', () => {
  const PER_CHAIN_GRACE =
    `(CASE WHEN split_part("chain_id", ':', 1) = 'eip155' ` +
    `THEN interval '7200 seconds' ELSE interval '1800 seconds' END)`;

  async function rendered(): Promise<{ sql: string; result: unknown }> {
    const dataSource = new DataSource({ type: 'postgres', entities: [PaymentIntentEntity] });
    await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
    const repo = new PaymentIntentRepository(dataSource);
    let sql = '';
    jest.spyOn(repo.manager, 'query').mockImplementation((async (text: string) => {
      sql = text;
      return [
        {
          count: 1,
          total: '5',
          largest: '5',
          redeemableUntil: new Date('2026-10-23T14:00:00Z'),
          redeemedSince: '0',
        },
      ];
    }) as never);
    const result = await repo.unsettledVouchers({
      payer: 'eip155:46630:0xabc',
      assetId: 'eip155:46630/erc20:0xabc',
      since: new Date('2026-10-23T12:00:00Z'),
    });
    return { sql: sql.replace(/\s+/g, ' '), result };
  }

  it('counts a served voucher as unsettled until expires_at + its own chain grace', async () => {
    const { sql } = await rendered();
    expect(sql).toContain(`"expires_at" > now() - ${PER_CHAIN_GRACE}`);
  });

  it('computes redeemableUntil in SQL, per row, and passes it through unchanged', async () => {
    const { sql, result } = await rendered();
    expect(sql).toContain(`MAX("expires_at" + ${PER_CHAIN_GRACE}) FILTER`);
    expect(result).toMatchObject({
      count: 1,
      total: 5n,
      redeemableUntil: new Date('2026-10-23T14:00:00Z'),
    });
  });
});
