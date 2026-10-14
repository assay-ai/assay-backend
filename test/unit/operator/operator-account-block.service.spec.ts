import { AccountBlockEntity } from '@database/postgres/entities/account-block.entity';
import { OverrideLogEntryEntity } from '@database/postgres/entities/override-log-entry.entity';
import { BlockSubjectKind } from '@modules/blocklist/domain/account-block';
import {
  ApprovalMode,
  lookupOverride,
  OperatorRole,
  OverrideFamily,
} from '@modules/operator/domain/override-register';
import { OperatorErrorCode } from '@modules/operator/errors/operator.errors';
import { ApprovalQueuedDto } from '@modules/operator/dto/operator-approval.dto';
import { OperatorApprover, OperatorSession } from '@modules/operator/ports/operator-session.port';
import { OperatorAccountBlockService } from '@modules/operator/services/operator-account-block.service';
import { OperatorApprovalService } from '@modules/operator/services/operator-approval.service';
import { OverrideLogService } from '@modules/operator/services/override-log.service';

import { noBlocks } from '../helpers/blocklist';

const ORG = '08773F92-21CD-4E53-8348-D3EF1DCC8378';
const WALLET = 'eip155:84532:0xA271A3407D3302f4b4Fbe469b9188487cedd7d45';
const NOTE = 'A leaked agent key was reported by the customer on the support line.';

const operator = (id: string, roles: OperatorRole[]): OperatorSession => ({
  operatorId: id,
  subject: `${id}@`,
  displayName: id,
  email: `${id}@example.test`,
  roles,
  authorityLimitMinor: null,
});
const SRE = operator('op-sre', [OperatorRole.SRE]);
const LEAD = operator('op-adjl', [OperatorRole.ADJL]);
const ADJ = operator('op-adj', [OperatorRole.ADJ]);

/** `account_blocks`, in memory: the one active-per-subject rule included. */
class FakeBlocks {
  readonly rows: AccountBlockEntity[] = [];

  async findOneBy(where: Partial<AccountBlockEntity> & { unblockedAt?: unknown }) {
    return (
      this.rows.find(
        (row) =>
          (where.id === undefined || row.id === where.id) &&
          (where.subjectKind === undefined || row.subjectKind === where.subjectKind) &&
          (where.subjectKey === undefined || row.subjectKey === where.subjectKey) &&
          (!('unblockedAt' in where) || row.unblockedAt === null),
      ) ?? null
    );
  }
  async findOneByOrFail(where: { id: string }) {
    const found = await this.findOneBy(where);
    if (!found) throw new Error('missing');
    return found;
  }
  async insertBlock(_runner: unknown, row: Partial<AccountBlockEntity>) {
    const entity = { ...row } as AccountBlockEntity;
    this.rows.push(entity);
    return entity;
  }
  async markUnblocked(_runner: unknown, id: string, patch: Partial<AccountBlockEntity>) {
    const row = this.rows.find((candidate) => candidate.id === id && !candidate.unblockedAt);
    if (!row) return 0;
    Object.assign(row, patch);
    return 1;
  }
}

function build() {
  const runner = {
    connect: async () => undefined,
    startTransaction: async () => undefined,
    commitTransaction: jest.fn(async () => undefined),
    rollbackTransaction: jest.fn(async () => undefined),
    release: async () => undefined,
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
  const blocks = new FakeBlocks();
  const blocklist = noBlocks();
  const applied = jest.spyOn(blocklist, 'applied');
  const operators = { findById: async (id: string) => ({ id, subject: `${id}@` }) };
  const queued: Record<string, unknown>[] = [];
  const approvals = new OperatorApprovalService(
    {
      create: (row: Record<string, unknown>) => row,
      save: async (row: Record<string, unknown>) => {
        queued.push(row);
        return { ...row, id: 'appr-1' };
      },
    } as never,
    operators as never,
    {} as never,
  );
  const service = new OperatorAccountBlockService(
    overrides,
    blocks as never,
    operators as never,
    blocklist,
    approvals,
  );
  return { service, blocks, entries, blocklist, applied, runner, queued };
}

/** A second operator who approved the queued unblock with their own session. */
const approvedBy = (session: OperatorSession): OperatorApprover => ({
  ...session,
  approvalId: 'appr-1',
});

describe('the account blocklist register rows', () => {
  it('A-9 blocks, single-person, for the incident roles', () => {
    expect(lookupOverride('A-9')).toMatchObject({
      family: OverrideFamily.ACCESS,
      action: 'account.blocked',
      roles: [OperatorRole.ADJL, OperatorRole.SRE],
      approval: ApprovalMode.SINGLE,
      implemented: true,
    });
  });

  it('A-10 lifts, two-person, and only a lead may check it', () => {
    expect(lookupOverride('A-10')).toMatchObject({
      family: OverrideFamily.ACCESS,
      action: 'account.unblocked',
      roles: [OperatorRole.ADJL, OperatorRole.SRE],
      approval: ApprovalMode.TWO_PERSON,
      approverRoles: [OperatorRole.ADJL],
      implemented: true,
    });
  });
});

describe('OperatorAccountBlockService.block', () => {
  it('writes the block and its A-9 entry together, then applies it to this instance', async () => {
    const { service, blocks, entries, applied, blocklist } = build();

    const dto = await service.block(
      SRE,
      {
        subjectKind: BlockSubjectKind.WALLET,
        subject: WALLET,
        reasonCode: 'LEAKED_KEY',
        note: NOTE,
      },
      'req-1',
    );

    expect(blocks.rows).toHaveLength(1);
    expect(dto).toMatchObject({
      subjectKind: BlockSubjectKind.WALLET,
      subject: WALLET.toLowerCase(),
      subjectKey: 'eip155:0xa271a3407d3302f4b4fbe469b9188487cedd7d45',
      active: true,
      blockedBy: 'op-sre@',
    });
    expect(entries).toEqual([
      expect.objectContaining({
        code: 'A-9',
        family: 'A',
        action: 'account.blocked',
        actorOperatorId: SRE.operatorId,
        approvalMode: ApprovalMode.SINGLE,
        targetType: 'account_block',
        targetId: dto.id,
        // A wallet block names no tenant.
        organizationId: null,
        reasonCode: 'LEAKED_KEY',
        requestId: 'req-1',
      }),
    ]);
    expect(applied).toHaveBeenCalledTimes(1);
    expect(
      blocklist.walletBlock('eip155:1:0xa271a3407d3302f4b4fbe469b9188487cedd7d45'),
    ).not.toBeNull();
  });

  it('names the organization as the entry tenant on an organization block', async () => {
    const { service, entries, blocklist } = build();

    await service.block(
      LEAD,
      { subjectKind: BlockSubjectKind.ORGANIZATION, subject: ORG, reasonCode: 'FRAUD', note: NOTE },
      null,
    );

    expect(entries[0]).toMatchObject({ organizationId: ORG.toLowerCase() });
    expect(blocklist.organizationBlock(ORG)).not.toBeNull();
  });

  it('refuses a subject that is not one, and writes nothing', async () => {
    const { service, blocks, entries } = build();

    await expect(
      service.block(
        SRE,
        { subjectKind: BlockSubjectKind.WALLET, subject: ORG, reasonCode: 'X', note: NOTE },
        null,
      ),
    ).rejects.toMatchObject({ errorCode: OperatorErrorCode.OPERATOR_BLOCK_SUBJECT_INVALID });
    await expect(
      service.block(
        SRE,
        {
          subjectKind: BlockSubjectKind.ORGANIZATION,
          subject: WALLET,
          reasonCode: 'X',
          note: NOTE,
        },
        null,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(blocks.rows).toHaveLength(0);
    expect(entries).toHaveLength(0);
  });

  it('refuses a second standing block of the same key, on any chain spelling', async () => {
    const { service, blocks } = build();
    const first = await service.block(
      SRE,
      { subjectKind: BlockSubjectKind.WALLET, subject: WALLET, reasonCode: 'X', note: NOTE },
      null,
    );

    await expect(
      service.block(
        SRE,
        {
          subjectKind: BlockSubjectKind.WALLET,
          subject: 'eip155:8453:0xa271a3407d3302f4b4fbe469b9188487cedd7d45',
          reasonCode: 'X',
          note: NOTE,
        },
        null,
      ),
    ).rejects.toMatchObject({
      errorCode: OperatorErrorCode.OPERATOR_BLOCK_ALREADY_ACTIVE,
      context: { blockId: first.id },
    });
    expect(blocks.rows).toHaveLength(1);
  });

  it('refuses an operator without an incident role before anything is written', async () => {
    const { service, blocks, applied } = build();

    await expect(
      service.block(
        ADJ,
        { subjectKind: BlockSubjectKind.WALLET, subject: WALLET, reasonCode: 'X', note: NOTE },
        null,
      ),
    ).rejects.toMatchObject({ errorCode: OperatorErrorCode.OPERATOR_ROLE_REQUIRED });
    expect(blocks.rows).toHaveLength(0);
    expect(applied).not.toHaveBeenCalled();
  });

  it('does not apply a block whose transaction rolled back', async () => {
    const { service, blocks, applied, runner } = build();
    jest.spyOn(blocks, 'insertBlock').mockRejectedValueOnce(new Error('insert failed'));

    await expect(
      service.block(
        SRE,
        { subjectKind: BlockSubjectKind.WALLET, subject: WALLET, reasonCode: 'X', note: NOTE },
        null,
      ),
    ).rejects.toThrow('insert failed');
    expect(runner.rollbackTransaction).toHaveBeenCalled();
    expect(applied).not.toHaveBeenCalled();
  });
});

describe('OperatorAccountBlockService.unblock', () => {
  async function blocked() {
    const built = build();
    const dto = await built.service.block(
      SRE,
      { subjectKind: BlockSubjectKind.ORGANIZATION, subject: ORG, reasonCode: 'X', note: NOTE },
      null,
    );
    built.entries.length = 0;
    built.applied.mockClear();
    return { ...built, blockId: dto.id };
  }

  it('lifts with a lead as checker, records A-10 two-person, and applies it at once', async () => {
    const { service, entries, applied, blocklist, blockId } = await blocked();

    const dto = await service.unblock(
      SRE,
      blockId,
      { reasonCode: 'KEY_ROTATED', note: NOTE },
      'req-2',
      approvedBy(LEAD),
    );

    expect(dto).toMatchObject({
      active: false,
      unblockedBy: 'op-sre@',
      unblockApprovedBy: 'op-adjl@',
      unblockNote: NOTE,
    });
    expect(entries).toEqual([
      expect.objectContaining({
        code: 'A-10',
        action: 'account.unblocked',
        actorOperatorId: SRE.operatorId,
        approverOperatorId: LEAD.operatorId,
        approvalMode: ApprovalMode.TWO_PERSON,
        targetId: blockId,
        organizationId: ORG.toLowerCase(),
      }),
    ]);
    expect(applied).toHaveBeenCalledWith({
      kind: 'unblocked',
      subjectKind: BlockSubjectKind.ORGANIZATION,
      subjectKey: ORG.toLowerCase(),
    });
    expect(blocklist.organizationBlock(ORG)).toBeNull();
  });

  it('queues the lifting for a second operator when called alone, and lifts nothing', async () => {
    const { service, blocks, blockId, queued, entries } = await blocked();
    const result = await service.unblock(SRE, blockId, { reasonCode: 'X', note: NOTE }, null);

    expect(result).toBeInstanceOf(ApprovalQueuedDto);
    expect(result).toMatchObject({
      approvalId: 'appr-1',
      status: 'PENDING',
      action: 'account.unblock',
    });
    expect(queued).toEqual([
      expect.objectContaining({
        action: 'account.unblock',
        target: `account_block:${blockId}`,
        requestedBy: SRE.operatorId,
        payload: { blockId, body: { reasonCode: 'X', note: NOTE } },
      }),
    ]);
    expect(blocks.rows[0].unblockedAt).toBeNull();
    expect(entries).toHaveLength(0);
  });

  it('refuses to queue a lifting of a block that does not exist', async () => {
    const { service, queued } = await blocked();
    await expect(
      service.unblock(
        SRE,
        '00000000-0000-4000-8000-000000000000',
        { reasonCode: 'X', note: NOTE },
        null,
      ),
    ).rejects.toMatchObject({ errorCode: OperatorErrorCode.OPERATOR_BLOCK_NOT_FOUND });
    expect(queued).toHaveLength(0);
  });

  it('refuses the actor approving their own lifting', async () => {
    const { service, blockId } = await blocked();
    await expect(
      service.unblock(SRE, blockId, { reasonCode: 'X', note: NOTE }, null, approvedBy(SRE)),
    ).rejects.toMatchObject({ errorCode: OperatorErrorCode.OPERATOR_SELF_APPROVAL_REFUSED });
  });

  it('refuses a checker who is not a lead, and leaves the block standing', async () => {
    const { service, blocks, applied, blocklist, blockId } = await blocked();
    await expect(
      service.unblock(SRE, blockId, { reasonCode: 'X', note: NOTE }, null, approvedBy(ADJ)),
    ).rejects.toMatchObject({ errorCode: OperatorErrorCode.OPERATOR_APPROVER_ROLE_REQUIRED });
    expect(blocks.rows[0].unblockedAt).toBeNull();
    expect(applied).not.toHaveBeenCalled();
    expect(blocklist.organizationBlock(ORG)).not.toBeNull();
  });

  it('answers 404 for an unknown block and 409 for a lifted one', async () => {
    const { service, blockId } = await blocked();
    await expect(
      service.unblock(
        SRE,
        '00000000-0000-4000-8000-000000000000',
        { reasonCode: 'X', note: NOTE },
        null,
        approvedBy(LEAD),
      ),
    ).rejects.toMatchObject({
      errorCode: OperatorErrorCode.OPERATOR_BLOCK_NOT_FOUND,
      statusCode: 404,
    });

    await service.unblock(SRE, blockId, { reasonCode: 'X', note: NOTE }, null, approvedBy(LEAD));
    await expect(
      service.unblock(SRE, blockId, { reasonCode: 'X', note: NOTE }, null, approvedBy(LEAD)),
    ).rejects.toMatchObject({
      errorCode: OperatorErrorCode.OPERATOR_BLOCK_ALREADY_LIFTED,
      statusCode: 409,
    });
  });
});
