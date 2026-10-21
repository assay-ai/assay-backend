import { randomUUID } from 'node:crypto';

import { Injectable, Optional } from '@nestjs/common';

import { OperatorEntity } from '@database/postgres/entities/operator.entity';
import { UNIQUE_VIOLATION_CODE } from '@database/postgres/repositories/abstract.repository';
import { OperatorRepository } from '@database/postgres/repositories/operator.repository';
import { asInstant, CursorPageDto, ListSpec, paginate } from '@shared/api';

import { OperatorSessionStore } from '../auth/operator-session.store';
import { OperatorRole } from '../domain/override-register';
import { ApprovalQueuedDto } from '../dto/operator-approval.dto';
import {
  AddOperatorBodyDto,
  ChangeOperatorBodyDto,
  ListOperatorsQueryDto,
  OperatorDirectoryEntryDto,
  RemoveOperatorBodyDto,
} from '../dto/operator-directory.dto';
import { OperatorErrors } from '../errors/operator.errors';
import { OperatorApprover, OperatorSession } from '../ports/operator-session.port';
import { OperatorApprovalService } from './operator-approval.service';
import { OperatorService } from './operator.service';
import { OverrideLogService } from './override-log.service';
import { LastSeenKind, LastSeenRecorder } from '@shared/last-seen';

const TARGET_TYPE = 'operator';

export const DIRECTORY_APPROVAL_ACTIONS = {
  add: 'operator.add',
  change: 'operator.change',
  remove: 'operator.remove',
} as const;

/**
 * True when the change takes `OPS_ADMIN` away. Who may add operators is the
 * one authority whose loss the console cannot repair (`A-12` needs a second
 * `OPS_ADMIN`), so losing a holder is two-person like gaining one.
 */
function demotesAdmin(current: readonly string[], next: readonly string[]): boolean {
  return current.includes(OperatorRole.OPS_ADMIN) && !next.includes(OperatorRole.OPS_ADMIN);
}

/** True when `next` grants anything `current` does not: a new role, or a higher limit. */
export function raisesAuthority(
  current: { roles: readonly string[]; authorityLimitMinor: string | null },
  next: { roles: readonly string[]; authorityLimitMinor: string | null },
): boolean {
  if (next.roles.some((role) => !current.roles.includes(role))) return true;
  if (next.authorityLimitMinor === null) return current.authorityLimitMinor !== null;
  if (current.authorityLimitMinor === null) return false;
  return BigInt(next.authorityLimitMinor) > BigInt(current.authorityLimitMinor);
}

/**
 * Refuse an approver granting an authority limit above their own: a checker
 * with a $0 ceiling must not be enough to create an unbounded operator. `null`
 * is unbounded, on either side.
 */
function assertApproverCanGrant(
  approver: OperatorApprover | null,
  granted: string | null,
  code: string,
): void {
  const limit = approver?.authorityLimitMinor;
  if (limit === null || limit === undefined) return;
  if (granted === null || BigInt(granted) > BigInt(limit)) {
    throw OperatorErrors.approverAuthorityExceeded({
      code,
      limit,
      requested: granted ?? 'unbounded',
    });
  }
}

/**
 * `A-12`, `A-13`, `A-14` — the operator directory, managed from the console.
 *
 * - Adding grants authority, so it is always two-person (queued, 202).
 * - Changing is single-person when it only lowers roles or the limit, and
 *   two-person when it adds a role or raises the limit.
 * - Removing is single-person, takes effect at once, and revokes every session
 *   the operator holds.
 * - Except for an `OPS_ADMIN`: removing one, or taking the role away, is
 *   two-person, approved by another `OPS_ADMIN` who is not the target. With
 *   two holders left, that leaves nobody to approve it, which is the point:
 *   one stolen admin session cannot strip the directory of its admins.
 *
 * Nobody acts on their own row, and an approver may not approve a change to
 * their own, nor grant an authority limit above their own.
 *
 * Two-person means two operator rows, not two people: nothing here proves the
 * wallet being added belongs to somebody other than the requester. That rests
 * on the approver knowing who the new operator is. Every change writes its register entry in the same transaction.
 */
@Injectable()
export class OperatorDirectoryService {
  constructor(
    private readonly overrides: OverrideLogService,
    private readonly operators: OperatorRepository,
    private readonly directory: OperatorService,
    private readonly sessions: OperatorSessionStore,
    private readonly approvals: OperatorApprovalService,
    @Optional() private readonly lastSeen: LastSeenRecorder | null = null,
  ) {
    approvals.register(DIRECTORY_APPROVAL_ACTIONS.add, {
      code: 'A-12',
      run: (requester, approver, payload, requestId) =>
        this.add(requester, payload.body as AddOperatorBodyDto, requestId, approver),
    });
    approvals.register(DIRECTORY_APPROVAL_ACTIONS.change, {
      code: 'A-13',
      run: (requester, approver, payload, requestId) =>
        this.change(
          requester,
          payload.operatorId as string,
          payload.body as ChangeOperatorBodyDto,
          requestId,
          approver,
        ),
    });
    approvals.register(DIRECTORY_APPROVAL_ACTIONS.remove, {
      code: 'A-14',
      run: (requester, approver, payload, requestId) =>
        this.remove(
          requester,
          payload.operatorId as string,
          payload.body as RemoveOperatorBodyDto,
          requestId,
          approver,
        ),
    });
  }

  async list(query: ListOperatorsQueryDto): Promise<CursorPageDto<OperatorDirectoryEntryDto>> {
    const qb = this.operators.createQueryBuilder('operator');
    if (query.status) qb.andWhere('operator.status = :status', { status: query.status });
    const page = await paginate(qb, query, OPERATOR_LIST);
    // `last_seen_at` is buffered (`LastSeenRecorder`): the screen reads the
    // latest of the row and the stamps not yet written.
    const pending =
      (await this.lastSeen?.pending(
        LastSeenKind.OPERATOR_SEEN,
        page.items.map((row) => row.id),
      )) ?? new Map<string, Date>();
    return new CursorPageDto(
      page.items.map((row) => this.toEntry(row, pending.get(row.id))),
      page.pageInfo.nextCursor,
    );
  }

  async add(
    actor: OperatorSession,
    body: AddOperatorBodyDto,
    requestId: string | null,
    approver: OperatorApprover | null = null,
  ): Promise<OperatorDirectoryEntryDto | ApprovalQueuedDto> {
    const wallet = body.walletAddress.toLowerCase();
    const attempt = async (): Promise<OperatorDirectoryEntryDto> => {
      const byWallet = await this.operators.findByWallet(wallet);
      if (byWallet && byWallet.status !== 'REMOVED') {
        throw OperatorErrors.alreadyExists({ field: 'wallet' });
      }
      const bySubject = await this.operators.findBySubject(body.subject);
      if (bySubject && bySubject.id !== byWallet?.id) {
        throw OperatorErrors.alreadyExists({ field: 'subject' });
      }

      const authorityLimitMinor =
        body.authorityLimitMinor === undefined ? '0' : body.authorityLimitMinor;
      assertApproverCanGrant(approver, authorityLimitMinor, 'A-12');

      // A removed operator coming back is the same row, so their history
      // stays theirs.
      const id = byWallet?.id ?? randomUUID();
      const values = {
        subject: body.subject,
        displayName: body.displayName ?? body.subject,
        email: body.email ?? byWallet?.email ?? '',
        walletAddress: wallet,
        roles: [...body.roles],
        authorityLimitMinor,
        status: 'ACTIVE',
        suspendedAt: null,
        removedAt: null,
      };

      let saved: OperatorEntity;
      try {
        saved = await this.overrides.perform<OperatorEntity>(
          {
            code: 'A-12',
            actor,
            approver,
            targetType: TARGET_TYPE,
            targetId: id,
            organizationId: null,
            reasonCode: body.reasonCode,
            reason: body.note,
            requestId,
          },
          async (queryRunner) => {
            const repository = queryRunner.manager.getRepository(OperatorEntity);
            if (byWallet) await repository.update({ id }, values);
            else await repository.insert({ id, ...values });
            return {
              value: await repository.findOneByOrFail({ id }),
              before: byWallet ? { status: byWallet.status } : { exists: false },
              after: {
                walletAddress: wallet,
                subject: values.subject,
                roles: values.roles,
                authorityLimitMinor: values.authorityLimitMinor,
                status: 'ACTIVE',
              },
            };
          },
        );
      } catch (error) {
        if ((error as { code?: string })?.code === UNIQUE_VIOLATION_CODE) {
          throw OperatorErrors.alreadyExists({});
        }
        throw error;
      }
      this.directory.invalidate(saved.id);
      return this.toEntry(saved);
    };

    if (approver) return attempt();
    return this.approvals.orQueue(
      {
        action: DIRECTORY_APPROVAL_ACTIONS.add,
        target: `operator_wallet:${wallet}`,
        payload: { body: { ...body } },
        requester: actor,
      },
      attempt,
    );
  }

  async change(
    actor: OperatorSession,
    operatorId: string,
    body: ChangeOperatorBodyDto,
    requestId: string | null,
    approver: OperatorApprover | null = null,
  ): Promise<OperatorDirectoryEntryDto | ApprovalQueuedDto> {
    const attempt = async (): Promise<OperatorDirectoryEntryDto> => {
      this.assertNotSelf(actor, operatorId, approver);
      const current = await this.requireListed(operatorId);
      const next = {
        roles: body.roles ? [...body.roles] : (current.roles as OperatorRole[]),
        authorityLimitMinor:
          body.authorityLimitMinor === undefined
            ? current.authorityLimitMinor
            : body.authorityLimitMinor,
      };
      const sameRoles =
        next.roles.length === current.roles.length &&
        next.roles.every((role) => current.roles.includes(role));
      if (sameRoles && next.authorityLimitMinor === current.authorityLimitMinor) {
        throw OperatorErrors.changeEmpty();
      }
      const losesRole = current.roles.some((role) => !next.roles.includes(role as OperatorRole));
      if (next.authorityLimitMinor !== current.authorityLimitMinor) {
        assertApproverCanGrant(approver, next.authorityLimitMinor, 'A-13');
      }

      const saved = await this.overrides.perform<OperatorEntity>(
        {
          code: 'A-13',
          actor,
          approver,
          escalateToTwoPerson:
            raisesAuthority(current, next) || demotesAdmin(current.roles, next.roles),
          targetType: TARGET_TYPE,
          targetId: operatorId,
          organizationId: null,
          reasonCode: body.reasonCode,
          reason: body.note,
          requestId,
        },
        async (queryRunner) => {
          const repository = queryRunner.manager.getRepository(OperatorEntity);
          await repository.update({ id: operatorId }, next);
          return {
            value: await repository.findOneByOrFail({ id: operatorId }),
            before: { roles: current.roles, authorityLimitMinor: current.authorityLimitMinor },
            after: next,
          };
        },
      );
      this.directory.invalidate(operatorId);
      // A role taken away ends the operator's sessions everywhere at once, as
      // a removal does, rather than when other instances' caches expire.
      if (losesRole) await this.sessions.revokeAll(operatorId);
      return this.toEntry(saved);
    };

    if (approver) return attempt();
    return this.approvals.orQueue(
      {
        action: DIRECTORY_APPROVAL_ACTIONS.change,
        target: `operator:${operatorId}`,
        payload: { operatorId, body: { ...body } },
        requester: actor,
      },
      attempt,
    );
  }

  async remove(
    actor: OperatorSession,
    operatorId: string,
    body: RemoveOperatorBodyDto,
    requestId: string | null,
    approver: OperatorApprover | null = null,
  ): Promise<OperatorDirectoryEntryDto | ApprovalQueuedDto> {
    const attempt = () => this.removeNow(actor, operatorId, body, requestId, approver);
    if (approver) return attempt();
    return this.approvals.orQueue(
      {
        action: DIRECTORY_APPROVAL_ACTIONS.remove,
        target: `operator:${operatorId}`,
        payload: { operatorId, body: { ...body } },
        requester: actor,
      },
      attempt,
    );
  }

  private async removeNow(
    actor: OperatorSession,
    operatorId: string,
    body: RemoveOperatorBodyDto,
    requestId: string | null,
    approver: OperatorApprover | null,
  ): Promise<OperatorDirectoryEntryDto> {
    this.assertNotSelf(actor, operatorId, approver);
    const current = await this.requireListed(operatorId);
    const removedAt = new Date();

    const saved = await this.overrides.perform<OperatorEntity>(
      {
        code: 'A-14',
        actor,
        approver,
        escalateToTwoPerson: current.roles.includes(OperatorRole.OPS_ADMIN),
        targetType: TARGET_TYPE,
        targetId: operatorId,
        organizationId: null,
        reasonCode: body.reasonCode,
        reason: body.note,
        requestId,
      },
      async (queryRunner) => {
        const repository = queryRunner.manager.getRepository(OperatorEntity);
        await repository.update(
          { id: operatorId },
          { status: 'REMOVED', removedAt, suspendedAt: null },
        );
        return {
          value: await repository.findOneByOrFail({ id: operatorId }),
          before: { status: current.status },
          after: { status: 'REMOVED' },
        };
      },
    );

    // Every instance resolves sessions from Redis, so this ends the removed
    // operator's access everywhere at once, not after a cache expires.
    this.directory.invalidate(operatorId);
    await this.sessions.revokeAll(operatorId);
    return this.toEntry(saved);
  }

  private assertNotSelf(
    actor: OperatorSession,
    targetId: string,
    approver: OperatorApprover | null,
  ): void {
    if (actor.operatorId === targetId || approver?.operatorId === targetId) {
      throw OperatorErrors.selfChangeRefused();
    }
  }

  /** The row, unless it does not exist or was removed. */
  private async requireListed(id: string): Promise<OperatorEntity> {
    const row = await this.operators.findById(id);
    if (!row || row.status === 'REMOVED') throw OperatorErrors.notFound({ id });
    return row;
  }

  private toEntry(row: OperatorEntity, seen?: Date): OperatorDirectoryEntryDto {
    return {
      ...this.directory.toDto(row),
      email: row.email,
      lastSeenAt: LastSeenRecorder.latest(row.lastSeenAt, seen),
      createdAt: row.createdAt,
    };
  }
}

/** Newest first, like every list. */
const OPERATOR_LIST: ListSpec = {
  alias: 'operator',
  defaultSort: 'createdAt',
  sortable: {
    createdAt: {
      column: 'operator.created_at',
      type: 'timestamptz',
      valueOf: asInstant((row: OperatorEntity) => row.createdAt),
    },
  },
  timeColumn: 'operator.created_at',
};
