import { CHAIN_IDS, ChainId, ChainNamespace } from '@modules/chains/ports/caip.types';
import { ChainVerifierRegistry } from '@modules/chains/multiplex/chain-verifier-registry';
import {
  RegisteredVerifierStatus,
  VerifierRegistryEntry,
  VerifierRegistryPort,
} from '@modules/verification/signing/ports/verifier-registry.port';

/**
 * The first namespace multiplexer, and the one that decides whether a
 * verifier key is enrolled.
 *
 * ## The degenerate this suite exists to kill
 *
 * `registryFor = () => this.byNamespace.values().next().value` — a
 * "multiplexer" that returns the first entry regardless of chain. It answers
 * every call, returns plausible data, and reports a key registered on Solana as
 * enrolled on 46630. Every assertion below therefore names **which**
 * implementation answered, not merely that an answer came back.
 */
describe('ChainVerifierRegistry', () => {
  const SOLANA = CHAIN_IDS.SOLANA_DEVNET;
  const EVM = CHAIN_IDS.ROBINHOOD_TESTNET;

  it('routes each namespace to its own implementation, both ways', async () => {
    const solana = fake('solana');
    const evm = fake('evm');
    const registry = new ChainVerifierRegistry(
      new Map([
        [ChainNamespace.SOLANA, solana.port],
        [ChainNamespace.EIP155, evm.port],
      ]),
    );

    expect(registry.addressOf(SOLANA, new Uint8Array(32))).toBe('solana-address');
    expect(registry.addressOf(EVM, new Uint8Array(65))).toBe('evm-address');
    await expect(registry.lookup(SOLANA, new Uint8Array(32))).resolves.toEqual(
      expect.objectContaining({ label: 'solana' }),
    );
    await expect(registry.lookup(EVM, new Uint8Array(65))).resolves.toEqual(
      expect.objectContaining({ label: 'evm' }),
    );

    // And the one the other side did NOT answer. "Routed correctly" is only
    // meaningful if the wrong implementation was never consulted — a
    // multiplexer that asked both and returned the first non-null would pass
    // every assertion above.
    expect(solana.calls).toEqual([SOLANA, SOLANA]);
    expect(evm.calls).toEqual([EVM, EVM]);
  });

  it('passes the chain down, not just the namespace', async () => {
    // The implementations serve several chains each — one `EvmVerifierRegistry`
    // covers every eip155 deployment — so dropping the chain here would make
    // every EVM lookup read whichever contract the callee defaulted to.
    const evm = fake('evm');
    const registry = new ChainVerifierRegistry(new Map([[ChainNamespace.EIP155, evm.port]]));

    await registry.lookup(CHAIN_IDS.ROBINHOOD_MAINNET, new Uint8Array(65));

    expect(evm.calls).toEqual([CHAIN_IDS.ROBINHOOD_MAINNET]);
  });

  it('throws for a namespace nobody wired up, rather than returning null', async () => {
    // `null` from `lookup` means "this key was never enrolled" — a
    // misconfiguration an operator fixes by enrolling a key. Answering that for
    // a chain nobody wired up sends them to the admin Ledger to solve a problem
    // that lives in a provider list.
    const registry = new ChainVerifierRegistry(new Map([[ChainNamespace.SOLANA, fake('s').port]]));

    expect(() => registry.addressOf(EVM, new Uint8Array(65))).toThrow(
      /No chain adapter is enabled for eip155:46630/,
    );
    await expect(registry.lookup(EVM, new Uint8Array(65))).rejects.toThrow(
      /No chain adapter is enabled for eip155:46630/,
    );
  });
});

function fake(label: string): { port: VerifierRegistryPort; calls: ChainId[] } {
  const calls: ChainId[] = [];
  return {
    calls,
    port: {
      addressOf(chainId: ChainId): string {
        calls.push(chainId);
        return `${label}-address`;
      },
      async lookup(chainId: ChainId): Promise<VerifierRegistryEntry | null> {
        calls.push(chainId);
        return {
          address: `${label}-address`,
          status: RegisteredVerifierStatus.ACTIVE,
          label,
          registeredAt: new Date(0),
          expiresAt: new Date(0),
          revokedAt: null,
        };
      },
    },
  };
}
