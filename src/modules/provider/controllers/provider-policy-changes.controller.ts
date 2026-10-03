import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentSession, SessionAuthGuard } from '@shared/auth';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';

import { PolicyChangeDto } from '../dto/provider-policy-changes.dto';
import { ProviderPolicyChangesService } from '../services/provider-policy-changes.service';

/**
 * `GET /providers/me/policy-changes` (the policy change notice slice only).
 *
 * Not paginated: the response is bounded by how many distinct tools this
 * provider has bound, which is small by construction, the same shape as
 * `GET /operator/policies`. See `ProviderPolicyChangesService` for the join,
 * the in-force/pending definitions, the diff, and the effective-date gap.
 */
@ApiTags('Provider')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('providers/me/policy-changes')
export class ProviderPolicyChangesController {
  constructor(private readonly policyChanges: ProviderPolicyChangesService) {}

  @Get()
  @ApiOperation({
    summary:
      'Pending (SHADOW) verification policy versions affecting this provider’s bindings, with a ' +
      'structural diff against the version in force. MVP notice only — no divergence computed on ' +
      'this provider’s own traffic, no objection form, no golden-set run, no auto-pause: those are ' +
      'not built yet.',
  })
  @ApiResponse({ status: 200, type: [PolicyChangeDto] })
  async list(@CurrentSession() session: McpSession): Promise<PolicyChangeDto[]> {
    // `providerId == organizationId` for a provider session — the equivalence
    // the whole provider surface rests on (`tool-binding.entity.ts`).
    return this.policyChanges.listPolicyChanges(session.organizationId);
  }
}
