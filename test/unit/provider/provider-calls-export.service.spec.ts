import {
  CallExportCursor,
  CallExportRow,
  PaymentIntentRepository,
} from '@database/postgres/repositories/payment-intent.repository';
import {
  EXPORT_BATCH_SIZE,
  ProviderCallsExportService,
} from '@modules/provider/services/provider-calls-export.service';

/**
 * BUG-R17b-P-01: a wide window lost its tail.
 *
 * `created_at` is stored to the microsecond. The stream used to page with a
 * `Date` cursor (millisecond), which sorts before the row it came from, so each
 * page re-read the previous page's last row, the `rowCount` budget filled with
 * duplicates and the window's last rows were never emitted. The fake below
 * keysets on the exact microsecond string, as Postgres does.
 */
function row(index: number): CallExportRow {
  const ms = Date.UTC(2026, 9, 14, 12, 0, 0) + index; // one call per millisecond
  const micros = String(100 + (index % 900)).padStart(3, '0');
  const iso = new Date(ms).toISOString();
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    callId: `call-${index}`,
    callClass: 'PAID',
    status: 'SETTLED',
    statusReason: null,
    classification: 'DATA_RESULT',
    verificationVerdict: 'PASS',
    toolId: 'tool',
    asset: 'solana:x/token:y',
    decimals: 6,
    priceAmount: '100',
    providerAmount: '90',
    platformFee: '10',
    awaitingRedemption: false,
    credited: true,
    redemptionLastError: null,
    debtOutstanding: false,
    createdAt: new Date(ms),
    createdAtExact: iso.replace('Z', `${micros}Z`),
  };
}

function fakeRepository(rows: CallExportRow[]) {
  const cursors: Array<CallExportCursor | null> = [];
  const repository = {
    countCallsForExport: jest.fn(async () => rows.length),
    findCallsPageForExport: jest.fn(
      async (
        _providerId: string,
        _period: unknown,
        _asset: unknown,
        after: CallExportCursor | null,
        limit: number,
      ) => {
        cursors.push(after);
        return rows
          .filter(
            (candidate) =>
              after === null ||
              candidate.createdAtExact > after.createdAt ||
              (candidate.createdAtExact === after.createdAt && candidate.id > after.id),
          )
          .slice(0, limit);
      },
    ),
  };
  return { repository: repository as unknown as PaymentIntentRepository, cursors };
}

async function collect(service: ProviderCallsExportService): Promise<string[]> {
  const result = await service.prepare('provider-1', {
    from: '2026-10-14T12:00:00Z',
    to: '2026-10-14T14:00:00Z',
  } as never);
  const ids: string[] = [];
  for await (const csvRow of result.rows) ids.push(String(csvRow[1]));
  return ids;
}

describe('ProviderCallsExportService — streaming every row of a wide window', () => {
  const rows = Array.from({ length: EXPORT_BATCH_SIZE * 3 + 7 }, (_, index) => row(index));

  it('emits each row exactly once across page boundaries, tail included', async () => {
    const { repository } = fakeRepository(rows);
    const ids = await collect(new ProviderCallsExportService(repository));

    expect(ids).toHaveLength(rows.length);
    expect(new Set(ids).size).toBe(rows.length);
    expect(ids[ids.length - 1]).toBe(rows[rows.length - 1].id);
  });

  it('keysets on the exact microsecond instant, never the millisecond Date', async () => {
    const { repository, cursors } = fakeRepository(rows);
    await collect(new ProviderCallsExportService(repository));

    expect(cursors[0]).toBeNull();
    expect(cursors[1]).toEqual({
      createdAt: rows[EXPORT_BATCH_SIZE - 1].createdAtExact,
      id: rows[EXPORT_BATCH_SIZE - 1].id,
    });
    for (const cursor of cursors.slice(1)) {
      expect(typeof cursor!.createdAt).toBe('string');
      expect(cursor!.createdAt).toMatch(/\.\d{6}Z$/);
    }
  });
});

describe('ProviderCallsExportService — an upheld-report refund (BUG-R2-PRV-03)', () => {
  it('classifies it REFUNDED_UPHELD, not PAID_UNCREDITED, with its reason and share', async () => {
    const refunded = {
      ...row(0),
      credited: false,
      redemptionLastError: 'voided:DISPUTE_UPHELD',
      providerAmount: '9000',
      platformFee: '1000',
    };
    const failed = { ...row(1), credited: false, redemptionLastError: 'voided:FAIL' };
    const { repository } = fakeRepository([refunded, failed]);
    const result = await new ProviderCallsExportService(repository).prepare('provider-1', {
      from: '2026-10-14T12:00:00Z',
      to: '2026-10-14T14:00:00Z',
    } as never);
    const rows: unknown[][] = [];
    for await (const csvRow of result.rows) rows.push(csvRow as unknown[]);

    const at = (name: string) => result.header.indexOf(name);
    expect(rows[0][at('classification')]).toBe('REFUNDED_UPHELD');
    expect(rows[0][at('reason')]).toBe('voided:DISPUTE_UPHELD');
    expect(rows[0][at('provider_amount')]).toBe('9000');
    expect(rows[0][at('platform_fee')]).toBe('0');
    expect(rows[1][at('classification')]).toBe('PAID_UNCREDITED');
  });
});
