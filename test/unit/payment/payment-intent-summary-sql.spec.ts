import { DataSource } from 'typeorm';
import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import {
  PaymentIntentRepository,
  ReceiptsSummaryGroupBy,
} from '@database/postgres/repositories/payment-intent.repository';

/**
 * Renders `summarizeReceipts`' SQL without a database. TypeORM rewrites
 * `alias.property` in raw fragments only when a delimiter follows the path, so
 * a fragment like `intent.providerId::text` survives untouched and Postgres
 * rejects it — something no mock of the repository can catch.
 */
async function renderedSql(
  groupBy: ReceiptsSummaryGroupBy,
  raw: Record<string, string>[] = [],
): Promise<string> {
  return (await run(groupBy, raw)).sql;
}

async function run(
  groupBy: ReceiptsSummaryGroupBy,
  raw: Record<string, string>[] = [],
): Promise<{
  sql: string;
  rows: Awaited<ReturnType<PaymentIntentRepository['summarizeReceipts']>>;
}> {
  const dataSource = new DataSource({ type: 'postgres', entities: [PaymentIntentEntity] });
  // Builds entity metadata without opening a connection.
  await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();

  const repo = new PaymentIntentRepository(dataSource);
  let captured = '';
  const original = dataSource.createQueryBuilder.bind(dataSource);
  jest.spyOn(dataSource, 'createQueryBuilder').mockImplementation(((...args: unknown[]) => {
    const qb = (original as (...a: unknown[]) => any)(...args);
    qb.getRawMany = async function () {
      captured = this.getQuery();
      return raw;
    };
    return qb;
  }) as never);
  jest
    .spyOn(repo, 'createQueryBuilder')
    .mockImplementation(((alias: string) =>
      dataSource.createQueryBuilder(PaymentIntentEntity, alias)) as never);

  const rows = await repo.summarizeReceipts('org_1', groupBy, {
    from: new Date('2026-10-01T00:00:00Z'),
    to: new Date('2026-10-12T00:00:00Z'),
  });
  return { sql: captured, rows };
}

describe('PaymentIntentRepository.summarizeReceipts SQL', () => {
  it.each(Object.values(ReceiptsSummaryGroupBy))(
    'leaves no unmapped camelCase property for groupBy=%s',
    async (groupBy) => {
      const sql = await renderedSql(groupBy);
      expect(sql).not.toMatch(/intent\.[a-z]+[A-Z]/);
      expect(sql).not.toMatch(/"?intent"?\.providerid/i);
    },
  );

  it('groups by the provider_id column', async () => {
    const sql = await renderedSql(ReceiptsSummaryGroupBy.PROVIDER);
    expect(sql).toContain('intent.provider_id::text');
  });

  it('groups by the agent_id column, so calls an agent credential paid for attribute to that agent', async () => {
    const sql = await renderedSql(ReceiptsSummaryGroupBy.AGENT);
    expect(sql).toMatch(/GROUP BY "intent"\."agent_id"/);
  });

  it('groups by the credential, falling back to the agent for rows without one (U02)', async () => {
    const sql = await renderedSql(ReceiptsSummaryGroupBy.CREDENTIAL);
    expect(sql).toContain(
      "COALESCE(intent.credential_id::text, 'agent:' || intent.agent_id::text)",
    );
  });

  it('orders every grouping by its key so a daily series is chronological', async () => {
    const sql = await renderedSql(ReceiptsSummaryGroupBy.DAY);
    expect(sql).toMatch(/ORDER BY to_char\(.*'YYYY-MM-DD'\) ASC/);
  });

  it('leaves an open buyer debt out of charged and counts it as owed (R17b-B-01)', async () => {
    const sql = await renderedSql(ReceiptsSummaryGroupBy.TOOL);
    const charged = sql.slice(0, sql.indexOf('"chargedTotal"'));
    expect(charged).toContain(
      'NOT ("intent"."redemption_lapsed_at" IS NOT NULL AND "intent"."hold_released_at" IS NULL)',
    );
    expect(sql).toContain('"owedTotal"');
    expect(sql).toContain('"inProgressTotal"');
  });

  it('counts a written-off debt as owed, not as not charged (final review M2)', async () => {
    const sql = await renderedSql(ReceiptsSummaryGroupBy.TOOL);
    const owedStart = sql.indexOf('"chargedCalls"');
    const owed = sql.slice(owedStart, sql.indexOf('"owedTotal"'));
    expect(owed).toContain(
      `OR COALESCE(("intent"."redemption_last_error" LIKE 'uncollected:%'), false)`,
    );
    expect(owed).toContain(
      `NOT COALESCE(("intent"."redemption_last_error" LIKE 'provider_forfeit:%'), false)`,
    );
    expect(owed).toContain(
      `NOT COALESCE(("intent"."redemption_last_error" LIKE 'voided:%'), false)`,
    );
  });

  it('leaves a terminal call that never reserved money out of every bucket (B1 I1)', async () => {
    const sql = await renderedSql(ReceiptsSummaryGroupBy.TOOL);
    const where = sql.slice(sql.indexOf('WHERE'));
    expect(where).toContain(
      'NOT ("intent"."status" IN (:...withheldStatuses) AND "intent"."hold_id" IS NULL)',
    );
  });

  it('counts free calls by price, not by group', async () => {
    const sql = await renderedSql(ReceiptsSummaryGroupBy.TOOL);
    expect(sql).toContain('COUNT(*) FILTER (WHERE "intent"."price_amount" = 0) AS "freeCalls"');
    const { rows } = await run(ReceiptsSummaryGroupBy.TOOL, [
      {
        key: 't',
        asset: 'a',
        decimals: '6',
        calls: '4',
        listedTotal: '0',
        chargedTotal: '0',
        chargedCalls: '4',
        owedTotal: '0',
        owedCalls: '0',
        inProgressTotal: '0',
        inProgressCalls: '0',
        withheldTotal: '0',
        refundedCalls: '0',
        freeCalls: '4',
      },
    ]);
    expect(rows[0].freeCalls).toBe(4);
  });

  it('derives not charged as listed minus charged, owed and in progress', async () => {
    const { rows } = await run(ReceiptsSummaryGroupBy.TOOL, [
      {
        key: 'tool-1',
        asset: 'asset',
        decimals: '6',
        calls: '13',
        listedTotal: '3000000',
        chargedTotal: '1500000',
        chargedCalls: '7',
        owedTotal: '250000',
        owedCalls: '1',
        inProgressTotal: '0',
        inProgressCalls: '0',
        withheldTotal: '750000',
        refundedCalls: '0',
      },
    ]);
    expect(rows[0]).toMatchObject({
      chargedTotal: 1_500_000n,
      owedTotal: 250_000n,
      owedCalls: 1,
      // 3 withheld + the forfeited call + the voided debt.
      notChargedTotal: 1_250_000n,
      notChargedCalls: 5,
      withheldTotal: 750_000n,
    });
  });
});
