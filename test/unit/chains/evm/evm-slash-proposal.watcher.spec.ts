import { Logger } from '@nestjs/common';

import { CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { DEFAULT_EVM_CHAIN_STATE_CONFIRMATIONS } from '@modules/chains/evm/chain-state/evm-chain-state.indexer';
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
    eventName: 'SlashProposed',
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
  disputeUpgradeBlock?: bigint;
  knownStatus?: string;
  indexer?: { fromBlock: ReadonlyMap<ChainId, bigint>; confirmations?: number };
  records?: unknown;
}) {
  const alerts: Alert[] = [];
  const ranges: [bigint, bigint][] = [];
  // The durable cursor (review S-4).
  const db = new Map<string, bigint>(options.cursor ? [[CHAIN, BigInt(options.cursor)]] : []);
  const cursors = {
    findSlashWatchCursor: async (chainId: string) => db.get(chainId) ?? null,
    saveSlashWatchCursor: async (chainId: string, block: bigint) => void db.set(chainId, block),
  };
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
              chainStatus: options.knownStatus ?? 'PENDING',
            },
          ]
        : [],
  };
  const watcher = new EvmSlashProposalWatcher(
    new Map([[CHAIN, client]]) as never,
    new Map([[CHAIN, { stake: STAKE, disputeUpgradeBlock: options.disputeUpgradeBlock }]]) as never,
    [CHAIN],
    parts as never,
    { emit: async (alert: Alert) => void alerts.push(alert) },
    cursors as never,
    options.rulings ? ({ get: () => options.rulings } as never) : null,
    (options.slashHolds ?? null) as never,
    options.indexer ?? null,
    (options.records ?? null) as never,
  );
  return { watcher, alerts, ranges, cursor: () => db.get(CHAIN)?.toString() };
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
    const { watcher, ranges, cursor } = build({ head: 1_000_000n, cursor: '100' });
    await watcher.check();

    const last = 100n + EVM_SLASH_WATCH_MAX_BLOCKS;
    expect(ranges[0]).toEqual([101n, 100n + EVM_SLASH_WATCH_CHUNK]);
    expect(ranges[ranges.length - 1][1]).toBe(last);
    expect(ranges).toHaveLength(Number(EVM_SLASH_WATCH_MAX_BLOCKS / EVM_SLASH_WATCH_CHUNK));
    // Durable, in Postgres.
    expect(cursor()).toBe(last.toString());
  });

  it('S-4: stops the confirmation depth behind the head', async () => {
    const confirmations = BigInt(DEFAULT_EVM_CHAIN_STATE_CONFIRMATIONS);
    const { watcher, ranges, cursor } = build({ head: 200n, cursor: '100' });
    await watcher.check();
    expect(ranges).toEqual([[101n, 200n - confirmations]]);
    expect(cursor()).toBe((200n - confirmations).toString());

    const configured = build({
      head: 200n,
      cursor: '100',
      indexer: { fromBlock: new Map(), confirmations: 50 },
    });
    await configured.watcher.check();
    expect(configured.ranges).toEqual([[101n, 150n]]);
  });

  it('S-4: reads nothing while the cursor is within the confirmation depth', async () => {
    const { watcher, ranges, cursor } = build({ head: 110n, cursor: '100' });
    await watcher.check();
    expect(ranges).toEqual([]);
    expect(cursor()).toBe('100');
  });

  it('S-4: a chain with no cursor starts at the known start block, not a fixed lookback', async () => {
    const upgrade = build({ head: 50_000n, disputeUpgradeBlock: 1_000n });
    await upgrade.watcher.check();
    expect(upgrade.ranges[0][0]).toBe(1_000n);

    const configured = build({
      head: 50_000n,
      disputeUpgradeBlock: 1_000n,
      indexer: { fromBlock: new Map([[CHAIN, 2_000n]]) },
    });
    await configured.watcher.check();
    expect(configured.ranges[0][0]).toBe(2_000n);
  });

  it('starts a chain with no cursor and no known start a bounded distance behind the safe head', async () => {
    const { watcher, ranges } = build({ head: 50_000n });
    await watcher.check();
    expect(ranges[0][0]).toBe(
      50_000n - BigInt(DEFAULT_EVM_CHAIN_STATE_CONFIRMATIONS) - EVM_SLASH_WATCH_INITIAL_LOOKBACK,
    );
  });

  it('S-5: hands a late SlashProposed of a given-up part to the slash domain, silently', async () => {
    const seen: unknown[] = [];
    const rulings = { recordLateProposal: async (event: unknown) => (seen.push(event), true) };
    const { watcher, alerts } = build({
      head: 500n,
      logs: [event(KNOWN, AGENT, 1_000_000n)],
      knownStatus: 'REFUSED',
      rulings,
    });
    await expect(watcher.check()).resolves.toEqual([]);
    expect(alerts).toEqual([]);
    expect(seen).toEqual([
      expect.objectContaining({ requestId: KNOWN, executableAt: new Date(1_800_000_000_000) }),
    ]);

    // A part that already stands is not handed over.
    const standing = build({ head: 500n, logs: [event(KNOWN, AGENT, 1_000_000n)], rulings });
    await standing.watcher.check();
    expect(seen).toHaveLength(1);
  });

  it('warns, keeps the cursor and does not throw when the chain cannot be read', async () => {
    const { watcher, alerts, cursor } = build({ head: 500n, cursor: '10' });
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
    expect(cursor()).toBe('10');
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
      const { watcher, cursor } = build({ head: 500n, logs: [disputedLog(KNOWN)], rulings });
      await watcher.check();
      expect(cursor()).toBeUndefined();
    });
  });
});

describe('EvmSlashProposalWatcher — remembers every record (review 2026-10-24 wave 2 M-2)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('stores ours and the foreign ones, flagged, and closes what the range cancelled or executed', async () => {
    const proposed: unknown[] = [];
    const closed: [string, string[], Date][] = [];
    const records = {
      recordProposed: async (rows: unknown[]) => void proposed.push(...rows),
      markClosed: async (chainId: string, ids: string[], at: Date) =>
        void closed.push([chainId, ids, at]),
    };
    const cancelled: SlashProposedLog = {
      eventName: 'SlashCancelled',
      args: { requestId: `0x${'b'.repeat(64)}`, reason: 2, cancelledAt: 1_800_000_100n },
      transactionHash: null,
      blockNumber: 101n,
    };
    const { watcher, cursor } = build({
      head: 500n,
      logs: [
        {
          ...event(KNOWN, AGENT, 1_000_000n),
          args: { ...event(KNOWN, AGENT, 1_000_000n).args, reserved: 900_000n },
        },
        event(ROGUE, ATTACKER, 1_000_000n),
        cancelled,
      ],
      records,
    });
    await watcher.check();

    expect(proposed).toEqual([
      expect.objectContaining({
        chainId: CHAIN,
        requestId: KNOWN,
        provider: '0x00000000000000000000000000000000000000c1',
        verifier: '0x00000000000000000000000000000000000000d1',
        reserved: 900_000n,
        foreign: false,
      }),
      expect.objectContaining({ requestId: ROGUE, reserved: 1_000_000n, foreign: true }),
    ]);
    expect(closed).toEqual([[CHAIN, ['b'.repeat(64)], new Date(1_800_000_100_000)]]);
    expect(cursor()).toBeDefined();
  });

  it('does not move the cursor when the records cannot be written', async () => {
    const records = {
      recordProposed: async () => {
        throw new Error('db down');
      },
      markClosed: async () => undefined,
    };
    const { watcher, cursor } = build({
      head: 500n,
      cursor: '100',
      logs: [event(ROGUE, ATTACKER, 1n)],
      records,
    });
    await watcher.check();
    expect(cursor()).toBe('100');
  });
});
