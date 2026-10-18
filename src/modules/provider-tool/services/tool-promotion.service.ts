import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';

import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { ToolPromotionInviteEntity } from '@database/postgres/entities/tool-promotion-invite.entity';
import { ToolEntity } from '@database/postgres/entities/tool.entity';
import { ToolVersionEntity } from '@database/postgres/entities/tool-version.entity';
import { parseProviderToolName } from '@modules/tool/domain/provider-tool-name';
import { ToolKind, ToolStatus, ToolVisibility } from '@modules/tool/ports/tool.types';

import { SimilarityInput, fieldsOf, similarGroups, similarTo } from '../domain/similarity';
import {
  PromotionCandidateDto,
  PromotionGroupDto,
  PromotionInviteDto,
  SimilarToolDto,
} from '../dto/tool-promotion.dto';
import { ProviderToolErrors } from '../errors/provider-tool.errors';

/** A provider tool as promotion compares it, with the version it serves now. */
interface Candidate extends SimilarityInput {
  readonly row: ToolEntity;
  readonly version: ToolVersionEntity;
}

/**
 * Promotion (design spec §7.5): when two or more provider tools do the same
 * job, an operator drafts a standard contract from one of them and invites
 * their providers to bind to it. The provider tools stay live and may point
 * to the standard tool as their replacement.
 *
 * This class finds the candidates and writes the invites; the standard
 * contract itself is drafted and published through the operator contract
 * editor (two-person publish), so promotion adds no second way to put a
 * contract on the wire.
 */
@Injectable()
export class ToolPromotionService {
  constructor(@InjectDataSource('postgres') private readonly dataSource: DataSource) {}

  /** Groups of similar shared provider tools: same category, similar names and schemas. */
  async groups(): Promise<PromotionGroupDto[]> {
    const candidates = await this.candidates();
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    return similarGroups(candidates).map((group) => ({
      category: group[0].category,
      tools: group.map((tool) => candidateDtoOf(byId.get(tool.id) as Candidate)),
    }));
  }

  /** The shared provider tools similar to one, most similar first. */
  async similarTo(toolId: string): Promise<SimilarToolDto[]> {
    const candidates = await this.candidates();
    const source = candidates.find((candidate) => candidate.id === toolId);
    if (!source) throw ProviderToolErrors.notFound();
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    return similarTo(source, candidates).map((entry) => ({
      ...candidateDtoOf(byId.get(entry.tool.id) as Candidate),
      similarity: entry.similarity,
    }));
  }

  /**
   * The draft a standard contract starts from: the source tool's current
   * version, copied. The operator edits it in the contract editor.
   */
  async draftFrom(sourceToolId: string): Promise<{
    readonly source: ToolEntity;
    readonly version: ToolVersionEntity;
  }> {
    const source = (await this.candidates()).find((candidate) => candidate.id === sourceToolId);
    if (!source) {
      throw ProviderToolErrors.promotionInvalid({
        reason:
          'the source must be a provider tool shared beyond its own team, with a published version',
        toolIds: [sourceToolId],
      });
    }
    return { source: source.row, version: source.version };
  }

  /** One invite per provider tool, to its owner; refused for a tool that is not a candidate. */
  async invite(
    manager: EntityManager,
    standardToolId: string,
    toolIds: readonly string[],
    operatorId: string,
  ): Promise<PromotionInviteDto[]> {
    const standard = await manager.findOne(ToolEntity, { where: { id: standardToolId } });
    if (!standard || standard.kind !== ToolKind.STANDARD) {
      throw ProviderToolErrors.promotionInvalid({ reason: 'invites name a standard tool' });
    }
    const ids = [...new Set(toolIds)];
    const candidates = new Map((await this.candidates(manager)).map((c) => [c.id, c]));
    const unknown = ids.filter((id) => !candidates.has(id));
    if (unknown.length > 0) {
      throw ProviderToolErrors.promotionInvalid({
        reason: 'only shared provider tools that still serve can be invited',
        toolIds: unknown,
      });
    }
    const now = new Date();
    for (const id of ids) {
      const candidate = candidates.get(id) as Candidate;
      await manager
        .createQueryBuilder()
        .insert()
        .into(ToolPromotionInviteEntity)
        .values({
          standardToolId,
          sourceToolId: id,
          organizationId: candidate.row.ownerOrgId as string,
          invitedBy: operatorId,
          invitedAt: now,
          dismissedAt: null,
        })
        .orIgnore()
        .execute();
    }
    return this.invites(standardToolId, manager);
  }

  /** The invites of a standard tool, and whether each provider bound to it yet. */
  async invites(standardToolId: string, manager?: EntityManager): Promise<PromotionInviteDto[]> {
    const em = manager ?? this.dataSource.manager;
    const rows = await em.find(ToolPromotionInviteEntity, {
      where: { standardToolId },
      order: { invitedAt: 'ASC' },
    });
    if (rows.length === 0) return [];
    const tools = new Map(
      (await em.find(ToolEntity, { where: { id: In(rows.map((row) => row.sourceToolId)) } })).map(
        (tool) => [tool.id, tool],
      ),
    );
    const bound = new Set(
      (
        await em.find(ToolBindingEntity, {
          where: {
            toolId: standardToolId,
            organizationId: In(rows.map((row) => row.organizationId)),
          },
          select: { organizationId: true },
        })
      ).map((binding) => binding.organizationId),
    );
    return rows.map((row) => ({
      standardToolId: row.standardToolId,
      sourceToolId: row.sourceToolId,
      sourceToolName: tools.get(row.sourceToolId)?.name ?? '',
      organizationId: row.organizationId,
      invitedAt: row.invitedAt,
      dismissedAt: row.dismissedAt,
      bound: bound.has(row.organizationId),
    }));
  }

  /**
   * Provider tools promotion may name: shared beyond their own team
   * (UNLISTED or LISTED), still serving, at their current version.
   */
  private async candidates(manager?: EntityManager): Promise<Candidate[]> {
    const em = manager ?? this.dataSource.manager;
    const rows = await em.find(ToolEntity, {
      where: {
        kind: ToolKind.PROVIDER,
        visibility: In([ToolVisibility.UNLISTED, ToolVisibility.LISTED]),
        status: In([ToolStatus.ACTIVE, ToolStatus.DEPRECATED]),
      },
    });
    const current = rows.filter((row) => row.currentVersion !== null);
    if (current.length === 0) return [];
    const versions = await em.find(ToolVersionEntity, {
      where: current.map((row) => ({ toolId: row.id, version: row.currentVersion as number })),
    });
    const byTool = new Map(versions.map((version) => [version.toolId, version]));
    return current
      .filter((row) => byTool.has(row.id))
      .map((row) => {
        const version = byTool.get(row.id) as ToolVersionEntity;
        return {
          id: row.id,
          name: row.name,
          category: row.category,
          inputFields: fieldsOf(version.inputSchema),
          outputFields: fieldsOf(version.outputSchema),
          row,
          version,
        };
      });
  }
}

function candidateDtoOf(candidate: Candidate): PromotionCandidateDto {
  return {
    toolId: candidate.id,
    name: candidate.name,
    handle: parseProviderToolName(candidate.name)?.handle ?? '',
    organizationId: candidate.row.ownerOrgId as string,
    category: candidate.category,
    visibility: candidate.row.visibility,
    semver: candidate.version.semver,
    summary: candidate.version.summary,
    inputFields: [...candidate.inputFields],
    outputFields: [...candidate.outputFields],
    replacementToolId: candidate.row.replacementToolId,
  };
}
