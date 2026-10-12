import { privateKeyToAccount } from 'viem/accounts';

import { takeOnceFromEnv } from '@modules/verification/signing/backends/env-key-source';

import { ChainErrors } from '../errors/chains.errors';
import { ChainId, ChainNamespace, isChainId, namespaceOf } from '../ports/caip.types';

/** The variable holding the relayer EOA's key(s). One entry per chain. */
export const EVM_RELAYER_KEYS_ENV = 'EVM_RELAYER_KEYS';

/** DI token: `readonly EvmRelayerKeySource[]`, parsed once at boot. */
export const EVM_RELAYER_KEY_SOURCES = 'EVM_RELAYER_KEY_SOURCES';

/**
 * The variable holding the REDEEMER EOA's key(s): the address in
 * `Config.params().redeemer`. Same shape and same take-once handling as
 * {@link EVM_RELAYER_KEYS_ENV}, and a different key on every chain.
 */
export const EVM_REDEEMER_KEYS_ENV = 'EVM_REDEEMER_KEYS';

/** DI token: the redeemer's `readonly EvmRelayerKeySource[]`, parsed once at boot. */
export const EVM_REDEEMER_KEY_SOURCES = 'EVM_REDEEMER_KEY_SOURCES';

export interface EvmRelayerKeySource {
  readonly chainId: ChainId;
  /** The 32-byte secp256k1 scalar, `0x`-prefixed hex. Zeroed after the account loads. */
  readonly secretKey: `0x${string}`;
}

/**
 * Read `EVM_RELAYER_KEYS` (or `variable`, e.g. `EVM_REDEEMER_KEYS`) and
 * **remove it from `process.env`**.
 *
 * Goes through the same {@link takeOnceFromEnv} the verifier keys go through,
 * and that is the point rather than an economy: there is one deletion and one
 * take-once cache in this codebase, so a second key-bearing variable cannot
 * quietly acquire a second, weaker reader. Everything that function's comment
 * says about crash reporters, diagnostics routes and inherited child
 * environments is true of this variable too.
 *
 * ## Keyed by chain, not by key id
 *
 * Unlike a verifier key, a relayer key has no identity anybody records: nothing
 * attests with it, no registry enrols it, and no journal row names it. What
 * decides which one to use is the chain the transaction goes to, so that is the
 * key of the map. A `keyId` here would be a field nothing ever reads.
 *
 * ## No error path quotes the value
 *
 * `JSON.parse`'s own message contains the offending input, so it is caught and
 * replaced. A boot failure on a malformed relayer key must not print the key.
 */
export function takeEvmRelayerKeys(
  env: NodeJS.ProcessEnv,
  variable: string = EVM_RELAYER_KEYS_ENV,
): readonly EvmRelayerKeySource[] {
  return takeOnceFromEnv(env, variable, (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw ChainErrors.programNotConfigured({
        what: `${variable} — it is not valid JSON`,
        variable,
      });
    }
    if (!Array.isArray(parsed)) {
      throw ChainErrors.programNotConfigured({
        what: `${variable} — it must be a JSON array of { chainId, secretKey }`,
        variable,
      });
    }

    const seen = new Set<string>();
    return parsed.map((entry, index) => {
      const chainId = readChainId(entry, index, variable);
      if (seen.has(chainId)) {
        throw ChainErrors.programNotConfigured({
          what: `${variable} — ${chainId} appears twice, so which key sends is undefined`,
          variable,
        });
      }
      seen.add(chainId);
      return { chainId, secretKey: readScalar(entry, chainId, variable) };
    });
  });
}

// ── Internals ──────────────────────────────────────────────────────────────

function readChainId(entry: unknown, index: number, variable: string): ChainId {
  const chainId = (entry as { chainId?: unknown })?.chainId;
  if (typeof chainId !== 'string' || !isChainId(chainId)) {
    throw ChainErrors.programNotConfigured({
      what: `${variable} entry ${index} — no CAIP-2 chainId, e.g. "eip155:46630"`,
      variable,
    });
  }
  if (namespaceOf(chainId) !== ChainNamespace.EIP155) {
    // A Solana chain here would produce a relayer nobody can use and, worse, a
    // deployment that believes it has one. The fee payer on Solana is
    // `FeePayerSignerPort` and a different key entirely.
    throw ChainErrors.unsupportedChain({ chainId });
  }
  return chainId;
}

function readScalar(entry: unknown, chainId: ChainId, variable: string): `0x${string}` {
  const secret = (entry as { secretKey?: unknown })?.secretKey;
  if (typeof secret !== 'string') {
    throw ChainErrors.programNotConfigured({
      what: `${variable} — the entry for ${chainId} has no secretKey`,
      variable,
    });
  }
  const hex = secret.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw ChainErrors.programNotConfigured({
      what: `${variable} — the entry for ${chainId} is not a 32-byte hex scalar`,
      variable,
    });
  }
  return `0x${hex}`;
}

/**
 * Refuse a deployment whose redeemer and relayer are the same key on any chain.
 *
 * The split is the point of having two variables: the relayer carries
 * buyer-signed requests and holds no on-chain role, the redeemer is the one
 * address `redeemVoucher[Batch]` accepts. One key in both places makes a leak
 * of either the leak of both. Compared by derived ADDRESS, so a differently
 * spelled scalar (case, `0x` prefix) cannot slip through, and the error names
 * the chain and the variables, never a key or an address.
 *
 * A chain present in only one list is not a failure here: a missing key fails
 * loudly at its first send, the same as before the split.
 */
export function assertDistinctRedeemerKeys(
  relayer: readonly EvmRelayerKeySource[],
  redeemer: readonly EvmRelayerKeySource[],
): void {
  const relayerByChain = new Map(relayer.map((source) => [source.chainId, source.secretKey]));
  for (const source of redeemer) {
    const relayerKey = relayerByChain.get(source.chainId);
    if (relayerKey === undefined) continue;
    if (privateKeyToAccount(relayerKey).address === privateKeyToAccount(source.secretKey).address) {
      throw ChainErrors.configValueInvalid({
        variable: EVM_REDEEMER_KEYS_ENV,
        accepted:
          `a redeemer key for ${source.chainId} that is NOT the ${EVM_RELAYER_KEYS_ENV} key for ` +
          `the same chain. The redeemer is Config.params().redeemer; the relayer holds no ` +
          `on-chain role and must be a different key`,
      });
    }
  }
}

/**
 * Per chain, the ADDRESS each key derives to. What `EvmVaultService` compares
 * with the live `params().redeemer`; the key itself goes no further.
 */
export function keyAddressesByChain(
  sources: readonly EvmRelayerKeySource[],
): ReadonlyMap<ChainId, `0x${string}`> {
  return new Map(
    sources.map((source) => [source.chainId, privateKeyToAccount(source.secretKey).address]),
  );
}
