import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsISO8601, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

import { HoldDto } from '@modules/ledger/dto/list-holds.dto';
import { GetBalancesResponseDto } from '@modules/ledger/dto/get-balances.dto';
import { GetWithheldResponseDto } from '@modules/ledger/dto/get-withheld.dto';
import { NotificationDto } from '@modules/account/dto/list-notifications.dto';
import { ToolCallDto } from '@modules/payment/dto/list-tool-calls.dto';
import {
  DailyReceiptsSummaryResponseDto,
  GetReceiptsSummaryResponseDto,
} from '@modules/verification/dto/get-receipts-summary.dto';
import { CursorPageDto, MAX_PAGE_SIZE } from '@shared/api';

/** What the Overview asks for today: six recent calls, one page of fifty alerts. */
export const OVERVIEW_DEFAULT_CALLS = 6;
export const OVERVIEW_DEFAULT_ALERTS = 50;

const toLimit =
  (fallback: number) =>
  ({ value }: { value: unknown }) =>
    value === undefined || value === '' ? fallback : Number(value);

/** `GET /overview`. */
export class OverviewQueryDto {
  @ApiPropertyOptional({
    description:
      'ISO 8601. The instant the windows are computed from (the dashboard sends its own ' +
      'anchor). Defaults to now.',
    example: '2026-08-19T10:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  at?: string;

  @ApiPropertyOptional({
    description:
      'CAIP-19 asset id, passed to every receipts summary in the response — required, as on ' +
      '`/receipts/summary`, when a window spans more than one asset',
  })
  @IsOptional()
  @IsString()
  asset?: string;

  @ApiPropertyOptional({ default: OVERVIEW_DEFAULT_CALLS, minimum: 1, maximum: MAX_PAGE_SIZE })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  @Transform(toLimit(OVERVIEW_DEFAULT_CALLS))
  callsLimit: number = OVERVIEW_DEFAULT_CALLS;

  @ApiPropertyOptional({ default: OVERVIEW_DEFAULT_ALERTS, minimum: 1, maximum: MAX_PAGE_SIZE })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  @Transform(toLimit(OVERVIEW_DEFAULT_ALERTS))
  alertsLimit: number = OVERVIEW_DEFAULT_ALERTS;
}

export class OverviewWindowDto {
  @ApiProperty({ description: 'ISO 8601, inclusive' })
  from: string;

  @ApiProperty({ description: 'ISO 8601, exclusive' })
  to: string;
}

export class OverviewDayWindowDto extends OverviewWindowDto {
  @ApiProperty({ example: '2026-08-19' })
  key: string;
}

export class OverviewWindowsDto {
  @ApiProperty({ type: OverviewWindowDto, description: 'The anchor’s UTC month' })
  month: OverviewWindowDto;

  @ApiProperty({ type: OverviewWindowDto, description: 'The anchor’s UTC day' })
  today: OverviewWindowDto;

  @ApiProperty({ type: OverviewWindowDto, description: 'The UTC day before' })
  yesterday: OverviewWindowDto;

  @ApiProperty({ type: [OverviewDayWindowDto], description: '7 UTC days ending today' })
  days: OverviewDayWindowDto[];
}

/**
 * Every part is the response of the route named beside it, for the windows in
 * `windows`, produced by that route's own service call.
 */
export class OverviewResponseDto {
  @ApiProperty({ description: 'ISO 8601. The anchor the windows were computed from' })
  at: string;

  @ApiProperty({ type: OverviewWindowsDto })
  windows: OverviewWindowsDto;

  @ApiProperty({ type: GetBalancesResponseDto, description: '`GET /balances`' })
  balances: GetBalancesResponseDto;

  @ApiProperty({ description: '`GET /holds` — CursorPage<HoldDto>' })
  holds: CursorPageDto<HoldDto>;

  @ApiProperty({
    type: GetWithheldResponseDto,
    description: '`GET /withheld?from=<month.from>&to=<month.to>`',
  })
  withheld: GetWithheldResponseDto;

  @ApiProperty({
    type: GetReceiptsSummaryResponseDto,
    description: '`GET /receipts/summary` over the month, `groupBy=day`',
  })
  monthSummary: GetReceiptsSummaryResponseDto;

  @ApiProperty({
    type: GetReceiptsSummaryResponseDto,
    description: '`GET /receipts/summary` over today, `groupBy=tool`',
  })
  todaySummary: GetReceiptsSummaryResponseDto;

  @ApiProperty({
    type: GetReceiptsSummaryResponseDto,
    description: '`GET /receipts/summary` over yesterday, `groupBy=tool`',
  })
  yesterdaySummary: GetReceiptsSummaryResponseDto;

  @ApiProperty({
    type: DailyReceiptsSummaryResponseDto,
    description: '`GET /receipts/summary/daily` over `days`, `groupBy=tool`',
  })
  chart: DailyReceiptsSummaryResponseDto;

  @ApiProperty({
    description: '`GET /tool-calls?limit=<callsLimit>&sort=createdAt&order=desc`',
  })
  recentCalls: CursorPageDto<ToolCallDto>;

  @ApiProperty({
    description:
      '`GET /notifications?limit=<alertsLimit>&unreadOnly=true` — the first page; read on ' +
      'with its `nextCursor`',
  })
  notifications: CursorPageDto<NotificationDto>;
}
