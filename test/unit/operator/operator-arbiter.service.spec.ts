import { OverrideLogEntryEntity } from '@database/postgres/entities/override-log-entry.entity';
import {
  ApprovalMode,
  lookupOverride,
  OperatorRole,
} from '@modules/operator/domain/override-register';
import { ApprovalQueuedDto } from '@modules/operator/dto/operator-approval.dto';
import { OperatorSession } from '@modules/operator/ports/operator-session.port';
import { OperatorApprovalService } from '@modules/operator/services/operator-approval.service';
import {
  ARBITER_BLOCK_APPROVAL_ACTION,
  OperatorArbiterService,
} from '@modules/operator/services/operator-arbiter.service';
import { OverrideLogService } from '@modules/operator/services/override-log.service';
import { SlashDisputeIntentService } from '@modules/slash/services/slash-dispute-intent.service';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

const CHAIN = 'eip155:46630';
const ACCOUNT = '0xA271A3407D3302f4b4Fbe469b9188487cedd7d45';
const CALL = {
  chainId: CHAIN,
  to: '0x0aF4D08f97B4FA8Ba3E47Cb025aE8CaD509bc73c',
  data: '0x',
  value: '0' as const,
  signer: '0x1111111111111111111111111111111111111111',
  signerRole: 'ARBITER' as const,
  functionName: 'setBlocked',
  requestIds: [] as string[],
};
const NOTE = 'The key was posted publicly and the address is draining.';

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
const TRE = operator('op-tre', [OperatorRole.TRE]);

function build() {
  const runner = {
    connect: async () => undefined,
    startTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
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
  const queued: Record<string, unknown>[] = [];
  const stored = new Map<string, Record<string, unknown>>();
  const approvals = new OperatorApprovalService(
    {
      create: (row: Record<string, unknown>) => row,
      save: async (row: Record<string, unknown>) => {
        queued.push(row);
        return { ...row, id: 'appr-1' };
      },
      expireStale: async () => 0,
      findOneBy: async ({ id }: { id: string }) => stored.get(id) ?? null,
    } as never,
    {} as never,
    {} as never,
  );
  const buildBlock = jest.fn(async () => CALL);
  const disputes = new SlashDisputeIntentService(
    {} as never,
    overrides,
    {} as never,
    { buildBlock } as never,
  );
  const service = new OperatorArbiterService(disputes, approvals);
  return { service, entries, queued, buildBlock, stored };
}

const context = (who: OperatorSession) => ({
  operator: who,
  reasonCode: 'LEAKED_KEY',
  note: NOTE,
  requestId: null,
});

describe('A-11 — the on-chain block is two-person', () => {
  it('is TWO_PERSON in the register, checked by a lead', () => {
    expect(lookupOverride('A-11')).toMatchObject({
      approval: ApprovalMode.TWO_PERSON,
      approverRoles: [OperatorRole.ADJL],
    });
  });

  it('queues the request and logs nothing until it is approved', async () => {
    const { service, entries, queued } = build();

    const result = await service.block(context(SRE), CHAIN, ACCOUNT);

    expect(result).toBeInstanceOf(ApprovalQueuedDto);
    expect(entries).toHaveLength(0);
    expect(queued[0]).toMatchObject({
      action: ARBITER_BLOCK_APPROVAL_ACTION,
      payload: { chainId: CHAIN, account: ACCOUNT, reasonCode: 'LEAKED_KEY', note: NOTE },
    });
  });

  it('builds and logs the call once a lead approves it', async () => {
    const { service, entries } = build();

    const call = await service.block(context(SRE), CHAIN, ACCOUNT, {
      ...LEAD,
      approvalId: 'appr-1',
    });

    expect(call).toMatchObject({ functionName: 'setBlocked' });
    expect(entries).toEqual([
      expect.objectContaining({
        code: 'A-11',
        actorOperatorId: SRE.operatorId,
        approverOperatorId: LEAD.operatorId,
        approvalMode: ApprovalMode.TWO_PERSON,
      }),
    ]);
  });

  it('refuses an approver who is not a lead', async () => {
    const { service, entries } = build();
    await expectErrorCodeAsync(
      () => service.block(context(SRE), CHAIN, ACCOUNT, { ...TRE, approvalId: 'appr-1' }),
      'OPERATOR_APPROVER_ROLE_REQUIRED',
    );
    expect(entries).toHaveLength(0);
  });
});

describe('A-11 — the approved block call, fetched again (review N-5)', () => {
  const approved = (patch: Record<string, unknown> = {}) => ({
    id: 'appr-1',
    action: ARBITER_BLOCK_APPROVAL_ACTION,
    status: 'APPROVED',
    payload: { chainId: CHAIN, account: ACCOUNT, reasonCode: 'LEAKED_KEY', note: NOTE },
    ...patch,
  });

  it('rebuilds the unsigned setBlocked of an APPROVED block, with no second register entry', async () => {
    const { service, stored, buildBlock, entries } = build();
    stored.set('appr-1', approved());

    await expect(service.approvedBlockCall('appr-1')).resolves.toMatchObject({
      functionName: 'setBlocked',
      signerRole: 'ARBITER',
    });
    expect(buildBlock).toHaveBeenCalledWith({ chainId: CHAIN, account: ACCOUNT });
    expect(entries).toHaveLength(0);
  });

  it('refuses a block that is not approved, and an approval of another action', async () => {
    const { service, stored } = build();
    stored.set('appr-1', approved({ status: 'PENDING' }));
    stored.set('appr-2', approved({ id: 'appr-2', action: 'slash.suspend' }));

    await expectErrorCodeAsync(
      () => service.approvedBlockCall('appr-1'),
      'OPERATOR_APPROVAL_NOT_APPROVED',
    );
    await expectErrorCodeAsync(
      () => service.approvedBlockCall('appr-2'),
      'OPERATOR_APPROVAL_NOT_APPROVED',
    );
    await expectErrorCodeAsync(
      () => service.approvedBlockCall('missing'),
      'OPERATOR_APPROVAL_NOT_FOUND',
    );
  });

  it('passes the chain refusal on once the address is blocked: the call was executed', async () => {
    const { service, stored, buildBlock } = build();
    stored.set('appr-1', approved());
    buildBlock.mockRejectedValueOnce(
      Object.assign(new Error('already blocked'), { errorCode: 'CHAIN_ADDRESS_ALREADY_BLOCKED' }),
    );
    await expect(service.approvedBlockCall('appr-1')).rejects.toMatchObject({
      errorCode: 'CHAIN_ADDRESS_ALREADY_BLOCKED',
    });
  });
});
