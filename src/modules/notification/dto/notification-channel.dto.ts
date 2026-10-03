import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

import { NotificationChannel } from '../ports/notification.port';

/** `GET /notification-channels` — one row per configured destination. */
export class NotificationChannelDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: NotificationChannel })
  channel: NotificationChannel;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Address, token or URL — `null` for `IN_APP`',
  })
  destination: string | null;

  @ApiProperty()
  enabled: boolean;

  @ApiPropertyOptional({ nullable: true, description: '`null` = unverified' })
  verifiedAt: Date | null;

  @ApiProperty()
  createdAt: Date;
}

/** `PUT /notification-channels/:channel` route param. */
export class NotificationChannelParamDto {
  @ApiProperty({ enum: NotificationChannel })
  @IsEnum(NotificationChannel)
  channel: NotificationChannel;
}

/**
 * `PUT /notification-channels/:channel` body.
 *
 * `IN_APP` is never a valid target here — the controller refuses it before
 * this DTO is even consulted, because it needs no destination and is never
 * disabled.
 */
export class UpsertNotificationChannelBodyDto {
  @ApiPropertyOptional({
    nullable: true,
    description: 'Email address, push token, Slack webhook URL, or HTTP callback',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  destination?: string | null;

  @ApiProperty()
  @IsBoolean()
  enabled: boolean;
}
