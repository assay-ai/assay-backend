import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class NotificationIdParamDto {
  @ApiProperty({ description: 'The notification id' })
  @IsUUID()
  id: string;
}
