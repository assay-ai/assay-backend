import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';

import { OperatorApprovalEntity } from '@database/postgres/entities/operator-approval.entity';
import { OperatorApprovalRepository } from '@database/postgres/repositories/operator-approval.repository';
import { OfficialToolsetDto } from '@modules/toolset/dto/official-toolset.dto';
import { ToolsetErrors } from '@modules/toolset/errors/toolset.errors';
import {
  OfficialPublishResult,
  OfficialToolsetsService,
} from '@modules/toolset/services/official-toolsets.service';

import { ApprovalQueuedDto } from '../dto/operator-approval.dto';
import {
  CreateOfficialToolsetBodyDto,
  OperatorOfficialToolsetDto,
  OperatorOfficialToolsetListDto,
  PublishOfficialToolsetBodyDto,
  UpdateOfficialToolsetBodyDto,
} from '../dto/operator-official-toolsets.dto';
import { OperatorApprover, OperatorSession } from '../ports/operator-session.port';
import { OperatorApprovalService } from './operator-approval.service';
import { OverrideLogService } from './override-log.service';

export const OFFICIAL_PUBLISH_APPROVAL_ACTION = 'toolset.official_publish';

/**
 * Official tool sets in the operator console (design spec §7.10):
 *
 * ```text
 * draft    create or edit a Draft     no override (a Draft serves nothing)
 * P-13     publish the Draft          two-person, for the hash of the Draft requested
 * A-15     delist                     the existing moderation route; A-18 confirms within 72 h
 * A-20     relist                     the existing moderation route
 * ```
 *
 * The same two-person flow as `OperatorContractsService.publish` (P-10): the
 * request runs through the override log, is refused for want of an approver
 * and queued with the Draft's hash; the approver's re-run publishes only if
 * the Draft is still exactly that. While a publish waits, the Draft is frozen.
 */
@Injectable()
export class OperatorOfficialToolsetsService {
  private readonly logger = new Logger(OperatorOfficialToolsetsService.name);

  constructor(
    private readonly official: OfficialToolsetsService,
    private readonly overrides: OverrideLogService,
    private readonly approvals: OperatorApprovalService,
    private readonly approvalRows: OperatorApprovalRepository,
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
  ) {
    approvals.register(OFFICIAL_PUBLISH_APPROVAL_ACTION, {
      code: 'P-13',
      run: (requester, approver, payload, requestId) =>
        this.publish(
          requester,
          payload.toolsetId as string,
          payload.body as PublishOfficialToolsetBodyDto,
          requestId,
          approver,
          payload.contentHash as string | undefined,
        ),
    });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async list(): Promise<OperatorOfficialToolsetListDto> {
    return { toolsets: await this.withPending(await this.official.list()) };
  }

  async get(id: string): Promise<OperatorOfficialToolsetDto> {
    const [dto] = await this.withPending([await this.official.get(id)]);
    return dto;
  }

  // ── Drafts (no override: a Draft serves nothing) ──────────────────────────

  async create(
    operator: OperatorSession,
    body: CreateOfficialToolsetBodyDto,
  ): Promise<OperatorOfficialToolsetDto> {
    const id = await this.dataSource.transaction((manager) =>
      this.official.createDraft(manager, body),
    );
    this.logger.log(
      `official toolset ${body.slug}: draft created by operator ${operator.operatorId}`,
    );
    return this.get(id);
  }

  async update(
    operator: OperatorSession,
    id: string,
    body: UpdateOfficialToolsetBodyDto,
  ): Promise<OperatorOfficialToolsetDto> {
    await this.official.get(id);
    await this.assertNoPendingPublish(id);
    const result = await this.dataSource.transaction((manager) =>
      this.official.updateDraft(manager, id, body),
    );
    await this.official.afterDraftChange(result);
    this.logger.log(`official toolset ${id}: draft edited by operator ${operator.operatorId}`);
    return this.get(id);
  }

  // ── P-13 publish (two-person) ─────────────────────────────────────────────

  async publish(
    operator: OperatorSession,
    id: string,
    body: PublishOfficialToolsetBodyDto,
    requestId: string | null,
    approver: OperatorApprover | null = null,
    /** The Draft the queued request was for; re-checked under the row lock. */
    contentHash?: string,
  ): Promise<OperatorOfficialToolsetDto | ApprovalQueuedDto> {
    // Checked before queueing, so a request no one could approve is refused at once.
    await this.official.assertPublishableNow(this.dataSource.manager, id);

    const attempt = async () => {
      const outcome = await this.overrides.perform<OfficialPublishResult>(
        {
          code: 'P-13',
          actor: operator,
          approver,
          targetType: 'toolset',
          targetId: id,
          organizationId: null,
          reasonCode: body.reasonCode,
          reason: body.note,
          ticketRef: body.ticketRef ?? null,
          requestId,
        },
        async (queryRunner) => {
          const result = await this.official.publish(queryRunner.manager, id, {
            changelog: body.changelog,
            // The approver approves content, not an id: a missing hash matches nothing.
            ...(approver ? { expectedHash: contentHash ?? '' } : {}),
          });
          return {
            value: result,
            before: result.before,
            after: {
              visibility: 'PUBLIC',
              latestVersion: result.version,
              contentHash: result.contentHash,
              changelog: result.changelog,
            },
          };
        },
      );
      await this.official.afterPublish(outcome);
      this.logger.log(`official toolset ${id} v${outcome.version} published`);
      return this.get(id);
    };

    if (approver) return attempt();
    return this.approvals.orQueue(
      {
        action: OFFICIAL_PUBLISH_APPROVAL_ACTION,
        target: targetOf(id),
        payload: {
          toolsetId: id,
          contentHash: await this.official.contentHash(this.dataSource.manager, id),
          body: { ...body },
        },
        requester: operator,
      },
      attempt,
    );
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * A Draft is frozen while its publish waits for a second operator: the
   * approval is for the content that was queued (as P-10, review P1-1).
   * Reject the pending request first to change the Draft.
   */
  private async assertNoPendingPublish(id: string): Promise<void> {
    await this.approvalRows.expireStale();
    const pending = await this.approvalRows.findOne({
      where: { action: OFFICIAL_PUBLISH_APPROVAL_ACTION, target: targetOf(id), status: 'PENDING' },
    });
    if (pending) {
      throw ToolsetErrors.state({
        reason: `a publish of this draft awaits a second operator (approval ${pending.id}); reject it to edit`,
      });
    }
  }

  private async withPending(
    toolsets: readonly OfficialToolsetDto[],
  ): Promise<OperatorOfficialToolsetDto[]> {
    const rows: OperatorApprovalEntity[] = toolsets.length
      ? await this.approvalRows.find({
          where: {
            action: OFFICIAL_PUBLISH_APPROVAL_ACTION,
            target: In(toolsets.map((toolset) => targetOf(toolset.id))),
            status: 'PENDING',
          },
        })
      : [];
    const now = Date.now();
    return toolsets.map((toolset) => {
      const pending = rows.find(
        (row) => row.target === targetOf(toolset.id) && new Date(row.expiresAt).getTime() > now,
      );
      return {
        ...toolset,
        pendingPublish: pending
          ? {
              approvalId: pending.id,
              requestedBy: pending.requestedBy,
              expiresAt: new Date(pending.expiresAt).toISOString(),
            }
          : null,
      };
    });
  }
}

function targetOf(id: string): string {
  return `toolset:${id}`;
}
