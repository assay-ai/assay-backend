import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class RevokeAgentCredentialParamsDto {
  @ApiProperty({ description: 'The agent id' })
  @IsUUID()
  agentId: string;

  @ApiProperty({ description: 'The credential id' })
  @IsUUID()
  id: string;
}
