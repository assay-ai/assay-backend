import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import { buildNamespaceVaultPort } from '@modules/chains/multiplex/namespace-vault.port';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
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
 * Built through {@link buildNamespaceVaultPort}, the same function
 * `chains.module.ts` calls. Only `eip155` has a vault (the escrow contract);
 * Solana's pooled Squads treasury is gone.
 */
describe('NamespaceVaultPort', () => {
  it('sends an eip155 asset to the EVM vault', async () => {
    const evm = fakeVault();
    const multiplexer = buildNamespaceVaultPort({ enabled: [SOLANA, EVM], evm });

    await multiplexer.getVaultAccount(USDG);

    expect(evm.getVaultAccount).toHaveBeenCalledWith(USDG);
    expect(multiplexer.namespaces()).toEqual(['eip155']);
  });

  it('refuses a Solana asset, naming the chain: Solana has no vault', async () => {
    const evm = fakeVault();
    const multiplexer = buildNamespaceVaultPort({ enabled: [SOLANA, EVM], evm });

    await expect(multiplexer.assertVaultControl(USDC)).rejects.toMatchObject({
      errorCode: ChainErrorCode.CHAIN_UNSUPPORTED,
    });
    expect(evm.assertVaultControl).not.toHaveBeenCalled();
  });

  it('holds no vault at all when no eip155 chain is enabled', () => {
    expect(buildNamespaceVaultPort({ enabled: [SOLANA], evm: fakeVault() }).namespaces()).toEqual(
      [],
    );
  });
});
