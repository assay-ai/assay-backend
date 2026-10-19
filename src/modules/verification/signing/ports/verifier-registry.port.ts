import { ChainId } from '@modules/chains/ports/caip.types';

/**
 * The on-chain verifier allowlist, read-only, behind a port.
 *
 * ## Read-only, and that is a security decision rather than a scope decision
 *
 * There is no `register` and no `revoke` here, and there must not be. The
 * program's `register_verifier` is admin-only precisely so that the service
 * holding the *signing* key cannot enrol keys — if one process could do both,
 * compromising it would be sufficient to mint a verifier and slash every
 * provider, which is the exact property the separation of keys exists to
 * deny. Writes are an operator action, out of band, with a key this codebase
 * never sees: `scripts/verifier-key/registry.ts`.
 *
 * Putting a `register()` on this interface would not be a convenience. It would
 * be an invitation to wire the admin key into the application, and the day
 * somebody did, every control downstream of the allowlist would be worth
 * nothing.
 *
 * ## What it is for, then
 *
 * Failing closed. The platform signs with a key only if the chain agrees the
 * key is enrolled, unrevoked, **active** and unexpired — so a key revoked
 * during an incident stops being used by *us* within one cache TTL, rather than
 * at the moment somebody remembers to update a config. The chain re-checks all
 * of it at `slash` regardless; this check exists so the platform does not spend
 * an outage issuing attestations that are already dead.
 *
 * "Active" is the condition that is easy to miss
 * because it fails in the *other* direction from the rest: a key that has been
 * enrolled but has not finished `Config::verifier_activation_delay_seconds`
 * looks completely healthy — `status == Active`, expiry years out — and every
 * attestation it signs is refused with `VerifierNotYetActive`. Mirroring
 * `expiresAt` without mirroring this would leave a rotation cutover failing at
 * the chain with no local explanation for it.
 */

/**
 * ## Every method carries the chain it is asking about
 *
 * Both methods gained a leading `chainId`, and it is not decoration. Each chain
 * keeps its **own** verifier allowlist — the Solana settlement program's
 * `VerifierKey` PDA and `AssayConfig.verifierKey` on eip155 are different
 * registries holding different keys — so "is this key enrolled" is not a
 * question with one answer. Without the argument, `ChainVerifierRegistry` could
 * not dispatch and every lookup would silently be answered by whichever
 * implementation happened to be bound: a key registered on Solana would read as
 * enrolled on 46630, which is the one mistake this port exists to make
 * impossible.
 */

/** The lifecycle the program keeps, mirrored — see `VerifierStatus` in the program's `state.rs`. */
export enum RegisteredVerifierStatus {
  ACTIVE = 'ACTIVE',
  REVOKED = 'REVOKED',
}

export interface VerifierRegistryEntry {
  /** The verifier identity in the chain's own notation. Base58 on Solana. */
  readonly address: string;
  readonly status: RegisteredVerifierStatus;
  /** The operator's label, as recorded on-chain. Usually the `keyId`. */
  readonly label: string;
  readonly registeredAt: Date;
  /**
   * After this, the program stops accepting the key whatever its status.
   *
   * There is no `activeFrom` any more: the program dropped the activation delay, so
   * a registered key is usable from the transaction that registered it.
   */
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface VerifierRegistryPort {
  /**
   * Render a raw public key in the chain's address notation.
   *
   * Here rather than in the signing module because base58 and EIP-55 are chain
   * conventions, and `SignerPort` is deliberately chain-agnostic — it deals in
   * opaque bytes. This is the one place the two vocabularies meet, and it is
   * why the key length differs by chain: 32 bytes of ed25519 on Solana, 65 of
   * uncompressed secp256k1 on eip155.
   */
  addressOf(chainId: ChainId, publicKey: Uint8Array): string;

  /**
   * The registry entry for this key, or `null` if it was never registered.
   *
   * `null` and `REVOKED` are different answers and callers must treat them so:
   * never-registered is a deployment that was set up wrong, revoked is an
   * incident. Collapsing them into a boolean loses the distinction at the only
   * moment anybody needs it.
   */
  lookup(chainId: ChainId, publicKey: Uint8Array): Promise<VerifierRegistryEntry | null>;
}

export const VERIFIER_REGISTRY = 'VERIFIER_REGISTRY';
