import { ApiProperty } from '@nestjs/swagger';

/**
 * `GET /api/v1/notifications/unread-count` — deliberately its own endpoint
 * rather than a `total` bolted onto the list envelope. `backend/docs/
 * api-list-contract.md` is explicit that a page envelope carries no count: a
 * total on a collection that grows while it is being paged is stale before it
 * renders, and costs the full scan cursors exist to avoid. The unread badge
 * needs exactly one cheap number, served by the partial index
 * `idx_notifications_unread` (`WHERE read_at IS NULL`), which is affordable
 * precisely because it only ever counts a small set.
 */
export class UnreadCountResponseDto {
  @ApiProperty()
  count: number;
}
