import { ChainErrors } from './errors/chains.errors';
import { CHAIN_IDS, ChainId, isChainId } from './ports/caip.types';

/** DI token: the chains this deployment offers. Provided AND exported by `ChainsModule`. */
export const ENABLED_CHAINS = 'ENABLED_CHAINS';

/** The environment variable behind {@link ENABLED_CHAINS}. */
export const ENABLED_CHAINS_ENV = 'ENABLED_CHAINS';

/** The variable this one replaces. Its presence is a boot failure — see below. */
export const LEGACY_ENABLED_CHAINS_ENV = 'SOLANA_ENABLED_CHAINS';

/**
 * What the old `SOLANA_ENABLED_CHAINS` accepted, kept for ONE purpose: printing
 * the CAIP-2 translation of a value we are refusing to read. Nothing here is
 * ever returned as an enabled chain.
 */
const LEGACY_ALIASES: ReadonlyMap<string, ChainId> = new Map([
  ['mainnet', CHAIN_IDS.SOLANA_MAINNET],
  ['mainnet-beta', CHAIN_IDS.SOLANA_MAINNET],
  ['solana-mainnet', CHAIN_IDS.SOLANA_MAINNET],
  ['devnet', CHAIN_IDS.SOLANA_DEVNET],
  ['solana-devnet', CHAIN_IDS.SOLANA_DEVNET],
]);

function translateLegacy(raw: string): string {
  const translated = raw
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0)
    .map((name) => LEGACY_ALIASES.get(name) ?? name);
  return translated.length > 0 ? `${ENABLED_CHAINS_ENV}=${translated.join(',')}` : '';
}

/**
 * Which chains this deployment offers.
 *
 * ## CAIP-2 literals only
 *
 * The short aliases the Solana-only parser accepted (`devnet`, `mainnet`,
 * `mainnet-beta`, …) are gone. They existed because *"a genesis hash is not
 * something anyone types correctly from memory"*, and that benefit disappears
 * the moment a second namespace is present: `mainnet` is then ambiguous between
 * `solana:5eykt4Us…` and `eip155:4663`. An ambiguous alias in the one variable
 * that decides which network is live is the mainnet/devnet mislabel this
 * variable was created to prevent, arriving through the fix. The four ids are
 * listed in `docs/runbooks/chains.md` to copy from.
 *
 * ## No default, and unset is a boot failure
 *
 * `DEFAULT_SOLANA_ENABLED_CHAINS` ("both mainnet and devnet") is deleted. Its
 * justification was byte-for-byte compatibility for a deployment upgrading
 * without setting the variable — a one-time concern that has been served — and
 * under two namespaces it becomes a default that silently enables a *mainnet*
 * nobody asked for. This follows `loadSlashConfig`'s house rule: operational
 * dials fall back so a typo does not stop the process, but a value that
 * silently changes what is live fails loudly at boot, where somebody is
 * looking.
 *
 * ## The renamed variable is enforced
 *
 * Boot fails if `SOLANA_ENABLED_CHAINS` is set *at all*, even when
 * `ENABLED_CHAINS` is also set and valid. A renamed variable that is silently
 * ignored is how a deployment serves a network the operator believes is off.
 *
 * "Set at all" is tested by **presence, not content**: `SOLANA_ENABLED_CHAINS=`
 * — the key still there with its value blanked — fails too. Blanking a value is
 * how an operator neutralises a deployment config key without deleting it, so it is the
 * shape most likely to be left behind by a half-finished migration, and reading
 * it as "not set" would be this guard failing open on the one input it exists
 * to catch.
 */
export function parseEnabledChains(raw: string | undefined): readonly ChainId[] {
  const legacy = process.env[LEGACY_ENABLED_CHAINS_ENV];
  if (legacy !== undefined) {
    throw ChainErrors.enabledChainsLegacyVariableSet({
      legacy: LEGACY_ENABLED_CHAINS_ENV,
      variable: ENABLED_CHAINS_ENV,
      translation: translateLegacy(legacy),
    });
  }

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
