import { pad, toHex } from 'viem';

import { createSanctionedEvmClient } from '@modules/chains/evm/sanctioned-evm-rpc';
import { EvmVaultClient, EvmVaultService } from '@modules/chains/evm/evm-vault.service';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS, ChainId, toAccountId } from '@modules/chains/ports/caip.types';
import { EgressHttpClient, EgressRequest, EgressResponse } from '@shared/network/egress';
import { MoneyUtil } from '@shared/utils/money.util';

import { deployment } from './evm-fixtures';

/**
 * The chain object `createSanctionedEvmClient` now requires — the numeric id it
 * asserts against and the multicall address viem needs before it will batch.
 */
const TEST_CHAIN = {
  id: 46630,
  name: 'eip155:46630',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [] } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
} as const;

/**
 * `VaultPort` on an `eip155` chain.
 *
 * ## The fake is a TRANSPORT, not a client object
 *
 * Every other EVM reader suite hands its subject a structural `{ readContract }`
 * stub. This one does not, and the reason is what this port has to prove:
 * `getVaultBalanceAt` publishes a balance **and the block it was true at** on a
 * page with no login, so the assertion that matters is about the JSON-RPC
 * traffic — which methods, in which order, carrying which block parameter.
 * A stub named `readContract` cannot show that `eth_call` was anchored to the
 * block `eth_blockNumber` returned, because it never speaks JSON-RPC at all.
 *
 * So the seam is {@link EgressHttpClient}, exactly as `sanctioned-evm-rpc.spec`
 * uses it, and everything between the service and the wire — viem's ABI
 * encoding, the block-tag serialisation, the decode — is the real thing.
 */
const TESTNET = CHAIN_IDS.ROBINHOOD_TESTNET;
const DEPLOYMENT = deployment(TESTNET);
const USDG = ASSET_IDS.USDG_ROBINHOOD_TESTNET;
const USDC_DEVNET = ASSET_IDS.USDC_SOLANA_DEVNET;

const RPC_URL = 'https://rpc.testnet.chain.robinhood.example';

/**
 * `keccak256("eip1967.proxy.implementation") - 1`, written out rather than
 * imported from the service.
 *
 * Importing the constant under test would make this a restatement: the suite
 * would go on passing against a slot that had been changed to anything at all.
 * The literal is copied from `assay-evm/script/verify-deployment.sh:43`, which is the
 * script an operator runs against the live proxy — so the backend and the
 * runbook are pinned to the same 32 bytes.
 */
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

/** Function selectors, from `cast sig` on the pinned Foundry build. */
const SELECTOR = {
  admin: '0xf851a440',
  ASSET: '0x4800d97f',
  balanceOf: '0x70a08231',
} as const;

const OTHER_IMPLEMENTATION = '0x00000000000000000000000000000000DeaDBeef';
const OTHER_ADMIN = '0x000000000000000000000000000000000000c0De';
const OTHER_TOKEN = '0x000000000000000000000000000000000000BadA';

interface ChainState {
  implementation: string;
  admin: string;
  asset: string;
  balance: bigint;
  blockNumber: bigint;
  throwOnCall?: Error;
}

interface Call {
  readonly method: string;
  readonly params: readonly unknown[];
}

function chain(overrides: Partial<ChainState> = {}): {
  client: EvmVaultClient;
  calls: Call[];
  state: ChainState;
} {
  const state: ChainState = {
    implementation: DEPLOYMENT.escrowImplementation,
    admin: DEPLOYMENT.admin,
    asset: DEPLOYMENT.asset,
    balance: 12_500_000n,
    blockNumber: 116_313_808n,
    ...overrides,
  };
  const calls: Call[] = [];

  const answer = (method: string, params: readonly unknown[]): string => {
    if (method === 'eth_blockNumber') {
      return toHex(state.blockNumber);
    }
    if (method === 'eth_getStorageAt') {
      return pad(state.implementation as `0x${string}`, { size: 32 });
    }
    if (method === 'eth_call') {
      if (state.throwOnCall) throw state.throwOnCall;
      const { data } = params[0] as { to: string; data: string };
      const selector = data.slice(0, 10);
      if (selector === SELECTOR.admin) return pad(state.admin as `0x${string}`, { size: 32 });
      if (selector === SELECTOR.ASSET) return pad(state.asset as `0x${string}`, { size: 32 });
      if (selector === SELECTOR.balanceOf) return toHex(state.balance, { size: 32 });
    }
    throw new Error(`unexpected JSON-RPC ${method} ${JSON.stringify(params)}`);
  };

  const egress = {
    async request(request: EgressRequest): Promise<EgressResponse> {
      const { id, method, params } = JSON.parse(String(request.body)) as {
        id: number;
        method: string;
        params?: readonly unknown[];
      };
      calls.push({ method, params: params ?? [] });
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ jsonrpc: '2.0', id, result: answer(method, params ?? []) }),
        bytes: 0,
        url: request.url,
        redirects: 0,
      };
    },
  } as unknown as EgressHttpClient;

  return {
    client: createSanctionedEvmClient(
      RPC_URL,
      egress,
      TEST_CHAIN as never,
    ) as unknown as EvmVaultClient,
    calls,
    state,
  };
}

function vaultWith(overrides: Partial<ChainState> = {}) {
  const { client, calls } = chain(overrides);
  return {
    vault: new EvmVaultService(
      new Map<ChainId, EvmVaultClient>([[TESTNET, client]]),
      new Map([[TESTNET, DEPLOYMENT]]),
    ),
    calls,
  };
}

describe('EvmVaultService', () => {
  it('names the escrow PROXY as the vault, for both the owner and the account', async () => {
    // On EVM the pool and its owner are the same address. There is no ATA, no
    // authority PDA and no multisig — `X402Escrow` holds the USDG and is
    // authorised by its own code.
    const { vault, calls } = vaultWith();
    const escrow = toAccountId(TESTNET, DEPLOYMENT.escrow);

    await expect(vault.getVaultOwner(USDG)).resolves.toBe(escrow);
    await expect(vault.getVaultAccount(USDG)).resolves.toBe(escrow);
    // And neither costs a round trip: the answer is the deployment record.
    expect(calls).toEqual([]);
  });

  it('reads the balance at the block it names, so the pair cannot describe two moments', async () => {
    // The proof-of-reserves page publishes the reading with no login, and a published
    // balance whose block came from a *different* moment describes two moments
    // as one. `eth_call` cannot report which block answered it, so the order is
    // the other way round: read the head, then read the balance ANCHORED to it.
    const { vault, calls } = vaultWith();

    const { balance, slot } = await vault.getVaultBalanceAt(USDG);

    expect(balance).toEqual(MoneyUtil.of(12_500_000n, USDG, 6));
    expect(slot).toBe(116_313_808n);
    expect(calls.map((c) => c.method)).toEqual(['eth_blockNumber', 'eth_call']);

    // THE assertion. `latest` here would be the defect the ordering exists to
    // prevent, and it is invisible in the two values above.
    const [target, blockTag] = calls[1].params as [{ to: string; data: string }, string];
    expect(blockTag).toBe(toHex(116_313_808n));
    // …of the TOKEN's `balanceOf(escrow)`, not of the escrow's own counter:
    // `totalEscrowed()` is the contract's opinion of what it holds, and proof
    // of reserves is about what the token ledger says it holds.
    expect(target.to.toLowerCase()).toBe(DEPLOYMENT.asset.toLowerCase());
    expect(target.data.slice(0, 10)).toBe(SELECTOR.balanceOf);
    expect(`0x${target.data.slice(-40)}`.toLowerCase()).toBe(DEPLOYMENT.escrow.toLowerCase());
  });

  it('getVaultBalance is the same reading, without the block', async () => {
    const { vault } = vaultWith({ balance: 7n });
    await expect(vault.getVaultBalance(USDG)).resolves.toEqual(MoneyUtil.of(7n, USDG, 6));
  });

  it('refuses when the proxy points at an implementation the record does not name', async () => {
    // THE control proof on EVM. There is no Squads program to ask "who owns
    // this?"; the question that means the same thing is "is the code behind
    // this address the code we deployed?".
    const { vault, calls } = vaultWith({ implementation: OTHER_IMPLEMENTATION });

    await expect(vault.assertVaultControl(USDG)).rejects.toMatchObject({
      errorCode: 'CHAIN_VAULT_CONTROL_UNVERIFIED',
    });
    // Read at the ERC-1967 slot and nowhere else. A guard that read slot 0
    // would answer about `CONFIG`, which is a real address and would pass.
    expect(calls[0]).toEqual({
      method: 'eth_getStorageAt',
      params: [DEPLOYMENT.escrow.toLowerCase(), IMPL_SLOT, 'latest'],
    });
  });

  it('refuses when config.admin() is not the admin the record names', async () => {
    // By design the admin IS the upgrade authority of all three contracts, so
    // an admin that moved without being recorded is an upgrade authority that
    // moved without being recorded.
    const { vault } = vaultWith({ admin: OTHER_ADMIN });

    await expect(vault.assertVaultControl(USDG)).rejects.toMatchObject({
      errorCode: 'CHAIN_VAULT_CONTROL_UNVERIFIED',
    });
  });

  it('refuses when the escrow ASSET() is not the asset being reconciled', async () => {
    const { vault } = vaultWith({ asset: OTHER_TOKEN });

    await expect(vault.assertVaultControl(USDG)).rejects.toMatchObject({
      errorCode: 'CHAIN_VAULT_CONTROL_UNVERIFIED',
    });
  });

  it('passes when all three agree — the positive control', async () => {
    const { vault, calls } = vaultWith();

    await expect(vault.assertVaultControl(USDG)).resolves.toBeUndefined();
    // Three reads, and the positive control is what stops the three negatives
    // above passing over a method that always threw.
    expect(calls.map((c) => c.method)).toEqual(['eth_getStorageAt', 'eth_call', 'eth_call']);
  });

  it('names which of the three failed, because the remedies do not overlap', async () => {
    // A single "control unverified" tells an operator to stop and nothing else.
    // An unrecorded upgrade, a moved admin key and a wrong token are three
    // different incidents.
    await expect(
      vaultWith({ implementation: OTHER_IMPLEMENTATION }).vault.assertVaultControl(USDG),
    ).rejects.toMatchObject({ message: expect.stringContaining('implementation') });
    await expect(
      vaultWith({ admin: OTHER_ADMIN }).vault.assertVaultControl(USDG),
    ).rejects.toMatchObject({ message: expect.stringContaining('admin') });
    await expect(
      vaultWith({ asset: OTHER_TOKEN }).vault.assertVaultControl(USDG),
    ).rejects.toMatchObject({ message: expect.stringContaining('ASSET') });
  });

  it('refuses an asset that is not on an eip155 chain, by name', async () => {
    const { vault } = vaultWith();
    await expect(vault.getVaultAccount(USDC_DEVNET)).rejects.toMatchObject({
      errorCode: 'CHAIN_UNSUPPORTED',
    });
  });

  it('refuses an asset that is not the one this deployment settles in', async () => {
    // A reading denominated in an asset the escrow does not hold is a `Money`
    // that `MoneyUtil.add` would happily combine with a real one.
    const { vault } = vaultWith();
    const other = `${TESTNET}/erc20:${OTHER_TOKEN}`;
    await expect(vault.getVaultBalanceAt(other as typeof USDG)).rejects.toMatchObject({
      errorCode: 'CHAIN_ASSET_NOT_ON_CHAIN',
    });
  });
});
