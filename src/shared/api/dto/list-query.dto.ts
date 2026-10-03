import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsDate, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** `asc` / `desc`, lowercase on the wire because every other query value is. */
export enum SortDirection {
  ASC = 'asc',
  DESC = 'desc',
}

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/**
 * The query envelope **every** list endpoint on this surface accepts.
 *
 * One pagination style, one filter style, one sort style — the single most
 * consequential decision in the dashboard API, because it is the one a frontend cannot
 * route around later. A surface with two pagination styles forces every client
 * to carry two list components, two "load more" behaviours and two empty
 * states, forever, and the cost lands on whoever writes the UI rather than on
 * whoever wrote the endpoint.
 *
 * ## Why cursors and not `page` / `limit`
 *
 * The repository shipped an offset `PaginationDto`, and this replaces it for
 * product endpoints. Offsets are wrong for what this API actually serves:
 *
 * - **Every collection here is an append-heavy time series** — tool calls,
 *   ledger entries, verdicts, notifications, audit records. Rows arrive at the
 *   head *while the user is paging*. With `OFFSET 20`, one new call between
 *   page 1 and page 2 pushes a row from the bottom of page 1 to the top of page
 *   2 and the user reads it twice; a deletion makes one vanish unread. On a
 *   spend history the duplicate is not cosmetic — it reads as a double charge.
 * - **`OFFSET n` is `O(n)` in Postgres.** It walks and discards. A provider
 *   auditing six months of traffic at page 900 pays for 22,500 discarded rows
 *   on every request, on the money tables.
 * - **A keyset predicate rides the index the sort already needs.** `(created_at,
 *   id) < (…, …)` on `(organization_id, created_at, id)` is a seek. Page 900
 *   costs what page 1 costs.
 *
 * What that trades away is `page=57` and a total count. Neither is free
 * elsewhere either — a total on a growing collection is a number that is stale
 * before it renders, and `COUNT(*)` is the same full scan the offset was. Where
 * a screen genuinely needs totals it reads them from the summary endpoints
 * (`/receipts/summary` and friends), which aggregate server-side and can say
 * exactly what window they counted.
 *
 * ## Why not `PaginationDto`
 *
 * List endpoints do not extend the offset `PaginationDto`, for the reasons
 * above. `PaginationDto` survives only under `src/modules/_examples/`, which is
 * reference material behind `EXAMPLES_ENABLED` and not part of the product
 * surface.
 */
export class ListQueryDto {
  @ApiPropertyOptional({
    description:
      'Opaque cursor from the previous page’s `pageInfo.nextCursor`. Omit for the first page. ' +
      'Do not construct or parse these — the encoding is not part of the contract.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @ApiPropertyOptional({
    description: 'Rows per page.',
    default: DEFAULT_PAGE_SIZE,
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  @Transform(({ value }) =>
    value === undefined || value === '' ? DEFAULT_PAGE_SIZE : Number(value),
  )
  limit: number = DEFAULT_PAGE_SIZE;

  /**
   * Left free-form here and validated per resource.
   *
   * The allowlist lives with the resource (`SortableFields`), not in this base
   * class, because "sortable" is a statement about which indexes exist. A
   * shared enum would either be the union of every resource's fields — letting
   * a caller sort verdicts by `payoutDate` — or the intersection, which is
   * empty. An unknown value raises `API_UNKNOWN_SORT_FIELD` and lists what the
   * resource does accept, so discovery does not require reading the source.
   */
  @ApiPropertyOptional({
    description:
      'Field to sort by. Each resource documents its own sortable fields; ' +
      'an unrecognised value returns `API_UNKNOWN_SORT_FIELD` listing the valid ones.',
    example: 'createdAt',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sort?: string;

  @ApiPropertyOptional({
    description:
      'Sort direction. Defaults to `desc` — newest first, which is what every list here wants.',
    enum: SortDirection,
    default: SortDirection.DESC,
  })
  @IsOptional()
  @IsIn(Object.values(SortDirection))
  order: SortDirection = SortDirection.DESC;

  @ApiPropertyOptional({
    description: 'Inclusive lower bound on the resource’s primary timestamp (ISO-8601).',
    example: '2026-08-01T00:00:00.000Z',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiPropertyOptional({
    description: 'Exclusive upper bound on the resource’s primary timestamp (ISO-8601).',
    example: '2026-09-01T00:00:00.000Z',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;

  @ApiPropertyOptional({
    description: 'Free-text match over the resource’s searchable fields.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  search?: string;
}
