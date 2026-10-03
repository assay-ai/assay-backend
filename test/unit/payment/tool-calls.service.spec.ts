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
