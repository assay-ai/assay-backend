import { Logger } from '@nestjs/common';

import {
  EVM_CHAIN_STATE_ALERTS,
  EvmChainStateIndexer,
} from '@modules/chains/evm/chain-state/evm-chain-state.indexer';
import { Alert, AlertSeverity } from '@shared/alerting';

const CHAIN = 'eip155:46630' as never;
const CONFIG = '0xCf6592A3a053d9714D16d176A86fA039Fe7B6a43';
const ARBITER = '0x5555555555555555555555555555555555555555';
const VICTIM = '0x2222222222222222222222222222222222222222';
const NOW = 1_800_000_000_000;

interface FakeState {
  chainId: string;
  paused: boolean;
  arbiter: string | null;
  cursorBlock: string | null;
  caughtUpAt: Date | null;
  reconciledAt: Date | null;
}

function build(options: {
  head: bigint;
  logs?: Record<string, unknown>[];
  state?: Partial<FakeState>;
  chain?: { paused?: boolean; blocked?: string[] };
}) {
  let state: FakeState | null = options.state
    ? {
        chainId: CHAIN,
        paused: false,
        arbiter: null,
        cursorBlock: null,
        caughtUpAt: null,
        reconciledAt: null,
        ...options.state,
      }
    : null;
  const blocked = new Map<string, boolean>();
  const ranges: [bigint, bigint][] = [];
  const alerts: Alert[] = [];
  const ensure = () =>
    (state ??= {
      chainId: CHAIN,
      paused: false,
      arbiter: null,
      cursorBlock: null,
      caughtUpAt: null,
      reconciledAt: null,
    });
  const repository = {
    findState: async () => (state ? { ...state } : null),
    findKnownAddresses: async () =>
      [...blocked].map(([address, value]) => ({ address, blocked: value })),
    applyIndexedRange: async (range: {
      cursorBlock: bigint;
      caughtUp: boolean;
      now: Date;
      paused?: boolean;
      arbiter?: string | null;
      blocked: { address: string; blocked: boolean }[];
    }) => {
      const s = ensure();
      s.cursorBlock = range.cursorBlock.toString();
      if (range.caughtUp) s.caughtUpAt = range.now;
      if (range.paused !== undefined) s.paused = range.paused;
      if (range.arbiter !== undefined) s.arbiter = range.arbiter;
      for (const row of range.blocked) blocked.set(row.address, row.blocked);
    },
    applyReconcile: async (
      _chain: string,
      terms: { paused: boolean; arbiter: string | null },
      corrections: { address: string; blocked: boolean }[],
      now: Date,
    ) => {
      const s = ensure();
      Object.assign(s, terms, { reconciledAt: now });
      for (const row of corrections) blocked.set(row.address, row.blocked);
    },
    recordError: async () => undefined,
  };
  const chain = options.chain ?? {};
  const client = {
    getBlockNumber: async () => options.head,
    getContractEvents: async (args: { fromBlock: bigint; toBlock: bigint }) => {
      ranges.push([args.fromBlock, args.toBlock]);
      return ranges.length === 1 ? (options.logs ?? []) : [];
    },
    readContract: async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
      if (functionName === 'paused') return chain.paused ?? false;
      if (functionName === 'slashDelaySeconds') return 600n;
      if (functionName === 'arbiter') return ARBITER;
      if (functionName === 'blocked') {
        return (chain.blocked ?? []).includes(String(args[0]).toLowerCase());
      }
      throw new Error(functionName);
    },
  };
  const indexer = new EvmChainStateIndexer(
    new Map([[CHAIN, client]]) as never,
    new Map([[CHAIN, { config: CONFIG }]]) as never,
    [CHAIN],
    repository as never,
    { emit: async (alert: Alert) => void alerts.push(alert) },
    { reconcileMs: 300_000, maxLagMs: 300_000, fromBlock: new Map(), now: () => NOW },
  );
  return { indexer, ranges, alerts, blocked, state: () => state };
}

const log = (eventName: string, args: Record<string, unknown>, block = 100n, index = 0) => ({
  eventName,
  args,
  blockNumber: block,
  logIndex: index,
  transactionHash: `0x${'1'.repeat(64)}`,
});

describe('EvmChainStateIndexer', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('indexes pause and blocklist events in chain order, then resumes after its cursor', async () => {
    const { indexer, blocked, state, ranges } = build({
      head: 20_500n,
      state: { cursorBlock: '19999', reconciledAt: new Date(NOW) },
      logs: [
        log('BlockedSet', { account: VICTIM, blocked: false, by: CONFIG }, 120n),
        log('BlockedSet', { account: VICTIM, blocked: true, by: CONFIG }, 110n),
        log('PauseToggled', { paused: true }, 105n),
      ],
    });
    await indexer.tick();
    expect(ranges[0]).toEqual([20_000n, 20_500n]);
    expect(state()).toMatchObject({ paused: true, cursorBlock: '20500' });
    // The later event wins: the address ends unblocked.
    expect(blocked.get(VICTIM)).toBe(false);
  });

  it('reconciles paused() and every known address live, and says it drifted', async () => {
    const { indexer, alerts, blocked, state } = build({
      head: 10n,
      state: { cursorBlock: '10', paused: false },
      chain: { paused: true, blocked: [VICTIM] },
    });
    blocked.set(VICTIM, false);
    await indexer.tick();
    expect(state()).toMatchObject({ paused: true, arbiter: ARBITER.toLowerCase() });
    expect(blocked.get(VICTIM)).toBe(true);
    expect(alerts.map((alert) => alert.name)).toContain(EVM_CHAIN_STATE_ALERTS.DRIFT);
  });

  it('raises CRITICAL on ArbiterSet, SlashDelaySet and VerifierRegistered, WARN on an arbiter block', async () => {
    const { indexer, alerts } = build({
      head: 200n,
      state: { cursorBlock: '99', reconciledAt: new Date(NOW) },
      logs: [
        log('ArbiterSet', { previousArbiter: CONFIG, newArbiter: ARBITER }, 100n, 0),
        log('SlashDelaySet', { previousDelay: 259_200n, newDelay: 600n }, 100n, 1),
        log('VerifierRegistered', { verifier: VICTIM, admin: CONFIG }, 100n, 2),
        log('BlockedSet', { account: VICTIM, blocked: true, by: ARBITER }, 101n, 0),
      ],
    });
    await indexer.tick();
    const levers = alerts.filter((alert) => alert.name === EVM_CHAIN_STATE_ALERTS.CONFIG_LEVER);
    expect(levers.map((alert) => [alert.severity, alert.details.event])).toEqual([
      [AlertSeverity.CRITICAL, 'ArbiterSet'],
      [AlertSeverity.CRITICAL, 'SlashDelaySet'],
      [AlertSeverity.CRITICAL, 'VerifierRegistered'],
    ]);
    expect(
      alerts.find((alert) => alert.name === EVM_CHAIN_STATE_ALERTS.ARBITER_BLOCK),
    ).toMatchObject({
      severity: AlertSeverity.WARN,
    });
  });

  it('warns when it is more than five minutes behind the head', async () => {
    const { indexer, alerts } = build({
      head: 50_000n,
      state: {
        cursorBlock: '0',
        caughtUpAt: new Date(NOW - 10 * 60_000),
        reconciledAt: new Date(NOW),
      },
    });
    await indexer.tick();
    expect(alerts.find((alert) => alert.name === EVM_CHAIN_STATE_ALERTS.LAGGING)).toMatchObject({
      severity: AlertSeverity.WARN,
      details: { lagSeconds: 600 },
    });
  });
});
