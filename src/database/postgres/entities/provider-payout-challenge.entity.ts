import { Column, Entity, Index } from 'typeorm';

import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * One nonce, issued in the console, signed by the wallet that wants to be paid.
 *
 * ## Why the message is stored, not rebuilt
 *
 * `message` holds the exact string the wallet was asked to sign. Verification
 * reads it from this row and never reconstructs it from the request that
 * carries the signature. The difference is the whole security property: a
 * verifier that rebuilds the signed bytes from client input verifies whatever
 * the client said the bytes were, which makes a signature over *any* message
 * the attacker can obtain — a voucher, a withdrawal, a login prompt from an
 * unrelated site — replayable as a payout-address proof. Storing it makes the
 * platform, not the caller, the author of what was signed.
 *
 * `SolanaChainAdapter` makes the same argument one level down about why there
 * is no generic `verifyMessageSignature`, and this row is that argument's
 * database half.
 *
 * ## Single use, enforced by an UPDATE rather than by a read
 *
 * `consumed_at` is set by `UPDATE … WHERE consumed_at IS NULL`, and the row
 * count is the answer. A check-then-write would let two concurrent submissions
 * both pass the check; on a proof of *payout control* that is not an academic
 * race.
 *
 * ## Channel
 *
 * `channel` exists to record that the address arrived through the console, and
 * `PayoutProofChannel` has exactly one member. It is here so that the day
 * somebody adds a CLI path, the column and the enum both have to change in a
 * diff that says so.
 */
@Entity('provider_payout_challenges')
@Index('idx_provider_payout_challenges_open', ['organizationId', 'consumedAt'])
export class ProviderPayoutChallengeEntity extends OrganizationScopedEntityWithoutSoftDelete {
  /** 32 random bytes, hex. Unique across the table, not merely per organization. */
  @Column({ name: 'nonce', type: 'varchar', length: 64 })
  nonce: string;

  /**
   * The address being claimed, CAIP-10.
   *
   * Bound into the challenge at issue time and into the signed message, so a
   * signature obtained for one address cannot be submitted for another.
   */
  @Column({ name: 'account_id', type: 'varchar', length: 256 })
  accountId: string;

  /** The exact bytes to sign, as UTF-8. See the class comment. */
  @Column({ name: 'message', type: 'text' })
  message: string;

  /** Leads {@link message}; kept so an old proof stays checkable after a format change. */
  @Column({ name: 'message_version', type: 'varchar', length: 64 })
  messageVersion: string;

  /** `CONSOLE`, and only `CONSOLE`. */
  @Column({ name: 'channel', type: 'varchar', length: 16, default: 'CONSOLE' })
  channel: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt: Date | null;

  /** The console credential the challenge was issued to. */
  @Column({ name: 'issued_to', type: 'varchar', length: 128 })
  issuedTo: string;
}
