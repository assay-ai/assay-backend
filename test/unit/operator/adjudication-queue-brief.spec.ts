import { AdjudicationQueueService } from '@modules/operator/services/adjudication-queue.service';
import { ChainProposalStatus } from '@modules/slash/domain/chain-slash-outcome';
import { SlashProposalStatus } from '@modules/slash/domain/slash-proposal-state';

/**
 * The console offers "cancel the judgement on chain" from the brief alone, and
 * `cancel-intent` is guarded on `chain_status`, which is not the case status:
 * an overturned case waiting for the settlement admin reads `OVERTURNED`.
 */
describe('AdjudicationQueueService.brief', () => {
  function build(chainStatus: ChainProposalStatus | null) {
    const proposals = {
      findOneScoped: jest.fn().mockResolvedValue(chainStatus === null ? null : { chainStatus }),
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
});
