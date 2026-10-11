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
async function renderedSql(groupBy: ReceiptsSummaryGroupBy): Promise<string> {
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
      return [];
    };
    return qb;
  }) as never);
  jest
    .spyOn(repo, 'createQueryBuilder')
    .mockImplementation(((alias: string) =>
      dataSource.createQueryBuilder(PaymentIntentEntity, alias)) as never);

  await repo.summarizeReceipts('org_1', groupBy, {
    from: new Date('2026-10-01T00:00:00Z'),
    to: new Date('2026-10-12T00:00:00Z'),
  });
  return captured;
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

  it('orders every grouping by its key so a daily series is chronological', async () => {
    const sql = await renderedSql(ReceiptsSummaryGroupBy.DAY);
    expect(sql).toMatch(/ORDER BY to_char\(.*'YYYY-MM-DD'\) ASC/);
  });
});
