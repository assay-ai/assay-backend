import { ChainId } from '@modules/chains/ports/caip.types';

/**
 * The vocabulary of the signing journal.
 *
 * Small enough to live beside the state machine and the rate limiter rather
 * than inside the entity, for the reason the rest of `domain/` exists: the
 * entity is a storage detail, and these values are read by alerting, by the
 * rotation drill and by whoever is investigating a key. None of those should
 * have to import a TypeORM class to name an outcome.
 */

/**
 * What became of one attempt to use the key.
 *
 * Refusals are values here, not absences, and that is the whole design. A
 * journal that only records successes cannot distinguish "the key was quiet"
 * from "the key was hammered and the limiter held" — and the second is the
 * signal that matters. Every path out of `VerifierSigningService.sign`
 * writes one of these.
 */
export enum SigningOutcome {
  /**
   * A row in this state means the bytes were about to be signed and the outcome
   * was never recorded — a crash, or a `SIGKILL`, in the window between the two
   * writes.
   *
   * **Treat it as a signature that probably exists.** It is the conservative
   * reading and it is the one an investigation needs: the alternative, assuming
   * nothing was signed, is how a real signature ends up with no journal line and
   * the correlation check in `verifier-signing-log-entry.entity.ts` reports a
   * compromise that did not happen.
   */
  ATTEMPTED = 'ATTEMPTED',
  SIGNED = 'SIGNED',
  /** The rate limiter said no. See `signing-rate-limit.ts`. */
  REFUSED_RATE_LIMIT = 'REFUSED_RATE_LIMIT',
  /**
   * The key was not in a state to sign — retired locally, absent from the
   * on-chain registry, revoked, or past its registered expiry.
   */
  REFUSED_KEY_NOT_SIGNABLE = 'REFUSED_KEY_NOT_SIGNABLE',
  /** The backend threw. The key is fine; the custody service was not. */
  FAILED = 'FAILED',
}

/** Did this outcome put a signature into the world? */
export function producedSignature(outcome: SigningOutcome): boolean {
  return outcome === SigningOutcome.SIGNED || outcome === SigningOutcome.ATTEMPTED;
}

/** Who asked for a signature. Mirrors `audit_log_entries.actor_type`. */
export enum SigningRequesterType {
  /** A background job — the ordinary case. */
  JOB = 'job',
  /** A long-lived service acting on its own behalf. */
  SERVICE = 'service',
  /** A human, through an operator tool. Rare, and worth noticing. */
  OPERATOR = 'operator',
  USER = 'user',
}

/**
 * Everything the journal needs about a request, before the signature exists.
 *
 * `purpose` and `requestId` are separate on purpose: `purpose` is the stable
 * grouping key an alert is keyed on, `requestId` is the per-occurrence value.
 * Merging them would make every alert its own category.
 */
export interface SigningRequest {
  /**
   * Which chain's verifier key signs this, and which chain's registry decides
   * whether it may.
   *
   * Required, not defaulted. The argument is that the first question of a
   * compromise investigation — *what could this key have signed* — must be
   * answerable by reading one column, and a default would fill that column
   * with the same value for every row whether or not it was true. It is
   * written to `verifier_signing_log.chain_id`.
   */
  readonly chainId: ChainId;
  readonly purpose: string;
  readonly requestId: string | null;
  readonly requestedBy: {
    readonly type: SigningRequesterType;
    /** Service name, job name, or user id — never a session token. */
    readonly id: string;
  };
  /** The exact bytes to sign. Hashed for the journal; never stored whole. */
  readonly payload: Uint8Array;
}
