import { Logger } from '@nestjs/common';

import { CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import {
  EVM_SLASH_WATCH_ALERTS,
  EVM_SLASH_WATCH_CHUNK,
  EVM_SLASH_WATCH_INITIAL_LOOKBACK,
  EVM_SLASH_WATCH_MAX_BLOCKS,
  EvmSlashProposalWatcher,
  SlashProposedLog,
} from '@modules/chains/evm/evm-slash-proposal.watcher';
import { Alert, AlertSeverity } from '@shared/alerting';

const CHAIN: ChainId = CHAIN_IDS.ROBINHOOD_TESTNET;
const STAKE = '0x00000000000000000000000000000000000000aa' as const;
const AGENT = '0x00000000000000000000000000000000000000b1' as const;
const ATTACKER = '0x00000000000000000000000000000000000000ee' as const;
const KNOWN = 'a'.repeat(64);
const ROGUE = 'f'.repeat(64);

function event(requestId: string, beneficiary: `0x${string}`, penalty: bigint): SlashProposedLog {
  return {
    args: {
      requestId: `0x${requestId}`,
      provider: '0x00000000000000000000000000000000000000c1',
      verifier: '0x00000000000000000000000000000000000000d1',
      beneficiary,
      penalty,
      executableAt: 1_800_000_000n,
    },
    transactionHash: `0x${'1'.repeat(64)}`,
    blockNumber: 100n,
  };
}

function build(options: {
  head: bigint;
  logs?: SlashProposedLog[];
  cursor?: string;
  rulings?: unknown;
  slashHolds?: unknown;
}) {
  const alerts: Alert[] = [];
  const ranges: [bigint, bigint][] = [];
  const store = new Map<string, string>(
    options.cursor ? [[`evm:slash-watch:cursor:${CHAIN}`, options.cursor]] : [],
  );
  const client = {
    getBlockNumber: async () => options.head,
    getContractEvents: async (args: { fromBlock: bigint; toBlock: bigint; address: string }) => {
      expect(args.address).toBe(STAKE);
      ranges.push([args.fromBlock, args.toBlock]);
      return ranges.length === 1 ? (options.logs ?? []) : [];
    },
  };
  const parts = {
    findByChainRequestIds: async (ids: readonly string[]) =>
      ids.includes(KNOWN)
        ? [
            {
              organizationId: 'org-1',
              proposalId: 'case-1',
              chainRequestId: KNOWN,
              beneficiaryAccount: `${CHAIN}:${AGENT}`,
              penaltyAmount: '1000000',
            },
          ]
        : [],
  };
  const redis = {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => store.set(key, value),
  };
  const watcher = new EvmSlashProposalWatcher(
    new Map([[CHAIN, client]]) as never,
    new Map([[CHAIN, { stake: STAKE }]]) as never,
    [CHAIN],
    parts as never,
    { emit: async (alert: Alert) => void alerts.push(alert) },
    redis as never,
    options.rulings ? ({ get: () => options.rulings } as never) : null,
    (options.slashHolds ?? null) as never,
  );
  return { watcher, alerts, ranges, store };
}

describe('EvmSlashProposalWatcher — alerts on slash records this platform did not plan', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('is silent for a record whose part matches', async () => {
    const { watcher, alerts } = build({ head: 500n, logs: [event(KNOWN, AGENT, 1_000_000n)] });
    await expect(watcher.check()).resolves.toEqual([]);
    expect(alerts).toEqual([]);
  });

  it('raises CRITICAL for a request id the database does not know', async () => {
    const { watcher, alerts } = build({ head: 500n, logs: [event(ROGUE, ATTACKER, 1_000_000n)] });
    await expect(watcher.check()).resolves.toEqual([
      { chainId: CHAIN, kind: 'UNKNOWN', requestId: ROGUE },
    ]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: AlertSeverity.CRITICAL,
      name: EVM_SLASH_WATCH_ALERTS.UNKNOWN,
      details: { requestId: `0x${ROGUE}`, beneficiary: ATTACKER },
    });
  });

  it('raises CRITICAL when the beneficiary or the penalty differs from the stored part', async () => {
    const beneficiary = build({ head: 500n, logs: [event(KNOWN, ATTACKER, 1_000_000n)] });
    await beneficiary.watcher.check();
    expect(beneficiary.alerts[0]).toMatchObject({
      severity: AlertSeverity.CRITICAL,
      name: EVM_SLASH_WATCH_ALERTS.MISMATCH,
      details: { storedBeneficiary: `${CHAIN}:${AGENT}`, beneficiary: ATTACKER },
    });

    const penalty = build({ head: 500n, logs: [event(KNOWN, AGENT, 2_000_000n)] });
    await penalty.watcher.check();
    expect(penalty.alerts[0]).toMatchObject({
      name: EVM_SLASH_WATCH_ALERTS.MISMATCH,
      details: { storedPenalty: '1000000', penalty: '2000000' },
    });
  });

  it('reads a bounded range in chunks from the cursor, and advances it', async () => {
    const { watcher, ranges, store } = build({ head: 1_000_000n, cursor: '100' });
    await watcher.check();

    const last = 100n + EVM_SLASH_WATCH_MAX_BLOCKS;
    expect(ranges[0]).toEqual([101n, 100n + EVM_SLASH_WATCH_CHUNK]);
    expect(ranges[ranges.length - 1][1]).toBe(last);
    expect(ranges).toHaveLength(Number(EVM_SLASH_WATCH_MAX_BLOCKS / EVM_SLASH_WATCH_CHUNK));
    expect(store.get(`evm:slash-watch:cursor:${CHAIN}`)).toBe(last.toString());
  });

  it('starts a chain with no cursor a bounded distance behind the head', async () => {
    const { watcher, ranges } = build({ head: 50_000n });
    await watcher.check();
    expect(ranges[0][0]).toBe(50_000n - EVM_SLASH_WATCH_INITIAL_LOOKBACK);
  });

  it('warns, keeps the cursor and does not throw when the chain cannot be read', async () => {
    const { watcher, alerts, store } = build({ head: 500n, cursor: '10' });
    (watcher as unknown as { clients: Map<ChainId, unknown> }).clients.set(CHAIN, {
      getBlockNumber: async () => {
        throw new Error('rpc down');
      },
    });
    await expect(watcher.check()).resolves.toEqual([]);
    expect(alerts[0]).toMatchObject({
      severity: AlertSeverity.WARN,
      name: EVM_SLASH_WATCH_ALERTS.UNREADABLE,
    });
    expect(store.get(`evm:slash-watch:cursor:${CHAIN}`)).toBe('10');
  });

  describe('the dispute upgrade (D-19)', () => {
    const disputedLog = (requestId: string): SlashProposedLog => ({
      eventName: 'SlashDisputed',
      args: {
        requestId: `0x${requestId}`,
        provider: '0x00000000000000000000000000000000000000c1',
        disputedAt: 1_799_000_000n,
        executableAt: 1_800_000_000n,
      },
      transactionHash: `0x${'2'.repeat(64)}`,
      blockNumber: 101n,
    });
    const upheldLog = (requestId: string): SlashProposedLog => ({
      eventName: 'SlashUpheld',
      args: {
        requestId: `0x${requestId}`,
        provider: '0x00000000000000000000000000000000000000c1',
        arbiter: '0x00000000000000000000000000000000000000a5',
        executableAt: 1_800_000_000n,
      },
      transactionHash: `0x${'3'.repeat(64)}`,
      blockNumber: 102n,
    });

    it("hands a dispute and an uphold to the slash domain with the chain's own clocks", async () => {
      const seen: unknown[] = [];
      const rulings = {
        recordDisputed: async (event: unknown) => (seen.push(event), true),
        recordUpheld: async (event: unknown) => (seen.push(event), true),
      };
      const { watcher, alerts } = build({
        head: 500n,
        logs: [disputedLog(KNOWN), upheldLog(KNOWN)],
        rulings,
      });
      await expect(watcher.check()).resolves.toEqual([]);
      expect(alerts).toEqual([]);
      expect(seen).toEqual([
        expect.objectContaining({
          requestId: KNOWN,
          disputedAt: new Date(1_799_000_000_000),
          executableAt: new Date(1_800_000_000_000),
        }),
        expect.objectContaining({ requestId: KNOWN, executableAt: new Date(1_800_000_000_000) }),
      ]);
    });

    it('warns on a dispute of a record nobody planned', async () => {
      const rulings = { recordDisputed: async () => false, recordUpheld: async () => false };
      const { watcher, alerts } = build({ head: 500n, logs: [disputedLog(ROGUE)], rulings });
      await watcher.check();
      expect(alerts).toEqual([
        expect.objectContaining({
          severity: AlertSeverity.WARN,
          name: EVM_SLASH_WATCH_ALERTS.UNKNOWN_RULING,
        }),
      ]);
    });

    it('AUDIT E-6: hands an arbiter cancel (SlashCancelled) to the slash domain, by reason name', async () => {
      const seen: unknown[] = [];
      const rulings = {
        recordDisputed: async () => true,
        recordUpheld: async () => true,
        recordCancelled: async (event: unknown) => (seen.push(event), true),
      };
      const { watcher, alerts } = build({
        head: 500n,
        logs: [
          {
            eventName: 'SlashCancelled',
            args: { requestId: `0x${KNOWN}`, reason: 0, cancelledAt: 1_801_000_000n },
            transactionHash: `0x${'4'.repeat(64)}`,
            blockNumber: 103n,
          },
        ],
        rulings,
      });
      await watcher.check();
      expect(alerts).toEqual([]);
      expect(seen).toEqual([
        expect.objectContaining({
          requestId: KNOWN,
          reason: 'WITHDRAWN',
          cancelledAt: new Date(1_801_000_000_000),
        }),
      ]);
    });

    it('re-checks the slash hold of each provider whose record an event touched', async () => {
      const rechecked: string[] = [];
      const { watcher } = build({
        head: 500n,
        logs: [disputedLog(KNOWN)],
        rulings: { recordDisputed: async () => true, recordUpheld: async () => true },
        slashHolds: {
          recheckAuthority: async (_chain: string, provider: string) =>
            void rechecked.push(provider),
        },
      });
      await watcher.check();
      expect(rechecked).toEqual(['0x00000000000000000000000000000000000000c1']);
    });

    it('BUG-R13-D-03: hands an execution sent by anybody (SlashExecuted) to the slash domain', async () => {
      const seen: unknown[] = [];
      const rulings = {
        recordDisputed: async () => true,
        recordUpheld: async () => true,
        recordCancelled: async () => true,
        recordExecuted: async (event: unknown) => (seen.push(event), true),
      };
      const { watcher, alerts } = build({
        head: 500n,
        logs: [
          {
            eventName: 'SlashExecuted',
            args: {
              requestId: `0x${KNOWN}`,
              provider: '0x00000000000000000000000000000000000000c1',
              applied: 500_000n,
              agentAmount: 300_000n,
              platformAmount: 150_000n,
              executedAt: 1_801_000_000n,
            },
            transactionHash: `0x${'5'.repeat(64)}`,
            blockNumber: 104n,
          },
        ],
        rulings,
      });
      await watcher.check();
      expect(alerts).toEqual([]);
      expect(seen).toEqual([
        {
          chainId: CHAIN,
          requestId: KNOWN,
          appliedMinor: '500000',
          agentAmountMinor: '300000',
          platformAmountMinor: '150000',
          executedAt: new Date(1_801_000_000_000),
          transactionHash: `0x${'5'.repeat(64)}`,
        },
      ]);
    });

    it('does not advance the cursor when the mirror fails, so the range is re-read', async () => {
      const rulings = {
        recordDisputed: async () => {
          throw new Error('db down');
        },
        recordUpheld: async () => true,
      };
      const { watcher, store } = build({ head: 500n, logs: [disputedLog(KNOWN)], rulings });
      await watcher.check();
      expect(store.has(`evm:slash-watch:cursor:${CHAIN}`)).toBe(false);
    });
  });
});
