import { DataSource } from 'typeorm';

import { ToolCallRecordEntity } from '@database/postgres/entities/tool-call-record.entity';
import { ReceiptsSummaryGroupBy } from '@database/postgres/repositories/payment-intent.repository';
import { ToolCallRecordRepository } from '@database/postgres/repositories/tool-call-record.repository';

/**
 * Renders `summarizeFreeCalls`' SQL without a database (BUG-AGT-01): the free
 * calls `GET /receipts/summary` counts, keyed like the paid rows.
 */
async function run(
  groupBy: ReceiptsSummaryGroupBy,
  raw: Record<string, string>[] = [],
  options: { byUtcDay?: boolean } = {},
) {
  const dataSource = new DataSource({ type: 'postgres', entities: [ToolCallRecordEntity] });
  await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();

  const repo = new ToolCallRecordRepository(dataSource);
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
      dataSource.createQueryBuilder(ToolCallRecordEntity, alias)) as never);

  const rows = await repo.summarizeFreeCalls(
    'org_1',
    groupBy,
    { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-12T00:00:00Z') },
    options,
  );
  return { sql: captured, rows };
}

describe('ToolCallRecordRepository.summarizeFreeCalls SQL', () => {
  it('counts served free calls only, in the window, grouped by tool', async () => {
    const { sql, rows } = await run(ReceiptsSummaryGroupBy.TOOL, [
      { key: 'tool-1', freeCalls: '7' },
    ]);

    expect(sql).toContain('"record"."pricing_mode" IS NOT NULL');
    expect(sql).toContain('"record"."refusal_code" IS NULL');
    expect(sql).toContain('"record"."created_at" >= :from');
    expect(sql).toContain('"record"."created_at" < :to');
    expect(sql).toContain(`GROUP BY COALESCE("record"."tool_id", 'unassigned')`);
    expect(rows).toEqual([{ key: 'tool-1', freeCalls: 7 }]);
  });

  it('never groups or orders on a literal (status), and drops an empty count', async () => {
    const { sql, rows } = await run(ReceiptsSummaryGroupBy.STATUS, [
      { key: 'FREE', freeCalls: '0' },
    ]);

    expect(sql).toContain(`'FREE' AS "key"`);
    expect(sql).not.toContain('GROUP BY');
    expect(sql).not.toContain('ORDER BY');
    expect(rows).toEqual([]);
  });

  it('byUtcDay splits by the UTC day, and carries it', async () => {
    const day = `to_char(("record"."created_at" AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;
    const { sql, rows } = await run(
      ReceiptsSummaryGroupBy.AGENT,
      [{ key: 'agent-1', freeCalls: '2', day: '2026-10-03' }],
      { byUtcDay: true },
    );

    expect(sql).toContain(`${day} AS "day"`);
    expect(sql).toContain(`GROUP BY record.agent_id::text, ${day}`);
    expect(rows).toEqual([{ key: 'agent-1', freeCalls: 2, day: '2026-10-03' }]);
  });
});
