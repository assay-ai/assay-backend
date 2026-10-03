import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class GetToolCallParamsDto {
  @ApiProperty({ description: 'The payment intent id' })
  @IsUUID()
  intentId: string;
}
