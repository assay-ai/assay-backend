import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsString } from 'class-validator';

/**
 * `GET /providers/me/calls/export`.
 *
 * Deliberately **not** a `ListQueryDto` — see `ProviderCallsExportService`'s
 * doc comment for why a bulk CSV file is not the same shape as a UI-paged
 * collection, and does not go through `paginate()` / `CursorPageDto`.
 */
export class GetProviderCallsExportQueryDto {
  @ApiProperty({ description: 'ISO 8601 — inclusive lower bound', example: '2026-08-01T00:00:00Z' })
  @IsISO8601()
  from: string;

  @ApiProperty({ description: 'ISO 8601 — exclusive upper bound', example: '2026-08-16T00:00:00Z' })
  @IsISO8601()
  to: string;

  @ApiPropertyOptional({ description: 'CAIP-19 asset id — narrows the export to one asset' })
  @IsOptional()
  @IsString()
  asset?: string;
}
