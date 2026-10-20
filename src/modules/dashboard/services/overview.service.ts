import { Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';

import { ListNotificationsQueryDto } from '@modules/account/dto/list-notifications.dto';
import { NotificationsService } from '@modules/account/services/notifications.service';
import { RefundEligibilityService } from '@modules/dispute/services/refund-eligibility.service';
import { ListHoldsQueryDto } from '@modules/ledger/dto/list-holds.dto';
import { BalancesService } from '@modules/ledger/services/balances.service';
import { HoldsService } from '@modules/ledger/services/holds.service';
import { ListToolCallsQueryDto } from '@modules/payment/dto/list-tool-calls.dto';
import { ToolCallsService } from '@modules/payment/services/tool-calls.service';
import { ReceiptsSummaryGroupBy } from '@modules/verification/dto/get-receipts-summary.dto';
import { ReceiptSummaryService } from '@modules/verification/services/receipt-summary.service';

import { OverviewWindow, overviewWindows } from '../domain/overview-windows';
import { OverviewQueryDto, OverviewResponseDto } from '../dto/overview.dto';

/**
 * `GET /overview` — what the buyer Overview loads every 30 s, in one request.
 *
 * Composition only. Every part is the service call the route it stands for
 * makes, with the query that route would have received: list queries are
 * built with `plainToInstance` from the strings a query string carries, which
 * is what the global `ValidationPipe` does, so their defaults are the route's
 * own. No figure is computed here, so none can drift from its route.
 *
 * The parts are independent and run in parallel; any one failing fails the
 * whole, as the dashboard's `Promise.all` does today.
 */
@Injectable()
export class OverviewService {
  constructor(
    private readonly balances: BalancesService,
    private readonly holds: HoldsService,
    private readonly summaries: ReceiptSummaryService,
    private readonly toolCalls: ToolCallsService,
    private readonly refunds: RefundEligibilityService,
    private readonly notifications: NotificationsService,
  ) {}

  async get(organizationId: string, query: OverviewQueryDto): Promise<OverviewResponseDto> {
    const at = query.at ? new Date(query.at) : new Date();
    const windows = overviewWindows(at);
    const asset = query.asset !== undefined ? { asset: query.asset } : {};
    const summary = (window: OverviewWindow, groupBy: ReceiptsSummaryGroupBy) =>
      this.summaries.getSummary(organizationId, { ...window, groupBy, ...asset });
    const days = windows.days;

    const [
      balances,
      holds,
      withheld,
      monthSummary,
      todaySummary,
      yesterdaySummary,
      chart,
      recentCalls,
      notifications,
    ] = await Promise.all([
      // GET /balances
      this.balances.getBalances(organizationId),
      // GET /holds
      this.holds.list(organizationId, plainToInstance(ListHoldsQueryDto, {})),
      // GET /withheld?from&to — as `WithheldController` passes them.
      this.balances
        .getWithheld(organizationId, {
          from: new Date(windows.month.from),
          to: new Date(windows.month.to),
        })
        .then((rows) => ({ withheld: rows })),
      // GET /receipts/summary, three windows of their own.
      summary(windows.month, ReceiptsSummaryGroupBy.DAY),
      summary(windows.today, ReceiptsSummaryGroupBy.TOOL),
      summary(windows.yesterday, ReceiptsSummaryGroupBy.TOOL),
      // GET /receipts/summary/daily: the chart's 7 per-day summaries.
      this.summaries.getDailySummaries(organizationId, {
        from: days[0].from,
        to: days[days.length - 1].to,
        groupBy: ReceiptsSummaryGroupBy.TOOL,
        ...asset,
      }),
      // GET /tool-calls?limit&sort=createdAt&order=desc — as `ToolCallsController` calls it.
      this.toolCalls.list(
        organizationId,
        plainToInstance(ListToolCallsQueryDto, {
          limit: String(query.callsLimit),
          sort: 'createdAt',
          order: 'desc',
        }),
        (calls, now) => this.refunds.ofCalls(calls, now),
      ),
      // GET /notifications?limit&unreadOnly=true
      this.notifications.list(
        organizationId,
        plainToInstance(ListNotificationsQueryDto, {
          limit: String(query.alertsLimit),
          unreadOnly: 'true',
        }),
      ),
    ]);

    return {
      at: at.toISOString(),
      windows: {
        month: windows.month,
        today: windows.today,
        yesterday: windows.yesterday,
        days: [...days],
      },
      balances,
      holds,
      withheld,
      monthSummary,
      todaySummary,
      yesterdaySummary,
      chart,
      recentCalls,
      notifications,
    };
  }
}
