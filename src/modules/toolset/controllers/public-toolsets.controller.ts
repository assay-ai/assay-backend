import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CacheHeader, PUBLIC_EDGE_CACHE } from '@shared/decorators/cache-header.decorator';
import { HttpCacheTTL } from '@shared/decorators/http-cache.decorator';
import { PublicReadRateLimitInterceptor } from '@shared/interceptors/public-read-rate-limit.interceptor';

import {
  ListPublicToolsetsQueryDto,
  PublicCategoryListDto,
  PublicHandleParamDto,
  PublicHandleProfileDto,
  PublicToolsetByTokenBodyDto,
  PublicToolsetListDto,
  PublicToolsetPageDto,
  PublicToolsetPathDto,
  PublicToolsetVersionDetailDto,
  PublicToolsetVersionListDto,
  PublicToolsetVersionPathDto,
  PublicToolsetVersionQueryDto,
} from '../dto/public-toolsets.dto';
import {
  PUBLIC_TOOLSETS_CACHE_MS,
  PublicToolsetsService,
} from '../services/public-toolsets.service';

/**
 * The routes below `toolsets` that are not served from the in-process list
 * cache read Postgres on every call: a page is three queries, `categories` a
 * `GROUP BY` over every tool. Each distinct URL is held in Redis for as long
 * as the list is held in process, so a URL Cloudflare has not cached yet still
 * costs the database one read per window, not one per request.
 */
const SERVER_CACHE_SECONDS = PUBLIC_TOOLSETS_CACHE_MS / 1000;

const CACHE = {
  maxAge: PUBLIC_TOOLSETS_CACHE_MS / 1000,
  staleWhileRevalidate: 0,
  staleIfError: 0,
  mustRevalidate: true,
  ...PUBLIC_EDGE_CACHE,
};

/**
 * The toolset catalogue without an account (design spec §7.9), on the same
 * terms as `/public/catalogue`: no guard, an allowlist of fields
 * (`dto/public-toolsets.dto.ts`), a 30 s in-process cache and a per-address
 * limit. Only PUBLIC, LISTED toolsets answer by name; a link-only one answers
 * only `POST …/by-token`, with the token in the body so it stays out of logs.
 */
@ApiTags('Public')
@UseInterceptors(PublicReadRateLimitInterceptor)
@Controller('public')
export class PublicToolsetsController {
  constructor(private readonly toolsets: PublicToolsetsService) {}

  @Get('toolsets')
  @CacheHeader(CACHE)
  @ApiOperation({
    summary: 'Listed tool sets — official, provider, community; popular, trending, new',
  })
  @ApiResponse({ status: 200, type: PublicToolsetListDto })
  @ApiResponse({ status: 429, description: 'Too many requests from this address.' })
  async list(@Query() query: ListPublicToolsetsQueryDto): Promise<PublicToolsetListDto> {
    return this.toolsets.list(query);
  }

  @Post('toolsets/by-token')
  @HttpCode(200)
  @ApiOperation({
    summary: 'A link-only tool set’s page; the token from the link is the permission',
    description:
      '`v` picks a version the link serves (published UNLISTED or PUBLIC); `diffFrom` adds the ' +
      'diff from another version the link serves.',
  })
  @ApiResponse({ status: 200, type: PublicToolsetPageDto })
  @ApiResponse({
    status: 404,
    description: 'No tool set serves this link, or the link serves no such version.',
  })
  @ApiResponse({ status: 429, description: 'Too many requests from this address.' })
  async byToken(@Body() body: PublicToolsetByTokenBodyDto): Promise<PublicToolsetPageDto> {
    return this.toolsets.byToken(body.token, body.v, body.diffFrom);
  }

  @Get('toolsets/@:handle/:slug/versions')
  @HttpCacheTTL(SERVER_CACHE_SECONDS)
  @CacheHeader(CACHE)
  @ApiOperation({ summary: 'A listed tool set’s published versions, newest first' })
  @ApiResponse({ status: 200, type: PublicToolsetVersionListDto })
  async versions(@Param() params: PublicToolsetPathDto): Promise<PublicToolsetVersionListDto> {
    return this.toolsets.versionsOf(params.handle, params.slug);
  }

  @Get('toolsets/@:handle/:slug/versions/:v')
  @HttpCacheTTL(SERVER_CACHE_SECONDS)
  @CacheHeader(CACHE)
  @ApiOperation({
    summary: 'One version a listed tool set serves on `/@…`: its tools and rules, and a diff',
    description:
      'Only versions published as PUBLIC, none past the newest. `?diffFrom=` adds the diff from ' +
      'another such version, for "Update available".',
  })
  @ApiResponse({ status: 200, type: PublicToolsetVersionDetailDto })
  @ApiResponse({
    status: 404,
    description: 'Not a listed tool set, or `/@…` serves no such version. Says nothing more.',
  })
  @ApiResponse({ status: 429, description: 'Too many requests from this address.' })
  async version(
    @Param() params: PublicToolsetVersionPathDto,
    @Query() query: PublicToolsetVersionQueryDto,
  ): Promise<PublicToolsetVersionDetailDto> {
    return this.toolsets.versionOf(params.handle, params.slug, params.v, query.diffFrom);
  }

  @Get('toolsets/@:handle/:slug')
  @HttpCacheTTL(SERVER_CACHE_SECONDS)
  @CacheHeader(CACHE)
  @ApiOperation({ summary: 'A listed tool set’s page: tools, rules, weekly figures, MCP URLs' })
  @ApiResponse({ status: 200, type: PublicToolsetPageDto })
  @ApiResponse({
    status: 404,
    description: 'Not a listed tool set. Says nothing about whether it exists.',
  })
  async page(@Param() params: PublicToolsetPathDto): Promise<PublicToolsetPageDto> {
    return this.toolsets.page(params.handle, params.slug);
  }

  @Get('handles/:handle')
  @HttpCacheTTL(SERVER_CACHE_SECONDS)
  @CacheHeader(CACHE)
  @ApiOperation({ summary: 'A public name’s profile: its listed tool sets (and, later, tools)' })
  @ApiResponse({ status: 200, type: PublicHandleProfileDto })
  async profile(@Param() params: PublicHandleParamDto): Promise<PublicHandleProfileDto> {
    return this.toolsets.profile(params.handle);
  }

  @Get('categories')
  @HttpCacheTTL(SERVER_CACHE_SECONDS)
  @CacheHeader(CACHE)
  @ApiOperation({ summary: 'Categories with their listed tools and tool sets' })
  @ApiResponse({ status: 200, type: PublicCategoryListDto })
  async categories(): Promise<PublicCategoryListDto> {
    return this.toolsets.categories();
  }
}
