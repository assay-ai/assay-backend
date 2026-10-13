import { AdjudicationQueueService } from '@modules/operator/services/adjudication-queue.service';
import { ChainProposalStatus } from '@modules/slash/domain/chain-slash-outcome';
import { SlashProposalStatus } from '@modules/slash/domain/slash-proposal-state';

/**
 * The console offers "cancel the judgement on chain" from the brief alone, and
 * `cancel-intent` is guarded on `chain_status`, which is not the case status:
 * an overturned case waiting for the settlement admin reads `OVERTURNED`.
 */
describe('AdjudicationQueueService.brief', () => {
  function build(chainStatus: ChainProposalStatus | null, chainExecutableAt: Date | null = null) {
    const proposals = {
      findOneScoped: jest
        .fn()
        .mockResolvedValue(chainStatus === null ? null : { chainStatus, chainExecutableAt }),
    };
    const cases = {
      buildCase: jest.fn().mockResolvedValue({
        proposal: { id: 'p1', status: SlashProposalStatus.OVERTURNED, disputeId: null },
      }),
      timeline: jest.fn().mockResolvedValue([]),
      restoration: jest.fn().mockResolvedValue(null),
    };
    const service = new AdjudicationQueueService(
      proposals as never,
      { findOneBy: jest.fn() } as never,
      {} as never,
      {} as never,
      cases as never,
    );
    return { service, proposals };
  }

  it('carries the on-chain record status next to the case', async () => {
    const { service, proposals } = build(ChainProposalStatus.CANCEL_REQUESTED);

    const brief = await service.brief('org_1', 'p1');

    expect(brief.chainStatus).toBe('CANCEL_REQUESTED');
    expect(brief.case.proposal.status).toBe('OVERTURNED');
    expect(proposals.findOneScoped).toHaveBeenCalledWith('org_1', 'p1');
  });

  it('reports NONE when the row cannot be read', async () => {
    const { service } = build(null);

    expect((await service.brief('org_1', 'p1')).chainStatus).toBe('NONE');
  });

  /**
   * The cancel has a deadline: from this moment the record is anyone's to
   * execute, so the console has to be able to say when.
   */
  it('carries the moment the on-chain record becomes executable', async () => {
    const executableAt = new Date('2026-10-17T09:15:00Z');
    const { service } = build(ChainProposalStatus.CANCEL_REQUESTED, executableAt);

    expect((await service.brief('org_1', 'p1')).chainExecutableAt).toEqual(executableAt);
  });

  it('reports no deadline when nothing stands on chain or the row cannot be read', async () => {
    expect(
      (await build(ChainProposalStatus.NONE).service.brief('org_1', 'p1')).chainExecutableAt,
    ).toBeNull();
    expect((await build(null).service.brief('org_1', 'p1')).chainExecutableAt).toBeNull();
  });
});
