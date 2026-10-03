import { ApiProperty } from '@nestjs/swagger';

export class HealthcheckResponseDto {
  @ApiProperty({ description: 'Whether the healthcheck was successful' })
  success: boolean;
  @ApiProperty({ description: 'The message from the healthcheck' })
  message: string;
}
