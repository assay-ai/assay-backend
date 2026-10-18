import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';
import { ToolCallsService } from '@modules/payment/services/tool-calls.service';
import { VerdictStatus } from '@modules/verification/domain/verdict';
import { SortDirection } from '@shared/api';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { fakeQueryBuilder } from './helpers/fake-query-builder';

const ORGANIZATION_ID = '11111111-1111-1111-1111-111111111111';
const INTENT_ID = '22222222-2222-2222-2222-222222222222';
const TOOL_ID = '33333333-3333-3333-3333-333333333333';
const PROVIDER_ID = '44444444-4444-4444-4444-444444444444';
const USDC = ASSET_IDS.USDC_SOLANA_DEVNET;

function baseQuery(overrides: Record<string, unknown> = {}) {
  return Object.assign({ limit: 25, order: SortDirection.DESC }, overrides) as any;
}

function intentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INTENT_ID,
    toolId: TOOL_ID,
    providerId: PROVIDER_ID,
    status: PaymentIntentStatus.SETTLED,
    assetId: USDC,
    decimals: 6,
    priceAmount: '1000000',
    createdAt: new Date('2026-08-10T10:00:00.000Z'),
    ...overrides,
  };
}

function buildHarness(rows: ReturnType<typeof intentRow>[]) {
  const fake = fakeQueryBuilder(rows);
  const paymentIntents = {
    createQueryBuilder: jest.fn().mockReturnValue(fake.qb),
    findOneBy: jest.fn(),
  };
  const verificationRecords = {
    find: jest.fn().mockResolvedValue([]),
    findByIntentId: jest.fn(),
  };

  const service = new ToolCallsService(paymentIntents as any, verificationRecords as any);
  return { service, fake, paymentIntents, verificationRecords };
}

describe('ToolCallsService.list', () => {
  it('scopes the query to the caller organization', async () => {
    const { service, fake } = buildHarness([]);
    await service.list(ORGANIZATION_ID, baseQuery());

    expect(fake.wheres[0]).toEqual({
      sql: 'intent.organizationId = :organizationId',
      params: { organizationId: ORGANIZATION_ID },
    });
  });

  it('joins verification_records so verdict can be filtered without selecting it', async () => {
    const { service, fake } = buildHarness([]);
    await service.list(ORGANIZATION_ID, baseQuery());

    expect(fake.joins).toEqual([{ alias: 'record', condition: 'record.intentId = intent.id' }]);
  });

  it('ORs repeated status values via IN', async () => {
    const { service, fake } = buildHarness([]);
    await service.list(
      ORGANIZATION_ID,
      baseQuery({ status: [PaymentIntentStatus.SETTLED, PaymentIntentStatus.REFUNDED] }),
    );

    expect(fake.wheres).toContainEqual({
      sql: 'intent.status IN (:...statuses)',
      params: { statuses: [PaymentIntentStatus.SETTLED, PaymentIntentStatus.REFUNDED] },
    });
  });

  it('filters on toolId and providerId as scalars', async () => {
    const { service, fake } = buildHarness([]);
    await service.list(ORGANIZATION_ID, baseQuery({ toolId: TOOL_ID, providerId: PROVIDER_ID }));

    expect(fake.wheres).toContainEqual({
      sql: 'intent.toolId = :toolId',
      params: { toolId: TOOL_ID },
    });
    expect(fake.wheres).toContainEqual({
      sql: 'intent.providerId = :providerId',
      params: { providerId: PROVIDER_ID },
    });
  });

  it('filters verdict against the joined record alias', async () => {
    const { service, fake } = buildHarness([]);
    await service.list(ORGANIZATION_ID, baseQuery({ verdict: [VerdictStatus.FAIL] }));

    expect(fake.wheres).toContainEqual({
      sql: 'record.verdictStatus IN (:...verdicts)',
      params: { verdicts: [VerdictStatus.FAIL] },
    });
  });

  it('search matches on id or requestHash', async () => {
    const { service, fake } = buildHarness([]);
    await service.list(ORGANIZATION_ID, baseQuery({ search: 'abc' }));

    expect(fake.wheres).toContainEqual({
      sql: '(intent.id::text ILIKE :search OR intent.requestHash ILIKE :search)',
      params: { search: '%abc%' },
    });
  });

  it('attaches the verdict from a single batched lookup, not one query per row', async () => {
    const rows = [intentRow(), intentRow({ id: 'row-2' })];
    const { service, verificationRecords } = buildHarness(rows);
    verificationRecords.find.mockResolvedValue([
      { intentId: INTENT_ID, verdictStatus: VerdictStatus.PASS },
      { intentId: 'row-2', verdictStatus: null },
    ]);

    const page = await service.list(ORGANIZATION_ID, baseQuery());

    expect(verificationRecords.find).toHaveBeenCalledTimes(1);
    expect(page.items.find((i) => i.intentId === INTENT_ID)?.verdict).toBe(VerdictStatus.PASS);
    expect(page.items.find((i) => i.intentId === 'row-2')?.verdict).toBeNull();
  });

  it('skips the batched lookup entirely when the page is empty', async () => {
    const { service, verificationRecords } = buildHarness([]);
    await service.list(ORGANIZATION_ID, baseQuery());

    expect(verificationRecords.find).not.toHaveBeenCalled();
  });

  it('charges the listed price only when SETTLED', async () => {
    const { service } = buildHarness([intentRow({ status: PaymentIntentStatus.SETTLED })]);
    const page = await service.list(ORGANIZATION_ID, baseQuery());

    expect(page.items[0].price).toEqual({ amount: '1000000', asset: USDC, decimals: 6 });
    expect(page.items[0].charged).toEqual({ amount: '1000000', asset: USDC, decimals: 6 });
  });

  it('charges zero for every non-SETTLED status, even a terminal one', async () => {
    const { service } = buildHarness([intentRow({ status: PaymentIntentStatus.REFUNDED })]);
    const page = await service.list(ORGANIZATION_ID, baseQuery());

    expect(page.items[0].price).toEqual({ amount: '1000000', asset: USDC, decimals: 6 });
    expect(page.items[0].charged).toEqual({ amount: '0', asset: USDC, decimals: 6 });
  });
  it('M4: a SETTLED call the provider forfeited is not charged, and says so — as on the receipt', async () => {
    const { service } = buildHarness([
      intentRow({ redemptionLastError: 'provider_forfeit:PayeeBlocked' }),
    ]);
    const page = await service.list(ORGANIZATION_ID, baseQuery());

    expect(page.items[0].charged).toEqual({ amount: '0', asset: USDC, decimals: 6 });
    expect(page.items[0].forfeited).toBe(true);
    expect(page.items[0].debt).toBeNull();
  });

  it('M4: an outstanding buyer debt is charged and flagged; a written-off one is not charged', async () => {
    const { service } = buildHarness([
      intentRow({
        id: 'debt-open',
        redemptionLapsedAt: new Date(),
        holdReleasedAt: null,
        redemptionLastError: 'VoucherExpired',
      }),
      intentRow({
        id: 'debt-gone',
        redemptionLapsedAt: new Date(),
        holdReleasedAt: new Date(),
        redemptionLastError: 'uncollected:VoucherExpired',
      }),
    ]);
    const page = await service.list(ORGANIZATION_ID, baseQuery());

    expect(page.items[0]).toMatchObject({
      debt: 'OUTSTANDING',
      forfeited: false,
      charged: { amount: '1000000' },
    });
    expect(page.items[1]).toMatchObject({
      debt: 'WRITTEN_OFF',
      forfeited: false,
      refundedByReport: false,
      charged: { amount: '0' },
    });
  });

  it('flags a call refunded by an upheld report apart from a late-verdict void (B1 I4)', async () => {
    const { service } = buildHarness([
      intentRow({
        id: 'report',
        holdReleasedAt: new Date(),
        redemptionLastError: 'voided:DISPUTE_UPHELD',
      }),
      intentRow({ id: 'late', holdReleasedAt: new Date(), redemptionLastError: 'voided:REFUND' }),
      intentRow({ id: 'plain' }),
    ]);
    const page = await service.list(ORGANIZATION_ID, baseQuery());

    expect(
      page.items.map((item) => [item.debt, item.refundedByReport, item.charged.amount]),
    ).toEqual([
      ['VOIDED', true, '0'],
      ['VOIDED', false, '0'],
      [null, false, '1000000'],
    ]);
  });
});

describe('ToolCallsService.getOne', () => {
  it('returns PAYMENT_INTENT_NOT_FOUND for a cross-organization or missing id', async () => {
    const { service, paymentIntents } = buildHarness([]);
    paymentIntents.findOneBy.mockResolvedValue(null);

    await expectErrorCodeAsync(
      () => service.getOne(ORGANIZATION_ID, INTENT_ID),
      PaymentErrorCode.PAYMENT_INTENT_NOT_FOUND,
    );
  });

  it('renders the same row shape the list uses, verdict included', async () => {
    const { service, paymentIntents, verificationRecords } = buildHarness([]);
    paymentIntents.findOneBy.mockResolvedValue(intentRow());
    verificationRecords.findByIntentId.mockResolvedValue({ verdictStatus: VerdictStatus.PASS });

    const dto = await service.getOne(ORGANIZATION_ID, INTENT_ID);

    expect(dto.intentId).toBe(INTENT_ID);
    expect(dto.verdict).toBe(VerdictStatus.PASS);
    expect(paymentIntents.findOneBy).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      id: INTENT_ID,
    });
  });

  it('verdict is null when no verification record exists yet', async () => {
    const { service, paymentIntents, verificationRecords } = buildHarness([]);
    paymentIntents.findOneBy.mockResolvedValue(intentRow());
    verificationRecords.findByIntentId.mockResolvedValue(null);

    const dto = await service.getOne(ORGANIZATION_ID, INTENT_ID);
    expect(dto.verdict).toBeNull();
  });
});

describe('ToolCallsService.list — refundable=true (B7)', () => {
  const until = new Date('2026-08-10T10:59:00.000Z');
  const settledAt = new Date('2026-08-10T10:00:01.000Z');

  it('narrows the scan to rows the refund predicate could accept', async () => {
    const { service, fake } = buildHarness([]);
    await service.list(ORGANIZATION_ID, baseQuery({ refundable: true }), jest.fn());

    const sql = fake.wheres.map((where) => where.sql);
    expect(sql).toContain('intent.status = :settled');
    expect(sql).toContain('intent.holdId IS NOT NULL');
    expect(sql).toContain('intent.holdReleasedAt IS NULL');
    expect(sql).toContain('intent.disputeOutcome IS NULL');
    expect(sql.some((s) => s.includes('intent.collectableAt > :guardedNow'))).toBe(true);
  });

  it('keeps only the rows the shared check calls refundable, with their end', async () => {
    const rows = [intentRow(), intentRow({ id: 'row-2' }), intentRow({ id: 'row-3' })];
    const { service, verificationRecords } = buildHarness(rows);
    verificationRecords.find.mockResolvedValue([
      { intentId: INTENT_ID, verdictStatus: VerdictStatus.PASS, settledAt },
    ]);
    const check = jest.fn(
      async (calls: readonly { intent: { id: string }; settledAt: Date | null }[]) =>
        new Map(
          calls.map(({ intent }) => [
            intent.id,
            intent.id === INTENT_ID
              ? { refundable: true, until, reported: false }
              : intent.id === 'row-3'
                ? { refundable: true, until: null, reported: false }
                : { refundable: false, until: null, reported: false },
          ]),
        ),
    );

    const page = await service.list(
      ORGANIZATION_ID,
      baseQuery({ refundable: true }),
      check as never,
    );

    expect(page.items.map((item) => [item.intentId, item.refundableIfReportedUntil])).toEqual([
      [INTENT_ID, until],
      ['row-3', null],
    ]);
    // One batched call, with the receipt's own inputs: the record's settledAt.
    expect(check).toHaveBeenCalledTimes(1);
    expect(check.mock.calls[0][0]).toEqual([
      { intent: expect.objectContaining({ id: INTENT_ID }), settledAt },
      { intent: expect.objectContaining({ id: 'row-2' }), settledAt: null },
      { intent: expect.objectContaining({ id: 'row-3' }), settledAt: null },
    ]);
  });

  it('drops a call that already carries an open report: it cannot be reported again', async () => {
    const { service } = buildHarness([intentRow()]);
    const check = jest.fn(
      async () => new Map([[INTENT_ID, { refundable: true, until, reported: true }]]),
    );

    const page = await service.list(
      ORGANIZATION_ID,
      baseQuery({ refundable: true }),
      check as never,
    );

    expect(page.items).toEqual([]);
  });

  it('refuses rather than answer an empty list without the check', async () => {
    const { service } = buildHarness([intentRow()]);
    await expect(service.list(ORGANIZATION_ID, baseQuery({ refundable: true }))).rejects.toThrow(
      'refundable=true needs the refund eligibility check',
    );
  });

  it('never calls the check, and adds no field, on an ordinary list', async () => {
    const { service } = buildHarness([intentRow()]);
    const check = jest.fn();

    const page = await service.list(ORGANIZATION_ID, baseQuery(), check);

    expect(check).not.toHaveBeenCalled();
    expect(page.items[0]).not.toHaveProperty('refundableIfReportedUntil');
  });
});
