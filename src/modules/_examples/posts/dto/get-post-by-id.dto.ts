import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class GetPostByIdParamsDto {
  @ApiProperty({ description: 'Post ID', example: 'uuid-string' })
  @IsUUID()
  id: string;
}

export class GetPostByIdResponseDto {
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
