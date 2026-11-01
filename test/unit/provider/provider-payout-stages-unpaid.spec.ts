import { DEFAULT_CHANNEL_POLICY } from '@modules/payment/domain/channel/channel-policy';
import { ProviderPayoutStagesService } from '@modules/provider/services/provider-payout-stages.service';

const A = 'eip155:46630/erc20:0x7e99c98e066032b2ef5768ff18ed090e1ab921ac';
const B = 'eip155:46630/erc20:0x1111111111111111111111111111111111111111';

/**
 * Frontend L-6: an unpaid (issuer-blocked) payout is never hidden by the
 * asset the page reads — listed per asset, every asset.
 */
describe('ProviderPayoutStagesService — unpaid payouts per asset (L-6)', () => {
  function service(
    unpaid: Array<{ assetId: string; amount: bigint; since: Date | null }>,
    assets: string[] = [],
  ) {
    const channels = {
      providerStages: async () => ({
        awaiting: { amount: 0n, calls: 0, oldest: null },
        inHold: { amount: 0n, calls: 0, endsAt: null },
        ready: { amount: 0n, calls: 0 },
        assets,
        doors: {
          perCall: { ready: 0n, oldestReadyAt: null, holdEndsAt: null },
          channel: { ready: 0n, holdEndsAt: null, active: false },
        },
      }),
      cadenceOf: async () => new Map(),
      unpaidOf: async (_p: string, asset: string | null) => {
        const rows = unpaid.filter((row) => asset === null || row.assetId === asset);
        return {
          amount: rows.reduce((sum, row) => sum + row.amount, 0n),
          since: rows[0]?.since ?? null,
        };
      },
      unpaidByAsset: async () => unpaid,
    };
    return new ProviderPayoutStagesService(channels as never, DEFAULT_CHANNEL_POLICY, () => 0);
  }

  it('lists every asset with unpaid, whatever asset was asked for', async () => {
    const since = new Date('2026-11-01T00:00:00Z');
    const view = await service([
      { assetId: A, amount: 1_000_000n, since },
      { assetId: B, amount: 2_000_000n, since: null },
    ]).stages('p', A);
    expect(view.unpaid).toEqual({ amount: '1000000', asset: A, decimals: expect.any(Number) });
    expect(
      view.unpaidByAsset.map((row) => [row.amount.asset, row.amount.amount, row.since]),
    ).toEqual([
      [A, '1000000', since.toISOString()],
      [B, '2000000', null],
    ]);
  });

  it('unpaid on one asset with none named and no channel asset: that asset, not a hidden null', async () => {
    const view = await service([{ assetId: B, amount: 5n, since: null }]).stages('p', null);
    expect(view.unpaid?.asset).toBe(B);
    expect(view.unpaid?.amount).toBe('5');
  });

  it('nothing unpaid: null and an empty list', async () => {
    const view = await service([]).stages('p', null);
    expect(view.unpaid).toBeNull();
    expect(view.unpaidByAsset).toEqual([]);
  });
});
