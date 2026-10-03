import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, MaxLength, IsOptional, IsBoolean } from 'class-validator';

export class CreatePostBodyDto {
  @ApiProperty({ description: 'Post title', example: 'My First Post', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;

  @ApiProperty({ description: 'Post content', example: 'Hello world...' })
  @IsString()
  @IsNotEmpty()
  content: string;

  @ApiProperty({ description: 'Post author', example: 'John Doe', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  author: string;

  @ApiPropertyOptional({
    description: 'Whether the post is published',
    example: false,
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isPublished?: boolean = false;
}

export class CreatePostResponseDto {
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
