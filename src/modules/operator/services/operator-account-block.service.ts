import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { IsNull } from 'typeorm';

import { AccountBlockEntity } from '@database/postgres/entities/account-block.entity';
import { AccountBlockRepository } from '@database/postgres/repositories/account-block.repository';
import { UNIQUE_VIOLATION_CODE } from '@database/postgres/repositories/abstract.repository';
import { OperatorRepository } from '@database/postgres/repositories/operator.repository';
import { OrganizationRepository } from '@database/postgres/repositories/organization.repository';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { asInstant, CursorPageDto, ListSpec, paginate } from '@shared/api';
import {
  BlockSubjectKind,
  normalizeSubject,
  subjectKey,
} from '@modules/blocklist/domain/account-block';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';

import {
  AccountBlockDto,
  CreateAccountBlockBodyDto,
  ListAccountBlocksQueryDto,
  UnblockAccountBodyDto,
} from '../dto/operator-console.dto';
import { ApprovalQueuedDto } from '../dto/operator-approval.dto';
import { OperatorErrors } from '../errors/operator.errors';
import { OperatorApprover, OperatorSession } from '../ports/operator-session.port';
import { OperatorApprovalService } from './operator-approval.service';
import { OverrideLogService } from './override-log.service';

/** The queued-action name for `A-10`. */
export const UNBLOCK_APPROVAL_ACTION = 'account.unblock';

const TARGET_TYPE = 'account_block';

/**
 * `A-9` and `A-10` — the only writer of `account_blocks`.
 *
 * Both writes go through `OverrideLogService.perform`, so the row and its
 * register entry commit together, and both tell `AccountBlocklistService` once
 * the transaction has committed — never before, or a rolled-back block would
 * be enforced on this instance until the next poll.
 *
 * ## The register entry's tenant
 *
 * An organization block names that organization as the entry's
 * `organizationId`: the tenant is the subject, and it can be shown its own
 * history. A wallet block names none. The wallet may be linked to an agent of
 * some tenant today and to another tomorrow, and the entry must not claim a
 * tenant the block is not about.
 */
@Injectable()
export class OperatorAccountBlockService {
  constructor(
    private readonly overrides: OverrideLogService,
    private readonly blocks: AccountBlockRepository,
    private readonly operators: OperatorRepository,
    private readonly blocklist: AccountBlocklistService,
    private readonly approvals: OperatorApprovalService,
    private readonly providers: ProviderRepository,
    private readonly organizations: OrganizationRepository,
  ) {
    approvals.register(UNBLOCK_APPROVAL_ACTION, {
      code: 'A-10',
      run: (requester, approver, payload, requestId) =>
        this.unblock(
          requester,
          payload.blockId as string,
          payload.body as UnblockAccountBodyDto,
          requestId,
          approver,
        ),
    });
  }

  async block(
    operator: OperatorSession,
    body: CreateAccountBlockBodyDto,
    requestId: string | null,
  ): Promise<AccountBlockDto> {
    const subject = normalizeSubject(body.subjectKind, body.subject);
    const key = subject === null ? null : subjectKey(body.subjectKind, subject);
    if (subject === null || key === null) {
      throw OperatorErrors.blockSubjectInvalid({
        subjectKind: body.subjectKind,
        subject: body.subject,
      });
    }

    // The cheap refusal, with the standing block named. The unique index is
    // still what decides a race between two operators blocking at once.
    const standing = await this.blocks.findOneBy({
      subjectKind: body.subjectKind,
      subjectKey: key,
      unblockedAt: IsNull(),
    });
    if (standing) throw OperatorErrors.blockAlreadyActive({ blockId: standing.id });

    const id = randomUUID();
    const blockedAt = new Date();
    let row: AccountBlockEntity;
    try {
      row = await this.overrides.perform<AccountBlockEntity>(
        {
          code: 'A-9',
          actor: operator,
          targetType: TARGET_TYPE,
          targetId: id,
          organizationId: body.subjectKind === BlockSubjectKind.ORGANIZATION ? subject : null,
          reasonCode: body.reasonCode,
          reason: body.note,
          ticketRef: body.ticketRef ?? null,
          requestId,
        },
        async (queryRunner) => {
          const inserted = await this.blocks.insertBlock(queryRunner, {
            id,
            subjectKind: body.subjectKind,
            subject,
            subjectKey: key,
            reasonCode: body.reasonCode,
            note: body.note,
            ticketRef: body.ticketRef ?? null,
            blockedBy: operator.operatorId,
            blockedAt,
            unblockedBy: null,
            unblockApprovedBy: null,
            unblockedAt: null,
            unblockNote: null,
          });
          return {
            value: inserted,
            before: { blocked: false },
            after: { blocked: true, subjectKind: body.subjectKind, subject },
          };
        },
      );
    } catch (error) {
      if ((error as { code?: string })?.code === UNIQUE_VIOLATION_CODE) {
        throw OperatorErrors.blockAlreadyActive({});
      }
      throw error;
    }

    await this.blocklist.applied({
      kind: 'blocked',
      row: {
        id: row.id,
        subjectKind: row.subjectKind,
        subject: row.subject,
        subjectKey: row.subjectKey,
        reasonCode: row.reasonCode,
        blockedAt: row.blockedAt,
      },
    });

    return (await this.toDtos([row]))[0];
  }

  /**
   * `A-10`, two-person. Called without an approver it is queued
   * (`ApprovalQueuedDto`); the approval re-runs it, block state checked again.
   */
  async unblock(
    operator: OperatorSession,
    blockId: string,
    body: UnblockAccountBodyDto,
    requestId: string | null,
    approver: OperatorApprover | null = null,
  ): Promise<AccountBlockDto | ApprovalQueuedDto> {
    const attempt = () => this.lift(operator, blockId, body, requestId, approver);
    if (approver) return attempt();
    return this.approvals.orQueue(
      {
        action: UNBLOCK_APPROVAL_ACTION,
        target: `account_block:${blockId}`,
        payload: { blockId, body: { ...body } },
        requester: operator,
      },
      attempt,
    );
  }

  private async lift(
    operator: OperatorSession,
    blockId: string,
    body: UnblockAccountBodyDto,
    requestId: string | null,
    approver: OperatorApprover | null,
  ): Promise<AccountBlockDto> {
    const existing = await this.blocks.findOneBy({ id: blockId });
    if (!existing) throw OperatorErrors.blockNotFound({ blockId });
    if (existing.unblockedAt) {
      throw OperatorErrors.blockAlreadyLifted({ unblockedAt: existing.unblockedAt.toISOString() });
    }

    const unblockedAt = new Date();

    await this.overrides.perform<void>(
      {
        code: 'A-10',
        actor: operator,
        approver,
        targetType: TARGET_TYPE,
        targetId: existing.id,
        organizationId:
          existing.subjectKind === BlockSubjectKind.ORGANIZATION ? existing.subject : null,
        reasonCode: body.reasonCode,
        reason: body.note,
        ticketRef: body.ticketRef ?? null,
        requestId,
      },
      async (queryRunner) => {
        const moved = await this.blocks.markUnblocked(queryRunner, existing.id, {
          unblockedBy: operator.operatorId,
          // `perform` refused the write unless an approver was present.
          unblockApprovedBy: (approver as OperatorApprover).operatorId,
          unblockedAt,
          unblockNote: body.note,
        });
        // Somebody lifted it between the read above and this write.
        if (moved !== 1) throw OperatorErrors.blockAlreadyLifted({});
        return {
          value: undefined,
          before: { blocked: true, subjectKind: existing.subjectKind, subject: existing.subject },
          after: { blocked: false },
        };
      },
    );

    await this.blocklist.applied({
      kind: 'unblocked',
      subjectKind: existing.subjectKind,
      subjectKey: existing.subjectKey,
    });

    const row = await this.blocks.findOneByOrFail({ id: existing.id });
    return (await this.toDtos([row]))[0];
  }

  async list(query: ListAccountBlocksQueryDto): Promise<CursorPageDto<AccountBlockDto>> {
    let key: string | undefined;
    let kind = query.subjectKind;
    if (query.subject) {
      // Without a kind, a uuid is an organization and anything else a wallet:
      // a CAIP-10 account is never a bare uuid.
      kind ??=
        normalizeSubject(BlockSubjectKind.ORGANIZATION, query.subject) !== null
          ? BlockSubjectKind.ORGANIZATION
          : BlockSubjectKind.WALLET;
      const matched = subjectKey(kind, query.subject);
      if (matched === null) {
        throw OperatorErrors.blockSubjectInvalid({ subjectKind: kind, subject: query.subject });
      }
      key = matched;
    }

    const page = await paginate(
      this.blocks.feedQueryBuilder({
        subjectKind: kind,
        subjectKey: key,
        active: query.active,
        reasonCode: query.reasonCode,
      }),
      query,
      ACCOUNT_BLOCK_LIST,
    );
    return new CursorPageDto(await this.toDtos(page.items), page.pageInfo.nextCursor);
  }

  private async toDtos(rows: readonly AccountBlockEntity[]): Promise<AccountBlockDto[]> {
    const ids = new Set<string>();
    for (const row of rows) {
      ids.add(row.blockedBy);
      if (row.unblockedBy) ids.add(row.unblockedBy);
      if (row.unblockApprovedBy) ids.add(row.unblockApprovedBy);
    }
    const subjects = new Map<string, string>();
    for (const id of ids) {
      const found = await this.operators.findById(id);
      if (found) subjects.set(id, found.subject);
    }
    const named = (id: string | null) => (id === null ? null : (subjects.get(id) ?? id));
    const orgNames = await this.organizationNames(rows);

    return rows.map((row) => ({
      id: row.id,
      subjectKind: row.subjectKind as BlockSubjectKind,
      subject: row.subject,
      subjectKey: row.subjectKey,
      subjectName:
        row.subjectKind === BlockSubjectKind.ORGANIZATION
          ? (orgNames.get(row.subject) ?? null)
          : null,
      active: row.unblockedAt === null,
      reasonCode: row.reasonCode,
      note: row.note,
      ticketRef: row.ticketRef,
      blockedBy: named(row.blockedBy) as string,
      blockedAt: row.blockedAt,
      unblockedBy: named(row.unblockedBy),
      unblockApprovedBy: named(row.unblockApprovedBy),
      unblockedAt: row.unblockedAt,
      unblockNote: row.unblockNote,
    }));
  }

  /**
   * A name for every blocked organization, so no row reads as a bare uuid:
   * the provider's public name when it is a provider (listed or not, as the
   * case view names it), else the organization's own name. Operators read
   * across tenants by construction, so neither is a disclosure.
   */
  private async organizationNames(
    rows: readonly AccountBlockEntity[],
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        rows
          .filter((row) => row.subjectKind === BlockSubjectKind.ORGANIZATION)
          .map((row) => row.subject),
      ),
    ];
    if (ids.length === 0) return new Map();
    const names = new Map(await this.providers.findDisplayNames(ids));
    for (const id of ids) {
      if (names.has(id)) continue;
      const organization = await this.organizations.findById(id);
      if (organization?.name) names.set(id, organization.name);
    }
    return names;
  }
}

/** Newest first — the order `idx_account_blocks_feed` is built for. */
const ACCOUNT_BLOCK_LIST: ListSpec = {
  alias: 'block',
  defaultSort: 'blockedAt',
  sortable: {
    blockedAt: {
      column: 'block.blocked_at',
      type: 'timestamptz',
      valueOf: asInstant((row: AccountBlockEntity) => row.blockedAt),
    },
  },
  timeColumn: 'block.blocked_at',
};
