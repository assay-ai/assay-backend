import { Logger } from '@nestjs/common';

import { EvmSlashHoldMonitor } from '@modules/chains/evm/evm-slash-hold.monitor';

const CHAIN = 'eip155:46630' as never;
const AUTHORITY = '0x1111111111111111111111111111111111111111';
const PROVIDER = '7f3e1c2a-0000-4000-8000-000000000001';
const NOW = 1_800_000_000_000;

function build() {
  const stake = {
    bonded: 100_000_000n,
    unbonding: 0n,
    pendingSlash: 0n,
    slashedInWindow: 0n,
    slashWindowStartedAt: 0n,
  };
  const params = { penaltyAmount: 1_000_000n, slashCapBps: 1_000, minimumStake: 50_000_000n };
  let waiting = new Map<string, { windowRefused: boolean }>();
  let failReads = false;
  const saved: Record<string, unknown>[] = [];
  let row: Record<string, unknown> | null = null;
  const monitor = new EvmSlashHoldMonitor(
    new Map([
      [
        CHAIN,
        {
          readContract: async ({ functionName }: { functionName: string }) => {
            if (failReads && functionName === 'stakeOf') throw new Error('HTTP 503');
            return functionName === 'params' ? params : stake;
          },
        },
      ],
    ]) as never,
    new Map([[CHAIN, { config: '0xc0', stake: '0x5a' }]]) as never,
    [CHAIN],
    {
      findStakeAuthoritiesOn: async () => [
        { providerId: PROVIDER, stakeAuthority: `${CHAIN}:${AUTHORITY}` },
      ],
    } as never,
    { findWaitingExecution: async () => waiting } as never,
    {
      findState: async () => row,
      saveState: async (_p: string, _c: string, state: Record<string, unknown>) => {
        saved.push(state);
        row = { ...row, ...state };
      },
    } as never,
    () => NOW,
  );
  return {
    monitor,
    stake,
    saved,
    row: () => row,
    setWaiting: (value: Map<string, { windowRefused: boolean }>) => (waiting = value),
    failReads: () => (failReads = true),
  };
}

describe('EvmSlashHoldMonitor', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('holds on condition 1: a full window with an upheld record waiting, and warns', async () => {
    const harness = build();
    harness.stake.slashedInWindow = 10_000_000n;
    harness.stake.slashWindowStartedAt = BigInt(NOW / 1000);
    harness.setWaiting(new Map([[PROVIDER, { windowRefused: false }]]));
    await harness.monitor.tick();
    expect(harness.row()).toMatchObject({ held: true, reasons: ['SLASH_WINDOW_FULL'] });
    expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringMatching(/slash hold/));
  });

  it('holds on condition 2: the free stake cannot back another penalty', async () => {
    const harness = build();
    harness.stake.pendingSlash = 99_500_000n;
    await harness.monitor.tick();
    expect(harness.row()).toMatchObject({ held: true, reasons: ['STAKE_FULLY_RESERVED'] });
  });

  it('holds on condition 3: bonded below the minimum stake', async () => {
    const harness = build();
    harness.stake.bonded = 10_000_000n;
    await harness.monitor.tick();
    expect(harness.row()).toMatchObject({ held: true, reasons: ['BONDED_BELOW_MINIMUM'] });
  });

  it('resumes after two consecutive clear checks, with an INFO', async () => {
    const harness = build();
    harness.stake.bonded = 10_000_000n;
    await harness.monitor.tick();
    harness.stake.bonded = 100_000_000n;
    await harness.monitor.tick();
    expect(harness.row()).toMatchObject({ held: true, clearChecks: 1 });
    await harness.monitor.tick();
    expect(harness.row()).toMatchObject({ held: false, clearChecks: 0 });
    expect(harness.row()?.releasedAt).toEqual(new Date(NOW));
    expect(Logger.prototype.log).toHaveBeenCalledWith(expect.stringMatching(/released/));
  });

  it('keeps the last decision when the chain cannot be read', async () => {
    const harness = build();
    harness.stake.bonded = 10_000_000n;
    await harness.monitor.tick();
    harness.failReads();
    await harness.monitor.tick();
    await harness.monitor.tick();
    expect(harness.row()).toMatchObject({ held: true });
    expect(harness.saved).toHaveLength(1);
  });

  it('re-checks one provider on its stake authority’s slash event', async () => {
    const harness = build();
    harness.stake.pendingSlash = 99_500_000n;
    await harness.monitor.recheckAuthority(CHAIN, AUTHORITY.toUpperCase().replace('0X', '0x'));
    expect(harness.row()).toMatchObject({ held: true });
  });
});
