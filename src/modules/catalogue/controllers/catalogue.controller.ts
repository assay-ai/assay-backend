import { ToolVersionListDto } from '@modules/tool/dto/tool-contract-version.dto';
import { Controller, Get, Param, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { CurrentSession, SessionAuthGuard } from '@shared/auth';
import { PublicReadRateLimitInterceptor } from '@shared/interceptors/public-read-rate-limit.interceptor';

import {
  CatalogueProviderDetailDto,
  CatalogueProviderListDto,
  CatalogueToolListDto,
  GetCatalogueProviderParamsDto,
  GetCatalogueToolParamsDto,
} from '../dto/get-catalogue.dto';
import { CatalogueService } from '../services/catalogue.service';

/**
 * The buyer's catalogue.
 *
 * ## Why `/catalogue/*` and not `GET /providers`
 *
 * `providers/*` is the **seller** surface: every route under it means "the
 * caller's own provider record", and the one route that forgot to scope —
 * `GET /providers/me/tool-bindings/catalogue` — answers any session at all,
 * which is a bug waiting to be fixed rather than a precedent to build on.
 * Hanging the buyer's market on the same prefix would make "whose provider is
 * this?" a question you answer by reading the handler.
 *
 * So the read model gets its own prefix, and the prefix says what it is: this
 * is the shop window, it is identical for every caller, and nothing under it is
 * about the caller at all.
 *
 * ## One per-caller field, and only that
 *
 * The guard is on the controller — an unauthenticated catalogue is a separate
 * decision nobody has taken. The market itself is identical for every caller.
 * The provider routes read the session for one thing only: `servesYou`, whether
 * the router takes a call from the caller's own agents (on their chains). It is
 * computed from the shared, cached answer and the caller's own agents, so it
 * reads nothing about any other organization. The tool routes take no session.
 *
 * ## Unpaged
 *
 * Same decision, and the same reason, as `ToolCataloguePort.listTools()` and
 * `GET /tools`: the market is tens of rows, and a cursor with nothing behind it
 * is an API that changes twice. When the port gains paging, so does this.
 *
 * ## Bounded cost
 *
 * Anyone can sign up, so a session is no bound on its own. Answers come from
 * `CatalogueService`'s 30 s in-process cache (shared with the public routes —
 * nothing here is per caller), and each address is held to the same per-minute
 * window as the public reads by `PublicReadRateLimitInterceptor`. The guard runs
 * first, so an unauthenticated request is refused before it is counted.
 */
@ApiTags('Catalogue')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@UseInterceptors(PublicReadRateLimitInterceptor)
@Controller('catalogue')
export class CatalogueController {
  constructor(private readonly catalogue: CatalogueService) {}

  @Get('providers')
  @ApiOperation({
    summary:
      'Every provider serving traffic, with the stake they have at risk, the quality we ' +
      'have measured on them and the chains they take payment on. Platform-wide; only ' +
      '`servesYou` is per caller.',
  })
  @ApiResponse({ status: 200, type: CatalogueProviderListDto })
  async listProviders(@CurrentSession() session: McpSession): Promise<CatalogueProviderListDto> {
    return this.catalogue.listProvidersFor(session.organizationId);
  }

  @Get('tools')
  @ApiOperation({
    summary:
      'Every tool at least one provider serves, with how many serve it, the market floor and ' +
      'the price a call would actually be held for; deprecated majors name their replacement.',
  })
  @ApiResponse({ status: 200, type: CatalogueToolListDto })
  async listTools(): Promise<CatalogueToolListDto> {
    return this.catalogue.listTools();
  }

  @Get('tools/:toolId/versions')
  @ApiOperation({
    summary:
      'A tool’s published contract versions, newest first: schemas, optional fields, ' +
      'examples, status, sunset and changelog; and per listed provider, the majors and ' +
      'optional fields it declares',
  })
  @ApiResponse({ status: 200, type: ToolVersionListDto })
  @ApiResponse({ status: 404, description: 'TOOL_NOT_FOUND' })
  async toolVersions(@Param() params: GetCatalogueToolParamsDto): Promise<ToolVersionListDto> {
    return this.catalogue.toolVersions(params.toolId);
  }

  /**
   * Declared **after** the two literal routes above so that neither is swallowed
   * by the parameter. Nest matches in declaration order, and
   * `GET /catalogue/tools` resolving to "the provider whose id is `tools`" is a
   * `400 providerId must be a UUID` about an id the caller never sent — the
   * exact trap `ProviderToolBindingsController` records at the top of its own
   * file.
   */
  @Get('providers/:providerId')
  @ApiOperation({ summary: 'One provider, and what they serve right now' })
  @ApiResponse({ status: 200, type: CatalogueProviderDetailDto })
  @ApiResponse({ status: 404, description: 'No such provider. Never 403 — that would confirm it.' })
  async getProvider(
    @Param() params: GetCatalogueProviderParamsDto,
    @CurrentSession() session: McpSession,
  ): Promise<CatalogueProviderDetailDto> {
    return this.catalogue.getProviderFor(params.providerId, session.organizationId);
  }
}
