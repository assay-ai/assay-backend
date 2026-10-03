import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import { CHAIN_IDS, ChainId, ChainNamespace } from '@modules/chains/ports/caip.types';
import { ChainAdapter } from '@modules/chains/ports/chain-adapter.port';
import { expectErrorCode } from '../helpers/expect-error-code';

function fakeAdapter(namespace: ChainNamespace, supportedChains: readonly ChainId[]): ChainAdapter {
  return { namespace, supportedChains } as ChainAdapter;
}

const solana = fakeAdapter(ChainNamespace.SOLANA, [
  CHAIN_IDS.SOLANA_MAINNET,
  CHAIN_IDS.SOLANA_DEVNET,
]);

describe('ChainAdapterRegistry', () => {
  it('resolves an adapter by CAIP-2 namespace', () => {
    expect(
      new ChainAdapterRegistry([solana], solana.supportedChains).resolve(CHAIN_IDS.SOLANA_MAINNET),
    ).toBe(solana);
  });

  it('refuses a chain whose namespace no adapter serves', () => {
    const registry = new ChainAdapterRegistry([solana], solana.supportedChains);
    expectErrorCode(
      () => registry.resolve(CHAIN_IDS.BASE_MAINNET),
      ChainErrorCode.CHAIN_UNSUPPORTED,
    );
  });

  it('refuses a namespace it serves but a network it was not configured for', () => {
    const registry = new ChainAdapterRegistry(
      [fakeAdapter(ChainNamespace.SOLANA, [CHAIN_IDS.SOLANA_DEVNET])],
      [CHAIN_IDS.SOLANA_DEVNET],
    );
    expectErrorCode(
      () => registry.resolve(CHAIN_IDS.SOLANA_MAINNET),
      ChainErrorCode.CHAIN_UNSUPPORTED,
    );
  });

  it('refuses a malformed chain id before it looks anything up', () => {
    const registry = new ChainAdapterRegistry([solana], solana.supportedChains);
    expectErrorCode(
      () => registry.resolve('solana' as ChainId),
      ChainErrorCode.CHAIN_INVALID_CHAIN_ID,
    );
  });

  it('lists every enabled chain, which is what the 402 accepts[] is built from', () => {
    expect(new ChainAdapterRegistry([solana], solana.supportedChains).enabledChains()).toEqual([
      CHAIN_IDS.SOLANA_MAINNET,
      CHAIN_IDS.SOLANA_DEVNET,
    ]);
  });

  it('refuses two adapters claiming the same namespace rather than silently keeping one', () => {
    expectErrorCode(
      () =>
        new ChainAdapterRegistry(
          [solana, fakeAdapter(ChainNamespace.SOLANA, [CHAIN_IDS.SOLANA_MAINNET])],
          solana.supportedChains,
        ),
      ChainErrorCode.CHAIN_ADAPTER_DUPLICATE_NAMESPACE,
    );
  });

  it('refuses an adapter claiming a chain outside its own namespace', () => {
    // `resolve()` finds the adapter by NAMESPACE and then checks the chain, so
    // an adapter that declares `solana` and lists `eip155:4663` would count as
    // serving that chain at boot — satisfying the ENABLED_CHAINS assertion —
    // and then be unreachable for it, failing CHAIN_UNSUPPORTED at the first
    // call. The EVM adapter is written against this contract, so it is asserted
    // rather than left as an unstated convention.
    expectErrorCode(
      () =>
        new ChainAdapterRegistry(
          [fakeAdapter(ChainNamespace.SOLANA, [CHAIN_IDS.SOLANA_DEVNET, CHAIN_IDS.BASE_MAINNET])],
          [CHAIN_IDS.SOLANA_DEVNET],
        ),
      ChainErrorCode.CHAIN_NAMESPACE_MISMATCH,
    );
  });

  it('starts empty and says so, rather than resolving to undefined', () => {
    expect(new ChainAdapterRegistry([], []).enabledChains()).toEqual([]);
  });
});
