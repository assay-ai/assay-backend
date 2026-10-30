import { Logger } from '@nestjs/common';

import {
  EVM_CLOCK_DRIFT_CRITICAL_ALERT,
  EVM_CLOCK_DRIFT_CRITICAL_SECONDS,
  EvmChainClockMonitor,
  EvmClockClient,
} from '@modules/chains/evm/evm-chain-clock.monitor';
import { EvmRelayerFloatMonitor } from '@modules/chains/evm/evm-relayer-float.monitor';
import { EVM_CLOCK_DRIFT_ALERT } from '@modules/chains/evm/evm-voucher-redeemer.service';
import { CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { Alert, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';

const TESTNET = CHAIN_IDS.ROBINHOOD_TESTNET;
const MAINNET = CHAIN_IDS.ROBINHOOD_MAINNET;
const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;

/**
 * Review 2026-10-23 L-4 (owner request 2026-10-30): the chain clock drift was
 * only logged, on the redemption path. It now pages from the scheduler.
 */
describe('EvmChainClockMonitor', () => {
  let emitted: Alert[];

  beforeEach(() => {
    emitted = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  function monitor(
    blocks: Record<string, number | Error>,
    enabled: readonly ChainId[] = [TESTNET],
    alerts: AlertPort = { emit: async (alert: Alert) => void emitted.push(alert) } as AlertPort,
  ) {
    const clients = new Map<ChainId, EvmClockClient>(
      Object.entries(blocks).map(([chainId, at]) => [
        chainId as ChainId,
        {
          getBlock: jest.fn(async () => {
            if (at instanceof Error) throw at;
            return { timestamp: BigInt(at) };
          }),
        },
      ]),
    );
    const clock = new EvmChainClockMonitor(clients, alerts, enabled);
    clock.now = () => NOW_MS;
    return clock;
  }

  it('says nothing within 120 s either way', async () => {
    for (const drift of [0, 120, -120]) {
      const readings = await monitor({ [TESTNET]: NOW_S + drift }).check();
      expect(readings[0].level).toBe('OK');
    }
    expect(emitted).toEqual([]);
  });

  it('WARNs past 120 s, once per incident, keyed on the chain id', async () => {
    const readings = await monitor({ [TESTNET]: NOW_S - 121 }).check();

    expect(readings).toEqual([{ chainId: TESTNET, driftSeconds: -121, level: 'WARN' }]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      name: EVM_CLOCK_DRIFT_ALERT,
      severity: AlertSeverity.WARN,
      aggregation: AlertAggregation.ONCE_PER_INCIDENT,
      dedupeKey: TESTNET,
      details: expect.objectContaining({ driftSeconds: -121 }),
    });
  });

  it('pages CRITICAL past 600 s, under its own name so an escalation still pages', async () => {
    expect(EVM_CLOCK_DRIFT_CRITICAL_SECONDS).toBe(600);
    await monitor({ [TESTNET]: NOW_S + 600 }).check();
    await monitor({ [TESTNET]: NOW_S + 601 }).check();

    expect(emitted.map((alert) => [alert.name, alert.severity, alert.dedupeKey])).toEqual([
      [EVM_CLOCK_DRIFT_ALERT, AlertSeverity.WARN, TESTNET],
      [EVM_CLOCK_DRIFT_CRITICAL_ALERT, AlertSeverity.CRITICAL, TESTNET],
    ]);
  });

  it('reads every enabled eip155 chain on its own, and no other namespace', async () => {
    const solana = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' as ChainId;
    const readings = await monitor({ [TESTNET]: NOW_S, [MAINNET]: NOW_S + 700 }, [
      TESTNET,
      solana,
      MAINNET,
    ]).check();

    expect(readings.map((reading) => [reading.chainId, reading.level])).toEqual([
      [TESTNET, 'OK'],
      [MAINNET, 'CRITICAL'],
    ]);
    expect(emitted.map((alert) => alert.dedupeKey)).toEqual([MAINNET]);
  });

  it('never throws: an unreadable block is a reading, a dead alert sink is a log line', async () => {
    const down = {
      emit: async () => {
        throw new Error('telegram down');
      },
    } as unknown as AlertPort;
    const readings = await monitor(
      { [TESTNET]: new Error('rpc down'), [MAINNET]: NOW_S + 900 },
      [TESTNET, MAINNET],
      down,
    ).check();

    expect(readings.map((reading) => reading.level)).toEqual(['UNREADABLE', 'CRITICAL']);
  });

  it('runs on the float monitor’s scheduled pass', async () => {
    const clock = { check: jest.fn(async () => []) } as unknown as EvmChainClockMonitor;
    const floats = new EvmRelayerFloatMonitor(
      {} as never,
      { emit: async () => undefined } as AlertPort,
      [],
      null,
      null,
      null,
      clock,
    );

    await floats.handleFloatCheck();

    expect(clock.check).toHaveBeenCalledTimes(1);
  });
});
