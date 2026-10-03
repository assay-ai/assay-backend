import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import {
  NamespaceVaultPort,
  buildNamespaceVaultPort,
} from '@modules/chains/multiplex/namespace-vault.port';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AssetId, CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { VaultPort } from '@modules/chains/ports/vault.port';

const SOLANA = CHAIN_IDS.SOLANA_DEVNET;
const EVM = CHAIN_IDS.ROBINHOOD_TESTNET;

const USDC = ASSET_IDS.USDC_SOLANA_DEVNET;
const USDG = ASSET_IDS.USDG_ROBINHOOD_TESTNET;

function fakeVault(): jest.Mocked<VaultPort> {
  return {
    getVaultOwner: jest.fn().mockResolvedValue(undefined),
    getVaultAccount: jest.fn().mockResolvedValue(undefined),
    getVaultBalance: jest.fn().mockResolvedValue(undefined),
    getVaultBalanceAt: jest.fn().mockResolvedValue(undefined),
    assertVaultControl: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<VaultPort>;
}

/**
 * `NamespaceVaultPort`.
 *
 * The multiplexer is built through {@link buildNamespaceVaultPort}, which is the
 * same function `chains.module.ts` calls — so a test that passes here passes
 * about the wiring the process actually gets, not about a map assembled by hand
 * in a spec.
 */
describe('NamespaceVaultPort', () => {
  const both = (): {
    multiplexer: NamespaceVaultPort;
    squads: jest.Mocked<VaultPort>;
    evm: jest.Mocked<VaultPort>;
  } => {
    const squads = fakeVault();
    const evm = fakeVault();
    return {
      multiplexer: buildNamespaceVaultPort({ enabled: [SOLANA, EVM], solana: squads, evm }),
      squads,
      evm,
    };
  };

  it('sends a solana asset to the Squads implementation and an eip155 asset to the EVM one', async () => {
    const { multiplexer, squads, evm } = both();

    await multiplexer.getVaultAccount(USDC);
    await multiplexer.getVaultAccount(USDG);

    expect(squads.getVaultAccount).toHaveBeenCalledTimes(1);
    expect(evm.getVaultAccount).toHaveBeenCalledTimes(1);
    // And the reason the other one was NOT chosen, not merely that it was
    // absent: a dispatcher that always picked the first entry would satisfy the
    // two counts above on a suite that ran them in this order.
    expect(squads.getVaultAccount).toHaveBeenCalledWith(USDC);
    expect(evm.getVaultAccount).toHaveBeenCalledWith(USDG);
  });

  it.each([
    ['getVaultOwner'],
    ['getVaultAccount'],
    ['getVaultBalance'],
    ['getVaultBalanceAt'],
    ['assertVaultControl'],
  ] as const)('dispatches %s, not only the one method a spec happened to try', async (method) => {
    // Five methods, and a multiplexer that forwarded four of them would be
    // caught by nothing above. `assertVaultControl` is the one that matters
    // most: it is the FIRST call of every reconciliation pass, and forwarding
    // it to Squads for an eip155 asset would derive a PDA from an `0x` string
    // and read a real account belonging to somebody else.
    const { multiplexer, squads, evm } = both();

    await multiplexer[method](USDG);

    expect(evm[method]).toHaveBeenCalledWith(USDG);
    expect(squads[method]).not.toHaveBeenCalled();
  });

  it('refuses a namespace with no implementation, naming the chain', async () => {
    const { multiplexer } = both();

    await expect(
      multiplexer.getVaultAccount('cosmos:hub-4:uatom' as AssetId),
    ).rejects.toMatchObject({
      errorCode: ChainErrorCode.CHAIN_UNSUPPORTED,
      message: expect.stringContaining('cosmos:hub-4'),
    });
  });

  it('does not construct the EVM implementation when eip155 is not enabled', () => {
    // A chain absent from ENABLED_CHAINS must be absent everywhere, and
    // a multiplexer that holds a live EVM client for a disabled chain has
    // already opened a socket nobody asked for.
    expect(
      buildNamespaceVaultPort({
        enabled: [SOLANA],
        solana: fakeVault(),
        evm: fakeVault(),
      }).namespaces(),
    ).toEqual(['solana']);
  });

  it('does not hold the Squads implementation when no solana chain is enabled', () => {
    // The mirror, and the half that would otherwise be assumed. Turning Solana
    // off must leave 46630 byte-identically unaffected — and it must also
    // actually turn Solana off.
    const evmOnly = buildNamespaceVaultPort({
      enabled: [EVM],
      solana: fakeVault(),
      evm: fakeVault(),
    });

    expect(evmOnly.namespaces()).toEqual(['eip155']);
    return expect(evmOnly.getVaultAccount(USDC)).rejects.toMatchObject({
      errorCode: ChainErrorCode.CHAIN_UNSUPPORTED,
    });
  });

  it('serves an enabled chain even when a sibling chain of the same namespace is not', async () => {
    // `solana:mainnet` and `solana:devnet` share a namespace. The map is keyed
    // on the namespace, so enabling either must wire the Solana implementation
    // — a `buildNamespaceVaultPort` that compared whole chain ids instead would
    // silently serve nothing on mainnet.
    const squads = fakeVault();
    const multiplexer = buildNamespaceVaultPort({
      enabled: [CHAIN_IDS.SOLANA_MAINNET as ChainId],
      solana: squads,
      evm: fakeVault(),
    });

    await multiplexer.getVaultAccount(ASSET_IDS.USDC_SOLANA_MAINNET);

    expect(squads.getVaultAccount).toHaveBeenCalledWith(ASSET_IDS.USDC_SOLANA_MAINNET);
  });
});
