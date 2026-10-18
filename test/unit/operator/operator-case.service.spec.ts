import { SlashProposalEntity } from '@database/postgres/entities/slash-proposal.entity';
import { OperatorCaseService } from '@modules/operator/services/operator-case.service';
import { SlashRecordSnapshot } from '@modules/slash/ports/slash-executor.port';

/**
 * B11: the brief says whether anything of the case stands on chain, so the
 * console never claims "anyone can execute" a penalty with nothing behind it.
 */
const EVM_ASSET = 'eip155:46630/erc20:0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3';
const SOLANA_ASSET =
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr';

function build(input: {
  proposal?: Partial<SlashProposalEntity>;
  parts?: { chainStatus: string }[];
  record?: SlashRecordSnapshot['status'] | null | Error;
}) {
  const proposal = {
    id: 'case-1',
    organizationId: 'org-1',
    providerId: 'org-1',
    chainEpoch: 0,
    chainRequestId: 'r'.repeat(64),
    assetId: EVM_ASSET,
    windowId: 'window-1',
    chainStatus: 'CANCEL_REQUESTED',
    ...input.proposal,
  } as SlashProposalEntity;
  const proposals = {
    tenantOf: jest.fn(async () => 'org-1'),
    findOneScoped: jest.fn(async () => proposal),
  };
  const queue = { brief: jest.fn(async () => ({ chainStatus: proposal.chainStatus })) };
  const approvals = { register: jest.fn() };
  const parts = { findForEpoch: jest.fn(async () => input.parts ?? []) };
  const enrolments = {
    findOneBy: jest.fn(async () => ({
      stakeAuthorityAccountId: 'eip155:46630:0x00000000000000000000000000000000000000aa',
    })),
  };
  const readRecord = jest.fn(async () => {
    if (input.record instanceof Error) throw input.record;
    return input.record ? ({ status: input.record } as SlashRecordSnapshot) : null;
  });
  const service = new OperatorCaseService(
    proposals as never,
    queue as never,
    {} as never,
    {} as never,
    approvals as never,
    parts as never,
    enrolments as never,
    { readRecord } as never,
  );
  return { service, readRecord };
}

describe('OperatorCaseService.brief chainStanding', () => {
  it('false once the chain side is closed', async () => {
    const { service, readRecord } = build({ proposal: { chainStatus: 'CANCELLED' } });
    await expect(service.brief('case-1')).resolves.toMatchObject({ chainStanding: false });
    expect(readRecord).not.toHaveBeenCalled();
  });

  it('a partitioned case stands while a part is Pending or Disputed', async () => {
    const standing = build({
      proposal: { chainStatus: 'PENDING' },
      parts: [{ chainStatus: 'CANCELLED' }, { chainStatus: 'DISPUTED' }],
    });
    await expect(standing.service.brief('case-1')).resolves.toMatchObject({ chainStanding: true });

    const gone = build({
      parts: [{ chainStatus: 'CANCELLED' }, { chainStatus: 'EXECUTED' }],
    });
    await expect(gone.service.brief('case-1')).resolves.toMatchObject({ chainStanding: false });
    expect(gone.readRecord).not.toHaveBeenCalled();
  });

  it('a window case with no parts (opened before parts) reads its own record', async () => {
    const cancelled = build({ record: 'CANCELLED' });
    await expect(cancelled.service.brief('case-1')).resolves.toMatchObject({
      chainStanding: false,
    });
    expect(cancelled.readRecord).toHaveBeenCalledWith(
      'r'.repeat(64),
      '0x00000000000000000000000000000000000000aa',
      'eip155:46630',
    );

    const missing = build({ record: null });
    await expect(missing.service.brief('case-1')).resolves.toMatchObject({ chainStanding: false });

    const pending = build({ record: 'PENDING' });
    await expect(pending.service.brief('case-1')).resolves.toMatchObject({ chainStanding: true });
  });

  it('cannot rule a record out when the chain is unreadable: standing', async () => {
    const { service } = build({ record: new Error('rpc down') });
    await expect(service.brief('case-1')).resolves.toMatchObject({ chainStanding: true });
  });

  it('a single-record case trusts its mirror', async () => {
    const { service, readRecord } = build({
      proposal: { assetId: SOLANA_ASSET, chainStatus: 'PENDING' },
    });
    await expect(service.brief('case-1')).resolves.toMatchObject({ chainStanding: true });
    expect(readRecord).not.toHaveBeenCalled();
  });
});
