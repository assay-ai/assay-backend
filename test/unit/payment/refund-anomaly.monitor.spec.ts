import {
  loadRefundAnomalyPolicy,
  RefundAnomalyMonitor,
} from '@modules/payment/services/refund-anomaly.monitor';

function monitor(rows: Array<{ held: bigint; refunded: bigint }>) {
  const alerts: { severity: string; name: string }[] = [];
  const payments = {
    refundVolumeByProvider: jest.fn(async () =>
      rows.map((row, i) => ({
        providerId: `p${i}`,
        assetId: 'eip155:46630/erc20:0xabc',
        refunds: 3,
        ...row,
      })),
    ),
  };
  const service = new RefundAnomalyMonitor(
    payments as never,
    { emit: async (a: never) => void alerts.push(a) } as never,
    loadRefundAnomalyPolicy({}),
    () => 1_800_000_000_000,
  );
  return { service, alerts, payments };
}

describe('RefundAnomalyMonitor (SPEC-W2 §7, per provider per hour)', () => {
  it('defaults: more than 20% of what went into hold AND more than $5', () => {
    expect(loadRefundAnomalyPolicy({})).toEqual({ shareBps: 2_000, minAtomic: 5_000_000n });
    expect(() => loadRefundAnomalyPolicy({ REFUND_ANOMALY_SHARE_BPS: '20000' })).toThrow();
  });

  it('pages WARN only when both thresholds are passed', async () => {
    const h = monitor([
      { held: 20_000_000n, refunded: 6_000_000n }, // 30%, $6: paged
      { held: 100_000_000n, refunded: 6_000_000n }, // 6%: not paged
      { held: 1_000_000n, refunded: 4_000_000n }, // $4: not paged
      { held: 0n, refunded: 5_000_001n }, // nothing held, $5.000001 refunded: paged
    ]);
    expect(await h.service.check()).toEqual(['p0', 'p3']);
    expect(h.alerts.map((a) => [a.severity, a.name])).toEqual([
      ['WARN', 'provider_refund_volume_anomaly'],
      ['WARN', 'provider_refund_volume_anomaly'],
    ]);
    expect(h.payments.refundVolumeByProvider).toHaveBeenCalledWith(3_600);
  });
});
