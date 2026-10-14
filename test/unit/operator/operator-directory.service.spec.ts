import { OperatorEntity } from '@database/postgres/entities/operator.entity';
import { OverrideLogEntryEntity } from '@database/postgres/entities/override-log-entry.entity';
import { ApprovalMode, OperatorRole } from '@modules/operator/domain/override-register';
import { ApprovalQueuedDto } from '@modules/operator/dto/operator-approval.dto';
import { OperatorApprover, OperatorSession } from '@modules/operator/ports/operator-session.port';
import { OperatorApprovalService } from '@modules/operator/services/operator-approval.service';
import { OperatorDirectoryService } from '@modules/operator/services/operator-directory.service';
import { OperatorService } from '@modules/operator/services/operator.service';
import { OverrideLogService } from '@modules/operator/services/override-log.service';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { buildOperator } from './helpers/fake-operator-repository';

const NOTE = 'Rotation agreed in the weekly operations review, ticket OPS-114.';

/** `operators`, in memory, with writes applied. */
class Rows {
  readonly byId = new Map<string, OperatorEntity>();

  seed(id: string, roles: OperatorRole[], extra: Partial<OperatorEntity> = {}): OperatorEntity {
    const row = buildOperator({
      id,
      subject: `${id}@`,
      walletAddress: `0x${id.replace(/\W/g, '').padEnd(40, '0').slice(0, 40)}`,
      roles,
      ...extra,
    });
    this.byId.set(id, row);
    return row;
  }

  async findById(id: string) {
    return this.byId.get(id) ?? null;
  }
  async findByWallet(wallet: string) {
    return [...this.byId.values()].find((row) => row.walletAddress === wallet) ?? null;
  }
  async findBySubject(subject: string) {
    return [...this.byId.values()].find((row) => row.subject === subject) ?? null;
  }
  async update(where: { id: string }, fields: Partial<OperatorEntity>) {
    Object.assign(this.byId.get(where.id)!, fields);
    return { affected: 1 };
  }
  async insert(row: OperatorEntity) {
    this.byId.set(row.id, buildOperator(row));
  }
  async findOneByOrFail(where: { id: string }) {
    return this.byId.get(where.id)!;
  }
}

const sessionOf = (row: OperatorEntity): OperatorSession => ({
  operatorId: row.id,
  subject: row.subject,
  displayName: row.displayName,
  email: row.email,
  roles: row.roles as OperatorRole[],
  authorityLimitMinor: row.authorityLimitMinor,
});
const approvedBy = (row: OperatorEntity): OperatorApprover => ({
  ...sessionOf(row),
  approvalId: 'appr-1',
});

function build() {
  const rows = new Rows();
  const runner = {
    connect: async () => undefined,
    startTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    release: async () => undefined,
    manager: { getRepository: () => rows },
  };
  const entries: Partial<OverrideLogEntryEntity>[] = [];
  const overrides = new OverrideLogService(
    { createQueryRunner: () => runner } as never,
    {
      append: async (_r: unknown, entry: Partial<OverrideLogEntryEntity>) => {
        entries.push(entry);
        return entry;
      },
    } as never,
    { markApproved: async () => true } as never,
  );
  const queued: Record<string, unknown>[] = [];
  const approvals = new OperatorApprovalService(
    {
      create: (row: Record<string, unknown>) => row,
      save: async (row: Record<string, unknown>) => {
        queued.push(row);
        return { ...row, id: 'appr-1' };
      },
    } as never,
    rows as never,
    {} as never,
  );
  const directory = new OperatorService(rows as never, { get: () => undefined } as never);
  const revoked: string[] = [];
  const sessions = { revokeAll: async (id: string) => void revoked.push(id) };
  const service = new OperatorDirectoryService(
    overrides,
    rows as never,
    directory,
    sessions as never,
    approvals,
  );
  return { service, rows, entries, queued, revoked };
}

describe('OperatorDirectoryService — OPS_ADMIN is not one person’s to take away', () => {
  it('removes a non-admin operator at once, single-person', async () => {
    const { service, rows, entries, queued } = build();
    const admin = rows.seed('admin-a', [OperatorRole.OPS_ADMIN]);
    rows.seed('adj-1', [OperatorRole.ADJ]);

    await service.remove(sessionOf(admin), 'adj-1', { reasonCode: 'LEFT', note: NOTE }, null);

    expect(rows.byId.get('adj-1')!.status).toBe('REMOVED');
    expect(queued).toHaveLength(0);
    expect(entries[0]).toMatchObject({ code: 'A-14', approvalMode: ApprovalMode.SINGLE });
  });

  it('queues the removal of an OPS_ADMIN, and applies it once another approves', async () => {
    const { service, rows, entries, queued } = build();
    const a = rows.seed('admin-a', [OperatorRole.OPS_ADMIN]);
    const c = rows.seed('admin-c', [OperatorRole.OPS_ADMIN]);
    rows.seed('admin-b', [OperatorRole.OPS_ADMIN]);
    const body = { reasonCode: 'LEFT', note: NOTE };

    const result = await service.remove(sessionOf(a), 'admin-b', body, null);
    expect(result).toBeInstanceOf(ApprovalQueuedDto);
    expect(queued[0]).toMatchObject({ action: 'operator.remove' });
    expect(rows.byId.get('admin-b')!.status).toBe('ACTIVE');

    await service.remove(sessionOf(a), 'admin-b', body, null, approvedBy(c));
    expect(rows.byId.get('admin-b')!.status).toBe('REMOVED');
    expect(entries[0]).toMatchObject({ code: 'A-14', approvalMode: ApprovalMode.TWO_PERSON });
  });

  it('refuses the target as the approver of their own removal', async () => {
    const { service, rows } = build();
    const a = rows.seed('admin-a', [OperatorRole.OPS_ADMIN]);
    const b = rows.seed('admin-b', [OperatorRole.OPS_ADMIN]);

    await expectErrorCodeAsync(
      () =>
        service.remove(sessionOf(a), 'admin-b', { reasonCode: 'LEFT', note: NOTE }, null, {
          ...approvedBy(b),
        }),
      'OPERATOR_SELF_CHANGE_REFUSED',
    );
  });

  it('queues taking OPS_ADMIN away, but not lowering another role', async () => {
    const { service, rows, queued } = build();
    const a = rows.seed('admin-a', [OperatorRole.OPS_ADMIN]);
    rows.seed('admin-b', [OperatorRole.OPS_ADMIN, OperatorRole.TRE]);

    const demote = await service.change(
      sessionOf(a),
      'admin-b',
      { roles: [OperatorRole.TRE], reasonCode: 'ROTATION', note: NOTE },
      null,
    );
    expect(demote).toBeInstanceOf(ApprovalQueuedDto);
    expect(rows.byId.get('admin-b')!.roles).toEqual([OperatorRole.OPS_ADMIN, OperatorRole.TRE]);

    await service.change(
      sessionOf(a),
      'admin-b',
      { roles: [OperatorRole.OPS_ADMIN], reasonCode: 'ROTATION', note: NOTE },
      null,
    );
    expect(rows.byId.get('admin-b')!.roles).toEqual([OperatorRole.OPS_ADMIN]);
    expect(queued).toHaveLength(1);
  });
});
