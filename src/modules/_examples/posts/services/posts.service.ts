import { Injectable, Logger } from '@nestjs/common';
import { PostRepository } from '@database/postgres/repositories/post.repository';
import { PostEntity } from '@database/postgres/entities/post.entity';
import { PostCreatedPublisher } from '../publishers/post-created.publisher';
import { WebSocketEmitterService } from '@websocket/services/websocket-emitter.service';
import { PostErrors } from '../errors/posts.errors';
import { GetPostsQueryDto, GetPostsResponseDto } from '../dto/get-posts.dto';
import { GetPostByIdResponseDto } from '../dto/get-post-by-id.dto';
import { CreatePostBodyDto, CreatePostResponseDto } from '../dto/create-post.dto';
import { PaginationResponseDto } from '@shared/dtos/pagination.dto';

@Injectable()
export class PostsService {
  private readonly logger = new Logger(PostsService.name);

  constructor(
    private readonly postRepository: PostRepository,
    private readonly postCreatedPublisher: PostCreatedPublisher,
    private readonly webSocketEmitterService: WebSocketEmitterService,
  ) {}

  async findAll(query: GetPostsQueryDto): Promise<PaginationResponseDto<GetPostsResponseDto>> {
    const { page, limit, search, isPublished } = query;
    const skip = (page - 1) * limit;

    const queryBuilder = this.postRepository.createQueryBuilder('post');

    if (search) {
      queryBuilder.andWhere('post.title ILIKE :search', { search: `%${search}%` });
    }

    if (isPublished !== undefined) {
      queryBuilder.andWhere('post.isPublished = :isPublished', { isPublished });
    }

    queryBuilder.orderBy('post.createdAt', 'DESC').skip(skip).take(limit);

    const [results, totalItems] = await queryBuilder.getManyAndCount();

    const totalPages = Math.ceil(totalItems / limit);

    return new PaginationResponseDto<GetPostsResponseDto>({
      results: results.map((entity) => this.mapToResponseDto(entity)),
      currentPage: page,
      pageSize: limit,
      totalItems,
      next: page < totalPages ? page + 1 : null,
      previous: page > 1 ? page - 1 : null,
    });
  }

  async findById(id: string): Promise<GetPostByIdResponseDto> {
    const post = await this.postRepository.findOne({ where: { id } });

    if (!post) {
      throw PostErrors.postNotFound({ id });
    }

    return this.mapToResponseDto(post);
  }

  async create(dto: CreatePostBodyDto): Promise<CreatePostResponseDto> {
    const post = this.postRepository.create({
      title: dto.title,
      content: dto.content,
      author: dto.author,
      isPublished: dto.isPublished ?? false,
      publishedAt: dto.isPublished ? new Date() : null,
    });

    const savedPost = await this.postRepository.save(post);

    // Enqueue the BullMQ wakeup job now that the row is committed
    await this.postCreatedPublisher.publishPostCreated({
      id: savedPost.id,
      title: savedPost.title,
      author: savedPost.author,
    });

    // Emit WebSocket event for real-time updates
    await this.webSocketEmitterService.emit([
      {
        event_name: 'post.created',
        timestamp: Date.now(),
        data: {
          id: savedPost.id,
          title: savedPost.title,
          author: savedPost.author,
        } as any,
      },
    ]);

    this.logger.log(`Post created: ${savedPost.id} - ${savedPost.title}`);

    return this.mapToResponseDto(savedPost);
  }

  private mapToResponseDto(entity: PostEntity): GetPostsResponseDto {
    return {
      id: entity.id,
      title: entity.title,
      content: entity.content,
      author: entity.author,
      isPublished: entity.isPublished,
      publishedAt: entity.publishedAt,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}
