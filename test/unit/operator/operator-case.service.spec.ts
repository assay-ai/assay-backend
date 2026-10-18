import { SlashProposalEntity } from '@database/postgres/entities/slash-proposal.entity';
import { OperatorCaseService } from '@modules/operator/services/operator-case.service';
import { SlashRecordSnapshot } from '@modules/slash/ports/slash-executor.port';

/**
 * B11: the brief says whether anything of the case stands on chain, so the
 * console never claims "anyone can execute" a penalty with nothing behind it.
 */
const EVM_ASSET = 'eip155:46630/erc20:0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3';
const SOLANA_ASSET =
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr';

function build(input: {
  proposal?: Partial<SlashProposalEntity>;
  parts?: { chainStatus: string }[];
  record?: SlashRecordSnapshot['status'] | null | Error;
}) {
  const proposal = {
    id: 'case-1',
    organizationId: 'org-1',
    providerId: 'org-1',
    chainEpoch: 0,
    chainRequestId: 'r'.repeat(64),
    assetId: EVM_ASSET,
    windowId: 'window-1',
    chainStatus: 'CANCEL_REQUESTED',
    chainProposedAt: null,
    ...input.proposal,
  } as SlashProposalEntity;
  const proposals = {
    tenantOf: jest.fn(async () => 'org-1'),
    findOneScoped: jest.fn(async () => proposal),
  };
  const queue = { brief: jest.fn(async () => ({ chainStatus: proposal.chainStatus })) };
  const approvals = { register: jest.fn() };
  const parts = { findForEpoch: jest.fn(async () => input.parts ?? []) };
  const enrolments = {
    findOneBy: jest.fn(async () => ({
      stakeAuthorityAccountId: 'eip155:46630:0x00000000000000000000000000000000000000aa',
    })),
  };
  const readRecord = jest.fn(async (): Promise<SlashRecordSnapshot | null> => {
    if (input.record instanceof Error) throw input.record;
    return input.record ? ({ status: input.record } as SlashRecordSnapshot) : null;
  });
  // A sink that pages once per name+dedupeKey for ONCE_PER_INCIDENT, as the suppressing sink does.
  const pages: string[] = [];
  const seen = new Set<string>();
  const alerts = {
    emit: jest.fn(async (alert: { name: string; dedupeKey?: string; aggregation?: string }) => {
      const key = `${alert.name}:${alert.dedupeKey ?? ''}`;
      if (alert.aggregation === 'ONCE_PER_INCIDENT' && seen.has(key)) return;
      seen.add(key);
      pages.push(key);
    }),
  };
  const service = new OperatorCaseService(
    proposals as never,
    queue as never,
    {} as never,
    {} as never,
    approvals as never,
    parts as never,
    enrolments as never,
    { readRecord } as never,
    alerts as never,
  );
  return { service, readRecord, alerts, pages };
}

describe('OperatorCaseService.brief chainRecord', () => {
  const brief = (ctx: ReturnType<typeof build>) => ctx.service.brief('case-1');

  it('GONE once the chain side is closed; EXECUTED once the mirror says so', async () => {
    const closed = build({ proposal: { chainStatus: 'CANCELLED' } });
    await expect(brief(closed)).resolves.toMatchObject({
      chainRecord: 'GONE',
      chainStanding: false,
    });
    expect(closed.readRecord).not.toHaveBeenCalled();
    await expect(brief(build({ proposal: { chainStatus: 'EXECUTED' } }))).resolves.toMatchObject({
      chainRecord: 'EXECUTED',
      chainStanding: false,
    });
  });

  it('a partitioned case reads its parts', async () => {
    const cases: [string[], string][] = [
      [['CANCELLED', 'DISPUTED'], 'STANDING'],
      [['CANCELLED', 'EXECUTED'], 'EXECUTED'],
      [['CANCELLED', 'CANCELLED'], 'GONE'],
      [['CANCELLED', 'NONE'], 'UNKNOWN'],
      [['CANCELLED', 'REFUSED'], 'UNKNOWN'],
    ];
    for (const [statuses, expected] of cases) {
      const ctx = build({ parts: statuses.map((chainStatus) => ({ chainStatus })) });
      await expect(brief(ctx)).resolves.toMatchObject({ chainRecord: expected });
      expect(ctx.readRecord).not.toHaveBeenCalled();
    }
  });

  // C1: an executed part is money taken, never "nothing stands".
  it('C1: an executed part or record is EXECUTED, never GONE', async () => {
    await expect(brief(build({ parts: [{ chainStatus: 'EXECUTED' }] }))).resolves.toMatchObject({
      chainRecord: 'EXECUTED',
    });
    await expect(brief(build({ record: 'EXECUTED' }))).resolves.toMatchObject({
      chainRecord: 'EXECUTED',
      chainStanding: false,
    });
  });

  it('a window case with no parts reads its own record', async () => {
    const cancelled = build({ record: 'CANCELLED' });
    await expect(brief(cancelled)).resolves.toMatchObject({ chainRecord: 'GONE' });
    expect(cancelled.readRecord).toHaveBeenCalledWith(
      'r'.repeat(64),
      '0x00000000000000000000000000000000000000aa',
      'eip155:46630',
    );
    await expect(brief(build({ record: 'PENDING' }))).resolves.toMatchObject({
      chainRecord: 'STANDING',
      chainStanding: true,
    });
  });

  it('no record: GONE only when none was ever written, else UNKNOWN (standing)', async () => {
    await expect(brief(build({ record: null }))).resolves.toMatchObject({ chainRecord: 'GONE' });
    await expect(
      brief(
        build({ record: null, proposal: { chainProposedAt: new Date('2026-10-14T11:17:01Z') } }),
      ),
    ).resolves.toMatchObject({ chainRecord: 'UNKNOWN', chainStanding: true });
  });

  it('an unreadable chain is UNKNOWN, read as standing', async () => {
    await expect(brief(build({ record: new Error('rpc down') }))).resolves.toMatchObject({
      chainRecord: 'UNKNOWN',
      chainStanding: true,
    });
  });

  it('a slow chain read gives up after a short timeout: UNKNOWN', async () => {
    jest.useFakeTimers();
    try {
      const ctx = build({});
      ctx.readRecord.mockImplementation(() => new Promise(() => undefined));
      const pending = brief(ctx);
      await jest.advanceTimersByTimeAsync(3_000);
      await expect(pending).resolves.toMatchObject({ chainRecord: 'UNKNOWN' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('a single-record case trusts its mirror', async () => {
    const { service, readRecord } = build({
      proposal: { assetId: SOLANA_ASSET, chainStatus: 'PENDING' },
    });
    await expect(service.brief('case-1')).resolves.toMatchObject({ chainRecord: 'STANDING' });
    expect(readRecord).not.toHaveBeenCalled();
  });
});

// Round-2 R1-I1: the page says operations was alerted, so the brief itself pages it.
describe('OperatorCaseService.brief: an execution while the cancel waited is paged', () => {
  it('EXECUTED under CANCEL_REQUESTED pages once across repeated views', async () => {
    const ctx = build({ record: 'EXECUTED' });
    await ctx.service.brief('case-1');
    await ctx.service.brief('case-1');
    expect(ctx.alerts.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'CRITICAL',
        name: 'slash_executed_while_cancel_waited',
        aggregation: 'ONCE_PER_INCIDENT',
        dedupeKey: 'case-1',
      }),
    );
    expect(ctx.pages).toEqual(['slash_executed_while_cancel_waited:case-1']);
  });

  it('an executed part under CANCEL_REQUESTED pages too', async () => {
    const ctx = build({ parts: [{ chainStatus: 'EXECUTED' }] });
    await ctx.service.brief('case-1');
    expect(ctx.pages).toHaveLength(1);
  });

  it('an ordinary executed penalty (mirror EXECUTED) or a standing one pages nothing', async () => {
    const executed = build({ proposal: { chainStatus: 'EXECUTED' } });
    await executed.service.brief('case-1');
    const standing = build({ record: 'PENDING' });
    await standing.service.brief('case-1');
    expect(executed.alerts.emit).not.toHaveBeenCalled();
    expect(standing.alerts.emit).not.toHaveBeenCalled();
  });
});
