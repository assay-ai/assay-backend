import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class TriggerDemoPingDto {
  @ApiProperty({
    description: 'Arbitrary payload echoed back by the demo processor logs',
    required: false,
    default: 'hello',
  })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  message?: string;
}
