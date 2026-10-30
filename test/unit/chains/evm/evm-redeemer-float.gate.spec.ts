import { Logger } from '@nestjs/common';

import { Alert, AlertPort, AlertSeverity } from '@shared/alerting';
import { CacheService } from '@shared/cache/redis-cache/cache.service';
import { AccountId, CHAIN_IDS, ChainId, toAccountId } from '@modules/chains/ports/caip.types';
import {
  REDEEMER_FLOAT_FLAG_TTL_SECONDS,
  REDEEMER_FLOAT_GATE_ALERTS,
  REDEEMER_FLOAT_READ_CACHE_MS,
  RedeemerFloatGate,
  redeemerFloatCriticalKey,
} from '@modules/chains/evm/evm-redeemer-float.gate';
import { parseFloatMarks } from '@modules/chains/evm/evm-relayer-float.constants';
import { EvmRelayerFloatMonitor } from '@modules/chains/evm/evm-relayer-float.monitor';
import { EvmRelayerPort } from '@modules/chains/evm/ports/evm-relayer.port';

const TESTNET = CHAIN_IDS.ROBINHOOD_TESTNET;
const DEVNET = CHAIN_IDS.SOLANA_DEVNET;
const KEY = redeemerFloatCriticalKey(TESTNET);

const LOW_WEI = 10_000_000_000_000_000n;
const CRITICAL_WEI = 2_000_000_000_000_000n;
const PER_GRANT_MAX_WEI = 1_000_000_000_000_000n;
const ADDRESS = '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4';

/** The four commands the gate sends, over a map, with the TTL recorded. */
class FakeRedis {
  readonly values = new Map<string, string>();
  readonly ttls = new Map<string, number>();
  failWith: Error | null = null;
  readonly get = jest.fn(async (key: string) => {
    this.fail();
    return this.values.get(key) ?? null;
  });

  async set(key: string, value: string, _ex: 'EX', ttl: number, _nx: 'NX'): Promise<'OK' | null> {
    this.fail();
    if (this.values.has(key)) return null;
    this.values.set(key, value);
    this.ttls.set(key, ttl);
    return 'OK';
  }

  async expire(key: string, ttl: number): Promise<number> {
    this.fail();
    this.ttls.set(key, ttl);
    return this.values.has(key) ? 1 : 0;
  }

  async del(key: string): Promise<number> {
    this.fail();
    this.ttls.delete(key);
    return this.values.delete(key) ? 1 : 0;
  }

  private fail(): void {
    if (this.failWith) throw this.failWith;
  }
}

describe('RedeemerFloatGate', () => {
  let redis: FakeRedis;
  let alerts: { emit: jest.Mock<Promise<void>, [Alert]> };
  let gate: RedeemerFloatGate;

  beforeEach(() => {
    redis = new FakeRedis();
    alerts = { emit: jest.fn<Promise<void>, [Alert]>().mockResolvedValue(undefined) };
    const cache = { getRedisClient: () => redis } as unknown as CacheService;
    gate = new RedeemerFloatGate(cache, alerts as unknown as AlertPort);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const alertNames = () => alerts.emit.mock.calls.map(([alert]) => alert.name);

  describe('publish (the scheduler)', () => {
    it('sets the flag with a TTL of a few passes and alerts the pause ONCE', async () => {
      await gate.publish(TESTNET, 'CRITICAL');
      await gate.publish(TESTNET, 'CRITICAL');

      expect(redis.values.get(KEY)).toBe('1');
      expect(redis.ttls.get(KEY)).toBe(REDEEMER_FLOAT_FLAG_TTL_SECONDS);
      expect(REDEEMER_FLOAT_FLAG_TTL_SECONDS).toBe(900);
      expect(alertNames()).toEqual([REDEEMER_FLOAT_GATE_ALERTS.PAUSED]);
      expect(alerts.emit.mock.calls[0][0].severity).toBe(AlertSeverity.CRITICAL);
    });

    it('clears the flag on the first pass above critical and alerts the resume ONCE', async () => {
      await gate.publish(TESTNET, 'CRITICAL');
      await gate.publish(TESTNET, 'LOW');
      await gate.publish(TESTNET, 'OK');

      expect(redis.values.has(KEY)).toBe(false);
      expect(alertNames()).toEqual([
        REDEEMER_FLOAT_GATE_ALERTS.PAUSED,
        REDEEMER_FLOAT_GATE_ALERTS.RESUMED,
      ]);
      // WARN, so the Telegram sink's default floor still forwards it.
      expect(alerts.emit.mock.calls[1][0].severity).toBe(AlertSeverity.WARN);
    });

    it('says nothing on a healthy pass when no pause was open', async () => {
      await gate.publish(TESTNET, 'OK');
      expect(alerts.emit).not.toHaveBeenCalled();
    });

    it('leaves the flag to its TTL on a pass that could not read the balance', async () => {
      await gate.publish(TESTNET, 'CRITICAL');
      await gate.publish(TESTNET, 'UNREADABLE');
      await gate.publish(TESTNET, 'NO_RELAYER');
      expect(redis.values.get(KEY)).toBe('1');
      expect(alertNames()).toEqual([REDEEMER_FLOAT_GATE_ALERTS.PAUSED]);
    });

    it('never throws when Redis is down', async () => {
      redis.failWith = new Error('connection refused');
      await expect(gate.publish(TESTNET, 'CRITICAL')).resolves.toBeUndefined();
      expect(alerts.emit).not.toHaveBeenCalled();
    });
  });

  describe('isPaused (the api and mcp replicas)', () => {
    it('is paused while the flag is set, and admits once it clears', async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      redis.values.set(KEY, '1');
      expect(await gate.isPaused(TESTNET)).toBe(true);

      redis.values.delete(KEY);
      now.mockReturnValue(1_000_000 + REDEEMER_FLOAT_READ_CACHE_MS + 1);
      expect(await gate.isPaused(TESTNET)).toBe(false);
    });

    it('fails open on a missing key', async () => {
      expect(await gate.isPaused(TESTNET)).toBe(false);
    });

    it('fails open, with a warning, when Redis errors', async () => {
      redis.failWith = new Error('connection refused');
      expect(await gate.isPaused(TESTNET)).toBe(false);
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.stringContaining('admitting paid calls'),
      );
    });

    it('reads Redis at most once per cache window per chain', async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(2_000_000);
      redis.values.set(KEY, '1');
      for (let index = 0; index < 10; index += 1) {
        expect(await gate.isPaused(TESTNET)).toBe(true);
      }
      expect(redis.get).toHaveBeenCalledTimes(1);

      now.mockReturnValue(2_000_000 + REDEEMER_FLOAT_READ_CACHE_MS + 1);
      await gate.isPaused(TESTNET);
      expect(redis.get).toHaveBeenCalledTimes(2);
    });

    it('never reads Redis for a Solana chain, which has no redeemer float here', async () => {
      expect(await gate.isPaused(DEVNET)).toBe(false);
      expect(redis.get).not.toHaveBeenCalled();
    });
  });

  describe('EvmRelayerFloatMonitor publishes the redeemer reading', () => {
    function port(balance: () => Promise<bigint>): EvmRelayerPort {
      return {
        name: 'fake',
        address: async (chainId: ChainId): Promise<AccountId> => toAccountId(chainId, ADDRESS),
        balanceWei: balance,
        sendCall: async () => {
          throw new Error('the monitor must never send');
        },
        sendValue: async () => {
          throw new Error('the monitor must never send');
        },
      } as unknown as EvmRelayerPort;
    }

    it('sets the flag on a critical redeemer and clears it when the float is back', async () => {
      let redeemerWei = CRITICAL_WEI;
      const monitor = new EvmRelayerFloatMonitor(
        port(async () => LOW_WEI * 10n),
        alerts as unknown as AlertPort,
        [TESTNET],
        parseFloatMarks(LOW_WEI.toString(), CRITICAL_WEI.toString(), PER_GRANT_MAX_WEI.toString()),
        port(async () => redeemerWei),
        gate,
      );

      await monitor.check();
      expect(redis.values.get(KEY)).toBe('1');

      redeemerWei = LOW_WEI * 10n;
      await monitor.check();
      expect(redis.values.has(KEY)).toBe(false);
      expect(alertNames()).toEqual([
        'evm_relayer_float_critical',
        REDEEMER_FLOAT_GATE_ALERTS.PAUSED,
        REDEEMER_FLOAT_GATE_ALERTS.RESUMED,
      ]);
    });

    it('never pauses on the RELAYER float, which no served call depends on', async () => {
      const monitor = new EvmRelayerFloatMonitor(
        port(async () => CRITICAL_WEI),
        alerts as unknown as AlertPort,
        [TESTNET],
        parseFloatMarks(LOW_WEI.toString(), CRITICAL_WEI.toString(), PER_GRANT_MAX_WEI.toString()),
        port(async () => LOW_WEI * 10n),
        gate,
      );

      await monitor.check();
      expect(redis.values.has(KEY)).toBe(false);
    });
  });
});
