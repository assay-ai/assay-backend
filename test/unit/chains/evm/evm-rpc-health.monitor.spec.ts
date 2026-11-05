import { EvmRpcHealthMonitor } from '@modules/chains/evm/evm-rpc-health.monitor';
import { AlertSeverity } from '@shared/alerting';

const CHAIN = 'eip155:4663' as never;
const NOW = 10_000_000;

function run(endpoints: { failingForMs: number | null; host: string }[], emit = jest.fn()) {
  const monitor = new EvmRpcHealthMonitor(
    new Map([
      [
        CHAIN,
        {
          rpcHealth: () =>
            endpoints.map(({ host, failingForMs }) => ({
              host,
              failingSince: failingForMs === null ? null : NOW - failingForMs,
              lastFailure: failingForMs === null ? null : 'HTTP 403',
            })),
        },
      ],
    ]),
    { emit } as never,
  );
  monitor.now = () => NOW;
  return monitor.check().then(() => emit);
}

describe('EvmRpcHealthMonitor', () => {
  it('stays quiet while every endpoint answers, and on a short failure', async () => {
    const emit = await run([
      { host: 'a.test', failingForMs: 299_000 },
      { host: 'b.test', failingForMs: null },
    ]);
    expect(emit).not.toHaveBeenCalled();
  });

  it('pages WARN when one endpoint has failed for five minutes, per host', async () => {
    const emit = await run([
      { host: 'a.test', failingForMs: 300_000 },
      { host: 'b.test', failingForMs: null },
    ]);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({
      severity: AlertSeverity.WARN,
      name: 'evm_rpc_endpoint_failing',
      dedupeKey: 'eip155:4663:a.test',
    });
  });

  it('pages CRITICAL, once, when every endpoint has failed for a minute', async () => {
    const emit = await run([
      { host: 'a.test', failingForMs: 600_000 },
      { host: 'b.test', failingForMs: 60_000 },
    ]);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({
      severity: AlertSeverity.CRITICAL,
      name: 'evm_rpc_all_failing',
      dedupeKey: 'eip155:4663',
    });
  });

  it('never throws when the alert sink is down', async () => {
    const emit = jest.fn(async () => {
      throw new Error('sink down');
    });
    await expect(run([{ host: 'a.test', failingForMs: 600_000 }], emit)).resolves.toBe(emit);
  });

  it('skips a client without a health report', async () => {
    const emit = jest.fn();
    const monitor = new EvmRpcHealthMonitor(new Map([[CHAIN, {}]]), { emit } as never);
    await monitor.check();
    expect(emit).not.toHaveBeenCalled();
  });
});
