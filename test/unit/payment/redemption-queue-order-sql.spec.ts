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
async function rendered(): Promise<{ sql: string; params: Record<string, unknown> }> {
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

  await repo.findAwaitingRedemption('eip155:46630/erc20:0xabc', 'SETTLED', 'RAIL_B_VOUCHER', 100);
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
});
