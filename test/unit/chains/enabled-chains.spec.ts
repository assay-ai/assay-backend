import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import { parseEnabledChains } from '@modules/chains/enabled-chains';
import { CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { ChainAdapter } from '@modules/chains/ports/chain-adapter.port';
import { AppError } from '@shared/errors/app-errors';

const MAINNET = CHAIN_IDS.SOLANA_MAINNET;
const DEVNET = CHAIN_IDS.SOLANA_DEVNET;
const EVM_TESTNET = 'eip155:46630' as ChainId;

/**
 * `ENABLED_CHAINS` — which chains THIS deployment offers.
 *
 * The predecessor accepted short aliases (`devnet`, `mainnet`) and defaulted to
 * "both Solana networks" when unset. Both are removed, and the removals are the
 * subject of most of this file: under two namespaces `mainnet` is ambiguous
 * between `solana:5eykt…` and `eip155:4663`, and a default that silently
 * enables a mainnet nobody asked for is the mislabel this variable exists to
 * prevent, arriving through the fix.
 */
describe('parseEnabledChains', () => {
  const call = (raw: string | undefined): AppError => {
    try {
      parseEnabledChains(raw);
    } catch (error) {
      return error as AppError;
    }
    throw new Error('expected parseEnabledChains to throw');
  };

  describe('fail-closed', () => {
    it.each([undefined, '', '   ', ',', ' , , '])('throws on %p — there is no default', (raw) => {
      expect(call(raw).errorCode).toBe(ChainErrorCode.CHAIN_ENABLED_CHAINS_INVALID);
    });

    it('throws naming the offending entry when one is not a CAIP-2 id', () => {
      const error = call(`${DEVNET},devnet`);
      expect(error.errorCode).toBe(ChainErrorCode.CHAIN_ENABLED_CHAINS_INVALID);
      expect(error.message).toContain('devnet');
    });

    it.each(['mainnet', 'mainnet-beta', 'solana-devnet', 'DEVNET'])(
      'rejects the alias %p that the Solana-only parser accepted',
      (alias) => {
        expect(call(alias).errorCode).toBe(ChainErrorCode.CHAIN_ENABLED_CHAINS_INVALID);
      },
    );

    it('rejects a CAIP-10 account id — a chain list is not an account list', () => {
      expect(call(`${DEVNET}:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM`).errorCode).toBe(
        ChainErrorCode.CHAIN_ENABLED_CHAINS_INVALID,
      );
    });
  });

  describe('accepts CAIP-2 literals', () => {
    it('parses one', () => {
      expect(parseEnabledChains(DEVNET)).toEqual([DEVNET]);
    });

    it('parses several across namespaces, preserving order', () => {
      expect(parseEnabledChains(`${DEVNET}, ${EVM_TESTNET} ,${MAINNET}`)).toEqual([
        DEVNET,
        EVM_TESTNET,
        MAINNET,
      ]);
    });

    it('de-duplicates, preserving first-seen order', () => {
      expect(parseEnabledChains(`${MAINNET},${DEVNET},${MAINNET}`)).toEqual([MAINNET, DEVNET]);
    });

    it('is case-sensitive — a CAIP-2 reference is not lowercased', () => {
      // `solana:etwt…` is a DIFFERENT chain id from `solana:EtWT…` as far as
      // the grammar is concerned, and lowercasing it would silently enable a
      // genesis hash nobody deployed against.
      expect(parseEnabledChains(DEVNET.toLowerCase())).toEqual([DEVNET.toLowerCase()]);
      expect(parseEnabledChains(DEVNET.toLowerCase())).not.toEqual([DEVNET]);
    });
  });

  describe('an enabled chain nothing serves fails the BOOT, not the first request', () => {
    // `parseEnabledChains` cannot know which adapters exist, so this row lives on the
    // registry: it is constructed once at boot from CHAIN_ADAPTERS and ENABLED_CHAINS, and
    // it refuses to exist if the two disagree. Without this, an operator who enables
    // `eip155:46630` on a Solana-only build finds out from a 500 on GET /chains.
    const solanaOnly = {
      namespace: 'solana',
      supportedChains: [DEVNET],
    } as unknown as ChainAdapter;

    it('throws at construction, naming the unserved chain and what IS served', () => {
      let thrown: AppError | undefined;
      try {
        new ChainAdapterRegistry([solanaOnly], [DEVNET, EVM_TESTNET]);
      } catch (error) {
        thrown = error as AppError;
      }
      expect(thrown?.errorCode).toBe(ChainErrorCode.CHAIN_ENABLED_CHAINS_INVALID);
      expect(thrown?.message).toContain(EVM_TESTNET);
      expect(thrown?.message).toContain(DEVNET);
    });

    it('constructs when every enabled chain is served', () => {
      expect(() => new ChainAdapterRegistry([solanaOnly], [DEVNET])).not.toThrow();
    });

    it('does not serve a chain the operator disabled, even when an adapter offers it', () => {
      // The other direction, and the one the variable was created for: an
      // adapter with a hard-coded `supportedChains` must not be able to
      // advertise, reconcile or accept a chain absent from ENABLED_CHAINS.
      // `enabledChains()` is what `ReconciliationJob` and `ProviderPayoutBatchJob`
      // walk — mainnet appearing there is what paged RECONCILIATION_BLIND
      // forever on a devnet-only deployment.
      const bothNetworks = {
        namespace: 'solana',
        supportedChains: [MAINNET, DEVNET],
      } as unknown as ChainAdapter;

      const registry = new ChainAdapterRegistry([bothNetworks], [DEVNET]);

      expect(registry.enabledChains()).toEqual([DEVNET]);
      let thrown: AppError | undefined;
      try {
        registry.resolve(MAINNET);
      } catch (error) {
        thrown = error as AppError;
      }
      expect(thrown?.errorCode).toBe(ChainErrorCode.CHAIN_UNSUPPORTED);
    });
  });
});
