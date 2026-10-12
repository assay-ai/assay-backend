import { Inject, Injectable, Logger } from '@nestjs/common';

import { VerifierSigningKeyEntity, VerifierSigningKeyRepository } from '@database/postgres';
import { ChainId } from '@modules/chains/ports/caip.types';
import { ALERT_PORT, Alert, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';

import { VerificationErrors } from '../../errors/verification.errors';
import { SigningCurve, curveForChain } from '../domain/key-curve';
import { SigningKeyState, canTransition, signsNewAttestations } from '../domain/key-lifecycle';
import { SignerKeyHandle, SignerPort } from '../ports/signer.port';
import {
  RegisteredVerifierStatus,
  VERIFIER_REGISTRY,
  VerifierRegistryEntry,
  VerifierRegistryPort,
} from '../ports/verifier-registry.port';
import { VerifierSigningConfig } from '../signing.config';
import { SIGNERS_BY_CURVE, VERIFIER_SIGNING_CONFIG } from '../signing.constants';

/** A key that passed every check, ready to be handed to the backend. */
export interface SignableKey {
  readonly handle: SignerKeyHandle;
  readonly row: VerifierSigningKeyEntity;
  readonly registry: VerifierRegistryEntry;
  /**
   * The backend holding this key's material.
   *
   * Carried on the result rather than injected separately into
   * `VerifierSigningService`, so that the choice of backend is made **once**,
   * here, beside the choice of key. Two independent resolutions — one for the
   * key, one for the signer — is how a directory row for the EVM chain gets
   * signed by the ed25519 backend.
   */
  readonly signer: SignerPort;
}

/**
 * Which key signs, and whether it is still allowed to.
 *
 * ## Three sources have to agree
 *
 * ```text
 * custody backend   does the material exist and can this process use it?
 * local directory   is this the key we have chosen to sign with?
 * on-chain registry does the settlement program still accept it?
 * ```
 *
 * A key signs only if all three say yes. They are separate because they fail
 * separately and for different reasons — a KMS outage, a rotation half-done, an
 * incident revoke — and an operator debugging at 3am needs the answer to say
 * *which* one said no. Collapsing them into a boolean produces the worst
 * possible message: "cannot sign".
 *
 * ## Why the chain is consulted on the signing path at all
 *
 * The program checks the allowlist again when a slash is submitted, so this
 * check buys no security against a forged attestation — it cannot, and it does
 * not claim to. What it buys is the incident-response property of
 * incident response: *remove the key from
 * the on-chain allowlist* has to be sufficient, on its own, to stop this
 * platform using it. Without this lookup, revoking on-chain would leave the
 * platform happily issuing attestations that are already void, filling the
 * journal with signatures during the exact window somebody is trying to
 * understand what the key did.
 *
 * The lookup is cached for {@link VerifierSigningConfig.registryCacheMs} — the
 * bound on how long that takes to take effect — and a cache miss during an RPC
 * outage **refuses to sign**. Same argument as the rate limiter: the failure
 * mode of signing anyway is that a compromised key keeps working through an
 * outage that an attacker can cause.
 */
@Injectable()
export class VerifierKeyDirectory {
  private readonly logger = new Logger(VerifierKeyDirectory.name);
  /**
   * The registry cache, **keyed by chain**.
   *
   * It was a single slot keyed by address before multichain support, and with two chains that is
   * not a smaller cache — it is a wrong one: a lookup for 46630 evicted the
   * Solana entry and vice versa, so under any mixed traffic at all the cache
   * never hits and every signature waits on an RPC round trip. Worse, the
   * eviction is invisible: the code is correct, just slow, and the
   * "revocation takes effect within one TTL" property it exists to bound
   * silently becomes "within one RPC call, if the RPC answers".
   */
  private readonly cached = new Map<
    ChainId,
    { entry: VerifierRegistryEntry; readAt: number; address: string }
  >();

  constructor(
    @Inject(SIGNERS_BY_CURVE) private readonly signers: ReadonlyMap<SigningCurve, SignerPort>,
    @Inject(VERIFIER_REGISTRY) private readonly registry: VerifierRegistryPort,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    @Inject(VERIFIER_SIGNING_CONFIG) private readonly config: VerifierSigningConfig,
    private readonly keys: VerifierSigningKeyRepository,
  ) {}

  /**
   * The key to sign with, having checked that it may.
   *
   * Throws rather than returning null — every caller's next move on a null
   * would be to throw, and the three failures have genuinely different
   * meanings, which a null cannot carry.
   */
  async resolveSignableKey(chainId: ChainId): Promise<SignableKey> {
    const row = await this.keys.findActive(chainId);
    if (!row) {
      throw VerificationErrors.signingNoActiveKey({ chainId });
    }
    if (!signsNewAttestations(row.state)) {
      // Unreachable through `findActive`, which filters on the state. Kept
      // because the invariant is enforced by a query, and a query is one
      // refactor away from being a different query.
      throw VerificationErrors.signingKeyNotSignable({
        keyId: row.keyId,
        reason: `local state is ${row.state}`,
      });
    }

    const signer = this.signerFor(chainId, row.keyId);
    const handle = await signer.getKey(row.keyId);
    this.assertHandleMatchesChain(chainId, row, handle);
    const entry = await this.readRegistry(chainId, handle);
    this.assertRegistryAllows(row.keyId, entry);
    this.warnIfExpiringSoon(row.keyId, entry);

    return { handle, row, registry: entry, signer };
  }

  /**
   * Everything the directory knows, for the ops read. Never includes material.
   */
  async describe(): Promise<readonly VerifierSigningKeyEntity[]> {
    return this.keys.findAllOrdered();
  }

  /**
   * Move a key through its lifecycle, checking the transition is legal first.
   *
   * The legality check is here rather than in the repository so that an illegal
   * transition is a domain error with both states in it, rather than an update
   * that quietly affects zero rows. The compare-and-swap in the repository is
   * the second half: it decides who wins when two operators try at once.
   */
  async transition(
    keyId: string,
    to: SigningKeyState,
    reason: string,
  ): Promise<VerifierSigningKeyEntity> {
    const row = await this.keys.findByKeyId(keyId);
    if (!row) {
      throw VerificationErrors.signingKeyUnknown({ keyId });
    }
    if (!canTransition(row.state, to)) {
      throw VerificationErrors.signingKeyTransitionInvalid({
        keyId,
        from: row.state,
        to,
        reason:
          row.state === SigningKeyState.REVOKED
            ? 'REVOKED is terminal, here and on-chain'
            : 'not a legal transition',
      });
    }

    const moved = await this.keys.transition(keyId, row.state, to, {
      reason,
      ...timestampFor(to),
    });
    if (!moved) {
      throw VerificationErrors.signingKeyTransitionInvalid({
        keyId,
        from: row.state,
        to,
        reason: 'the key moved underneath this request',
      });
    }

    await this.alerts.emit(this.transitionAlert(keyId, row.state, to, reason));
    return (await this.keys.findByKeyId(keyId)) as VerifierSigningKeyEntity;
  }

  /** Drops the registry cache. The rotation path calls it so a cutover is not delayed. */
  forgetRegistryCache(): void {
    this.cached.clear();
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * The key the directory resolved must be able to sign for the chain that
   * asked.
   *
   * Two checks, and the first is the one that protects money.
   *
   * **Curve.** `eip155`'s `ecrecover` verifies secp256k1 and the Solana
   * program's `ed25519_program` verifies ed25519; neither is a deployment
   * choice. A directory row naming an EVM chain whose `keyId` the ed25519
   * backend happens to hold produces a 64-byte signature that `ecrecover`
   * does not read as malformed — it reads it as a well-formed signature
   * belonging to a stranger, answers `VerifierNotRegistered`, and sends the
   * investigation to the registry rather than to the misrouted key. The curve
   * is intrinsic to the handle, so this cannot be defeated by configuration.
   *
   * **Chain pin.** A backend whose configuration names the chain (the EVM env
   * format requires it) is cross-checked against the row. A backend that does
   * not pin says `null` and only the curve check applies — see
   * `SignerKeyHandle.chainId` for why inventing a chain id for those would be
   * worse than not having one.
   */
  /**
   * The backend that holds this chain's curve, or a refusal that names both.
   *
   * A deployment serving eip155 without `EVM_VERIFIER_SIGNING_KEYS` reaches
   * here, and the honest answer is "there is no secp256k1 backend" rather than
   * "no such key" from a backend that was never going to have it.
   */
  private signerFor(chainId: ChainId, keyId: string): SignerPort {
    const curve = curveForChain(chainId);
    const signer = this.signers.get(curve);
    if (!signer) {
      throw VerificationErrors.signingKeyNotSignable({
        keyId,
        reason: `${chainId} verifies ${curve} and no ${curve} custody backend is bound`,
      });
    }
    return signer;
  }

  private assertHandleMatchesChain(
    chainId: ChainId,
    row: VerifierSigningKeyEntity,
    handle: SignerKeyHandle,
  ): void {
    const required = curveForChain(chainId);
    if (handle.curve !== required) {
      throw VerificationErrors.signingKeyNotSignable({
        keyId: row.keyId,
        reason: `${chainId} verifies ${required}, and this key is ${handle.curve}`,
      });
    }
    if (handle.chainId !== null && handle.chainId !== chainId) {
      throw VerificationErrors.signingKeyNotSignable({
        keyId: row.keyId,
        reason: `the directory names ${chainId}, the custody backend names ${handle.chainId}`,
      });
    }
  }

  private async readRegistry(
    chainId: ChainId,
    handle: SignerKeyHandle,
  ): Promise<VerifierRegistryEntry> {
    const address = this.registry.addressOf(chainId, handle.publicKey);
    const cached = this.cached.get(chainId);
    const fresh =
      cached &&
      cached.address === address &&
      Date.now() - cached.readAt < this.config.registryCacheMs;
    if (fresh && cached) {
      return cached.entry;
    }

    const entry = await this.registry.lookup(chainId, handle.publicKey);
    if (!entry) {
      // Never registered. A deployment misconfiguration, not an incident — and
      // the cache is deliberately not populated with the negative, so a key
      // enrolled a second from now works immediately.
      throw VerificationErrors.signingKeyNotSignable({
        keyId: handle.keyId,
        reason: `${address} is not in ${chainId}'s on-chain verifier registry`,
      });
    }
    this.cached.set(chainId, { entry, readAt: Date.now(), address });
    return entry;
  }

  private assertRegistryAllows(keyId: string, entry: VerifierRegistryEntry): void {
    if (entry.status === RegisteredVerifierStatus.REVOKED) {
      throw VerificationErrors.signingKeyNotSignable({
        keyId,
        reason: `revoked on-chain at ${entry.revokedAt?.toISOString() ?? 'an unknown time'}`,
      });
    }
    // There is no activation delay to check any more: the program dropped
    // `active_from`, so a registered key is usable from the transaction that
    // registered it and a rotation's cutover has nothing to wait for.
    if (entry.expiresAt.getTime() <= Date.now()) {
      throw VerificationErrors.signingKeyNotSignable({
        keyId,
        reason: `on-chain registration expired at ${entry.expiresAt.toISOString()}`,
      });
    }
  }

  /**
   * The key's registration will lapse, and when it does the program stops
   * accepting it — silently, from the platform's point of view, because nothing
   * *changes*. That is the failure this warning exists for: an expiry is the one
   * outage nobody is paged for, because it is an event that does not happen.
   */
  private warnIfExpiringSoon(keyId: string, entry: VerifierRegistryEntry): void {
    const remainingMs = entry.expiresAt.getTime() - Date.now();
    if (remainingMs > this.config.expiryWarningMs) {
      return;
    }
    void this.alerts.emit({
      severity: AlertSeverity.WARN,
      name: 'verifier_key_expiring',
      summary: `Verifier signing key ${keyId} expires on-chain in ${Math.floor(
        remainingMs / 86_400_000,
      )} day(s) — rotate it`,
      details: {
        keyId,
        expiresAt: entry.expiresAt.toISOString(),
        remainingHours: Math.floor(remainingMs / 3_600_000),
      },
      // Otherwise this pages on every registry lookup — every signing
      // request — for the entire warning window before expiry.
      aggregation: AlertAggregation.ONCE_PER_INCIDENT,
      dedupeKey: keyId,
    });
  }

  private transitionAlert(
    keyId: string,
    from: SigningKeyState,
    to: SigningKeyState,
    reason: string,
  ): Alert {
    return {
      // A revocation is the incident-response action, so it pages. Everything
      // else on this path is a planned operation and only needs recording —
      // an alert that fires on every routine rotation is one nobody reads by
      // the time a real revoke happens.
      severity: to === SigningKeyState.REVOKED ? AlertSeverity.CRITICAL : AlertSeverity.INFO,
      name: 'verifier_key_lifecycle',
      summary: `Verifier signing key ${keyId}: ${from} → ${to}`,
      details: { keyId, from, to, reason },
    };
  }
}

/** Which timestamp column a state change stamps. `PENDING` has none — it is the start. */
function timestampFor(to: SigningKeyState): Partial<VerifierSigningKeyEntity> {
  const now = new Date();
  switch (to) {
    case SigningKeyState.ACTIVE:
      return { activatedAt: now };
    case SigningKeyState.RETIRED:
      return { retiredAt: now };
    case SigningKeyState.REVOKED:
      return { revokedAt: now };
    default:
      return {};
  }
}
