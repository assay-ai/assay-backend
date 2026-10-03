import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

import { NotificationChannel } from '../ports/notification.port';

/** `GET /notifications/:id` route param. */
export class NotificationIdParamDto {
  @ApiProperty()
  @IsUUID()
  id: string;
}

/** One channel's outcome for one notification — `GET /notifications/:id/deliveries`. */
export class NotificationDeliveryDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: NotificationChannel })
  channel: NotificationChannel;

  @ApiProperty({ enum: ['PENDING', 'DELIVERED', 'FAILED', 'SUPPRESSED'] })
  status: string;

  @ApiProperty()
  attempts: number;

  @ApiPropertyOptional({ nullable: true })
  lastError: string | null;

  @ApiPropertyOptional({ nullable: true })
  deliveredAt: Date | null;

  @ApiProperty()
  createdAt: Date;
}
