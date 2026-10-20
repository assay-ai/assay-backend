import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';

import { UNLISTED_TOKEN_RE } from './toolset-publishing.dto';

/** `POST /reports` — exactly one of `toolsetId`, `toolId`, `handle`. */
export class CreateReportBodyDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  toolsetId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  toolId?: string;

  @ApiPropertyOptional({ example: 'acme' })
  @IsOptional()
  @Matches(/^@?[a-zA-Z][a-zA-Z0-9-]{2,23}$/)
  handle?: string;

  @ApiPropertyOptional({ description: 'A link-only tool set: the token from its link' })
  @IsOptional()
  @Matches(UNLISTED_TOKEN_RE)
  unlistedToken?: string;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsString()
  @Length(3, 500)
  reason: string;
}

export class ReportDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  createdAt: string;
}
