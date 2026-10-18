import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { ToolEntity } from '@database/postgres/entities/tool.entity';
import { ToolVersionEntity } from '@database/postgres/entities/tool-version.entity';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { ToolRepository } from '@database/postgres/repositories/tool.repository';
import { ScreenFindingCode } from '@modules/tool/domain/contract/schema-screen';
import { parseProviderToolName } from '@modules/tool/domain/provider-tool-name';
import {
  TOOL_CONTRACT_CHANGES,
  ToolContractChanges,
} from '@modules/tool/ports/tool-contracts.port';
import {
  ToolKind,
  ToolTier,
  ToolVersionStatus,
  ToolVisibility,
} from '@modules/tool/ports/tool.types';
import { AccessEpochService } from '@modules/toolset/services/access-epoch.service';

import { ReviewKind, ReviewStatus, reviewContentHash, reviewKindOf } from '../domain/review';
import { diffDraft } from '../domain/versioning';
import {
  ReviewChecklistItemDto,
  ReviewDetailDto,
  ReviewQueueItemDto,
} from '../dto/provider-tool-review.dto';
import { ScreenFindingDto } from '../dto/provider-tools.dto';
import { ProviderToolErrors } from '../errors/provider-tool.errors';
import { ProviderToolGateService, screenVersion } from './provider-tool-gate.service';
import { ProviderToolPolicyService } from './provider-tool-policy.service';
import {
  ProviderToolsService,
  draftShapeOf,
  isServedRow,
  lockTool,
  publishDraft,
  reviewedVersionOf,
  settledSemver,
  versionDtoOf,
} from './provider-tools.service';

export enum ReviewDecision {
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
}

/** The review checklist for LISTED (design spec §7.6). */
export enum ReviewChecklistItem {
  NO_IMPERSONATION = 'NO_IMPERSONATION',
  NO_MODEL_INSTRUCTIONS = 'NO_MODEL_INSTRUCTIONS',
  NO_SECRET_INPUTS = 'NO_SECRET_INPUTS',
  EXAMPLES_MATCH_SCHEMA = 'EXAMPLES_MATCH_SCHEMA',
  PRICING_CLEAR = 'PRICING_CLEAR',
}

export interface DecideInput {
  readonly toolId: string;
  readonly operatorId: string;
  readonly decision: ReviewDecision;
  readonly note: string | null;
  readonly tier: ToolTier | null;
  /** The content hash the operator read (`GET /operator/reviews/:id`). */
  readonly contentHash: string;
}

export interface DecideOutcome {
  readonly organizationId: string;
  readonly toolName: string;
  readonly kind: ReviewKind;
  readonly decision: ReviewDecision;
  readonly approvedVersion: number | null;
  /** The version a CHANGE approval just published, for its shadow policy. */
  readonly published: ToolVersionEntity | null;
}

/**
 * The operator's review of provider tools (design spec §7.6, §7.9): the
 * queue, one review with its checklist, and the decision.
 *
 * The checklist's machine half is filled in from the publish gate's schema
 * screen and the provider's binding; the operator answers the rest. A
 * decision is for the content hash the operator read: if the provider's
 * content differs, or the hash recorded at submission does, it is refused
 * (`TOOL_REVIEW_STALE`) — an approval can never land on content nobody read.
 */
@Injectable()
export class ProviderToolReviewService {
  constructor(
    private readonly tools: ToolRepository,
    private readonly providers: ProviderRepository,
    private readonly owned: ProviderToolsService,
    private readonly gate: ProviderToolGateService,
    private readonly policy: ProviderToolPolicyService,
    private readonly epochs: AccessEpochService,
    @Inject(TOOL_CONTRACT_CHANGES) private readonly changes: ToolContractChanges,
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
  ) {}

  /** `GET /operator/reviews`: pending first, oldest submission first; `all` adds decided ones. */
  async queue(pendingOnly: boolean): Promise<ReviewQueueItemDto[]> {
    const qb = this.tools
      .createQueryBuilder('tool')
      .where(`tool.kind = 'PROVIDER'`)
      .andWhere(
        pendingOnly
          ? `tool.review_status = 'PENDING'`
          : `tool.review_status IN ('PENDING', 'APPROVED', 'REJECTED')`,
      )
      .orderBy(`CASE WHEN tool.review_status = 'PENDING' THEN 0 ELSE 1 END`, 'ASC')
      .addOrderBy('tool.review_submitted_at', 'ASC', 'NULLS LAST')
      .limit(500);
    const rows = await qb.getMany();
    const versions = await this.owned.versionsOf(rows.map((row) => row.id));
    return rows.map((row) => {
      const own = versions.get(row.id) ?? [];
      return {
        toolId: row.id,
        name: row.name,
        handle: parseProviderToolName(row.name)?.handle ?? '',
        organizationId: row.ownerOrgId as string,
        category: row.category,
        visibility: row.visibility,
        status: row.reviewStatus as ReviewStatus,
        kind: reviewKindOf(row),
        reviewVersion: row.reviewVersion,
        reviewSemver: own.find((version) => version.version === row.reviewVersion)?.semver ?? null,
        submittedAt: row.reviewSubmittedAt,
        decidedAt: row.reviewedAt,
      };
    });
  }

  /** `GET /operator/reviews/:toolId`: what is under review, the checklist and the gate. */
  async detail(toolId: string): Promise<ReviewDetailDto> {
    const row = await this.requireProviderTool(toolId);
    const versions = (await this.owned.versionsOf([row.id])).get(row.id) ?? [];
    const kind = reviewKindOf(row);
    const covered = coveredVersions(row, versions, kind);
    const approved = versions.find((version) => version.version === row.approvedVersion) ?? null;
    const draft = kind === ReviewKind.CHANGE ? (covered[0] ?? null) : null;
    const findings = covered.flatMap((version) =>
      screenVersion(version).map((finding) => ({
        ...finding,
        location: `v${version.semver}/${finding.location}`,
      })),
    );
    const [tool, gate, provider, binding] = await Promise.all([
      this.owned.detail(row),
      this.gate.evaluate(row, versions, draft),
      this.providers.findOne({ where: { organizationId: row.ownerOrgId as string } }),
      this.gate.bindingOf(row),
    ]);
    return {
      tool,
      kind,
      pending: row.reviewStatus === ReviewStatus.PENDING,
      contentHash: reviewContentHash(row.name, covered.map(reviewedVersionOf)),
      covered: covered.map((version) => versionDtoOf(row, version)),
      changes:
        draft && approved
          ? diffDraft(draftShapeOf(approved), draftShapeOf(draft)).changes.map((change) => ({
              ...change,
            }))
          : [],
      checklist: checklistOf(findings, {
        handle: parseProviderToolName(row.name)?.handle ?? '',
        legalName: provider?.legalName ?? null,
        providerVerified: provider?.verified ?? false,
        pricing: binding
          ? {
              pricingMode: binding.pricingMode,
              priceAmount: binding.priceAmount,
              assetId: binding.assetId,
              freeQuotaPerAgent: binding.freeQuotaPerAgent,
            }
          : null,
        examples: covered.reduce((sum, version) => sum + (version.examples?.length ?? 0), 0),
      }),
      gate,
    };
  }

  /**
   * Approve or reject, on the caller's transaction (the operator register
   * commits with it). Approve: FIRST → LISTED with every covered version
   * approved; CHANGE → the draft is published and becomes current.
   */
  async decide(manager: EntityManager, input: DecideInput): Promise<DecideOutcome> {
    const row = await lockTool(manager, input.toolId);
    if (row.reviewStatus !== ReviewStatus.PENDING) throw ProviderToolErrors.reviewNotPending();
    const versions = await manager.find(ToolVersionEntity, { where: { toolId: row.id } });
    const kind = reviewKindOf(row);
    const covered = coveredVersions(row, versions, kind);
    const hash = reviewContentHash(row.name, covered.map(reviewedVersionOf));
    if (covered.length === 0 || hash !== row.reviewContentHash || hash !== input.contentHash) {
      throw ProviderToolErrors.reviewStale({ contentHash: hash });
    }
    if (input.tier === ToolTier.GUARANTEED) {
      throw ProviderToolErrors.state({ reason: 'a provider tool is never GUARANTEED' });
    }
    const now = new Date();
    const decided = {
      reviewedAt: now,
      reviewedBy: input.operatorId,
      reviewContentHash: null,
      updatedAt: now,
    };

    if (input.decision === ReviewDecision.REJECT) {
      await manager.update(
        ToolEntity,
        { id: row.id },
        { ...decided, reviewStatus: ReviewStatus.REJECTED, reviewNote: input.note },
      );
      return {
        organizationId: row.ownerOrgId as string,
        toolName: row.name,
        kind,
        decision: input.decision,
        approvedVersion: row.approvedVersion,
        published: null,
      };
    }

    const tier = input.tier ?? ToolTier.UNVERIFIED;
    if (kind === ReviewKind.FIRST) {
      const approvedVersion = Math.max(...covered.map((version) => version.version));
      for (const version of covered) {
        await manager.update(
          ToolVersionEntity,
          { toolId: row.id, version: version.version },
          { tier },
        );
      }
      await manager.update(
        ToolEntity,
        { id: row.id },
        {
          ...decided,
          reviewStatus: ReviewStatus.APPROVED,
          reviewNote: input.note,
          approvedVersion,
          visibility: ToolVisibility.LISTED,
        },
      );
      return {
        organizationId: row.ownerOrgId as string,
        toolName: row.name,
        kind,
        decision: input.decision,
        approvedVersion,
        published: null,
      };
    }

    const draft = covered[0];
    if (draft.status !== ToolVersionStatus.DRAFT) {
      throw ProviderToolErrors.reviewStale({ contentHash: hash });
    }
    const semver = settledSemver(versions, draft);
    await publishDraft(
      manager,
      row,
      draft,
      semver,
      {
        ...decided,
        reviewStatus: ReviewStatus.APPROVED,
        reviewNote: input.note,
        approvedVersion: draft.version,
      },
      tier,
    );
    return {
      organizationId: row.ownerOrgId as string,
      toolName: row.name,
      kind,
      decision: input.decision,
      approvedVersion: draft.version,
      published: { ...draft, semver },
    };
  }

  /** After the decision commits: every process re-reads contracts and views. */
  async afterDecision(toolId: string, outcome: DecideOutcome): Promise<void> {
    await this.changes.contractsChanged();
    await this.epochs.bump(outcome.organizationId);
    await this.epochs.bumpShared();
    if (outcome.published) {
      await this.policy.registerShadow({
        toolId,
        toolName: outcome.toolName,
        organizationId: outcome.organizationId,
        rules: outcome.published.declaredRules ?? [],
      });
    }
  }

  async requireProviderTool(toolId: string): Promise<ToolEntity> {
    const row = await this.tools.findOne({ where: { id: toolId, kind: ToolKind.PROVIDER } });
    if (!row) throw ProviderToolErrors.notFound();
    return row;
  }
}

/** What a review covers: FIRST, every version the tool serves; CHANGE, the draft submitted. */
export function coveredVersions(
  row: Pick<ToolEntity, 'reviewVersion'>,
  versions: readonly ToolVersionEntity[],
  kind: ReviewKind,
): ToolVersionEntity[] {
  if (kind === ReviewKind.CHANGE) {
    return versions.filter((version) => version.version === row.reviewVersion);
  }
  return versions.filter(isServedRow).sort((a, b) => a.version - b.version);
}

/** The checklist, machine half filled in; PASS/FAIL are the screen's, CHECK is the operator's. */
export function checklistOf(
  findings: readonly ScreenFindingDto[],
  facts: {
    readonly handle: string;
    readonly legalName: string | null;
    readonly providerVerified: boolean;
    readonly pricing: {
      readonly pricingMode: string;
      readonly priceAmount: string;
      readonly assetId: string;
      readonly freeQuotaPerAgent: number | null;
    } | null;
    readonly examples: number;
  },
): ReviewChecklistItemDto[] {
  const of = (codes: readonly string[]) =>
    findings.filter((finding) => codes.includes(finding.code));
  const instructions = of([
    ScreenFindingCode.INSTRUCTION_PATTERN,
    ScreenFindingCode.HIDDEN_CHARACTERS,
    ScreenFindingCode.TEXT_TOO_LONG,
  ]);
  const secrets = of([ScreenFindingCode.SECRET_INPUT]);
  const examples = of(['EXAMPLE_MISMATCH']);
  return [
    {
      item: ReviewChecklistItem.NO_IMPERSONATION,
      automated: 'CHECK',
      detail:
        `Public name "${facts.handle}"; provider "${facts.legalName ?? 'unknown'}"` +
        `${facts.providerVerified ? ' (identity verified)' : ' (identity not verified)'}. ` +
        'Confirm the name, summary and description do not pose as another maker or the platform.',
      findings: [],
    },
    {
      item: ReviewChecklistItem.NO_MODEL_INSTRUCTIONS,
      automated: instructions.length > 0 ? 'FAIL' : 'PASS',
      detail:
        instructions.length > 0
          ? 'The screen found text that addresses a model or hides from a reader.'
          : 'The screen found nothing; read the summary, description and every schema text.',
      findings: instructions,
    },
    {
      item: ReviewChecklistItem.NO_SECRET_INPUTS,
      automated: secrets.length > 0 ? 'FAIL' : 'PASS',
      detail:
        secrets.length > 0
          ? 'An input would collect a credential.'
          : 'No input reads as a secret; confirm none asks for one in other words.',
      findings: secrets,
    },
    {
      item: ReviewChecklistItem.EXAMPLES_MATCH_SCHEMA,
      automated: examples.length > 0 ? 'FAIL' : facts.examples === 0 ? 'CHECK' : 'PASS',
      detail:
        examples.length > 0
          ? 'An example does not match the schemas.'
          : facts.examples === 0
            ? 'There are no examples; ask for at least one.'
            : 'Every example matches the schemas; the binding’s tester run is in the gate below.',
      findings: examples,
    },
    {
      item: ReviewChecklistItem.PRICING_CLEAR,
      automated: facts.pricing ? 'CHECK' : 'FAIL',
      detail: facts.pricing
        ? `${facts.pricing.pricingMode}, ${facts.pricing.priceAmount} atomic units of ${facts.pricing.assetId}` +
          `${facts.pricing.freeQuotaPerAgent ? `, ${facts.pricing.freeQuotaPerAgent} free calls per agent a day` : ''}. ` +
          'Confirm the summary does not promise another price.'
        : 'No binding: the tool has no price.',
      findings: [],
    },
  ];
}
