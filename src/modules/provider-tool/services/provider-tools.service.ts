import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { ToolPromotionInviteEntity } from '@database/postgres/entities/tool-promotion-invite.entity';
import { ToolEntity } from '@database/postgres/entities/tool.entity';
import { ToolVersionEntity } from '@database/postgres/entities/tool-version.entity';
import { UNIQUE_VIOLATION_CODE } from '@database/postgres/repositories/abstract.repository';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { ToolRepository } from '@database/postgres/repositories/tool.repository';
import { ProviderStatus } from '@modules/provider/ports/provider.types';
import {
  ContractShape,
  MIN_SUNSET_MS,
  VersionBump,
  compareSemverText,
  contractProblems,
  parseSemver,
} from '@modules/tool/domain/contract';
import { JsonSchema } from '@modules/tool/domain/mapping/schema-validator';
import {
  parseProviderToolName,
  providerToolName,
  providerToolNameProblems,
} from '@modules/tool/domain/provider-tool-name';
import {
  TOOL_CONTRACT_CHANGES,
  ToolContractChanges,
} from '@modules/tool/ports/tool-contracts.port';
import {
  ToolKind,
  ToolStatus,
  ToolTier,
  ToolVersionStatus,
  ToolVisibility,
} from '@modules/tool/ports/tool.types';
import { MCP_HOST_CONFIG, McpHostConfig } from '@modules/toolset/config/mcp-host.config';
import { HandleStatus } from '@modules/toolset/domain/handle';
import { AccessEpochService } from '@modules/toolset/services/access-epoch.service';
import { HandlesService, lockHandle } from '@modules/toolset/services/handles.service';
import { CursorPageDto, ListQueryDto, ListSpec, asInstant, paginate } from '@shared/api';
import { AuditActor, AuditLogWriter } from '@shared/audit';

import { declaredRuleProblems } from '../domain/declared-rules';
import { isServedRow, servedVersionsOf } from '../domain/served-versions';
import {
  ReviewKind,
  ReviewStatus,
  ReviewedMeta,
  ReviewedVersion,
  reviewContentHash,
  reviewDisplayOf,
  reviewKindOf,
} from '../domain/review';
import {
  ProviderDraftShape,
  baseForDraft,
  diffDraft,
  newestOf,
  nextDraftSemver,
} from '../domain/versioning';
import {
  CreateProviderToolBodyDto,
  PromotionInvitationListDto,
  ProviderToolContractBodyDto,
  ProviderToolDraftDto,
  ProviderToolDto,
  ProviderToolGateDto,
  ProviderToolReviewDto,
  ProviderToolSummaryDto,
  ProviderToolVersionDto,
  UpdateProviderToolBodyDto,
} from '../dto/provider-tools.dto';
import { ProviderToolErrors } from '../errors/provider-tool.errors';
import { ProviderToolGateService, screenVersion } from './provider-tool-gate.service';
import { ProviderToolPolicyService, providerPolicyId } from './provider-tool-policy.service';
import { ProviderToolQualityService } from './provider-tool-quality.service';

const PROVIDER_TOOL_LIST: ListSpec = {
  alias: 'tool',
  defaultSort: 'createdAt',
  sortable: {
    createdAt: {
      column: 'tool.created_at',
      type: 'timestamptz',
      valueOf: asInstant((row: ToolEntity) => row.createdAt),
    },
  },
};

/** The name preview uses a 4-letter server name, as the Connect sheet suggests (§7.10). */
const PREVIEW_SERVER = 'acme';

/**
 * A provider's own tools (design spec §7.6, phase T4): `{handle}__{tool}`,
 * with a contract the provider writes, versioned by the T3 rules, and its own
 * binding as the only implementation.
 *
 * ```text
 * create            PRIVATE, a DRAFT 1.0.0                      own org only
 * save / discard    the one DRAFT version
 * publish version   PRIVATE: at once · UNLISTED: through the gate · LISTED: to review
 * share UNLISTED    through the gate; locks the handle
 * submit review     through the gate; PENDING, for the content hashed now
 * withdraw review   PENDING → back
 * ```
 *
 * Every read and write names the caller's organization: another
 * organization's tool, whatever its visibility, is the same 404 as a tool
 * that does not exist. Every write that changes what serves moves the
 * contract epoch and the shared view epoch.
 */
@Injectable()
export class ProviderToolsService {
  constructor(
    private readonly tools: ToolRepository,
    private readonly providers: ProviderRepository,
    private readonly handles: HandlesService,
    private readonly gate: ProviderToolGateService,
    private readonly policy: ProviderToolPolicyService,
    private readonly quality: ProviderToolQualityService,
    private readonly epochs: AccessEpochService,
    private readonly audit: AuditLogWriter,
    @Inject(TOOL_CONTRACT_CHANGES) private readonly changes: ToolContractChanges,
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    @Inject(MCP_HOST_CONFIG) private readonly host: McpHostConfig,
  ) {}

  // ── Reads ───────────────────────────────────────────────────────────────

  async list(
    organizationId: string,
    query: ListQueryDto,
  ): Promise<CursorPageDto<ProviderToolSummaryDto>> {
    const qb = this.tools
      .createQueryBuilder('tool')
      .where('tool.owner_org_id = :organizationId', { organizationId })
      .andWhere(`tool.kind = 'PROVIDER'`);
    const page = await paginate(qb, query, PROVIDER_TOOL_LIST);
    const versions = await this.versionsOf(page.items.map((row) => row.id));
    const names = await this.replacementNames(page.items);
    return page.map((row) => summaryOf(row, versions.get(row.id) ?? [], names));
  }

  async get(organizationId: string, toolId: string): Promise<ProviderToolDto> {
    const row = await this.requireOwned(organizationId, toolId);
    return this.detail(row);
  }

  /** The detail of a provider tool, for its provider and for the operator's review. */
  async detail(row: ToolEntity): Promise<ProviderToolDto> {
    const versions = (await this.versionsOf([row.id])).get(row.id) ?? [];
    const published = versions.filter((version) => version.status !== ToolVersionStatus.DRAFT);
    const draftRow = versions.find((version) => version.status === ToolVersionStatus.DRAFT) ?? null;
    const [binding, quality, names] = await Promise.all([
      this.gate.bindingOf(row),
      this.quality.of(row),
      this.replacementNames([row]),
    ]);
    const handle = parseProviderToolName(row.name)?.handle ?? null;
    return {
      ...summaryOf(row, versions, names),
      versions: published
        .sort((a, b) => compareSemverText(b.semver, a.semver))
        .map((version) => versionDtoOf(row, version)),
      draft: draftRow ? draftDtoOf(row, draftRow, published) : null,
      binding: binding
        ? {
            bindingId: binding.id,
            status: binding.status,
            mappingVersion: binding.mappingVersion,
            publishedVersion: binding.publishedVersion ?? null,
          }
        : null,
      mcpUrls: {
        handle:
          row.visibility === ToolVisibility.LISTED && handle && !row.removedAt
            ? `${this.mcpBase()}/@${handle}`
            : null,
      },
      quality,
    };
  }

  /** `GET …/publish-check`: the gate as it stands, every version the tool would serve screened. */
  async publishCheck(organizationId: string, toolId: string): Promise<ProviderToolGateDto> {
    const row = await this.requireOwned(organizationId, toolId);
    const versions = (await this.versionsOf([row.id])).get(row.id) ?? [];
    const draft =
      row.visibility === ToolVisibility.LISTED
        ? (versions.find((version) => version.status === ToolVersionStatus.DRAFT) ?? null)
        : null;
    return this.gate.evaluate(row, versions, draft);
  }

  // ── Create and draft ───────────────────────────────────────────────────

  async create(
    organizationId: string,
    body: CreateProviderToolBodyDto,
    actor: AuditActor,
  ): Promise<ProviderToolDto> {
    const provider = await this.providers.findOne({ where: { organizationId } });
    if (!provider || provider.status !== ProviderStatus.ACTIVE) {
      throw ProviderToolErrors.notAllowed({ reason: 'NOT_PROVIDER' });
    }
    const handle = (await this.handles.handlesOf([organizationId])).get(organizationId);
    if (!handle) throw ProviderToolErrors.notAllowed({ reason: 'NO_HANDLE' });

    const name = providerToolName(handle, body.name);
    const nameProblems = providerToolNameProblems(handle, body.name);
    if (nameProblems.length > 0) throw ProviderToolErrors.invalid({ problems: nameProblems });
    await this.assertCategory(body.category);

    const newId = randomUUID();
    const shape = shapeOfBody(body, null, newId);
    const problems = [...contractProblems(shape), ...declaredRuleProblems(body.rules ?? [])];
    if (problems.length > 0) throw ProviderToolErrors.invalid({ problems });

    let toolId: string;
    try {
      toolId = await this.dataSource.transaction(async (manager) => {
        // The handle again, locked: a takedown, rename or reassignment that
        // landed since the read above would leave the new tool outside it.
        await lockHandle(manager, handle);
        const [owner] = (await manager.query(
          `SELECT handle, handle_status AS "handleStatus" FROM organizations
            WHERE id = $1 FOR UPDATE`,
          [organizationId],
        )) as { handle: string | null; handleStatus: string | null }[];
        if (owner?.handle !== handle || owner.handleStatus !== HandleStatus.ACTIVE) {
          throw ProviderToolErrors.notAllowed({ reason: 'NO_HANDLE' });
        }
        const [inserted] = (await manager.query(
          `INSERT INTO tools (id, name, kind, owner_org_id, category, tags, visibility,
                              review_status, status, last_version_number)
           VALUES ($5, $1, 'PROVIDER', $2, $3, $4::text[], 'PRIVATE',
                   'NONE', 'DRAFT', 1)
           RETURNING id`,
          [name, organizationId, body.category, dedupe(body.tags ?? []), newId],
        )) as { id: string }[];
        await manager.insert(ToolVersionEntity, {
          ...versionFieldsOf(shape),
          toolId: inserted.id,
          version: 1,
          semver: '1.0.0',
          major: 1,
          status: ToolVersionStatus.DRAFT,
          changelog: body.changelog ?? null,
        });
        await this.audit.record(manager, {
          organizationId,
          actor,
          action: 'provider_tool.created',
          resourceType: 'tool',
          resourceId: inserted.id,
          before: null,
          after: { name, category: body.category },
        });
        return inserted.id;
      });
    } catch (error) {
      if ((error as { code?: string })?.code === UNIQUE_VIOLATION_CODE) {
        throw ProviderToolErrors.nameTaken({ name, suggestion: await this.tools.freeName(name) });
      }
      throw error;
    }
    return this.get(organizationId, toolId);
  }

  /** `POST …/versions`: create or replace the tool's one DRAFT version. */
  async saveDraft(
    organizationId: string,
    toolId: string,
    body: ProviderToolContractBodyDto,
    actor: AuditActor,
  ): Promise<ProviderToolDto> {
    const owned = await this.requireOwned(organizationId, toolId);
    if (body.category !== undefined) await this.assertCategory(body.category);
    await this.dataSource.transaction(async (manager) => {
      const row = await lockTool(manager, owned.id);
      assertNotRemoved(row);
      const versions = await manager.find(ToolVersionEntity, { where: { toolId: row.id } });
      const existing = versions.find((version) => version.status === ToolVersionStatus.DRAFT);
      if (existing) assertDraftNotInReview(row, existing);
      await applyDraftMeta(manager, row, body);
      const published = versions.filter((version) => version.status !== ToolVersionStatus.DRAFT);

      let base: ToolVersionEntity | null = newestOf(published);
      if (body.baseVersion !== undefined) {
        const named = published.find((version) => version.version === body.baseVersion);
        if (!named)
          throw ProviderToolErrors.state({ reason: `no published version ${body.baseVersion}` });
        const newestOfMajor = newestOf(
          published.filter((version) => version.major === named.major),
        );
        if (newestOfMajor && newestOfMajor.version !== named.version) {
          throw ProviderToolErrors.state({
            reason: `draft against the newest version of v${named.major} (v${newestOfMajor.semver})`,
          });
        }
        base = named;
      }
      const shape = shapeOfBody(body, base, row.id);
      const problems = [...contractProblems(shape), ...declaredRuleProblems(body.rules ?? [])];
      if (problems.length > 0) throw ProviderToolErrors.invalid({ problems });

      const diff = diffDraft(base ? draftShapeOf(base) : null, shape);
      const next = nextDraftSemver(base, base ? diff.bump : VersionBump.MAJOR, published, {
        allowNoChange: true,
      });
      if ('refusal' in next) {
        throw ProviderToolErrors.state({
          reason:
            next.refusal.kind === 'NO_CHANGES'
              ? `identical to v${next.refusal.base}`
              : next.refusal.reason,
        });
      }
      const semver = next.semver;
      const fields = {
        ...versionFieldsOf(shape),
        semver,
        major: (parseSemver(semver) as { major: number }).major,
        changelog: body.changelog ?? null,
      };
      if (existing) {
        await manager.update(
          ToolVersionEntity,
          { toolId: row.id, version: existing.version },
          { ...fields, updatedAt: new Date() },
        );
      } else {
        const highest = versions.reduce((max, version) => Math.max(max, version.version), 0);
        const number = Math.max(highest, row.lastVersionNumber ?? 0) + 1;
        await manager.insert(ToolVersionEntity, {
          ...fields,
          toolId: row.id,
          version: number,
          status: ToolVersionStatus.DRAFT,
        });
        await manager.update(ToolEntity, { id: row.id }, { lastVersionNumber: number });
      }
      await this.audit.record(manager, {
        organizationId,
        actor,
        action: 'provider_tool.draft_saved',
        resourceType: 'tool',
        resourceId: row.id,
        before: null,
        after: { semver },
      });
    });
    return this.get(organizationId, owned.id);
  }

  async discardDraft(
    organizationId: string,
    toolId: string,
    actor: AuditActor,
  ): Promise<ProviderToolDto> {
    const owned = await this.requireOwned(organizationId, toolId);
    await this.dataSource.transaction(async (manager) => {
      const row = await lockTool(manager, owned.id);
      const draft = await manager.findOne(ToolVersionEntity, {
        where: { toolId: row.id, status: ToolVersionStatus.DRAFT },
      });
      if (!draft) throw ProviderToolErrors.state({ reason: 'there is no draft' });
      assertDraftNotInReview(row, draft);
      if (row.status === ToolStatus.DRAFT) {
        throw ProviderToolErrors.state({
          reason: 'the first version can be edited, not discarded',
        });
      }
      await manager.update(
        ToolEntity,
        { id: row.id },
        {
          pendingCategory: null,
          pendingTags: null,
          ...(row.reviewVersion === draft.version ? { reviewVersion: null } : {}),
        },
      );
      await manager.delete(ToolVersionEntity, { toolId: row.id, version: draft.version });
      await this.audit.record(manager, {
        organizationId,
        actor,
        action: 'provider_tool.draft_discarded',
        resourceType: 'tool',
        resourceId: row.id,
        before: { semver: draft.semver },
        after: null,
      });
    });
    return this.get(organizationId, owned.id);
  }

  async update(
    organizationId: string,
    toolId: string,
    body: UpdateProviderToolBodyDto,
    actor: AuditActor,
  ): Promise<ProviderToolDto> {
    const row = await this.requireOwned(organizationId, toolId);
    assertNotRemoved(row);
    // A reviewed tool's category and tags are part of what was reviewed
    // (§7.6): they change with a draft, through review, never here.
    if (row.approvedVersion !== null) {
      throw ProviderToolErrors.state({
        reason: 'a reviewed tool’s category and tags change with its next draft, through review',
      });
    }
    if (row.reviewStatus === ReviewStatus.PENDING) {
      throw ProviderToolErrors.inReview({ reviewVersion: row.reviewVersion });
    }
    const patch: Partial<ToolEntity> = {};
    if (body.category !== undefined && body.category !== row.category) {
      await this.assertCategory(body.category);
      patch.category = body.category;
    }
    if (body.tags !== undefined) patch.tags = dedupe(body.tags);
    if (Object.keys(patch).length > 0) {
      await this.dataSource.transaction(async (manager) => {
        await manager.update(ToolEntity, { id: row.id }, { ...patch, updatedAt: new Date() });
        await this.audit.record(manager, {
          organizationId,
          actor,
          action: 'provider_tool.updated',
          resourceType: 'tool',
          resourceId: row.id,
          before: { category: row.category, tags: row.tags },
          after: patch as Record<string, unknown>,
        });
      });
      await this.contractsChanged(organizationId);
    }
    return this.get(organizationId, row.id);
  }

  // ── Publish a version ──────────────────────────────────────────────────

  /**
   * `POST …/versions/:version/publish`. PRIVATE: published at once.
   * UNLISTED: through the gate, the draft screened with every served
   * version. LISTED: the draft goes to review (PENDING) and the approved
   * version keeps serving until an operator approves it (§7.6 "Re-review").
   */
  async publishVersion(
    organizationId: string,
    toolId: string,
    version: number,
    actor: AuditActor,
  ): Promise<ProviderToolDto> {
    const owned = await this.requireOwned(organizationId, toolId);
    const before = await this.versionsOf([owned.id]);
    const draftBefore = (before.get(owned.id) ?? []).find((v) => v.version === version);
    if (!draftBefore || draftBefore.status !== ToolVersionStatus.DRAFT) {
      throw ProviderToolErrors.state({ reason: `version ${version} is not a draft` });
    }
    // The gate reads stake and the binding outside the transaction; the
    // transaction re-checks everything the gate's verdict depends on that
    // this service writes.
    const gate =
      owned.visibility === ToolVisibility.PRIVATE
        ? null
        : await this.gate.evaluate(owned, before.get(owned.id) ?? [], draftBefore);
    if (gate && !gate.passed) throw gateFailed(gate);

    let published = false;
    await this.dataSource.transaction(async (manager) => {
      const row = await lockTool(manager, owned.id);
      assertNotRemoved(row);
      if (row.reviewStatus === ReviewStatus.PENDING) {
        throw ProviderToolErrors.inReview({ reviewVersion: row.reviewVersion });
      }
      if (row.visibility !== owned.visibility) {
        throw ProviderToolErrors.state({ reason: 'the tool changed; try again' });
      }
      const versions = await manager.find(ToolVersionEntity, { where: { toolId: row.id } });
      const draft = versions.find((v) => v.version === version);
      if (!draft || draft.status !== ToolVersionStatus.DRAFT) {
        throw ProviderToolErrors.state({ reason: `version ${version} is no longer a draft` });
      }
      if (draft.updatedAt.getTime() !== draftBefore.updatedAt.getTime()) {
        throw ProviderToolErrors.state({
          reason: 'the draft changed while it was checked; try again',
        });
      }
      const semver = settledSemver(versions, draft);

      if (row.visibility === ToolVisibility.LISTED) {
        // Re-review: nothing reaches LISTED surfaces before an operator reads it.
        await submitForReview(
          manager,
          row,
          [{ ...draft, semver } as ToolVersionEntity],
          draft.version,
          reviewMetaOf(row, ReviewKind.CHANGE),
        );
        await manager.update(
          ToolVersionEntity,
          { toolId: row.id, version },
          { semver, major: majorOf(semver) },
        );
        await this.audit.record(manager, {
          organizationId,
          actor,
          action: 'provider_tool.review_submitted',
          resourceType: 'tool',
          resourceId: row.id,
          before: { approvedVersion: row.approvedVersion },
          after: { kind: ReviewKind.CHANGE, version, semver },
        });
        return;
      }
      await publishDraft(manager, row, draft, semver);
      published = true;
      await this.audit.record(manager, {
        organizationId,
        actor,
        action: 'provider_tool.version_published',
        resourceType: 'tool',
        resourceId: row.id,
        before: { currentVersion: row.currentVersion },
        after: { version, semver, visibility: row.visibility },
      });
    });
    if (published) {
      await this.contractsChanged(organizationId);
      await this.policy.registerShadow({
        toolId: owned.id,
        toolName: owned.name,
        organizationId,
        rules: draftBefore.declaredRules ?? [],
      });
    }
    return this.get(organizationId, owned.id);
  }

  /** `POST …/versions/:version/deprecate`: a major other than the current one, sunset ≥ 90 days. */
  async deprecateMajor(
    organizationId: string,
    toolId: string,
    version: number,
    sunsetAtText: string,
    actor: AuditActor,
  ): Promise<ProviderToolDto> {
    const owned = await this.requireOwned(organizationId, toolId);
    const sunsetAt = new Date(sunsetAtText);
    if (Number.isNaN(sunsetAt.getTime()) || sunsetAt.getTime() < Date.now() + MIN_SUNSET_MS) {
      throw ProviderToolErrors.state({
        reason: 'sunsetAt must be at least 90 days from now (UTC)',
      });
    }
    await this.dataSource.transaction(async (manager) => {
      const row = await lockTool(manager, owned.id);
      assertNotRemoved(row);
      const target = await manager.findOne(ToolVersionEntity, {
        where: { toolId: row.id, version },
      });
      if (!target || target.status !== ToolVersionStatus.ACTIVE) {
        throw ProviderToolErrors.state({ reason: `version ${version} is not ACTIVE` });
      }
      const current = row.currentVersion
        ? await manager.findOne(ToolVersionEntity, {
            where: { toolId: row.id, version: row.currentVersion },
          })
        : null;
      if (current && current.major === target.major) {
        throw ProviderToolErrors.state({
          reason: `v${target.major} is the current major; publish a newer major first`,
        });
      }
      await manager.update(
        ToolVersionEntity,
        { toolId: row.id, major: target.major, status: ToolVersionStatus.ACTIVE },
        { status: ToolVersionStatus.DEPRECATED, sunsetAt, updatedAt: new Date() },
      );
      await this.audit.record(manager, {
        organizationId,
        actor,
        action: 'provider_tool.major_deprecated',
        resourceType: 'tool',
        resourceId: row.id,
        before: { major: target.major },
        after: { sunsetAt: sunsetAt.toISOString() },
      });
    });
    await this.contractsChanged(organizationId);
    return this.get(organizationId, owned.id);
  }

  // ── Share and review ───────────────────────────────────────────────────

  /** `POST …/publish { visibility: UNLISTED }`: through the gate; locks the handle. */
  async shareUnlisted(
    organizationId: string,
    toolId: string,
    actor: AuditActor,
  ): Promise<ProviderToolDto> {
    const owned = await this.requireOwned(organizationId, toolId);
    assertNotRemoved(owned);
    if (owned.visibility !== ToolVisibility.PRIVATE) {
      throw ProviderToolErrors.state({ reason: `the tool is already ${owned.visibility}` });
    }
    const versions = (await this.versionsOf([owned.id])).get(owned.id) ?? [];
    const gate = await this.gate.evaluate(owned, versions);
    if (!gate.passed) throw gateFailed(gate);
    await this.dataSource.transaction(async (manager) => {
      const row = await lockTool(manager, owned.id);
      assertNotRemoved(row);
      if (row.visibility !== ToolVisibility.PRIVATE) {
        throw ProviderToolErrors.state({ reason: `the tool is already ${row.visibility}` });
      }
      assertSameServedVersions(
        versions,
        await manager.find(ToolVersionEntity, { where: { toolId: row.id } }),
      );
      await this.handles.lockForSharing(manager, organizationId);
      await manager.update(
        ToolEntity,
        { id: row.id },
        { visibility: ToolVisibility.UNLISTED, updatedAt: new Date() },
      );
      await this.audit.record(manager, {
        organizationId,
        actor,
        action: 'provider_tool.shared',
        resourceType: 'tool',
        resourceId: row.id,
        before: { visibility: ToolVisibility.PRIVATE },
        after: { visibility: ToolVisibility.UNLISTED },
      });
    });
    await this.contractsChanged(organizationId);
    return this.get(organizationId, owned.id);
  }

  /**
   * `POST …/review`: submit for LISTED. A tool never approved submits every
   * version it serves; a LISTED one submits its draft (the same as
   * publishing that draft).
   */
  async submitReview(
    organizationId: string,
    toolId: string,
    actor: AuditActor,
  ): Promise<ProviderToolDto> {
    const owned = await this.requireOwned(organizationId, toolId);
    assertNotRemoved(owned);
    if (owned.reviewStatus === ReviewStatus.PENDING) {
      throw ProviderToolErrors.inReview({ reviewVersion: owned.reviewVersion });
    }
    const versions = (await this.versionsOf([owned.id])).get(owned.id) ?? [];
    if (owned.approvedVersion !== null) {
      const draft = versions.find((version) => version.status === ToolVersionStatus.DRAFT);
      if (!draft) {
        throw ProviderToolErrors.state({ reason: 'the tool is listed; save a draft to change it' });
      }
      return this.publishVersion(organizationId, toolId, draft.version, actor);
    }
    if (owned.status === ToolStatus.DRAFT) {
      throw ProviderToolErrors.state({ reason: 'publish a version first' });
    }
    const gate = await this.gate.evaluate(owned, versions);
    if (!gate.passed) throw gateFailed(gate);
    await this.dataSource.transaction(async (manager) => {
      const row = await lockTool(manager, owned.id);
      assertNotRemoved(row);
      if (row.reviewStatus === ReviewStatus.PENDING || row.approvedVersion !== null) {
        throw ProviderToolErrors.state({ reason: 'the tool changed; reload' });
      }
      const now = await manager.find(ToolVersionEntity, { where: { toolId: row.id } });
      assertSameServedVersions(versions, now);
      await this.handles.lockForSharing(manager, organizationId);
      const served = servedVersionsOf(now);
      await submitForReview(
        manager,
        row,
        served,
        row.currentVersion as number,
        reviewMetaOf(row, ReviewKind.FIRST),
      );
      await this.audit.record(manager, {
        organizationId,
        actor,
        action: 'provider_tool.review_submitted',
        resourceType: 'tool',
        resourceId: row.id,
        before: { reviewStatus: row.reviewStatus },
        after: { kind: ReviewKind.FIRST, versions: served.map((version) => version.semver) },
      });
    });
    return this.get(organizationId, owned.id);
  }

  async withdrawReview(
    organizationId: string,
    toolId: string,
    actor: AuditActor,
  ): Promise<ProviderToolDto> {
    const owned = await this.requireOwned(organizationId, toolId);
    await this.dataSource.transaction(async (manager) => {
      const row = await lockTool(manager, owned.id);
      if (row.reviewStatus !== ReviewStatus.PENDING) {
        throw ProviderToolErrors.state({ reason: 'nothing is in review' });
      }
      const back = row.approvedVersion !== null ? ReviewStatus.APPROVED : ReviewStatus.NONE;
      await manager.update(
        ToolEntity,
        { id: row.id },
        { reviewStatus: back, reviewContentHash: null, updatedAt: new Date() },
      );
      await this.audit.record(manager, {
        organizationId,
        actor,
        action: 'provider_tool.review_withdrawn',
        resourceType: 'tool',
        resourceId: row.id,
        before: { reviewStatus: ReviewStatus.PENDING, reviewVersion: row.reviewVersion },
        after: { reviewStatus: back },
      });
    });
    return this.get(organizationId, owned.id);
  }

  /** `PUT …/replacement`: point to the standard tool that replaces this one, or clear it (§7.5). */
  async setReplacement(
    organizationId: string,
    toolId: string,
    replacementToolId: string | null,
    actor: AuditActor,
  ): Promise<ProviderToolDto> {
    const row = await this.requireOwned(organizationId, toolId);
    assertNotRemoved(row);
    if (replacementToolId !== null) {
      const target = await this.tools.findOne({ where: { id: replacementToolId } });
      if (
        !target ||
        target.kind !== ToolKind.STANDARD ||
        target.visibility !== ToolVisibility.LISTED ||
        !(target.status === ToolStatus.ACTIVE || target.status === ToolStatus.DEPRECATED)
      ) {
        throw ProviderToolErrors.state({
          reason: 'the replacement must be a published standard tool',
        });
      }
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.update(
        ToolEntity,
        { id: row.id },
        { replacementToolId, updatedAt: new Date() },
      );
      await this.audit.record(manager, {
        organizationId,
        actor,
        action: 'provider_tool.replacement_set',
        resourceType: 'tool',
        resourceId: row.id,
        before: { replacementToolId: row.replacementToolId },
        after: { replacementToolId },
      });
    });
    await this.contractsChanged(organizationId);
    return this.get(organizationId, row.id);
  }

  // ── Promotion invitations ──────────────────────────────────────────────

  async invitations(organizationId: string): Promise<PromotionInvitationListDto> {
    const invites = await this.dataSource.getRepository(ToolPromotionInviteEntity).find({
      where: { organizationId },
      order: { invitedAt: 'DESC' },
    });
    const open = invites.filter((invite) => !invite.dismissedAt);
    if (open.length === 0) return { invitations: [] };
    const ids = [
      ...new Set(open.flatMap((invite) => [invite.standardToolId, invite.sourceToolId])),
    ];
    const tools = new Map((await this.tools.findByIds(ids)).map((tool) => [tool.id, tool]));
    const bindings = await this.dataSource.getRepository(ToolBindingEntity).find({
      where: ids.map((toolId) => ({ organizationId, toolId })),
    });
    const bindingOf = new Map(bindings.map((binding) => [binding.toolId, binding]));
    return {
      invitations: open
        .filter((invite) => tools.has(invite.standardToolId) && tools.has(invite.sourceToolId))
        .map((invite) => {
          const standard = tools.get(invite.standardToolId) as ToolEntity;
          const source = tools.get(invite.sourceToolId) as ToolEntity;
          const own = bindingOf.get(source.id);
          return {
            standardToolId: standard.id,
            standardToolName: standard.name,
            standardToolStatus: standard.status,
            sourceToolId: source.id,
            sourceToolName: source.name,
            invitedAt: invite.invitedAt,
            bound: bindingOf.has(standard.id),
            prefill: own
              ? {
                  endpoint: own.endpoint,
                  requestMapping: own.requestMapping,
                  responseMapping: own.responseMapping,
                  pricingMode: own.pricingMode,
                  priceAmount: own.priceAmount,
                  assetId: own.assetId,
                  settlementChains: [...(own.settlementChains ?? [])],
                  timeoutMs: own.timeoutMs,
                }
              : null,
          };
        }),
    };
  }

  async dismissInvitation(
    organizationId: string,
    standardToolId: string,
    sourceToolId: string,
  ): Promise<void> {
    const result = await this.dataSource
      .getRepository(ToolPromotionInviteEntity)
      .update({ organizationId, standardToolId, sourceToolId }, { dismissedAt: new Date() });
    if (!result.affected) throw ProviderToolErrors.notFound();
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  async requireOwned(organizationId: string, toolId: string): Promise<ToolEntity> {
    const row = await this.tools.findOne({
      where: { id: toolId, ownerOrgId: organizationId, kind: ToolKind.PROVIDER },
    });
    if (!row) throw ProviderToolErrors.notFound();
    return row;
  }

  async versionsOf(toolIds: readonly string[]): Promise<Map<string, ToolVersionEntity[]>> {
    const out = new Map<string, ToolVersionEntity[]>();
    if (toolIds.length === 0) return out;
    const rows = await this.dataSource
      .getRepository(ToolVersionEntity)
      .createQueryBuilder('v')
      .where('v.tool_id IN (:...ids)', { ids: [...toolIds] })
      .getMany();
    for (const row of rows) out.set(row.toolId, [...(out.get(row.toolId) ?? []), row]);
    return out;
  }

  /** A provider tool's category is the platform's: one a standard tool already uses. */
  private async assertCategory(category: string): Promise<void> {
    const rows = (await this.dataSource.query(
      `SELECT DISTINCT category FROM tools WHERE kind = 'STANDARD' ORDER BY category`,
    )) as { category: string }[];
    const known = rows.map((row) => row.category);
    if (!known.includes(category)) {
      throw ProviderToolErrors.invalid({
        problems: [`category must be one of the catalogue's: ${known.join(', ')}`],
      });
    }
  }

  private async replacementNames(rows: readonly ToolEntity[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.map((row) => row.replacementToolId).filter(Boolean))] as string[];
    return new Map((await this.tools.findByIds(ids)).map((tool) => [tool.id, tool.name]));
  }

  private async contractsChanged(organizationId: string): Promise<void> {
    await this.changes.contractsChanged();
    await this.epochs.bump(organizationId);
    await this.epochs.bumpShared();
  }

  private mcpBase(): string {
    return this.host.mcpPublicUrl;
  }
}

// ── Pure helpers, shared with the operator review ─────────────────────────

/** The tool row, locked for the rest of the transaction. */
export async function lockTool(manager: EntityManager, toolId: string): Promise<ToolEntity> {
  const row = await manager
    .createQueryBuilder(ToolEntity, 'tool')
    .setLock('pessimistic_write')
    .where('tool.id = :toolId', { toolId })
    .getOne();
  if (!row || row.kind !== ToolKind.PROVIDER) throw ProviderToolErrors.notFound();
  return row;
}

function assertNotRemoved(row: Pick<ToolEntity, 'status'>): void {
  if (row.status === ToolStatus.REMOVED) {
    throw ProviderToolErrors.state({ reason: 'the tool was removed' });
  }
}

/** A draft a pending review is for is frozen (§7.6): an edit would change what the operator reads. */
function assertDraftNotInReview(row: ToolEntity, draft: ToolVersionEntity): void {
  if (row.reviewStatus === ReviewStatus.PENDING && row.reviewVersion === draft.version) {
    throw ProviderToolErrors.inReview({ reviewVersion: row.reviewVersion });
  }
}

/** The versions a tool serves did not change between the gate and the write. */
function assertSameServedVersions(
  before: readonly ToolVersionEntity[],
  now: readonly ToolVersionEntity[],
): void {
  const key = (rows: readonly ToolVersionEntity[]) =>
    servedVersionsOf(rows)
      .map((row) => `${row.version}:${row.updatedAt?.getTime?.() ?? 0}`)
      .sort()
      .join(',');
  if (key(before) !== key(now)) {
    throw ProviderToolErrors.state({ reason: 'the tool changed while it was checked; try again' });
  }
}

function majorOf(semver: string): number {
  return (parseSemver(semver) as { major: number }).major;
}

/** The semver `draft` publishes as now, recomputed against what is published: never a silent re-number. */
export function settledSemver(
  versions: readonly ToolVersionEntity[],
  draft: ToolVersionEntity,
): string {
  const published = versions.filter((version) => version.status !== ToolVersionStatus.DRAFT);
  const base = baseForDraft(published, draft.semver);
  const diff = diffDraft(base ? draftShapeOf(base) : null, draftShapeOf(draft));
  const next = nextDraftSemver(base, base ? diff.bump : VersionBump.MAJOR, published);
  if ('refusal' in next) {
    throw ProviderToolErrors.state({
      reason:
        next.refusal.kind === 'NO_CHANGES'
          ? `the draft is identical to v${next.refusal.base}`
          : next.refusal.reason,
    });
  }
  const problems = [
    ...contractProblems(draftShapeOf(draft)),
    ...declaredRuleProblems(draft.declaredRules ?? []),
  ];
  if (problems.length > 0) throw ProviderToolErrors.invalid({ problems });
  return next.semver;
}

/** DRAFT → ACTIVE; the tool's current version follows it. */
export async function publishDraft(
  manager: EntityManager,
  row: ToolEntity,
  draft: ToolVersionEntity,
  semver: string,
  extra: Partial<ToolEntity> = {},
  tier: ToolTier | null = null,
): Promise<void> {
  const now = new Date();
  await manager.update(
    ToolVersionEntity,
    { toolId: row.id, version: draft.version },
    {
      semver,
      major: majorOf(semver),
      status: ToolVersionStatus.ACTIVE,
      publishedAt: now,
      updatedAt: now,
      ...(tier ? { tier } : {}),
    },
  );
  await manager.update(
    ToolEntity,
    { id: row.id },
    {
      currentVersion: draft.version,
      ...(row.status === ToolStatus.DRAFT ? { status: ToolStatus.ACTIVE } : {}),
      ...extra,
      updatedAt: now,
    },
  );
}

/** PENDING, for exactly `versions` as they are stored now. */
export async function submitForReview(
  manager: EntityManager,
  row: ToolEntity,
  versions: readonly ToolVersionEntity[],
  reviewVersion: number,
  meta: ReviewedMeta,
): Promise<void> {
  await manager.update(
    ToolEntity,
    { id: row.id },
    {
      reviewStatus: ReviewStatus.PENDING,
      reviewVersion,
      reviewSubmittedAt: new Date(),
      reviewContentHash: reviewContentHash(row.name, versions.map(reviewedVersionOf), meta),
      reviewNote: null,
      updatedAt: new Date(),
    },
  );
}

/**
 * The category and tags a review covers: the tool's own for a first review;
 * for a change, the ones its draft proposes (or the current ones, unchanged).
 */
export function reviewMetaOf(
  row: Pick<ToolEntity, 'category' | 'tags' | 'pendingCategory' | 'pendingTags'>,
  kind: ReviewKind,
): ReviewedMeta {
  if (kind === ReviewKind.CHANGE) {
    return {
      category: row.pendingCategory ?? row.category,
      tags: row.pendingTags ?? row.tags ?? [],
    };
  }
  return { category: row.category, tags: row.tags ?? [] };
}

/**
 * A draft's category and tags. On a reviewed tool they wait beside the draft
 * (`pending_*`) and change only with its approval; on any other tool they
 * apply at once — the publish gate screens them before anyone else sees them.
 */
async function applyDraftMeta(
  manager: EntityManager,
  row: ToolEntity,
  body: Pick<ProviderToolContractBodyDto, 'category' | 'tags'>,
): Promise<void> {
  if (body.category === undefined && body.tags === undefined) return;
  if (row.reviewStatus === ReviewStatus.PENDING) {
    throw ProviderToolErrors.inReview({ reviewVersion: row.reviewVersion });
  }
  const tags = body.tags === undefined ? undefined : dedupe(body.tags);
  if (row.approvedVersion !== null) {
    await manager.update(
      ToolEntity,
      { id: row.id },
      {
        ...(body.category !== undefined ? { pendingCategory: body.category } : {}),
        ...(tags !== undefined ? { pendingTags: tags } : {}),
      },
    );
    return;
  }
  await manager.update(
    ToolEntity,
    { id: row.id },
    {
      ...(body.category !== undefined ? { category: body.category } : {}),
      ...(tags !== undefined ? { tags } : {}),
    },
  );
}

export function reviewedVersionOf(row: ToolVersionEntity): ReviewedVersion {
  return {
    version: row.version,
    semver: row.semver,
    summary: row.summary,
    description: row.description,
    inputSchema: row.inputSchema,
    outputSchema: row.outputSchema,
    optionalInputFields: row.optionalInputFields ?? [],
    optionalOutputFields: row.optionalOutputFields ?? [],
    examples: row.examples ?? [],
    declaredRules: row.declaredRules ?? [],
  };
}

function shapeOfBody(
  body: ProviderToolContractBodyDto,
  base: ToolVersionEntity | null,
  toolId: string,
): ProviderDraftShape {
  return {
    summary: body.summary,
    description: body.description,
    inputSchema: body.inputSchema as JsonSchema,
    outputSchema: body.outputSchema as JsonSchema,
    optionalInputFields: dedupe(body.optionalInputFields ?? []),
    optionalOutputFields: dedupe(body.optionalOutputFields ?? []),
    examples: body.examples ?? [],
    // The provider sets neither: the policy is the tool's own, and the tier
    // is the reviewer's (never GUARANTEED, §7.6).
    verificationPolicyId: base?.verificationPolicyId ?? providerPolicyId(toolId),
    tier: base?.tier ?? ToolTier.UNVERIFIED,
    declaredRules: body.rules ?? [],
  };
}

export function draftShapeOf(row: ToolVersionEntity): ProviderDraftShape {
  return {
    summary: row.summary,
    description: row.description,
    inputSchema: row.inputSchema as JsonSchema,
    outputSchema: row.outputSchema as JsonSchema,
    optionalInputFields: row.optionalInputFields ?? [],
    optionalOutputFields: row.optionalOutputFields ?? [],
    examples: row.examples ?? [],
    verificationPolicyId: row.verificationPolicyId,
    tier: row.tier,
    declaredRules: row.declaredRules ?? [],
  };
}

function versionFieldsOf(shape: ProviderDraftShape): Partial<ToolVersionEntity> {
  return {
    summary: shape.summary,
    description: shape.description,
    inputSchema: shape.inputSchema as Record<string, unknown>,
    outputSchema: shape.outputSchema as Record<string, unknown>,
    optionalInputFields: [...shape.optionalInputFields],
    optionalOutputFields: [...shape.optionalOutputFields],
    examples: [...shape.examples],
    verificationPolicyId: shape.verificationPolicyId,
    tier: shape.tier,
    declaredRules: [...shape.declaredRules],
  };
}

function gateFailed(gate: ProviderToolGateDto) {
  return ProviderToolErrors.gateFailed({
    failed: gate.requirements
      .filter((requirement) => !requirement.met)
      .map((requirement) => `${requirement.requirement} (${requirement.code})`)
      .join(', '),
    findings: gate.screen.flatMap((entry) =>
      entry.findings.map((finding) => ({ ...finding, semver: entry.semver })),
    ),
  });
}

export function reviewDtoOf(
  row: ToolEntity,
  versions: readonly ToolVersionEntity[],
): ProviderToolReviewDto {
  const semverOf = (version: number | null) =>
    version === null ? null : (versions.find((v) => v.version === version)?.semver ?? null);
  const display = reviewDisplayOf(row, semverOf);
  const status = (row.reviewStatus as ReviewStatus) ?? ReviewStatus.NONE;
  return {
    status,
    state: display.state,
    label: display.label,
    kind:
      status === ReviewStatus.PENDING || status === ReviewStatus.REJECTED
        ? reviewKindOf(row)
        : null,
    reviewVersion: row.reviewVersion,
    reviewSemver: semverOf(row.reviewVersion),
    note: status === ReviewStatus.REJECTED ? row.reviewNote : null,
    submittedAt: row.reviewSubmittedAt,
    decidedAt: row.reviewedAt,
    approvedVersion: row.approvedVersion,
    approvedSemver: semverOf(row.approvedVersion),
  };
}

export function summaryOf(
  row: ToolEntity,
  versions: readonly ToolVersionEntity[],
  replacementNames: ReadonlyMap<string, string>,
): ProviderToolSummaryDto {
  const parsed = parseProviderToolName(row.name);
  const current = versions.find((version) => version.version === row.currentVersion) ?? null;
  return {
    id: row.id,
    name: row.name,
    localName: parsed?.local ?? row.name,
    handle: parsed?.handle ?? '',
    preview: `mcp__${PREVIEW_SERVER}__${row.name}`,
    category: row.category,
    tags: [...(row.tags ?? [])],
    visibility: row.visibility,
    status: row.status,
    currentSemver: current?.semver ?? null,
    currentVersion: row.currentVersion,
    hasDraft: versions.some((version) => version.status === ToolVersionStatus.DRAFT),
    notReviewed: row.approvedVersion === null,
    review: reviewDtoOf(row, versions),
    replacementToolId: row.replacementToolId,
    replacementName: row.replacementToolId
      ? (replacementNames.get(row.replacementToolId) ?? null)
      : null,
    removedAt: row.removedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function versionDtoOf(row: ToolEntity, version: ToolVersionEntity): ProviderToolVersionDto {
  return {
    version: version.version,
    semver: version.semver,
    major: version.major,
    status: version.status,
    summary: version.summary,
    description: version.description,
    inputSchema: version.inputSchema,
    outputSchema: version.outputSchema,
    optionalInputFields: [...(version.optionalInputFields ?? [])],
    optionalOutputFields: [...(version.optionalOutputFields ?? [])],
    examples: [...(version.examples ?? [])],
    rules: [...(version.declaredRules ?? [])],
    tier:
      version.tier === ToolTier.GUARANTEED
        ? ToolTier.VERIFIED
        : (version.tier ?? ToolTier.UNVERIFIED),
    changelog: version.changelog,
    sunsetAt: version.sunsetAt,
    publishedAt: version.publishedAt,
    isCurrent: row.currentVersion === version.version,
    approved:
      version.status !== ToolVersionStatus.DRAFT &&
      row.approvedVersion !== null &&
      version.version <= row.approvedVersion,
  };
}

export function draftDtoOf(
  row: ToolEntity,
  draft: ToolVersionEntity,
  published: readonly ToolVersionEntity[],
): ProviderToolDraftDto {
  const base = baseForDraft(published, draft.semver);
  const diff = diffDraft(base ? draftShapeOf(base) : null, draftShapeOf(draft));
  const shape = draftShapeOf(draft) as ContractShape;
  return {
    ...versionDtoOf(row, draft),
    baseSemver: base?.semver ?? null,
    bump: base ? diff.bump : VersionBump.MAJOR,
    changes: diff.changes.map((change) => ({ ...change })),
    problems: [
      ...contractProblems(shape),
      ...declaredRuleProblems(draft.declaredRules ?? []),
      ...(base && !diff.bump ? [`identical to v${base.semver}`] : []),
    ],
    screen: screenVersion(draft),
    inReview: row.reviewStatus === ReviewStatus.PENDING && row.reviewVersion === draft.version,
  };
}

function dedupe<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

export { isServedRow, servedVersionsOf };
