import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';

import { CacheHeaderInterceptor } from '@shared/interceptors/cache-header.interceptor';

import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { ChainsController } from '@modules/chains/controllers/chains.controller';
import { ChainDirectoryService } from '@modules/chains/services/chain-directory.service';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS, ChainId, ChainNamespace } from '@modules/chains/ports/caip.types';
import { ChainAdapter } from '@modules/chains/ports/chain-adapter.port';

const DEVNET = CHAIN_IDS.SOLANA_DEVNET;

function stubAdapter(chains: readonly ChainId[]): ChainAdapter {
  return { namespace: ChainNamespace.SOLANA, supportedChains: chains } as unknown as ChainAdapter;
}

/**
 * The registry refuses a Solana adapter handed an `eip155` chain, so the
 * two-namespace fixture below needs its own. Deliberately a second function
 * rather than a `namespace` parameter on the one above: every other test in
 * this file is single-namespace and gains nothing from the argument.
 */
function stubEvmAdapter(chains: readonly ChainId[]): ChainAdapter {
  return { namespace: ChainNamespace.EIP155, supportedChains: chains } as unknown as ChainAdapter;
}

/**
 * `GET /api/v1/chains`.
 *
 * The frontend's own `libs/chains/registry.ts` holds STATIC per-chain metadata
 * and never the enabled list: a build-time copy drifts from the API, and the
 * failure is a user shown a chain the API then refuses. So this endpoint is the
 * only source of "which chains does this deployment offer", and the assertion
 * that matters is the negative one — a chain the registry serves but
 * `ENABLED_CHAINS` does not name must not appear.
 */
/** The public-RPC map, empty unless a test says otherwise. */
const NO_PUBLIC_RPCS = new Map<string, string>();

describe('ChainDirectoryService', () => {
  it('returns exactly the enabled chains, with their settlement asset and decimals', () => {
    const service = new ChainDirectoryService(
      [DEVNET],
      new ChainAdapterRegistry([stubAdapter([DEVNET])], [DEVNET]),
      NO_PUBLIC_RPCS,
    );

    expect(service.listChains()).toEqual({
      chains: [
        {
          chainId: DEVNET,
          namespace: 'solana',
          displayName: 'Solana devnet',
          explorerBaseUrl: 'https://explorer.solana.com/?cluster=devnet',
          settlementAsset: ASSET_IDS.USDC_SOLANA_DEVNET,
          settlementAssetSymbol: 'USDC',
          decimals: 6,
        },
      ],
    });
  });

  /**
   * TWO chains whose settlement assets have DIFFERENT symbols, asserted paired
   * with the chain they belong to.
   *
   * A one-chain fixture cannot tell "the symbol of this chain's declared
   * settlement asset" from "the first symbol in the registry" — both answer
   * `USDC`, which is what every Solana row says. `eip155:46630` settles in
   * USDG, so the pairing below fails outright for any implementation that
   * reaches for a fixed entry, for `registeredAssets()[0]`, or for the first
   * asset registered ON the chain rather than the DECLARED one.
   */
  it('carries the PUBLIC rpc url of a chain that has one, and nothing for a chain that has not', () => {
    /*
      The browser signs eip155 transactions itself and needs an endpoint to
      fill the nonce, the gas and the fees from — and `NEXT_PUBLIC_*` cannot
      carry it: the frontend's CI composes `.env.production` from three keys it
      knows about and drops a fourth in silence. So the chain list carries it,
      which is also where every other chain fact already comes from.

      From `PUBLIC_RPC_URLS`, never from `EVM_RPC_URLS` / `SOLANA_RPC_URL`:
      those may hold a keyed endpoint (dev's Helius URL does), and this field
      is served to anyone who asks for the chain list.
    */
    const enabled = [DEVNET, CHAIN_IDS.ROBINHOOD_TESTNET];
    const registry = new ChainAdapterRegistry(
      [stubAdapter([DEVNET]), stubEvmAdapter([CHAIN_IDS.ROBINHOOD_TESTNET])],
      enabled as ChainId[],
    );
    const service = new ChainDirectoryService(
      enabled as ChainId[],
      registry,
      new Map([[CHAIN_IDS.ROBINHOOD_TESTNET as string, 'https://rpc.testnet.chain.robinhood.com']]),
    );

    const chains = service.listChains().chains;

    expect(chains.find((c) => c.chainId === CHAIN_IDS.ROBINHOOD_TESTNET)?.publicRpcUrl).toBe(
      'https://rpc.testnet.chain.robinhood.com',
    );
    // Absent, not empty: a chain with no configured public endpoint says so by
    // omission, and the browser refuses that chain by name rather than dialling "".
    expect(chains.find((c) => c.chainId === DEVNET)).not.toHaveProperty('publicRpcUrl');
  });

  it('pairs each chain with ITS OWN settlement symbol, not the first one registered', () => {
    const enabled = [DEVNET, CHAIN_IDS.ROBINHOOD_TESTNET];
    const service = new ChainDirectoryService(
      enabled,
      new ChainAdapterRegistry(
        [stubAdapter([DEVNET]), stubEvmAdapter([CHAIN_IDS.ROBINHOOD_TESTNET])],
        enabled,
      ),
      NO_PUBLIC_RPCS,
    );

    expect(service.listChains().chains.map((c) => [c.chainId, c.settlementAssetSymbol])).toEqual([
      [DEVNET, 'USDC'],
      [CHAIN_IDS.ROBINHOOD_TESTNET, 'USDG'],
    ]);
  });

  it('serves the contracts and on-chain params of a chain that has them, and none for one that has not', () => {
    const enabled = [DEVNET, CHAIN_IDS.ROBINHOOD_TESTNET];
    const evm = CHAIN_IDS.ROBINHOOD_TESTNET as ChainId;
    const params = {
      current: (chainId: ChainId) =>
        chainId === evm
          ? {
              chainId,
              source: 'chain',
              readAt: new Date('2026-10-25T00:00:00Z'),
              contracts: { config: '0xC0', stake: '0xC1', escrow: '0xC2', asset: '0xA5' },
              minimumStake: { amount: '50000000' },
              penaltyAmount: { amount: '1000000' },
              verifierDailyCap: { amount: '500000000' },
              takeRateBps: 1000,
              slashAgentBps: 6000,
              slashPlatformBps: 3000,
              slashCapBps: 1000,
              unbondingPeriodSeconds: 950_400,
              slashDelaySeconds: 600,
              policySlashDelaySeconds: 259_200,
              collectHoldSeconds: 3600,
              paused: false,
              arbiter: null,
            }
          : null,
    };
    const service = new ChainDirectoryService(
      enabled,
      new ChainAdapterRegistry(
        [stubAdapter([DEVNET]), stubEvmAdapter([CHAIN_IDS.ROBINHOOD_TESTNET])],
        enabled,
      ),
      NO_PUBLIC_RPCS,
      params as never,
    );

    const [solana, robinhood] = service.listChains().chains;
    expect(solana).not.toHaveProperty('params');
    expect(solana).not.toHaveProperty('contracts');
    expect(robinhood.contracts).toEqual({
      config: '0xC0',
      stake: '0xC1',
      escrow: '0xC2',
      asset: '0xA5',
    });
    expect(robinhood.params).toEqual({
      source: 'chain',
      readAt: '2026-10-25T00:00:00.000Z',
      minimumStake: '50000000',
      penaltyAmount: '1000000',
      takeRateBps: 1000,
      slashAgentBps: 6000,
      slashPlatformBps: 3000,
      slashCapBps: 1000,
      unbondingPeriodSeconds: 950_400,
      slashDelaySeconds: 600,
      // The platform's 72 h floor is longer than the chain's 10 min.
      effectiveSlashDelaySeconds: 259_200,
      collectHoldSeconds: 3600,
      withdrawDelaySeconds: 10_800,
      tightenDelaySeconds: 10_800,
      redeemGraceSeconds: 7_200,
      heldTimeoutSeconds: 604_800,
      disputeTimeoutSeconds: 2_592_000,
      paused: false,
      arbiter: null,
    });
  });

  it('omits a chain the adapter serves but ENABLED_CHAINS does not name', () => {
    // The guard's subject is the ENABLED list, so the adapter here deliberately
    // supports MORE than the list does. A service that read `registry
    // .enabledChains()` instead would pass every other test in this file and
    // fail this one.
    const registry = new ChainAdapterRegistry(
      [stubAdapter([DEVNET, CHAIN_IDS.SOLANA_MAINNET])],
      [DEVNET, CHAIN_IDS.SOLANA_MAINNET],
    );
    const service = new ChainDirectoryService([DEVNET], registry, NO_PUBLIC_RPCS);

    expect(service.listChains().chains.map((c) => c.chainId)).toEqual([DEVNET]);
  });

  /**
   * Order, asserted BOTH WAYS round — and it has to be both.
   *
   * There are only two chains and therefore only two permutations, so any
   * single ordering test is ambiguous between three different mutations:
   *
   * | enabled order | registry order | alphabetical |
   * |---|---|---|
   * | `[MAINNET, DEVNET]` | `[DEVNET, MAINNET]` | `[MAINNET, DEVNET]` — `'5eykt…' < 'EtWT…'` |
   * | `[DEVNET, MAINNET]` | `[DEVNET, MAINNET]` | `[MAINNET, DEVNET]` |
   *
   * The first row alone passes under a `.sort()` — which is why it did, before
   * review caught it: an alphabetical canonicalisation of the operator's list
   * was indistinguishable from preserving it. The second row alone passes under
   * `registry.enabledChains()`. Together they pin every one of the three, and
   * neither is redundant.
   */
  it.each([
    ['operator order that is also alphabetical', [CHAIN_IDS.SOLANA_MAINNET, DEVNET]],
    ['operator order that is NOT alphabetical', [DEVNET, CHAIN_IDS.SOLANA_MAINNET]],
  ])('preserves ENABLED_CHAINS order — %s', (_label, enabled) => {
    const registry = new ChainAdapterRegistry(
      [stubAdapter([DEVNET, CHAIN_IDS.SOLANA_MAINNET])],
      [DEVNET, CHAIN_IDS.SOLANA_MAINNET],
    );
    const service = new ChainDirectoryService(enabled as ChainId[], registry, NO_PUBLIC_RPCS);

    expect(service.listChains().chains.map((c) => c.chainId)).toEqual(enabled);
  });
});

/**
 * The controller is four lines and delegates, which is exactly why it is worth
 * one test: the thing that can go wrong here is not arithmetic, it is a handler
 * that returns something other than what the service computed — a hand-built
 * literal, a `chains` array unwrapped, a cached copy. Asserting identity with
 * the service's own return value is the cheapest way to say "this is a
 * delegation and nothing else".
 */
describe('ChainsController', () => {
  it('serves the directory verbatim', () => {
    const expected = { chains: [] };
    const service = { listChains: jest.fn().mockReturnValue(expected) };

    const controller = new ChainsController(service as unknown as ChainDirectoryService);

    expect(controller.list()).toBe(expected);
    expect(service.listChains).toHaveBeenCalledTimes(1);
  });
});

/**
 * The browser cache directives on `GET /api/v1/chains`.
 *
 * This runs the REAL `CacheHeaderInterceptor` over the REAL handler rather than
 * reading the decorator's metadata back. The metadata is not the thing that can
 * be wrong — it is what the browser is told, and between the two sits a merge
 * with a global default whose `stale-while-revalidate=3600` is precisely the
 * hour-old chain list this endpoint exists to prevent. `PublicReservesController` hit
 * exactly this and it was caught by watching a live page, because nothing in
 * the suite asserted a `Cache-Control` string. Now something does.
 */
describe('GET /chains — cache directives', () => {
  function interceptHeaders(
    handler: () => unknown,
    requestHeaders: Record<string, string> = {},
  ): Record<string, string> {
    const headers: Record<string, string> = {};
    const response = {
      statusCode: 200,
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
      getHeader: (name: string) => headers[name],
      removeHeader: (name: string) => delete headers[name],
    };
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'GET', headers: requestHeaders }),
        getResponse: () => response,
      }),
      getHandler: () => handler,
      getClass: () => ChainsController,
    } as unknown as ExecutionContext;

    const interceptor = new CacheHeaderInterceptor(new Reflector(), new ConfigService());

    interceptor.intercept(context, { handle: () => of({ chains: [] }) }).subscribe(() => undefined);

    return headers;
  }

  it('grants no stale window — a browser must never paint a chain list it cannot verify', () => {
    const cacheControl = interceptHeaders(ChainsController.prototype.list)['Cache-Control'];

    expect(cacheControl).toContain('max-age=60');
    expect(cacheControl).toContain('must-revalidate');
    expect(cacheControl).not.toContain('stale-while-revalidate');
    expect(cacheControl).not.toContain('stale-if-error');
  });

  /**
   * The credentialed path, pinned because the controller's comment makes a
   * claim about it.
   *
   * `visibility` is undeclared, so `CacheHeaderInterceptor` applies RFC 9111's
   * rule for a response to a request carrying `Authorization`: `private`, and
   * out of shared caches. An earlier version of that comment said `public`
   * "stays", which is true only for anonymous callers. This test exists so the
   * comment and the header cannot drift apart again, and so that adding
   * `visibility: 'public'` becomes a deliberate act with a red test attached
   * rather than a one-word edit.
   */
  it('downgrades a credentialed request to private, out of every shared cache', () => {
    const headers = interceptHeaders(ChainsController.prototype.list, {
      authorization: 'Bearer irrelevant',
    });

    expect(headers['Cache-Control']).toContain('private');
    expect(headers['Cache-Control']).not.toContain('public');
    expect(headers['CDN-Cache-Control']).toBe('no-store');
    // Same freshness contract either way — the downgrade is about WHO may cache.
    expect(headers['Cache-Control']).toContain('max-age=60');
    expect(headers['Cache-Control']).not.toContain('stale-while-revalidate');
  });
});
