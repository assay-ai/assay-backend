import { Column, Entity, Index } from 'typeorm';

// Relative — see `verifier-signing-key.entity.ts` for why an alias here breaks
// the migration CLI.
import { SigningOutcome } from '../../../modules/verification/signing/domain/signing-journal';

import { AbstractEntityWithoutSoftDelete } from './abstract.entity';

/**
 * Every use, and every attempted use, of a verifier signing key.
 *
 * > *"Signing log: every signature records who requested it, for which requestId,
 * > and when. This log is the only thing that tells whether the key has been
 * > abused."*
 *
 * ## The property that makes this worth writing
 *
 * A journal of our own signing does **not** catch the worst case on its own. An
 * attacker who exfiltrates the key signs somewhere else, and nothing they do
 * appears here. So the value is not in what the table contains — it is in what
 * the table's *absence of a row* proves:
 *
 * > every attestation the settlement program accepts must correspond to a row
 * > here, matched by `payload_sha256`. One that does not is a signature this
 * > platform did not produce, and therefore a key that has left the building.
 *
 * That inference only holds if the hash is recorded **before** the signature
 * exists, which is why a row is inserted with {@link SigningOutcome.ATTEMPTED}
 * and updated afterwards rather than written once at the end. A crash between
 * signing and logging would otherwise produce a real signature with no row, and
 * the one detection this design offers would report a compromise that did not
 * happen — which is how a control gets switched off.
 *
 * ## Append-only, with exactly one exception, stated
 *
 * Rows are never deleted and never soft-deleted. After insert, **only `outcome`,
 * `signature`, `refusal_reason` and `completed_at` are ever written**, once, by
 * the same call that inserted the row. Identity — who asked, for what,
 * over which bytes, when — is fixed at insert and never updated, because those
 * are the fields an investigator has to be able to trust.
 *
 * ## No `organization_id`
 *
 * Same reasoning as `verifier-signing-key.entity.ts`: the signing key is the
 * platform's, not a tenant's. `requested_by_*` is the actor pair
 * `audit-log-entry.entity.ts` uses, for the same reason — most of these rows are
 * written by a worker, not a person.
 */
@Entity('verifier_signing_log')
@Index('idx_verifier_signing_log_key_created', ['keyId', 'createdAt'])
@Index('idx_verifier_signing_log_request', ['requestId'])
@Index('idx_verifier_signing_log_payload', ['payloadSha256'])
export class VerifierSigningLogEntryEntity extends AbstractEntityWithoutSoftDelete {
  /** `verifier_signing_keys.key_id`. Not an FK — see the migration for why. */
  @Column({ name: 'key_id', type: 'varchar', length: 64 })
  keyId: string;

  /**
   * The public key as it was at the time, hex.
   *
   * Denormalised from `verifier_signing_keys` deliberately. The join would
   * resolve today, and an investigation reads this table years later, possibly
   * from an export, possibly after the key row was migrated. A journal that has
   * to be joined to be understood is one edit away from being unreadable.
   */
  @Column({ name: 'public_key', type: 'varchar', length: 256 })
  publicKey: string;

  /**
   * What the signature was for — `slash_attestation`, `rotation_drill`.
   *
   * Coarse and stable: it is what a rate-anomaly alert groups by, so it must not
   * carry per-occurrence values.
   */
  /**
   * CAIP-2, and **nullable**.
   *
   * The first question of a key-compromise investigation is *what could this
   * key have signed*, and with two chains live the answer has to name one —
   * reading it off `purpose` would mean parsing a free-text field. Nullable
   * because rows written before multichain support genuinely have no answer,
   * and back-dating one would make the column an investigator reads first into
   * a column that lies.
   */
  @Column({ name: 'chain_id', type: 'varchar', length: 64, nullable: true })
  chainId: string | null;

  @Column({ name: 'purpose', type: 'varchar', length: 64 })
  purpose: string;

  /**
   * The identifier of the thing being attested — the `requestId` of a slash
   * attestation, the window id of an SLA-window attestation.
   *
   * Nullable because a signature can be legitimately unattached to one (the
   * rotation drill), and inventing a value would make the column useless for
   * the query it exists for: *show me every signature issued for this request.*
   */
  @Column({ name: 'request_id', type: 'varchar', length: 128, nullable: true })
  requestId: string | null;

  /** `user` | `service` | `job` | `operator`. */
  @Column({ name: 'requested_by_type', type: 'varchar', length: 16 })
  requestedByType: string;

  /** The user id, the service name, the job name. */
  @Column({ name: 'requested_by_id', type: 'varchar', length: 128 })
  requestedById: string;

  /**
   * `sha256` of the exact bytes that were signed, hex.
   *
   * The bytes themselves are not stored: they are the attestation, which has its
   * own home, and copying them here would put a second authoritative version of
   * a signed document in a table nobody thinks of as authoritative. The hash is
   * what the correlation above needs and it is enough.
   */
  @Column({ name: 'payload_sha256', type: 'varchar', length: 64 })
  payloadSha256: string;

  /**
   * Hex. 128 characters for ed25519, 130 for secp256k1 — hence 256. Null until
   * the signature exists — or forever, if it never did.
   */
  @Column({ name: 'signature', type: 'varchar', length: 256, nullable: true })
  signature: string | null;

  @Column({ name: 'outcome', type: 'varchar', length: 32 })
  outcome: SigningOutcome;

  /** Why it was refused. Null when it was not. Never carries key material. */
  @Column({ name: 'refusal_reason', type: 'varchar', length: 256, nullable: true })
  refusalReason: string | null;

  /**
   * How many signatures this key had already produced in the rate window when
   * this one was attempted.
   *
   * Recorded per row rather than derived by counting, so the rate at the moment
   * of the decision survives even if rows are later archived out — and so the
   * alert that fired can be reconciled against the row that caused it.
   */
  @Column({ name: 'observed_in_window', type: 'int', nullable: true })
  observedInWindow: number | null;

  /** When the outcome was settled. Null on a row that never got one. */
  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;
}
