import { OVERRIDE_REGISTER } from '@modules/operator/domain/override-register';
import { OperatorChannelDrainService } from '@modules/operator/services/operator-channel-drain.service';

describe('OperatorChannelDrainService (override M-2)', () => {
  it('is registered: money family, one operator, SRE or TRE', () => {
    expect(OVERRIDE_REGISTER['M-2']).toMatchObject({
      action: 'channels.drain_requested',
      approval: 'SINGLE',
      implemented: true,
    });
    expect(OVERRIDE_REGISTER['M-2'].roles).toEqual(expect.arrayContaining(['SRE', 'TRE']));
  });

  it('marks the channels inside the audited override and reports how many', async () => {
    const requestDrain = jest.fn(async () => 3);
    const perform = jest.fn(
      async (context: unknown, mutation: (qr: unknown) => Promise<{ value: unknown }>) =>
        (await mutation({ manager: 'tx' })).value,
    );
    const service = new OperatorChannelDrainService(
      { perform } as never,
      { requestDrain } as never,
    );
    const result = await service.drain(
      { operatorId: 'op', subject: 'op' } as never,
      {
        assetId: 'eip155:46630/erc20:0xabc',
        reasonCode: 'REDEEMER_ROTATION',
        note: 'drain before rotation',
      },
      'req-1',
    );
    expect(result).toEqual({ assetId: 'eip155:46630/erc20:0xabc', channels: 3 });
    expect(perform.mock.calls[0][0]).toMatchObject({
      code: 'M-2',
      targetType: 'channel_drain',
      organizationId: null,
    });
    expect(requestDrain).toHaveBeenCalledWith('tx', 'eip155:46630/erc20:0xabc');
  });
});
