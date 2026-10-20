import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { VerifierSigningLogEntryRepository } from '@database/postgres';
import { ChainId } from '@modules/chains/ports/caip.types';
import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';

import { VerificationErrors } from '../../errors/verification.errors';
import { SigningOutcome, SigningRequest } from '../domain/signing-journal';
import {
  RateWindowObservation,
  SigningRateVerdict,
  decideSigningRate,
} from '../domain/signing-rate-limit';
import { VerifierSigningConfig } from '../signing.config';
import { VERIFIER_SIGNING_CONFIG } from '../signing.constants';
import { RedisSigningRateLimiter } from './redis-signing-rate-limiter.service';
import { SignableKey, VerifierKeyDirectory } from './verifier-key-directory.service';

export interface SignatureResult {
  readonly keyId: string;
  /**
   * The raw public key — 32 bytes of ed25519, or 65 of uncompressed secp256k1.
   * The caller renders it however its chain wants.
   */
  readonly publicKey: Uint8Array;
  readonly signature: Uint8Array;
  /** The journal row this signature is recorded on. */
  readonly journalId: string;
  readonly signedAt: Date;
}

/**
 * The only way anything in this codebase gets a verifier signature.
 *
 * ```text
 *  sign(request)
 *      │
 *      ├─ 1. which key?        VerifierKeyDirectory — local state AND the chain
 *      ├─ 2. open the journal  identity + payload hash, BEFORE any signature exists
 *      ├─ 3. rate limit        counted, decided, and alerted on
 *      ├─ 4. sign              SignerPort — env today, KMS later, unchanged here
 *      └─ 5. settle the journal
 * ```
 *
 * Every early exit between 2 and 5 settles the journal row too. A refusal that
 * left no record would be the one shape of event this design cannot afford to
 * lose: a burst of refusals *is* the signal that the key is being abused, and a
 * journal that only holds successes reads identically to a quiet week.
 *
 * ## Order matters, twice
 *
 * **The journal opens before the rate limiter runs**, so a refused attempt is
 * recorded with the identity of whoever made it. Rate-limiting first would drop
 * exactly the attempts an investigator wants to attribute.
 *
 * **The journal opens before the signature is produced**, so the payload hash
 * exists even if this process dies mid-signature. That is what makes "an
 * attestation on-chain with no journal row was signed outside this platform" a
 * sound inference rather than a hopeful one — see
 * `verifier-signing-log-entry.entity.ts`.
 *
 * ## What this class deliberately does not do
 *
 * It does not build the attestation, and it has no idea what the bytes mean.
 * The canonical encoding — which fields the signature covers, and therefore
 * which fields an attacker can still change afterwards — belongs to the attestation encoder, and it
 * belongs beside the on-chain verifier rather than inside the component whose
 * job is custody and accounting.
 */
@Injectable()
export class VerifierSigningService {
  private readonly logger = new Logger(VerifierSigningService.name);

  constructor(
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    @Inject(VERIFIER_SIGNING_CONFIG) private readonly config: VerifierSigningConfig,
    private readonly directory: VerifierKeyDirectory,
    private readonly rateLimiter: RedisSigningRateLimiter,
    private readonly journal: VerifierSigningLogEntryRepository,
  ) {}

  /**
   * The active key's raw **public** key on one chain, without signing anything.
   *
   * Exists because a caller can need the key's *address* without needing a
   * signature: `SolanaSlashExecutor` names the verifier key as the fee payer of
   * `execute_slash` and `expire_slash`, neither of which carries an attestation.
   * Recovering the address by signing an empty payload — the obvious shortcut —
   * would put a journal row against every such submission that attests to
   * nothing, and this journal is the audit record for the key: an entry whose
   * payload hash is the hash of zero bytes is noise in exactly the log an
   * investigator reads first.
   *
   * Runs the same three checks `sign()` opens with, because it resolves through
   * the same {@link VerifierKeyDirectory}: no active key, a locally unsignable
   * one, or an on-chain revocation all refuse here too. That is deliberate —
   * naming a fee payer this process may not sign with would build a transaction
   * that cannot be signed, and failing at the directory says why.
   *
   * Returns no private key material and therefore does not breach `docs/architecture.md`
   * §"Signing Keys" — a KMS, Turnkey or Vault signer can implement this, which
   * is the property that rule actually protects.
   */
  async publicKey(chainId: ChainId): Promise<Uint8Array> {
    const key = await this.directory.resolveSignableKey(chainId);
    return key.handle.publicKey;
  }

  async sign(request: SigningRequest): Promise<SignatureResult> {
    // 1. Before anything is written: is there a key at all, and may it sign?
    //    A refusal here has no journal row on purpose — nothing was attempted
    //    with a key, because no key was resolved, and a row with no `key_id`
    //    would be a line in the key's history that is not about the key.
    const key = await this.directory.resolveSignableKey(request.chainId);
    const publicKeyHex = Buffer.from(key.handle.publicKey).toString('hex');
    const payloadSha256 = createHash('sha256').update(request.payload).digest('hex');

    // 2. Identity, on the record, before a signature can exist.
    const journalId = await this.journal.openAttempt({
      keyId: key.handle.keyId,
      publicKey: publicKeyHex,
      // What this key could have signed, answerable by reading one
      // column rather than by parsing `purpose`.
      chainId: request.chainId,
      purpose: request.purpose,
      requestId: request.requestId,
      requestedByType: request.requestedBy.type,
      requestedById: request.requestedBy.id,
      payloadSha256,
    });

    // 3. Rate.
    const observations = await this.observeRate(journalId, key, request);
    const rate = decideSigningRate(observations, this.config.rateLimits);
    await this.raiseRateAlerts(key, request, rate.elevated, rate.verdict);
    // The key-wide count, stamped on the row rather than derived later by
    // counting: it is the rate *at the moment of the decision*, which survives
    // rows being archived out and lets an alert be reconciled with the attempt
    // that caused it.
    const observedInWindow = observations.find((o) => o.scope.startsWith('key:'))?.observed;

    if (rate.verdict === SigningRateVerdict.REFUSE) {
      const breached = rate.breached as RateWindowObservation;
      await this.journal.settleAttempt(journalId, SigningOutcome.REFUSED_RATE_LIMIT, {
        refusalReason: `${breached.scope} at ${breached.observed}/${breached.limit}`,
        observedInWindow,
      });
      throw VerificationErrors.signingRateLimited({
        scope: breached.scope,
        observed: breached.observed,
        limit: breached.limit,
        windowSeconds: this.config.rateLimits.windowSeconds,
      });
    }

    // 4. Sign.
    let signature: Uint8Array;
    try {
      // The backend the DIRECTORY resolved, beside the key it resolved. This
      // class deliberately injects no `SignerPort` of its own: with two curves
      // live, a second, independent resolution here is how the ed25519 backend
      // ends up being handed an EVM key id.
      signature = await key.signer.sign(key.handle.keyId, request.payload);
    } catch (error) {
      await this.journal.settleAttempt(journalId, SigningOutcome.FAILED, {
        // The custody backend's own message, and nothing from the payload. A
        // KMS error can carry a request id and a reason; neither is a secret,
        // and both are what makes the row actionable.
        refusalReason: truncate(error instanceof Error ? error.message : 'unknown signer failure'),
        observedInWindow,
      });
      throw error;
    }

    // 5. Settle.
    const signatureHex = Buffer.from(signature).toString('hex');
    await this.journal.settleAttempt(journalId, SigningOutcome.SIGNED, {
      signature: signatureHex,
      observedInWindow,
    });

    return {
      keyId: key.handle.keyId,
      publicKey: key.handle.publicKey,
      signature,
      journalId,
      signedAt: new Date(),
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Count the attempt, and treat a counter that will not answer as a refusal.
   *
   * `RedisSigningRateLimiter` explains why this fails closed. What is worth
   * noting *here* is that the journal row is settled before the throw: an
   * outage that stops signing must still leave a record that somebody asked,
   * or the gap in the journal looks like a quiet period rather than an
   * incident.
   */
  private async observeRate(
    journalId: string,
    key: SignableKey,
    request: SigningRequest,
  ): Promise<readonly RateWindowObservation[]> {
    try {
      return await this.rateLimiter.observe(key.handle.keyId, request.requestedBy.id);
    } catch (error) {
      await this.journal.settleAttempt(journalId, SigningOutcome.REFUSED_RATE_LIMIT, {
        refusalReason: 'the signing rate counter is unavailable — failing closed',
      });
      await this.alerts.emit({
        severity: AlertSeverity.CRITICAL,
        name: 'verifier_signing_rate_counter_down',
        summary: 'The verifier signing rate counter is unavailable; attestation issuance is halted',
        details: {
          keyId: key.handle.keyId,
          requestedBy: request.requestedBy.id,
          error: truncate(error instanceof Error ? error.message : 'unknown'),
        },
        // Otherwise a down counter pages once per signing attempt — dozens of
        // times a second under production traffic — for the whole outage.
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: key.handle.keyId,
      });
      throw VerificationErrors.signingRateLimited({
        scope: 'counter-unavailable',
        windowSeconds: this.config.rateLimits.windowSeconds,
      });
    }
  }

  /**
   * One alert per elevated scope.
   *
   * Severity tracks the verdict rather than the number: a refusal pages,
   * because the key has hit a ceiling that production traffic is two orders of
   * magnitude below (`signing-rate-limit.ts` §defaults), and being at that
   * ceiling is either an incident or a bug that will become one. Crossing the
   * warn line only warns.
   *
   * `name` is fixed and the numbers are in `details`, per `AlertPort` — routing
   * keys off the name, so putting the count in it would make every burst its
   * own alert class and none of them routable.
   */
  private async raiseRateAlerts(
    key: SignableKey,
    request: SigningRequest,
    elevated: readonly RateWindowObservation[],
    verdict: SigningRateVerdict,
  ): Promise<void> {
    if (elevated.length === 0) {
      return;
    }
    const severity =
      verdict === SigningRateVerdict.REFUSE ? AlertSeverity.CRITICAL : AlertSeverity.WARN;

    await Promise.all(
      elevated.map((observation) =>
        this.alerts.emit({
          severity,
          name: 'verifier_signing_rate_elevated',
          summary:
            `Verifier signing rate ${verdict === SigningRateVerdict.REFUSE ? 'exceeded' : 'elevated'}` +
            ` for ${observation.scope} — ${observation.observed}/${observation.limit}`,
          details: {
            keyId: key.handle.keyId,
            scope: observation.scope,
            observed: observation.observed,
            limit: observation.limit,
            windowSeconds: this.config.rateLimits.windowSeconds,
            purpose: request.purpose,
            requestedBy: `${request.requestedBy.type}:${request.requestedBy.id}`,
          },
          // Otherwise a sustained burst pages once per signing request for as
          // long as the scope stays elevated.
          aggregation: AlertAggregation.ONCE_PER_INCIDENT,
          dedupeKey: `${key.handle.keyId}:${observation.scope}`,
        }),
      ),
    );
  }
}

/** `refusal_reason` is `varchar(256)`, and an over-long message must not lose the row. */
function truncate(message: string): string {
  return message.length <= 240 ? message : `${message.slice(0, 237)}...`;
}
