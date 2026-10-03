import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { PostsService } from '../services/posts.service';
import { GetPostsQueryDto, GetPostsResponseDto } from '../dto/get-posts.dto';
import { GetPostByIdParamsDto, GetPostByIdResponseDto } from '../dto/get-post-by-id.dto';
import { CreatePostBodyDto, CreatePostResponseDto } from '../dto/create-post.dto';
import { PaginationResponseDto } from '@shared/dtos/pagination.dto';

// Uncomment below to protect endpoints with JWT authentication:
// import { UseGuards } from '@nestjs/common';
// import { JwtAuthGuard } from '@shared/guards/jwt-auth.guard';

@Controller('posts')
@ApiTags('Posts')
export class PostsController {
  constructor(private readonly postsService: PostsService) {}

  @Get()
  @ApiOperation({ summary: 'Get all posts with pagination' })
  @ApiResponse({ status: 200, description: 'List of posts', type: [GetPostsResponseDto] })
  async findAll(
    @Query() query: GetPostsQueryDto,
  ): Promise<PaginationResponseDto<GetPostsResponseDto>> {
    return this.postsService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a post by ID' })
  @ApiResponse({ status: 200, description: 'Post details', type: GetPostByIdResponseDto })
  @ApiResponse({ status: 404, description: 'Post not found' })
  async findById(@Param() params: GetPostByIdParamsDto): Promise<GetPostByIdResponseDto> {
    return this.postsService.findById(params.id);
  }

  // Uncomment @UseGuards(JwtAuthGuard) to protect this endpoint with JWT authentication
  // @UseGuards(JwtAuthGuard)
  @Post()
  @ApiOperation({ summary: 'Create a new post' })
  @ApiResponse({
    status: 201,
    description: 'Post created successfully',
    type: CreatePostResponseDto,
  })
  async create(@Body() dto: CreatePostBodyDto): Promise<CreatePostResponseDto> {
    return this.postsService.create(dto);
  }
}
