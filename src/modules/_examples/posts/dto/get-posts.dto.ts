import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsBoolean } from 'class-validator';
import { Transform } from 'class-transformer';
import { PaginationDto } from '@shared/dtos/pagination.dto';

export class GetPostsQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    description: 'Search keyword to filter posts by title',
    example: 'nestjs',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter by published status',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  isPublished?: boolean;
}

export class GetPostsResponseDto {
  @ApiProperty({ description: 'Post ID', example: 'uuid-string' })
  id: string;

  @ApiProperty({ description: 'Post title', example: 'My First Post' })
  title: string;

  @ApiProperty({ description: 'Post content', example: 'Hello world...' })
  content: string;

  @ApiProperty({ description: 'Post author', example: 'John Doe' })
  author: string;

  @ApiProperty({ description: 'Whether the post is published', example: false })
  isPublished: boolean;

  @ApiProperty({ description: 'Date the post was published', nullable: true })
  publishedAt: Date | null;

  @ApiProperty({ description: 'Date the post was created' })
  createdAt: Date;

  @ApiProperty({ description: 'Date the post was last updated' })
  updatedAt: Date;
}
