import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

import { TransformToArray } from '@decorators/transform-to-array.decorator';
import { ListQueryDto } from '@shared/api';

/**
 * `GET /api/v1/notifications` — the notification feed.
 *
 * `event` and `severity` are free-form/enum-ish but not validated against a
 * fixed list here: `NotificationEntity.event` is deliberately a `varchar`
 * because the event catalogue is shared with webhooks and grows independently
 * — see the entity's class comment. Validating against a closed enum on the
 * query would make this endpoint the thing that breaks every time a new
 * webhook event ships.
 */
export class ListNotificationsQueryDto extends ListQueryDto {
  @ApiPropertyOptional({
    isArray: true,
    description: 'Event name(s) from the catalogue, e.g. `payment_intent.refunded`',
  })
  @IsOptional()
  @IsString({ each: true })
  @TransformToArray()
  event?: string[];

  @ApiPropertyOptional({ isArray: true, enum: ['INFO', 'WARNING', 'CRITICAL'] })
  @IsOptional()
  @IsString({ each: true })
  @TransformToArray()
  severity?: string[];

  @ApiPropertyOptional({ description: 'Only unread notifications' })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  unreadOnly?: boolean;
}

export class NotificationDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ description: 'From the shared event catalogue, e.g. `payment_intent.refunded`' })
  event: string;

  @ApiProperty({ enum: ['INFO', 'WARNING', 'CRITICAL'] })
  severity: string;

  @ApiProperty()
  title: string;

  @ApiProperty()
  body: string;

  @ApiPropertyOptional({ nullable: true })
  subjectType: string | null;

  @ApiPropertyOptional({ nullable: true })
  subjectId: string | null;

  @ApiProperty({ description: 'The event payload as sent to webhooks' })
  payload: Record<string, unknown>;

  @ApiPropertyOptional({ nullable: true, description: 'Null means unread' })
  readAt: Date | null;

  @ApiProperty()
  createdAt: Date;
}
