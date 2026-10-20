import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentSession, SessionAuthGuard } from '@shared/auth';
import { ApiCursorPage, CursorPageDto } from '@shared/api';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { GetVerdictParamsDto } from '@modules/verification/dto/get-verdict.dto';
import { ProviderVerdictEvidenceDto } from '@modules/verification/dto/get-verdict-evidence.dto';
import { EvidencePackService } from '@modules/verification/services/evidence-pack.service';

import {
  ListProviderVerdictsQueryDto,
  ProviderVerdictDetailDto,
  ProviderVerdictListItemDto,
} from '../dto/provider-verdict.dto';
import { ProviderVerdictService } from '../services/provider-verdict.service';
import { TenantCache } from '@shared/decorators/tenant-cache.decorator';

/**
 * `GET /providers/me/verdicts`, `GET /providers/me/verdicts/:id`, and
 * `GET /providers/me/verdicts/:id/evidence`.
 *
 * The reason all three exist is that a provider is charged for a verdict and
 * must be able to see why. Before evidence packs, they could not: `verification_records
 * .organization_id` and `evidence_packs.organization_id` are the **buying**
 * organization, so the buyer-side endpoints scoped to the caller's own tenant
 * return nothing at all for the provider who served the call. Their identity
 * on every one of these rows is `provider_id`, and this controller is the one
 * that reads by it — `providerId == organizationId` for a provider session,
 * the assumption the whole provider surface is built on (`provider.entity.ts`).
 *
 * `evidence` is nested under `:id` so it inherits the same 404 rather than
 * needing a second lookup path. Nothing here is a second implementation of the
 * pack: it is read, and its hash recomputed, by the same `EvidencePackService`
 * the buyer's route uses — a provider seeing a different answer from the buyer
 * about the same call would be worse than either of them seeing nothing. The
 * feed and detail routes are `ProviderVerdictService`'s own read of
 * `verification_records`, deliberately **not** the evidence pack — see that
 * service's class comment and `ProviderVerdictDetailDto` for why the detail
 * route links to `evidence` rather than duplicating its five panes.
 *
 * Two boundaries every route here holds:
 *
 * - **404, never 403**, for a verdict this provider did not serve. A status
 *   code that separated "does not exist" from "not yours" would let ids be
 *   enumerated by anyone with a token.
 * - **No `seq`, no `prevHash`.** The chain position belongs to the buyer's
 *   chain and counts their verdicts; see `ProviderEvidenceIntegrityDto`. The
 *   feed and detail routes never touch `evidence_packs.seq` at all.
 *
 * `evidence` has no unsealed fallback, unlike the buyer's route: a verdict
 * judged before evidence packs existed has no pack, and without a pack there is no
 * `provider_id` on anything that route reads — so it 404s rather than
 * guessing. The feed and detail routes read `verification_records` directly
 * and so have no such gap — `provider_id` has been on that table since before
 * evidence packs.
 */
@ApiTags('Provider')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('providers/me/verdicts')
export class ProviderVerdictsController {
  constructor(
    private readonly evidence: EvidencePackService,
    private readonly verdicts: ProviderVerdictService,
  ) {}

  @Get()
  @TenantCache({ ttl: 15, vary: 'org', epochs: ['provider'] })
  @ApiOperation({
    summary: 'The verdict feed for calls this provider served, newest first',
  })
  @ApiCursorPage(ProviderVerdictListItemDto)
  async list(
    @CurrentSession() session: McpSession,
    @Query() query: ListProviderVerdictsQueryDto,
  ): Promise<CursorPageDto<ProviderVerdictListItemDto>> {
    // `providerId == organizationId` for a provider session — see the class comment.
    return this.verdicts.list(session.organizationId, query);
  }

  @Get(':id')
  @TenantCache({ ttl: 15, vary: 'org', epochs: ['provider'] })
  @ApiOperation({
    summary:
      'The verdict decomposition and production consequence for one call this provider ' +
      'served — not the evidence pack; see `evidenceUrl`',
  })
  @ApiResponse({ status: 200, type: ProviderVerdictDetailDto })
  @ApiResponse({ status: 404, description: 'No such verdict served by this provider' })
  async getById(
    @CurrentSession() session: McpSession,
    @Param() params: GetVerdictParamsDto,
  ): Promise<ProviderVerdictDetailDto> {
    return this.verdicts.getById(session.organizationId, params);
  }

  @Get(':id/evidence')
  @ApiOperation({
    summary:
      'The evidence pack for a call this provider served — request, response, every stage, the ' +
      'sampling proof, the pinned policy, and the content hash to check a local copy against',
  })
  @ApiResponse({ status: 200, type: ProviderVerdictEvidenceDto })
  @ApiResponse({
    status: 404,
    description: 'No sealed pack for this verdict, or not this provider',
  })
  @ApiResponse({ status: 500, description: 'The pack no longer matches its content hash' })
  async getEvidence(
    @CurrentSession() session: McpSession,
    @Param() params: GetVerdictParamsDto,
  ): Promise<ProviderVerdictEvidenceDto> {
    // `providerId == organizationId` for a provider session — the assumption the
    // whole provider surface is built on (`provider.entity.ts`).
    return this.evidence.forProvider(session.organizationId, params.id);
  }
}
