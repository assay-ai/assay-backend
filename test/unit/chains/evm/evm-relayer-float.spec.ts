import { Logger } from '@nestjs/common';

import { Alert, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';
import { AccountId, CHAIN_IDS, ChainId, toAccountId } from '@modules/chains/ports/caip.types';
import {
  EVM_GAS_GRANT_MAX_WEI_ENV,
  EVM_RELAYER_FLOAT_LOW_WATER_ENV,
} from '@modules/chains/evm/evm-gas-grant.service';
import {
  EVM_RELAYER_FLOAT_ALERTS,
  EVM_RELAYER_FLOAT_CRITICAL_WEI,
  EVM_RELAYER_FLOAT_LOW_WEI,
  parseFloatMarks,
} from '@modules/chains/evm/evm-relayer-float.constants';
import { EvmRelayerFloatMonitor } from '@modules/chains/evm/evm-relayer-float.monitor';
import {
  EvmRelayResult,
  EvmRelayedCall,
  EvmRelayerPort,
  EvmValueTransfer,
} from '@modules/chains/evm/ports/evm-relayer.port';

const TESTNET = CHAIN_IDS.ROBINHOOD_TESTNET;
const MAINNET = CHAIN_IDS.ROBINHOOD_MAINNET;
const DEVNET = CHAIN_IDS.SOLANA_DEVNET;

/** 0.05 ETH — the deploy runbook's target float (assay-evm). */
const LOW_WEI = 10_000_000_000_000_000n; // 0.01 ETH
const CRITICAL_WEI = 2_000_000_000_000_000n; // 0.002 ETH
const PER_GRANT_MAX_WEI = 1_000_000_000_000_000n; // 0.001 ETH

const RELAYER_ADDRESS = '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4';

class FakeRelayer implements EvmRelayerPort {
  readonly name = 'fake-relayer';
  readonly balanceWei = jest.fn<Promise<bigint>, [ChainId]>();
  readonly addressFor = jest.fn<Promise<AccountId>, [ChainId]>();

  async address(chainId: ChainId): Promise<AccountId> {
    return this.addressFor(chainId);
  }

  async sendCall(_call: EvmRelayedCall): Promise<EvmRelayResult> {
    throw new Error('the monitor must never send');
  }

  async sendValue(_transfer: EvmValueTransfer): Promise<EvmRelayResult> {
    throw new Error('the monitor must never send');
  }
}

interface BuildOptions {
  readonly lowWei?: string;
  readonly criticalWei?: string;
  readonly perGrantMaxWei?: string;
  readonly enabled?: readonly ChainId[];
}

describe('EvmRelayerFloatMonitor', () => {
  let relayer: FakeRelayer;
  let alerts: { emit: jest.Mock<Promise<void>, [Alert]> };

  function buildMonitor(options: BuildOptions = {}): EvmRelayerFloatMonitor {
    const marks = parseFloatMarks(
      'lowWei' in options ? options.lowWei : LOW_WEI.toString(),
      'criticalWei' in options ? options.criticalWei : CRITICAL_WEI.toString(),
      'perGrantMaxWei' in options ? options.perGrantMaxWei : PER_GRANT_MAX_WEI.toString(),
    );
    return new EvmRelayerFloatMonitor(
      relayer,
      alerts as unknown as AlertPort,
      options.enabled ?? [TESTNET],
      marks,
    );
  }

  beforeEach(() => {
    relayer = new FakeRelayer();
    relayer.addressFor.mockImplementation(async (chainId) => toAccountId(chainId, RELAYER_ADDRESS));
    alerts = { emit: jest.fn<Promise<void>, [Alert]>().mockResolvedValue(undefined) };
  });

  it('is silent above the low mark', async () => {
    relayer.balanceWei.mockResolvedValue(LOW_WEI * 2n);
    const [reading] = await buildMonitor().check();
    expect(reading.level).toBe('OK');
    expect(alerts.emit).not.toHaveBeenCalled();
  });

  it('warns at or below the low mark, ONCE per incident, with the numbers in the alert', async () => {
    relayer.balanceWei.mockResolvedValue(LOW_WEI);
    const monitor = buildMonitor();
    await monitor.check();
    await monitor.check();
    expect(alerts.emit).toHaveBeenCalledTimes(2); // the port is called every pass…
    expect(alerts.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: EVM_RELAYER_FLOAT_ALERTS.LOW,
        severity: AlertSeverity.WARN,
        // …and the SINK suppresses. `AlertPort` call sites are all "this is still true"
        // loops, so the aggregation is the alert's property, never the caller's counter.
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: 'eip155:46630',
        details: expect.objectContaining({
          chainId: 'eip155:46630',
          relayer: expect.stringContaining('eip155:46630:'),
          balanceWei: expect.any(String),
          lowMarkWei: expect.any(String),
          withdrawsRemaining: expect.any(Number),
        }),
      }),
    );
  });

  it('pages at or below the critical mark, and says what stops', async () => {
    relayer.balanceWei.mockResolvedValue(CRITICAL_WEI);
    await buildMonitor().check();
    expect(alerts.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: EVM_RELAYER_FLOAT_ALERTS.CRITICAL,
        severity: AlertSeverity.CRITICAL,
      }),
    );
    const [alert] = alerts.emit.mock.calls[0];
    // "what stops" is the decision the person paged has to make. Redemption first —
    // calls already served that cannot be collected — then the gas grant.
    expect(alert.details.stops).toContain('redemption');
    expect(alert.details.stops).toContain('gas grant');
  });

  it('treats an unreadable balance as UNREADABLE, never as healthy', async () => {
    // A monitor that swallows an RPC error goes quiet exactly when the chain is
    // unhealthy — the same argument RECONCILIATION_BLIND makes, one balance at a time.
    relayer.balanceWei.mockRejectedValue(new Error('ECONNRESET'));
    const [reading] = await buildMonitor().check();
    expect(reading.level).toBe('UNREADABLE');
    expect(reading.wei).toBeNull();
    expect(alerts.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: EVM_RELAYER_FLOAT_ALERTS.UNREADABLE,
        severity: AlertSeverity.WARN,
      }),
    );
  });

  it('reads every enabled eip155 chain separately and NEVER sums them', async () => {
    relayer.balanceWei.mockResolvedValue(LOW_WEI * 2n);
    const readings = await buildMonitor({ enabled: [TESTNET, MAINNET] }).check();
    expect(readings.map((r) => r.chainId)).toEqual(['eip155:46630', 'eip155:4663']);
    expect(relayer.balanceWei.mock.calls).toEqual([['eip155:46630'], ['eip155:4663']]);
  });

  it('reads NO chain when no eip155 chain is enabled', async () => {
    await buildMonitor({ enabled: [DEVNET] }).check();
    expect(relayer.balanceWei).not.toHaveBeenCalled();
    expect(alerts.emit).not.toHaveBeenCalled();
  });

  it('refuses to boot when either mark is unset', () => {
    // An unset cap is a boot failure, not an unlimited faucet — the gas grant's rule, and
    // the same number is at stake here.
    expect(() => buildMonitor({ lowWei: undefined })).toThrow(/EVM_RELAYER_FLOAT_LOW_WEI/);
    expect(() => buildMonitor({ criticalWei: undefined })).toThrow(
      /EVM_RELAYER_FLOAT_CRITICAL_WEI/,
    );
  });

  it('refuses to boot when critical is not strictly below low', () => {
    expect(() => buildMonitor({ lowWei: '1', criticalWei: '2' })).toThrow(/must be below/);
    expect(() => buildMonitor({ lowWei: '1', criticalWei: '1' })).toThrow(/must be below/);
  });

  it('the grant and the monitor read the SAME mark', () => {
    // A structural assertion on purpose. Two config keys with the same meaning drift, and
    // this drift is invisible: the grant keeps paying below a level nobody watches.
    expect(EVM_RELAYER_FLOAT_LOW_WATER_ENV).toBe(EVM_RELAYER_FLOAT_LOW_WEI);
    expect(EVM_RELAYER_FLOAT_CRITICAL_WEI).not.toBe(EVM_RELAYER_FLOAT_LOW_WEI);
  });

  it('counts withdrawsRemaining against the grant cap, so it can never over-report', () => {
    // `withdrawsRemaining` is the number an operator acts on; `balanceWei` is not. It is
    // floored against EVM_RELAYER_GAS_GRANT_MAX_WEI — the ceiling the grant itself refuses
    // above — so the figure is a guarantee rather than an average.
    expect(EVM_GAS_GRANT_MAX_WEI_ENV).toBe('EVM_RELAYER_GAS_GRANT_MAX_WEI');
  });

  it('reports withdrawsRemaining as the floor of balance over the per-grant cap', async () => {
    relayer.balanceWei.mockResolvedValue(PER_GRANT_MAX_WEI * 3n + 1n);
    await buildMonitor().check();
    const [alert] = alerts.emit.mock.calls[0];
    expect(alert.details.withdrawsRemaining).toBe(3);
  });
  it('answers NO_RELAYER rather than UNREADABLE when this process holds no key for the chain', async () => {
    // The two are opposite incidents and used to be one alert. An unreadable
    // balance sends the person paged to the RPC node; a missing key sends them
    // to the deployment's configuration. Measured live on a keyless scheduler:
    // it paged "the float could not be read", which is the wrong one.
    relayer.addressFor.mockRejectedValue(new Error('no relayer key for eip155:46630'));
    relayer.balanceWei.mockResolvedValue(LOW_WEI * 2n);

    const [reading] = await buildMonitor().check();

    expect(reading.level).toBe('NO_RELAYER');
    expect(reading.address).toBeNull();
    expect(reading.wei).toBeNull();
    // The read is SKIPPED, not attempted and swallowed: `balanceWei` needs the
    // account `address` just failed to produce, so asking could only fail —
    // into the branch that reports the wrong incident.
    expect(relayer.balanceWei).not.toHaveBeenCalled();
    expect(alerts.emit).toHaveBeenCalledTimes(1);
    expect(alerts.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: EVM_RELAYER_FLOAT_ALERTS.NO_RELAYER,
        severity: AlertSeverity.WARN,
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: 'eip155:46630',
        details: expect.objectContaining({ chainId: 'eip155:46630', variable: 'EVM_RELAYER_KEYS' }),
      }),
    );
    // The control the assertion above is worth nothing without: the ONLY thing
    // that changed is which call fails, and the alert name changes with it.
    const [noRelayer] = alerts.emit.mock.calls[0];
    expect(noRelayer.name).not.toBe(EVM_RELAYER_FLOAT_ALERTS.UNREADABLE);
  });

  it('still says UNREADABLE when the key is there and the NODE is what failed', async () => {
    relayer.addressFor.mockResolvedValue(toAccountId(TESTNET, RELAYER_ADDRESS));
    relayer.balanceWei.mockRejectedValue(new Error('ECONNRESET'));

    const [reading] = await buildMonitor().check();

    expect(reading.level).toBe('UNREADABLE');
    expect(alerts.emit).toHaveBeenCalledWith(
      expect.objectContaining({ name: EVM_RELAYER_FLOAT_ALERTS.UNREADABLE }),
    );
  });

  it('logs one line per cron pass even when the float is healthy and nothing alerts', async () => {
    // Without this the most common path emits NOTHING, and the log of a working
    // monitor is byte-identical to the log of a scheduler whose cron was never
    // registered or whose process died. "No alert fired" would then be evidence
    // of nothing.
    const lines: string[] = [];
    const spy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation((message: unknown) => void lines.push(String(message)));
    try {
      // Comfortably above the low mark, so this pass alerts about nothing.
      const healthy = PER_GRANT_MAX_WEI * 20n;
      relayer.balanceWei.mockResolvedValue(healthy);
      await buildMonitor().handleFloatCheck();

      expect(alerts.emit).not.toHaveBeenCalled();
      const heartbeat = lines.find((line) => line.startsWith('relayer float pass:'));
      expect(heartbeat).toContain('eip155:46630=OK');
      expect(heartbeat).toContain(`${healthy} wei`);
      expect(heartbeat).toContain('20 withdraws left');
    } finally {
      spy.mockRestore();
    }
  });

  it('says so on a pass that read nothing, rather than logging nothing', async () => {
    const lines: string[] = [];
    const spy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation((message: unknown) => void lines.push(String(message)));
    try {
      await buildMonitor({ enabled: [DEVNET] }).handleFloatCheck();
      expect(lines.some((line) => line.includes('no eip155 chain is enabled'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
