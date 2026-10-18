import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { OperatorApprovalRepository } from '@database/postgres/repositories/operator-approval.repository';
import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { ToolVersionEntity } from '@database/postgres/entities/tool-version.entity';
import { ToolEntity } from '@database/postgres/entities/tool.entity';
import { UNIQUE_VIOLATION_CODE } from '@database/postgres/repositories/abstract.repository';
import { ToolRepository } from '@database/postgres/repositories/tool.repository';
import { ToolVersionRepository } from '@database/postgres/repositories/tool-version.repository';
import { ENABLED_CHAINS } from '@modules/chains/enabled-chains';
import { ChainId } from '@modules/chains/ports/caip.types';
import {
  ContractShape,
  MIN_SUNSET_MS,
  VersionBump,
  bumpSemver,
  compareSemverText,
  contractProblems,
  diffContracts,
  formatSemver,
  parseSemver,
  replacementOf,
} from '@modules/tool/domain/contract';
import { bindingRange } from '@modules/tool/domain/contract/version-range';
import {
  assertNoReservedToolNames,
  isReservedToolName,
} from '@modules/tool/domain/reserved-tool-names';
import { ToolContractVersionDto } from '@modules/tool/dto/tool-contract-version.dto';
import { ToolErrors } from '@modules/tool/errors/tool.errors';
import {
  TOOL_CONTRACT_CHANGES,
  ToolContractChanges,
} from '@modules/tool/ports/tool-contracts.port';
import { ToolStatus, ToolTier, ToolVersionStatus } from '@modules/tool/ports/tool.types';
import {
  DEFAULT_VERIFICATION_POLICY_ID,
  buildTools,
  toContractVersion,
} from '@modules/tool/services/database-tool-contracts';
import { ProviderRouterService } from '@modules/tool/services/provider-router.service';
import { ContractLifecycleService } from '@modules/toolset/services/contract-lifecycle.service';

import { ApprovalQueuedDto } from '../dto/operator-approval.dto';
import {
  ContractActionBodyDto,
  ContractDraftDto,
  ContractMajorDto,
  CreateStandardToolBodyDto,
  DeprecateVersionBodyDto,
  MoveCurrentVersionBodyDto,
  OperatorToolDto,
  OperatorToolListDto,
  OperatorToolSummaryDto,
  SaveContractDraftBodyDto,
} from '../dto/operator-contracts.dto';
import { OperatorApprover, OperatorSession } from '../ports/operator-session.port';
import { OperatorErrors } from '../errors/operator.errors';
import { OperatorApprovalService, canonicalJson } from './operator-approval.service';
import { OverrideLogService } from './override-log.service';

export const PUBLISH_VERSION_APPROVAL_ACTION = 'tool_version.publish';
export const MOVE_CURRENT_VERSION_APPROVAL_ACTION = 'tool.current_version';

/** A newer major is suggested once it has this many eligible bindings (§7.3). */
export const SUGGEST_CURRENT_MIN_BINDINGS = 2;

/**
 * The operator contract editor (design spec §7.5, §7.9):
 *
 * ```text
 * draft      create a DRAFT tool, save or discard its one DRAFT version  no override (nothing serves)
 * P-10       publish the draft                                          two-person
 * P-11       move tools.current_version                                 two-person
 * P-12       deprecate a major: sunset ≥ 90 days, notices sent          one operator
 * ```
 *
 * Publishing computes the version from the schema diff (§7.5 rules): a patch
 * or minor of the current major moves `current_version` with it; a new major
 * never does — unpinned URLs move only when an operator moves it. Every write
 * that reaches traffic bumps the contract epoch, so every process re-reads.
 */
@Injectable()
export class OperatorContractsService {
  private readonly logger = new Logger(OperatorContractsService.name);

  constructor(
    private readonly tools: ToolRepository,
    private readonly versions: ToolVersionRepository,
    private readonly overrides: OverrideLogService,
    private readonly approvals: OperatorApprovalService,
    private readonly approvalRows: OperatorApprovalRepository,
    private readonly router: ProviderRouterService,
    private readonly lifecycle: ContractLifecycleService,
    @Inject(TOOL_CONTRACT_CHANGES) private readonly changes: ToolContractChanges,
    @Inject(ENABLED_CHAINS) private readonly enabledChains: readonly ChainId[],
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
  ) {
    approvals.register(PUBLISH_VERSION_APPROVAL_ACTION, {
      code: 'P-10',
      run: (requester, approver, payload, requestId) =>
        this.publish(
          requester,
          payload.toolId as string,
          payload.version as number,
          payload.body as ContractActionBodyDto,
          requestId,
          approver,
          payload.contentHash as string | undefined,
        ),
    });
    approvals.register(MOVE_CURRENT_VERSION_APPROVAL_ACTION, {
      code: 'P-11',
      run: (requester, approver, payload, requestId) =>
        this.moveCurrentVersion(
          requester,
          payload.toolId as string,
          payload.body as MoveCurrentVersionBodyDto,
          requestId,
          approver,
        ),
    });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async list(): Promise<OperatorToolListDto> {
    const rows = await this.tools.find({ order: { name: 'ASC' } });
    const versions = await this.versions.findByTools(rows.map((row) => row.id));
    return {
      tools: rows.map((row) =>
        summaryOf(
          row,
          versions.filter((v) => v.toolId === row.id),
        ),
      ),
    };
  }

  async get(toolId: string): Promise<OperatorToolDto> {
    const row = await this.requireTool(toolId);
    const versions = await this.versions.findByTools([row.id]);
    const draftRow = versions.find((version) => version.status === ToolVersionStatus.DRAFT) ?? null;
    const published = versions.filter((version) => version.status !== ToolVersionStatus.DRAFT);
    const majors = await this.majorsOf(row, published);
    return {
      ...summaryOf(row, versions),
      replacementToolId: row.replacementToolId,
      versions: published
        .map(toContractVersion)
        .sort((a, b) => compareSemverText(b.semver, a.semver))
        .map((version) => ToolContractVersionDto.of(version, row.currentVersion)),
      draft: draftRow ? draftOf(draftRow, published) : null,
      majors,
      suggestedCurrentVersion: suggestedCurrent(row, published, majors),
    };
  }

  // ── Drafting (no override: nothing serves a draft) ────────────────────────

  async createTool(body: CreateStandardToolBodyDto): Promise<OperatorToolDto> {
    const row = await this.insertDraftTool(body.name, body.category, body.tags ?? []);
    return this.get(row.id);
  }

  /** A DRAFT tool row under `name`, refused when the name is reserved or held. */
  async insertDraftTool(
    name: string,
    category: string,
    tags: readonly string[],
  ): Promise<ToolEntity> {
    if (isReservedToolName(name) || name.includes('__')) {
      throw ToolErrors.contractInvalid({ problems: [`"${name}" cannot name a standard tool`] });
    }
    try {
      assertNoReservedToolNames([name], 'contract editor');
      return await this.tools.insertDraft({ name, category, tags: [...new Set(tags)] });
    } catch (error) {
      if ((error as { code?: string })?.code === UNIQUE_VIOLATION_CODE) {
        throw ToolErrors.contractNameTaken({ name, suggestion: await this.tools.freeName(name) });
      }
      throw error;
    }
  }

  /** Create or replace the tool's one DRAFT version. */
  async saveDraft(
    operator: OperatorSession,
    toolId: string,
    body: SaveContractDraftBodyDto,
  ): Promise<OperatorToolDto> {
    const row = await this.requireStandardTool(toolId);
    const shape = shapeOf(body);
    const problems = contractProblems(shape);
    if (problems.length > 0) throw ToolErrors.contractInvalid({ problems });

    await this.assertNoPendingPublish(row.id);
    await this.inDraftTransaction(async (manager) => {
      const locked = await lockTool(manager, row.id);
      const versions = await manager.find(ToolVersionEntity, { where: { toolId: row.id } });
      const published = versions.filter((version) => version.status !== ToolVersionStatus.DRAFT);
      if (body.baseVersion !== undefined) {
        const named = published.find((v) => v.version === body.baseVersion);
        if (!named) throw ToolErrors.versionNotFound({ version: body.baseVersion });
        const newestOfMajor = newestOf(published.filter((v) => v.major === named.major));
        if (newestOfMajor && newestOfMajor.version !== named.version) {
          throw ToolErrors.contractState({
            reason: `draft against the newest version of v${named.major} (v${newestOfMajor.semver})`,
          });
        }
      }
      const base = baseOf(published, body.baseVersion ?? null);
      const next = nextSemver(base, shape, published, { allowNoChange: true });
      const existing = versions.find((version) => version.status === ToolVersionStatus.DRAFT);
      const fields: Partial<ToolVersionEntity> = {
        semver: next,
        major: (parseSemver(next) as { major: number }).major,
        summary: shape.summary,
        description: shape.description,
        inputSchema: shape.inputSchema as Record<string, unknown>,
        outputSchema: shape.outputSchema as Record<string, unknown>,
        optionalInputFields: [...shape.optionalInputFields],
        optionalOutputFields: [...shape.optionalOutputFields],
        examples: [...shape.examples],
        verificationPolicyId: shape.verificationPolicyId,
        tier: shape.tier,
        changelog: body.changelog ?? null,
      };
      if (existing) {
        await manager.update(
          ToolVersionEntity,
          { toolId: row.id, version: existing.version },
          { ...fields, editedBy: operator.operatorId, updatedAt: new Date() },
        );
      } else {
        // A number is never handed out twice, discarded drafts included: an
        // approval names a version, and a reused one would name new content.
        const highest = versions.reduce((max, version) => Math.max(max, version.version), 0);
        const number = Math.max(highest, locked.lastVersionNumber ?? 0) + 1;
        await manager.insert(ToolVersionEntity, {
          ...fields,
          toolId: row.id,
          version: number,
          status: ToolVersionStatus.DRAFT,
          createdBy: operator.operatorId,
          editedBy: operator.operatorId,
        });
        await manager.update(ToolEntity, { id: row.id }, { lastVersionNumber: number });
      }
    });
    this.logger.log(`${row.name}: draft saved by operator ${operator.operatorId}`);
    return this.get(row.id);
  }

  async discardDraft(operator: OperatorSession, toolId: string): Promise<OperatorToolDto> {
    const row = await this.requireStandardTool(toolId);
    await this.assertNoPendingPublish(row.id);
    await this.versions.delete({ toolId: row.id, status: ToolVersionStatus.DRAFT });
    this.logger.log(`${row.name}: draft discarded by operator ${operator.operatorId}`);
    return this.get(row.id);
  }

  /**
   * A draft is frozen while its publish waits for a second operator: the
   * approval is for the content that was queued, and an edit or a discard in
   * between would have the approver sign for something else (review P1-1).
   * Reject the pending request first to change the draft.
   */
  private async assertNoPendingPublish(toolId: string): Promise<void> {
    await this.approvalRows.expireStale();
    const pending = await this.approvalRows.findOne({
      where: {
        action: PUBLISH_VERSION_APPROVAL_ACTION,
        target: `tool:${toolId}`,
        status: 'PENDING',
      },
    });
    if (pending) {
      throw ToolErrors.contractState({
        reason: `a publish of this draft awaits a second operator (approval ${pending.id}); reject it to edit`,
      });
    }
  }

  // ── P-10 publish (two-person) ─────────────────────────────────────────────

  async publish(
    operator: OperatorSession,
    toolId: string,
    version: number,
    body: ContractActionBodyDto,
    requestId: string | null,
    approver: OperatorApprover | null = null,
    /** The draft content the queued request was for; re-checked under the lock. */
    contentHash?: string,
  ): Promise<OperatorToolDto | ApprovalQueuedDto> {
    const row = await this.requireStandardTool(toolId);
    // Checked before queueing, so a request no one could approve is refused at once.
    const draft = await this.versions.findVersion(row.id, version);
    if (!draft) throw ToolErrors.versionNotFound({ version });
    if (draft.status !== ToolVersionStatus.DRAFT) {
      throw ToolErrors.contractState({
        reason: `v${draft.semver} is ${draft.status}, not a draft`,
      });
    }

    const attempt = async () => {
      const outcome = await this.overrides.perform<{ semver: string; movedCurrent: boolean }>(
        {
          code: 'P-10',
          actor: operator,
          approver,
          targetType: 'tool',
          targetId: row.id,
          organizationId: null,
          reasonCode: body.reasonCode,
          reason: body.note,
          ticketRef: body.ticketRef ?? null,
          requestId,
        },
        async (queryRunner) => {
          const manager = queryRunner.manager;
          const tool = await lockTool(manager, row.id);
          const versions = await manager.find(ToolVersionEntity, { where: { toolId: row.id } });
          const current = versions.find((v) => v.version === version);
          if (!current || current.status !== ToolVersionStatus.DRAFT) {
            throw ToolErrors.contractState({ reason: `version ${version} is no longer a draft` });
          }
          // The approval is for content, not a number (review P1-1).
          const hash = draftContentHash(current);
          if (approver && hash !== contentHash) {
            throw ToolErrors.contractState({
              reason: 'the draft changed after its publish was requested; request it again',
            });
          }
          if (approver && approver.operatorId === (current.editedBy ?? current.createdBy)) {
            throw OperatorErrors.selfApprovalRefused({ code: 'P-10' });
          }
          const shape = shapeOfVersion(current);
          const problems = contractProblems(shape);
          if (problems.length > 0) throw ToolErrors.contractInvalid({ problems });

          const published = versions.filter((v) => v.status !== ToolVersionStatus.DRAFT);
          // Recomputed against what is published now: the version the draft's
          // semver was bumped from (§7.5). A version published since the draft
          // was saved shows here as a conflict, never as a silent re-number.
          const semver = nextSemver(baseForDraft(published, current.semver), shape, published);
          const major = (parseSemver(semver) as { major: number }).major;

          const now = new Date();
          await manager.update(
            ToolVersionEntity,
            { toolId: row.id, version },
            {
              semver,
              major,
              status: ToolVersionStatus.ACTIVE,
              publishedAt: now,
              publishedBy: operator.operatorId,
              updatedAt: now,
            },
          );

          const currentRow = published.find((v) => v.version === tool.currentVersion) ?? null;
          // A first version becomes current; a patch or minor of the current
          // major moves current with it; a new major does not (§7.3).
          const movesCurrent =
            !currentRow ||
            (currentRow.major === major && compareSemverText(semver, currentRow.semver) > 0);
          await manager.update(
            ToolEntity,
            { id: row.id },
            {
              ...(movesCurrent ? { currentVersion: version } : {}),
              ...(tool.status === ToolStatus.DRAFT ? { status: ToolStatus.ACTIVE } : {}),
              updatedAt: now,
            },
          );
          return {
            value: { semver, movedCurrent: movesCurrent },
            before: { status: 'DRAFT', currentVersion: tool.currentVersion },
            after: {
              status: 'ACTIVE',
              semver,
              contentHash: hash,
              currentVersion: movesCurrent ? version : tool.currentVersion,
            },
          };
        },
      );
      await this.changes.contractsChanged();
      this.logger.log(
        `${row.name} v${outcome.semver} published` +
          (outcome.movedCurrent ? ' and is now current' : ' (current version unchanged)'),
      );
      return this.get(row.id);
    };

    if (approver) return attempt();
    return this.approvals.orQueue(
      {
        action: PUBLISH_VERSION_APPROVAL_ACTION,
        target: `tool:${row.id}`,
        payload: {
          toolId: row.id,
          version,
          contentHash: draftContentHash(draft),
          body: { ...body },
        },
        requester: operator,
      },
      attempt,
    );
  }

  // ── P-11 move current_version (two-person) ────────────────────────────────

  async moveCurrentVersion(
    operator: OperatorSession,
    toolId: string,
    body: MoveCurrentVersionBodyDto,
    requestId: string | null,
    approver: OperatorApprover | null = null,
  ): Promise<OperatorToolDto | ApprovalQueuedDto> {
    const row = await this.requireStandardTool(toolId);
    const target = await this.versions.findVersion(row.id, body.version);
    if (!target) throw ToolErrors.versionNotFound({ version: body.version });
    if (target.status !== ToolVersionStatus.ACTIVE) {
      throw ToolErrors.contractState({
        reason: `v${target.semver} is ${target.status}; only an ACTIVE version can be current`,
      });
    }
    if (row.currentVersion === target.version) {
      throw ToolErrors.contractState({ reason: `v${target.semver} is already current` });
    }

    const attempt = async () => {
      await this.overrides.perform<void>(
        {
          code: 'P-11',
          actor: operator,
          approver,
          targetType: 'tool',
          targetId: row.id,
          organizationId: null,
          reasonCode: body.reasonCode,
          reason: body.note,
          ticketRef: body.ticketRef ?? null,
          requestId,
        },
        async (queryRunner) => {
          const manager = queryRunner.manager;
          const tool = await lockTool(manager, row.id);
          const version = await manager.findOne(ToolVersionEntity, {
            where: { toolId: row.id, version: body.version },
          });
          if (!version || version.status !== ToolVersionStatus.ACTIVE) {
            throw ToolErrors.contractState({ reason: `version ${body.version} is not ACTIVE` });
          }
          await manager.update(
            ToolEntity,
            { id: row.id },
            { currentVersion: body.version, updatedAt: new Date() },
          );
          return {
            value: undefined,
            before: { currentVersion: tool.currentVersion },
            after: { currentVersion: body.version, semver: version.semver },
          };
        },
      );
      await this.changes.contractsChanged();
      return this.get(row.id);
    };

    if (approver) return attempt();
    return this.approvals.orQueue(
      {
        action: MOVE_CURRENT_VERSION_APPROVAL_ACTION,
        target: `tool:${row.id}`,
        payload: { toolId: row.id, body: { ...body } },
        requester: operator,
      },
      attempt,
    );
  }

  // ── P-12 deprecate a major (one operator) ─────────────────────────────────

  async deprecate(
    operator: OperatorSession,
    toolId: string,
    version: number,
    body: DeprecateVersionBodyDto,
    requestId: string | null,
  ): Promise<OperatorToolDto> {
    const row = await this.requireStandardTool(toolId);
    const target = await this.versions.findVersion(row.id, version);
    if (!target || target.status === ToolVersionStatus.DRAFT) {
      throw ToolErrors.versionNotFound({ version });
    }
    if (target.status !== ToolVersionStatus.ACTIVE) {
      throw ToolErrors.contractState({ reason: `v${target.semver} is already ${target.status}` });
    }
    const sunsetAt = new Date(body.sunsetAt);
    if (Number.isNaN(sunsetAt.getTime()) || sunsetAt.getTime() < Date.now() + MIN_SUNSET_MS) {
      throw ToolErrors.contractState({
        reason: 'sunsetAt must be at least 90 days from now (UTC)',
      });
    }
    if (body.replacementToolId === row.id) {
      throw ToolErrors.contractState({ reason: 'a tool cannot replace itself' });
    }
    if (
      body.replacementToolId &&
      !(await this.tools.findOne({ where: { id: body.replacementToolId } }))
    ) {
      throw ToolErrors.toolNotFound({ toolId: body.replacementToolId });
    }

    const major = target.major;
    await this.overrides.perform<void>(
      {
        code: 'P-12',
        actor: operator,
        targetType: 'tool',
        targetId: row.id,
        organizationId: null,
        reasonCode: body.reasonCode,
        reason: body.note,
        ticketRef: body.ticketRef ?? null,
        requestId,
      },
      async (queryRunner) => {
        const manager = queryRunner.manager;
        const tool = await lockTool(manager, row.id);
        const current = tool.currentVersion
          ? await manager.findOne(ToolVersionEntity, {
              where: { toolId: row.id, version: tool.currentVersion },
            })
          : null;
        // Unpinned URLs serve the current major: deprecating it would sunset
        // every unpinned caller. The current version moves first (P-11).
        if (current && current.major === major) {
          throw ToolErrors.contractState({
            reason: `v${major} is the current major; move the current version first`,
          });
        }
        await manager.update(
          ToolVersionEntity,
          { toolId: row.id, major, status: ToolVersionStatus.ACTIVE },
          { status: ToolVersionStatus.DEPRECATED, sunsetAt, updatedAt: new Date() },
        );
        if (body.replacementToolId) {
          await manager.update(
            ToolEntity,
            { id: row.id },
            { replacementToolId: body.replacementToolId, updatedAt: new Date() },
          );
        }
        return {
          value: undefined,
          before: { major, status: 'ACTIVE' },
          after: {
            major,
            status: 'DEPRECATED',
            sunsetAt: sunsetAt.toISOString(),
            replacementToolId: body.replacementToolId ?? row.replacementToolId,
          },
        };
      },
    );
    await this.changes.contractsChanged();

    const detail = await this.get(row.id);
    const tool = buildTools(
      [await this.requireTool(row.id)],
      await this.versions.findByTools([row.id]),
    ).get(row.id);
    const replacement = tool ? replacementOf(tool, { major }) : null;
    await this.lifecycle
      .notifyDeprecated({ toolId: row.id, toolName: row.name, major, sunsetAt, replacement })
      .catch((error: unknown) => {
        this.logger.warn(`deprecation notices for ${row.name} v${major} failed: ${String(error)}`);
      });
    return detail;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async inDraftTransaction(work: (manager: EntityManager) => Promise<void>): Promise<void> {
    try {
      await this.dataSource.transaction(work);
    } catch (error) {
      if ((error as { code?: string })?.code === UNIQUE_VIOLATION_CODE) {
        throw ToolErrors.contractState({
          reason: 'that version number is taken; reload and retry',
        });
      }
      throw error;
    }
  }

  /**
   * The editor writes standard contracts only: a provider tool's contract is
   * its provider's, reviewed through `/operator/reviews` (§7.6), never
   * rewritten here.
   */
  private async requireStandardTool(toolId: string): Promise<ToolEntity> {
    const row = await this.requireTool(toolId);
    if (row.kind !== 'STANDARD') {
      throw ToolErrors.contractState({
        reason: 'a provider tool’s contract is its provider’s; review it in /operator/reviews',
      });
    }
    return row;
  }

  private async requireTool(toolId: string): Promise<ToolEntity> {
    const row = await this.tools.findOne({ where: { id: toolId } });
    if (!row) throw ToolErrors.toolNotFound({ toolId });
    return row;
  }

  /** Per major: its newest version, and the bindings that can serve it now. */
  private async majorsOf(
    row: ToolEntity,
    published: readonly ToolVersionEntity[],
  ): Promise<ContractMajorDto[]> {
    const majors = [...new Set(published.map((version) => version.major))].sort((a, b) => b - a);
    if (majors.length === 0) return [];
    const bindings = await this.dataSource.getRepository(ToolBindingEntity).find({
      where: { toolId: row.id, status: 'ACTIVE' },
      select: { id: true, toolVersionRange: true },
    });

    const out: ContractMajorDto[] = [];
    for (const major of majors) {
      const latest = [...published]
        .filter((version) => version.major === major)
        .sort((a, b) => compareSemverText(b.semver, a.semver))[0];
      const quote =
        row.status === ToolStatus.DRAFT
          ? null
          : await this.router
              .quote(row.id, {
                payerChains: this.enabledChains,
                withdrawingChains: [],
                enabledChains: this.enabledChains,
                defaultChainId: null,
                contract: { range: [major], requireOutputFields: [] },
              })
              .catch(() => null);
      out.push({
        major,
        latestSemver: latest.semver,
        status: latest.status,
        sunsetAt: latest.sunsetAt ?? null,
        eligibleBindings: quote?.routableBindings ?? 0,
        activeBindings: bindings.filter((binding) =>
          bindingRange(binding.toolVersionRange).includes(major),
        ).length,
      });
    }
    return out;
  }
}

function summaryOf(
  row: ToolEntity,
  versions: readonly ToolVersionEntity[],
): OperatorToolSummaryDto {
  const current = versions.find((version) => version.version === row.currentVersion) ?? null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    category: row.category,
    tags: [...(row.tags ?? [])],
    status: row.status,
    currentSemver: current?.semver ?? null,
    currentVersion: row.currentVersion,
    hasDraft: versions.some((version) => version.status === ToolVersionStatus.DRAFT),
  };
}

function shapeOf(body: SaveContractDraftBodyDto): ContractShape {
  return {
    summary: body.summary,
    description: body.description,
    inputSchema: body.inputSchema,
    outputSchema: body.outputSchema,
    optionalInputFields: [...new Set(body.optionalInputFields ?? [])],
    optionalOutputFields: [...new Set(body.optionalOutputFields ?? [])],
    examples: body.examples ?? [],
    verificationPolicyId: body.verificationPolicyId ?? DEFAULT_VERIFICATION_POLICY_ID,
    tier: body.tier ?? ToolTier.UNVERIFIED,
  };
}

function shapeOfVersion(row: ToolVersionEntity): ContractShape {
  return {
    summary: row.summary,
    description: row.description,
    inputSchema: row.inputSchema,
    outputSchema: row.outputSchema,
    optionalInputFields: row.optionalInputFields ?? [],
    optionalOutputFields: row.optionalOutputFields ?? [],
    examples: row.examples ?? [],
    verificationPolicyId: row.verificationPolicyId,
    tier: row.tier,
  };
}

/** The version a draft is diffed against: the one named, else the newest published. */
function baseOf(
  published: readonly ToolVersionEntity[],
  baseVersion: number | null,
): ToolVersionEntity | null {
  if (baseVersion !== null)
    return published.find((version) => version.version === baseVersion) ?? null;
  return newestOf(published);
}

function newestOf(versions: readonly ToolVersionEntity[]): ToolVersionEntity | null {
  return [...versions].sort((a, b) => compareSemverText(b.semver, a.semver))[0] ?? null;
}

/** The base a saved draft was bumped from: the newest published version below it. */
function baseForDraft(
  published: readonly ToolVersionEntity[],
  draftSemver: string,
): ToolVersionEntity | null {
  return newestOf(
    published.filter((version) => compareSemverText(version.semver, draftSemver) < 0),
  );
}

/**
 * The semver a draft publishes as: 1.0.0 for a first version, else its base
 * bumped by the diff (§7.5). A bump that lands on a version that exists (a
 * minor of an older major whose next minor is taken) is refused: draft
 * against the newest version of that major instead.
 */
function nextSemver(
  base: ToolVersionEntity | null,
  shape: ContractShape,
  published: readonly ToolVersionEntity[],
  options: { readonly allowNoChange?: boolean } = {},
): string {
  if (!base) return '1.0.0';
  const diff = diffContracts(shapeOfVersion(base), shape);
  // A draft saved identical to its base keeps a patch number until it
  // differs; it cannot be published like that.
  if (!diff.bump && !options.allowNoChange)
    throw ToolErrors.contractNoChanges({ base: base.semver });
  const bump = diff.bump ?? VersionBump.PATCH;
  const highest = published.reduce((max, version) => Math.max(max, version.major), 0);
  if (bump === VersionBump.MAJOR && base.major !== highest) {
    throw ToolErrors.contractState({
      reason: `a new major is drafted against the newest version (v${highest}), not v${base.semver}`,
    });
  }
  // A deprecated or retired major takes no new version: it is on its way
  // out, and a version published there would escape its sunset.
  if (
    bump !== VersionBump.MAJOR &&
    published.some(
      (version) =>
        version.major === base.major &&
        (version.status === ToolVersionStatus.DEPRECATED ||
          version.status === ToolVersionStatus.RETIRED),
    )
  ) {
    throw ToolErrors.contractState({
      reason: `v${base.major} is deprecated; draft a change to the newest major instead`,
    });
  }
  const next = bumpSemver(parseSemver(base.semver), bump);
  const text = formatSemver(next);
  if (published.some((version) => version.semver === text)) {
    throw ToolErrors.contractState({
      reason: `v${text} already exists; draft against the newest version of v${next.major}`,
    });
  }
  return text;
}

function draftOf(
  row: ToolVersionEntity,
  published: readonly ToolVersionEntity[],
): ContractDraftDto {
  const shape = shapeOfVersion(row);
  const base = baseForDraft(published, row.semver);
  const diff = base ? diffContracts(shapeOfVersion(base), shape) : { bump: null, changes: [] };
  return {
    version: row.version,
    baseSemver: base?.semver ?? null,
    baseVersion: base?.version ?? null,
    nextSemver: row.semver,
    bump: base ? diff.bump : VersionBump.MAJOR,
    changes: diff.changes.map((change) => ({ ...change })),
    problems: [
      ...contractProblems(shape),
      ...(base && !diff.bump ? [`identical to v${base.semver}`] : []),
    ],
    summary: row.summary,
    description: row.description,
    inputSchema: row.inputSchema,
    outputSchema: row.outputSchema,
    optionalInputFields: [...(row.optionalInputFields ?? [])],
    optionalOutputFields: [...(row.optionalOutputFields ?? [])],
    examples: (row.examples ?? []) as ContractDraftDto['examples'],
    verificationPolicyId: row.verificationPolicyId,
    tier: row.tier as ToolTier | null,
    changelog: row.changelog,
    // The same operator the publish approval refuses as approver.
    editedBy: row.editedBy ?? row.createdBy ?? null,
    updatedAt: row.updatedAt,
  };
}

/**
 * The editor's suggestion to move `current_version` (§7.3): the newest ACTIVE
 * version of a newer major once that major has at least two eligible
 * bindings, or half of the current major's.
 */
function suggestedCurrent(
  row: ToolEntity,
  published: readonly ToolVersionEntity[],
  majors: readonly ContractMajorDto[],
): number | null {
  const current = published.find((version) => version.version === row.currentVersion);
  if (!current) return null;
  const currentEligible = majors.find((m) => m.major === current.major)?.eligibleBindings ?? 0;
  for (const major of majors) {
    if (major.major <= current.major) continue;
    if (
      major.eligibleBindings >= SUGGEST_CURRENT_MIN_BINDINGS ||
      (currentEligible > 0 && major.eligibleBindings * 2 >= currentEligible)
    ) {
      const newest = [...published]
        .filter(
          (version) => version.major === major.major && version.status === ToolVersionStatus.ACTIVE,
        )
        .sort((a, b) => compareSemverText(b.semver, a.semver))[0];
      if (newest) return newest.version;
    }
  }
  return null;
}

/** SHA-256 of everything a draft would publish: what a P-10 approval is for. */
export function draftContentHash(row: ToolVersionEntity): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        version: row.version,
        semver: row.semver,
        shape: shapeOfVersion(row),
        changelog: row.changelog ?? null,
      }),
      'utf8',
    )
    .digest('hex');
}

/** The tool row, locked for the rest of the transaction. */
async function lockTool(manager: EntityManager, toolId: string): Promise<ToolEntity> {
  const row = await manager
    .createQueryBuilder(ToolEntity, 'tool')
    .setLock('pessimistic_write')
    .where('tool.id = :toolId', { toolId })
    .getOne();
  if (!row) throw ToolErrors.toolNotFound({ toolId });
  return row;
}
