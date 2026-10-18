import { ChainErrors } from './errors/chains.errors';
import { ChainId, isChainId } from './ports/caip.types';

/** DI token: the chains this deployment offers. Provided AND exported by `ChainsModule`. */
export const ENABLED_CHAINS = 'ENABLED_CHAINS';

/** The environment variable behind {@link ENABLED_CHAINS}. */
export const ENABLED_CHAINS_ENV = 'ENABLED_CHAINS';

/**
 * Which chains this deployment offers.
 *
 * ## CAIP-2 literals only
 *
 * Short aliases (`devnet`, `mainnet`, …) are not accepted: with a second
 * namespace present, `mainnet` is ambiguous between `solana:5eykt4Us…` and
 * `eip155:4663`, and an ambiguous alias in the one variable that decides which
 * network is live is a mainnet/devnet mislabel waiting to happen. The four ids are
 * listed in `docs/runbooks/chains.md` to copy from.
 *
 * ## No default, and unset is a boot failure
 *
 * Under two namespaces a default silently enables a *mainnet* nobody asked
 * for. This follows `loadSlashConfig`'s house rule: operational dials fall back
 * so a typo does not stop the process, but a value that silently changes what
 * is live fails loudly at boot, where somebody is looking.
 */
export function parseEnabledChains(raw: string | undefined): readonly ChainId[] {
  const names = (raw ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  if (names.length === 0) {
    throw ChainErrors.enabledChainsInvalid({
      variable: ENABLED_CHAINS_ENV,
      value: raw ?? '(unset)',
      accepted: 'a comma-separated list of CAIP-2 chain ids — see docs/runbooks/chains.md',
    });
  }

  const chains: ChainId[] = [];
  for (const name of names) {
    if (!isChainId(name)) {
      throw ChainErrors.enabledChainsInvalid({
        variable: ENABLED_CHAINS_ENV,
        value: name,
        accepted: 'a CAIP-2 chain id, e.g. solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      });
    }
    if (!chains.includes(name)) {
      chains.push(name);
    }
  }

  return chains;
}
