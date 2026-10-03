import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Transform } from 'class-transformer';
export interface IPaginationResult<T> {
  results: T[];
  currentPage: number;
  pageSize: number;
  totalItems: number;
  next: number;
  previous: number;
}

export interface IPaginationInfo {
  page: number;
  skip: number;
  limit: number;
}

export class PaginationDto {
  @ApiProperty({
    description: 'Page number',
    example: 1,
    type: Number,
    default: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Transform(({ value }) => (value ? parseInt(value) : 1))
  page: number = 1;

  @ApiProperty({
    description: 'Page size',
    example: 20,
    type: Number,
    default: 20,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  @Transform(({ value }) => (value ? parseInt(value) : 20))
  limit: number = 20;
}

export class PaginationResponseDto<T> {
  @ApiProperty({
    description: 'Array of results for the current page',
    example: [],
    isArray: true,
  })
  public results: T[];

  @ApiProperty({
    description: 'Current page number',
    example: 1,
    type: Number,
  })
  public currentPage: number;

  @ApiProperty({
    description: 'Number of items per page',
    example: 20,
    type: Number,
  })
  public pageSize: number;

  @ApiProperty({
    description: 'Total number of items in the database',
    example: 100,
    type: Number,
  })
  public totalItems: number;

  @ApiProperty({
    description: 'Next page number (null if it is the last page)',
    example: 2,
    type: Number,
    nullable: true,
  })
  public next: number;

  @ApiProperty({
    description: 'Previous page number (null if it is the first page)',
    example: null,
    type: Number,
    nullable: true,
  })
  public previous: number;

  constructor(paginationResults: IPaginationResult<T>) {
    this.results = paginationResults.results;
    this.currentPage = paginationResults.currentPage;
    this.pageSize = paginationResults.pageSize;
    this.totalItems = paginationResults.totalItems;
    this.next = paginationResults.next;
    this.previous = paginationResults.previous;
  }
}
