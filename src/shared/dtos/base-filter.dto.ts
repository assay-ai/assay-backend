import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';
import { PaginationDto } from './pagination.dto';

/**
 * Base filter DTO containing common filter properties
 * Can be reused across different resource types (events, markets, etc.)
 */
export class BaseFilterDto {
  @ApiPropertyOptional({ description: 'Search query string' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Filter by provider ID' })
  @IsOptional()
  @IsUUID()
  provider?: string;
}
