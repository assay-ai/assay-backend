import { plainToInstance } from 'class-transformer';

import { ListNotificationsQueryDto } from '@modules/account/dto/list-notifications.dto';
import { NotificationsService } from '@modules/account/services/notifications.service';
import { OverviewQueryDto } from '@modules/dashboard/dto/overview.dto';
import { OverviewService } from '@modules/dashboard/services/overview.service';
import { RefundEligibilityService } from '@modules/dispute/services/refund-eligibility.service';
import { ListHoldsQueryDto } from '@modules/ledger/dto/list-holds.dto';
import { BalancesService } from '@modules/ledger/services/balances.service';
import { HoldsService } from '@modules/ledger/services/holds.service';
import { ListToolCallsQueryDto } from '@modules/payment/dto/list-tool-calls.dto';
import { ToolCallsService } from '@modules/payment/services/tool-calls.service';
import { ReceiptsSummaryGroupBy } from '@modules/verification/dto/get-receipts-summary.dto';
import { ReceiptSummaryService } from '@modules/verification/services/receipt-summary.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const AT = '2026-10-20T10:30:00.000Z';

/**
 * `GET /overview` composes; it computes nothing. Each part must be the
 * service call its own route makes, with the query that route's
 * `ValidationPipe` would have built from `useOverview`'s parameters, and the
 * result must be passed through untouched.
 */
describe('OverviewService — each part is its route’s own service call', () => {
  function build() {
    const marker = (name: string) => ({ marker: name });
    const balances = {
      getBalances: jest.fn().mockResolvedValue(marker('balances')),
      getWithheld: jest.fn().mockResolvedValue([marker('withheld')]),
    };
    const holds = { list: jest.fn().mockResolvedValue(marker('holds')) };
    const summaries = {
      getSummary: jest.fn(async (_org: string, q: { from: string; groupBy: string }) =>
        marker(`summary ${q.groupBy} ${q.from}`),
      ),
      getDailySummaries: jest.fn().mockResolvedValue(marker('daily')),
    };
    const toolCalls = { listPaid: jest.fn().mockResolvedValue(marker('calls')) };
    const refunds = { ofCalls: jest.fn().mockResolvedValue(new Map()) };
    const notifications = { list: jest.fn().mockResolvedValue(marker('notifications')) };
    const service = new OverviewService(
      balances as unknown as BalancesService,
      holds as unknown as HoldsService,
      summaries as unknown as ReceiptSummaryService,
      toolCalls as unknown as ToolCallsService,
      refunds as unknown as RefundEligibilityService,
      notifications as unknown as NotificationsService,
    );
    return { service, balances, holds, summaries, toolCalls, refunds, notifications };
  }

  const query = (plain: Record<string, string>) => plainToInstance(OverviewQueryDto, plain);

  it('asks every part for the window and query the dashboard asks for today', async () => {
    const parts = build();
    const answer = await parts.service.get(ORG, query({ at: AT }));

    expect(parts.balances.getBalances).toHaveBeenCalledWith(ORG);
    expect(parts.holds.list).toHaveBeenCalledWith(ORG, plainToInstance(ListHoldsQueryDto, {}));
    expect(parts.balances.getWithheld).toHaveBeenCalledWith(ORG, {
      from: new Date('2026-10-01T00:00:00.000Z'),
      to: new Date('2026-11-01T00:00:00.000Z'),
    });
    expect(parts.summaries.getSummary.mock.calls).toEqual([
      [
        ORG,
        {
          from: '2026-10-01T00:00:00.000Z',
          to: '2026-11-01T00:00:00.000Z',
          groupBy: ReceiptsSummaryGroupBy.DAY,
        },
      ],
      [
        ORG,
        {
          from: '2026-10-20T00:00:00.000Z',
          to: '2026-10-21T00:00:00.000Z',
          groupBy: ReceiptsSummaryGroupBy.TOOL,
        },
      ],
      [
        ORG,
        {
          from: '2026-10-19T00:00:00.000Z',
          to: '2026-10-20T00:00:00.000Z',
          groupBy: ReceiptsSummaryGroupBy.TOOL,
        },
      ],
    ]);
    expect(parts.summaries.getDailySummaries).toHaveBeenCalledWith(ORG, {
      from: '2026-10-14T00:00:00.000Z',
      to: '2026-10-21T00:00:00.000Z',
      groupBy: ReceiptsSummaryGroupBy.TOOL,
    });
    const [org, calls, check] = parts.toolCalls.listPaid.mock.calls[0];
    expect(org).toBe(ORG);
    expect(calls).toEqual(
      plainToInstance(ListToolCallsQueryDto, { limit: '6', sort: 'createdAt', order: 'desc' }),
    );
    expect(calls.limit).toBe(6);
    // The refundable check is `/tool-calls`' own: the dispute module's predicate.
    await check([], new Date(AT));
    expect(parts.refunds.ofCalls).toHaveBeenCalledWith([], new Date(AT));
    const [, alerts] = parts.notifications.list.mock.calls[0];
    expect(alerts).toEqual(
      plainToInstance(ListNotificationsQueryDto, { limit: '50', unreadOnly: 'true' }),
    );
    expect(alerts).toMatchObject({ limit: 50, unreadOnly: true });

    // Passed through untouched.
    expect(answer).toMatchObject({
      at: AT,
      balances: { marker: 'balances' },
      holds: { marker: 'holds' },
      withheld: { withheld: [{ marker: 'withheld' }] },
      monthSummary: { marker: 'summary day 2026-10-01T00:00:00.000Z' },
      todaySummary: { marker: 'summary tool 2026-10-20T00:00:00.000Z' },
      yesterdaySummary: { marker: 'summary tool 2026-10-19T00:00:00.000Z' },
      chart: { marker: 'daily' },
      recentCalls: { marker: 'calls' },
      notifications: { marker: 'notifications' },
    });
    expect(answer.windows.days).toHaveLength(7);
  });

  it('names the asset on every summary, and only when given', async () => {
    const parts = build();
    const asset =
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    await parts.service.get(ORG, query({ at: AT, asset }));
    for (const [, q] of parts.summaries.getSummary.mock.calls) expect(q).toMatchObject({ asset });
    expect(parts.summaries.getDailySummaries.mock.calls[0][1]).toMatchObject({ asset });

    const without = build();
    await without.service.get(ORG, query({ at: AT }));
    for (const [, q] of without.summaries.getSummary.mock.calls)
      expect(q).not.toHaveProperty('asset');
  });

  it('takes the limits it is given', async () => {
    const parts = build();
    await parts.service.get(ORG, query({ at: AT, callsLimit: '2', alertsLimit: '9' }));
    expect(parts.toolCalls.listPaid.mock.calls[0][1]).toMatchObject({ limit: 2 });
    expect(parts.notifications.list.mock.calls[0][1]).toMatchObject({ limit: 9 });
  });

  it('anchors on now when no anchor is given', async () => {
    jest.useFakeTimers({ now: new Date('2026-12-31T23:59:59.999Z'), doNotFake: ['nextTick'] });
    try {
      const answer = await build().service.get(ORG, query({}));
      expect(answer.at).toBe('2026-12-31T23:59:59.999Z');
      expect(answer.windows.month.to).toBe('2027-01-01T00:00:00.000Z');
    } finally {
      jest.useRealTimers();
    }
  });

  it('refuses an anchor Date cannot read with a 400, not a RangeError', async () => {
    const parts = build();
    await expect(
      parts.service.get(ORG, Object.assign(new OverviewQueryDto(), { at: '2026-W43' })),
    ).rejects.toMatchObject({ errorCode: 'API_INVALID_FILTER' });
    expect(parts.balances.getBalances).not.toHaveBeenCalled();
  });

  it('fails as a whole when a part fails, as the dashboard’s Promise.all does', async () => {
    const parts = build();
    const refusal = new Error('VERIFICATION_SUMMARY_MULTIPLE_ASSETS');
    parts.summaries.getSummary.mockRejectedValueOnce(refusal);
    await expect(parts.service.get(ORG, query({ at: AT }))).rejects.toBe(refusal);
  });
});
