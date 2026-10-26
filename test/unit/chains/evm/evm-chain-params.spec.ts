import { EvmChainParamsCache } from '@modules/chains/evm/evm-chain-params.service';
import { ChainParamsFallback } from '@modules/chains/evm/chain-params-fallback';
import { ChainId } from '@modules/chains/ports/caip.types';

/**
 * The on-chain params cache: one multicall per chain, chain values win in both
 * directions, the env values only stand in for a chain never read, and a
 * difference between the two is alerted once per change.
 */
describe('EvmChainParamsCache', () => {
  const CHAIN = 'eip155:46630' as ChainId;
  const OTHER = 'eip155:1' as ChainId;
  const ARBITER = '0x00000000000000000000000000000000000000Ab';
  const deploymentOf = (chainId: ChainId) => ({
    chainId,
    config: '0x00000000000000000000000000000000000000c0',
    stake: '0x00000000000000000000000000000000000000c1',
    escrow: '0x00000000000000000000000000000000000000c2',
    asset: '0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac',
  });
  const FALLBACK: ChainParamsFallback = {
    minimumStake: '50000000',
    takeRateBps: 1000,
    slashAgentBps: 6000,
    slashPlatformBps: 3000,
    collectHoldSeconds: 3600,
    slashDelaySeconds: 259_200,
  };
  const paramSet = (overrides: Record<string, unknown> = {}) => ({
    treasury: '0x0000000000000000000000000000000000000001',
    redeemer: '0x0000000000000000000000000000000000000002',
    unbondingPeriodSeconds: 950_400n,
    minimumStake: 100_000_000n,
    penaltyAmount: 1_000_000n,
    verifierDailyCap: 500_000_000n,
    takeRateBps: 1000,
    slashAgentBps: 6000,
    slashPlatformBps: 3000,
    slashCapBps: 1000,
    ...overrides,
  });
  const ok = (result: unknown) => ({ status: 'success', result });
  const fail = { status: 'failure', error: new Error('execution reverted') };
  const answers = (overrides: Record<string, unknown> = {}) => [
    ok(paramSet(overrides)),
    ok(259_200n),
    ok(3_600n),
    ok(false),
    ok(ARBITER),
  ];

  function build(
    clients: Map<ChainId, unknown>,
    deployments: ChainId[] = [CHAIN],
    alerts = { emit: jest.fn(async () => undefined) },
  ) {
    const cache = new EvmChainParamsCache(
      clients as never,
      new Map(deployments.map((chainId) => [chainId, deploymentOf(chainId)])) as never,
      FALLBACK,
      alerts as never,
      { timeoutMs: 2_000, retryMs: 20_000, now: () => Date.parse('2026-10-25T00:00:00Z') },
    );
    return { cache, alerts };
  }

  afterEach(() => jest.useRealTimers());

  it('reads params, slash delay, collect hold, pause and arbiter in one multicall', async () => {
    const multicall = jest.fn(async () => answers());
    const { cache } = build(new Map([[CHAIN, { multicall }]]));

    await cache.refresh();

    expect(multicall).toHaveBeenCalledTimes(1);
    const [{ contracts }] = multicall.mock.calls[0] as unknown as [
      { contracts: { functionName: string; address: string }[] },
    ];
    expect(contracts.map((call) => call.functionName)).toEqual([
      'params',
      'slashDelaySeconds',
      'collectHoldSeconds',
      'paused',
      'arbiter',
    ]);
    expect(contracts[0].address).toBe('0x00000000000000000000000000000000000000C0');
    const params = cache.current(CHAIN)!;
    expect(params).toMatchObject({
      source: 'chain',
      takeRateBps: 1000,
      slashAgentBps: 6000,
      slashPlatformBps: 3000,
      slashCapBps: 1000,
      unbondingPeriodSeconds: 950_400,
      slashDelaySeconds: 259_200,
      policySlashDelaySeconds: 259_200,
      collectHoldSeconds: 3_600,
      paused: false,
      arbiter: '0x00000000000000000000000000000000000000AB',
    });
    expect(params.minimumStake).toMatchObject({
      amount: '100000000',
      asset: `${CHAIN}/erc20:0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac`,
      decimals: 6,
    });
    expect(params.penaltyAmount?.amount).toBe('1000000');
    expect(params.contracts.escrow.toLowerCase()).toBe(
      '0x00000000000000000000000000000000000000c2',
    );
  });

  it('serves the env fallback for a chain never read, and the chain value once read (both directions)', async () => {
    const multicall = jest.fn(async () => answers({ minimumStake: 20_000_000n, takeRateBps: 800 }));
    const { cache } = build(new Map([[CHAIN, { multicall }]]));

    expect(cache.current(CHAIN)).toMatchObject({
      source: 'config',
      takeRateBps: 1000,
      collectHoldSeconds: 3600,
      penaltyAmount: null,
    });
    expect(cache.current(CHAIN)!.minimumStake?.amount).toBe('50000000');

    await cache.refresh();

    // Lower than the env floor and the env fee: the chain still wins.
    expect(cache.current(CHAIN)!.minimumStake?.amount).toBe('20000000');
    expect(cache.current(CHAIN)!.takeRateBps).toBe(800);
  });

  it('keeps the last reading when a later read fails', async () => {
    const multicall = jest
      .fn()
      .mockResolvedValueOnce(answers())
      .mockRejectedValueOnce(new Error('ECONNREFUSED 10.0.0.1:8545'));
    const { cache } = build(new Map([[CHAIN, { multicall }]]));

    await cache.refresh();
    await cache.refresh();

    expect(cache.current(CHAIN)).toMatchObject({ source: 'chain' });
    expect(cache.current(CHAIN)!.minimumStake?.amount).toBe('100000000');
  });

  it('gives up on a chain that never answers after the budget, and keeps the one that did', async () => {
    jest.useFakeTimers();
    const hung = { multicall: jest.fn(() => new Promise(() => undefined)) };
    const fine = { multicall: jest.fn(async () => answers()) };
    const { cache } = build(
      new Map<ChainId, unknown>([
        [CHAIN, fine],
        [OTHER, hung],
      ]),
      [CHAIN, OTHER],
    );

    const pending = cache.refresh();
    await jest.advanceTimersByTimeAsync(2_000);
    await pending;

    expect(cache.all().map((params) => [params.chainId, params.source])).toEqual([
      [CHAIN, 'chain'],
      [OTHER, 'config'],
    ]);
  });

  it('tells subscribers when a value changed, and only then', async () => {
    const multicall = jest
      .fn()
      .mockResolvedValueOnce(answers())
      .mockResolvedValueOnce(answers())
      .mockResolvedValueOnce(answers({ minimumStake: 50_000_000n }));
    const { cache } = build(new Map([[CHAIN, { multicall }]]));
    const listener = jest.fn();
    cache.subscribe(listener);

    await cache.refresh();
    await cache.refresh();
    await cache.refresh();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[1][0].minimumStake.amount).toBe('50000000');
  });

  it('alerts a difference from the env fallback once per change, not once per read', async () => {
    const multicall = jest
      .fn()
      .mockResolvedValueOnce(answers())
      .mockResolvedValueOnce(answers())
      .mockResolvedValueOnce(answers({ takeRateBps: 1200 }))
      .mockResolvedValueOnce(answers({ minimumStake: 50_000_000n }));
    const { cache, alerts } = build(new Map([[CHAIN, { multicall }]]));

    await cache.refresh();
    await cache.refresh();
    expect(alerts.emit).toHaveBeenCalledTimes(1);
    expect(alerts.emit.mock.calls[0]).toEqual([
      expect.objectContaining({
        name: 'evm_onchain_param_env_drift',
        details: expect.objectContaining({
          differences: 'minimumStake (PROVIDER_MINIMUM_STAKE_FLOOR) chain=100000000 env=50000000',
        }),
      }),
    ]);

    await cache.refresh();
    expect(alerts.emit).toHaveBeenCalledTimes(2);

    // Back in agreement: logged, no alert.
    await cache.refresh();
    expect(alerts.emit).toHaveBeenCalledTimes(2);
  });

  it('alerts at boot when the settlement token reports other decimals than the registry', async () => {
    const readContract = jest.fn(async () => 18);
    const multicall = jest.fn(async () => answers({ minimumStake: 50_000_000n }));
    const { cache, alerts } = build(new Map([[CHAIN, { multicall, readContract }]]));

    await cache.onModuleInit();
    await new Promise((resolve) => setImmediate(resolve));
    cache.onModuleDestroy();

    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'decimals' }),
    );
    expect(alerts.emit).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'evm_asset_decimals_mismatch' }),
    );
  });

  it('M3: a failed optional getter falls back for that field only; params() is required', async () => {
    const multicall = jest
      .fn()
      .mockResolvedValueOnce([
        ok(paramSet({ minimumStake: 70_000_000n })),
        ok(600n),
        fail,
        ok(true),
        fail,
      ])
      .mockResolvedValueOnce([fail, ok(600n), ok(3_600n), ok(false), ok(ARBITER)]);
    const { cache } = build(new Map([[CHAIN, { multicall }]]));

    await cache.refresh();
    const params = cache.current(CHAIN)!;
    expect(params.source).toBe('chain');
    expect(params.minimumStake?.amount).toBe('70000000');
    expect(params.slashDelaySeconds).toBe(600);
    expect(params.paused).toBe(true);
    // Missing getters: the env fallback (never read before), not a guess.
    expect(params.collectHoldSeconds).toBe(3_600);
    expect(params.arbiter).toBeNull();

    // params() itself failing keeps the last reading whole.
    await cache.refresh();
    expect(cache.current(CHAIN)!.minimumStake?.amount).toBe('70000000');
  });

  it('M1: a chain that never answered at boot is retried every 20 s until it does', async () => {
    jest.useFakeTimers();
    const multicall = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(answers());
    const { cache } = build(
      new Map([[CHAIN, { multicall, readContract: jest.fn(async () => 6) }]]),
    );

    await cache.onModuleInit();
    expect(cache.current(CHAIN)!.source).toBe('config');
    await jest.advanceTimersByTimeAsync(20_000);
    expect(multicall).toHaveBeenCalledTimes(2);
    expect(cache.current(CHAIN)!.source).toBe('config');
    await jest.advanceTimersByTimeAsync(20_000);
    expect(multicall).toHaveBeenCalledTimes(3);
    expect(cache.current(CHAIN)!.source).toBe('chain');
    // Once read, back to the normal 5-minute refresh: no more 20 s retries.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(multicall).toHaveBeenCalledTimes(3);
    cache.onModuleDestroy();
  });

  it('has no entry for a chain with no deployment', () => {
    const { cache } = build(new Map());
    expect(cache.current(OTHER)).toBeNull();
  });
});
