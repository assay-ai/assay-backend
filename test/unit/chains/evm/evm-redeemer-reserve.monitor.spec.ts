import { EvmRedeemerReserveMonitor } from '@modules/chains/evm/evm-redeemer-reserve.monitor';

const CHAIN = 'eip155:46630' as never;

function monitor(balance: bigint, spends: bigint[]) {
  let now = 1_800_000_000_000;
  const alerts: { severity: string }[] = [];
  const service = new EvmRedeemerReserveMonitor(
    { balanceWei: async () => balance } as never,
    { emit: async (a: never) => void alerts.push(a) } as never,
    [CHAIN],
    { spentThisHour: async () => spends.shift() ?? 0n },
    () => now,
  );
  return { service, alerts, advance: (ms: number) => (now += ms) };
}

describe('EvmRedeemerReserveMonitor (G6, the monitor half)', () => {
  it('measures the peak sliding hour and reads 2× as the reserve', async () => {
    const h = monitor(500n, [100n, 300n, 50n]);
    await h.service.check(CHAIN);
    await h.service.check(CHAIN);
    const reading = await h.service.check(CHAIN);
    expect(reading).toMatchObject({ peakHourWei: 300n, level: 'LOW' });
    // OK at the first sample (peak 100), LOW from the second on (deduped by the sink).
    expect(h.alerts.map((a) => a.severity)).toEqual(['WARN', 'WARN']);
  });

  it('CRITICAL below one peak hour, OK above two, unmeasured before any spend', async () => {
    expect((await monitor(99n, [100n]).service.check(CHAIN)).level).toBe('CRITICAL');
    expect((await monitor(200n, [100n]).service.check(CHAIN)).level).toBe('OK');
    expect((await monitor(1n, [0n]).service.check(CHAIN)).level).toBe('UNMEASURED');
  });

  it('forgets a peak older than 24 h', async () => {
    const h = monitor(150n, [1_000n, 50n]);
    await h.service.check(CHAIN);
    h.advance(25 * 3_600_000);
    expect((await h.service.check(CHAIN)).peakHourWei).toBe(50n);
  });
});
