import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ProviderToolErrors } from '@modules/provider-tool/errors/provider-tool.errors';
import {
  ReviewDetailDto,
  ReviewQueueItemDto,
} from '@modules/provider-tool/dto/provider-tool-review.dto';
import {
  DraftPromotionBodyDto,
  InvitePromotionBodyDto,
  PromotionGroupListDto,
  PromotionInviteListDto,
  ReviewDecisionBodyDto,
  SimilarToolListDto,
} from '@modules/provider-tool/dto/tool-promotion.dto';
import { ReviewKind } from '@modules/provider-tool/domain/review';
import {
  DecideOutcome,
  ProviderToolReviewService,
  ReviewDecision,
} from '@modules/provider-tool/services/provider-tool-review.service';
import { ToolPromotionService } from '@modules/provider-tool/services/tool-promotion.service';
import { ToolTier } from '@modules/tool/ports/tool.types';

import { OperatorToolDto, SaveContractDraftBodyDto } from '../dto/operator-contracts.dto';
import { OperatorSession } from '../ports/operator-session.port';
import { OperatorContractsService } from './operator-contracts.service';
import { OverrideLogService } from './override-log.service';

export interface ReviewDecisionResultDto {
  readonly toolId: string;
  readonly decision: ReviewDecision;
  readonly kind: ReviewKind;
  readonly approvedVersion: number | null;
}

/**
 * The operator's side of provider tools (design spec §7.6, §7.5, §7.9):
 * the review queue and its decision (`A-24`, through the override register,
 * so the decision and its register entry commit together), and promotion —
 * drafting a standard contract from a provider tool and inviting the
 * providers of similar ones. Drafting serves nothing (the standard contract
 * goes live only through the two-person `P-10` publish), so promotion is not
 * an override.
 */
@Injectable()
export class OperatorProviderToolsService {
  constructor(
    private readonly overrides: OverrideLogService,
    private readonly review: ProviderToolReviewService,
    private readonly promotion: ToolPromotionService,
    private readonly contracts: OperatorContractsService,
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
  ) {}

  queue(pendingOnly: boolean): Promise<ReviewQueueItemDto[]> {
    return this.review.queue(pendingOnly);
  }

  detail(toolId: string): Promise<ReviewDetailDto> {
    return this.review.detail(toolId);
  }

  /** `A-24`: approve or reject the content hash the operator read. */
  async decide(
    operator: OperatorSession,
    toolId: string,
    body: ReviewDecisionBodyDto,
    requestId: string | null,
  ): Promise<ReviewDecisionResultDto> {
    const decision = body.decision as ReviewDecision;
    if (decision === ReviewDecision.REJECT && !body.note?.trim()) {
      throw ProviderToolErrors.state({
        reason: 'a rejection needs a note the provider can act on',
      });
    }
    const tool = await this.review.requireProviderTool(toolId);
    const outcome = await this.overrides.perform<DecideOutcome>(
      {
        code: 'A-24',
        actor: operator,
        targetType: 'tool',
        targetId: tool.id,
        organizationId: tool.ownerOrgId,
        reasonCode: body.reasonCode,
        reason: body.note?.trim() || `${decision} ${tool.name}`,
        ticketRef: body.ticketRef ?? null,
        requestId,
      },
      async (queryRunner) => {
        const value = await this.review.decide(queryRunner.manager, {
          toolId: tool.id,
          operatorId: operator.operatorId,
          decision,
          note: body.note?.trim() || null,
          tier: (body.tier as ToolTier | undefined) ?? null,
          contentHash: body.contentHash,
        });
        return {
          value,
          before: { reviewStatus: 'PENDING', approvedVersion: tool.approvedVersion },
          after: {
            decision,
            kind: value.kind,
            approvedVersion: value.approvedVersion,
            contentHash: body.contentHash,
            tier: body.tier ?? null,
          },
        };
      },
    );
    await this.review.afterDecision(tool.id, outcome);
    return {
      toolId: tool.id,
      decision,
      kind: outcome.kind,
      approvedVersion: outcome.approvedVersion,
    };
  }

  async groups(): Promise<PromotionGroupListDto> {
    return { groups: await this.promotion.groups() };
  }

  async similar(toolId: string): Promise<SimilarToolListDto> {
    return { tools: await this.promotion.similarTo(toolId) };
  }

  /**
   * Draft a standard contract from a provider tool's current version and
   * invite the source's provider, and any others named. The draft is the
   * contract editor's from here: edit, then publish (`P-10`, two-person).
   */
  async draft(
    operator: OperatorSession,
    body: DraftPromotionBodyDto,
  ): Promise<{ readonly tool: OperatorToolDto; readonly invites: PromotionInviteListDto }> {
    const { source, version } = await this.promotion.draftFrom(body.sourceToolId);
    const others = [...new Set(body.inviteToolIds ?? [])].filter((id) => id !== source.id);
    // Checked before anything is written: an invite that cannot be sent
    // leaves no draft behind.
    for (const id of others) await this.promotion.draftFrom(id);

    const created = await this.contracts.insertDraftTool(
      body.name,
      body.category ?? source.category,
      source.tags ?? [],
    );
    const draft: SaveContractDraftBodyDto = {
      summary: version.summary,
      description: version.description,
      inputSchema: version.inputSchema,
      outputSchema: version.outputSchema,
      optionalInputFields: [...(version.optionalInputFields ?? [])],
      optionalOutputFields: [...(version.optionalOutputFields ?? [])],
      examples: [...((version.examples ?? []) as Record<string, unknown>[])],
      changelog: `Drafted from ${source.name} v${version.semver}`,
    };
    const tool = await this.contracts.saveDraft(operator, created.id, draft);
    const invites = await this.dataSource.transaction((manager) =>
      this.promotion.invite(manager, created.id, [source.id, ...others], operator.operatorId),
    );
    return { tool, invites: { invites } };
  }

  async invite(
    operator: OperatorSession,
    standardToolId: string,
    body: InvitePromotionBodyDto,
  ): Promise<PromotionInviteListDto> {
    const invites = await this.dataSource.transaction((manager) =>
      this.promotion.invite(manager, standardToolId, body.toolIds, operator.operatorId),
    );
    return { invites };
  }

  async invites(standardToolId: string): Promise<PromotionInviteListDto> {
    return { invites: await this.promotion.invites(standardToolId) };
  }
}
