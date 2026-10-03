import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

import { NotificationChannel, NotificationEvent } from '../ports/notification.port';

/** `GET /notification-preferences` — only the rows that override the catalogue default. */
export class NotificationPreferenceDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: NotificationEvent })
  event: NotificationEvent;

  @ApiProperty({ enum: NotificationChannel })
  channel: NotificationChannel;

  @ApiProperty()
  enabled: boolean;
}

export class UpsertNotificationPreferenceItemDto {
  @ApiProperty({ enum: NotificationEvent })
  @IsEnum(NotificationEvent)
  event: NotificationEvent;

  @ApiProperty({ enum: NotificationChannel })
  @IsEnum(NotificationChannel)
  channel: NotificationChannel;

  @ApiProperty()
  @IsBoolean()
  enabled: boolean;
}

/**
 * `PUT /notification-preferences` body — a bulk upsert.
 *
 * One request rather than one call per `(event, channel)` pair: a settings
 * screen changes several toggles at once, and one round trip means one
 * `nonSuppressible` refusal covers the whole save rather than leaving some
 * toggles applied and others rejected mid-batch.
 */
export class UpsertNotificationPreferencesBodyDto {
  @ApiProperty({ type: [UpsertNotificationPreferenceItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(256)
  @ValidateNested({ each: true })
  @Type(() => UpsertNotificationPreferenceItemDto)
  preferences: UpsertNotificationPreferenceItemDto[];
}
