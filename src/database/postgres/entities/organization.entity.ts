import { Column, Entity } from 'typeorm';

import { AbstractEntityWithoutSoftDelete } from './abstract.entity';

/**
 * The tenant.
 *
 * ## It did not exist until now, and that is the whole point of this table
 *
 * `OrganizationScopedEntity` has put an `organization_id uuid` on every
 * business table since the first one, and `OrganizationScopedRepository`
 * refuses any query that does not name it. What none of that had was a row on
 * the other end: `organization_id` referenced nothing, so the id in a session
 * was whatever the credential file said it was, and "which organizations exist"
 * was a question the database could not answer.
 *
 * A login has to answer it. The organization is created automatically on
 * sign-up, which requires somewhere to create it.
 *
 * ## No foreign keys point here yet, deliberately
 *
 * The ~30 tables carrying `organization_id` are **not** given a foreign key to
 * this table in the migration that creates it. Every one of them already holds
 * rows whose organization id was invented by a credential file or a seed
 * script, and a constraint added over that data either fails to apply or
 * forces a backfill of fabricated parent rows — which would make this table
 * lie about who exists on the day it was created. The column becomes a real
 * reference as tenants are created through this path, and the constraint is
 * the migration that follows the last invented id being gone.
 *
 * ## Not soft-deletable
 *
 * Same reasoning as `operators`: an organization is an identity other rows are
 * attributed to, and a soft-deleted tenant whose payments remain is a
 * reconciliation hole with a nicer name. Closing an account is `status`.
 */
@Entity('organizations')
export class OrganizationEntity extends AbstractEntityWithoutSoftDelete {
  /**
   * What a human calls this tenant.
   *
   * Derived from the signup identity when the row is created automatically
   * (the email's local part, or the Privy DID when there is no email), because
   * there is no naming step in a login. It is a label, never authorisation.
   */
  @Column({ name: 'name', type: 'varchar', length: 160 })
  name: string;

  /**
   * Whether the public receipt page may show this organization's calls to
   * anyone who has a call's id. On by default; the owner can turn it off
   * (a hidden receipt answers 404). Read by `PublicReceiptReadRepository`.
   */
  @Column({ name: 'receipts_public', type: 'boolean', default: true })
  receiptsPublic: boolean;

  /** `ACTIVE` | `SUSPENDED`. Enforced by a CHECK constraint, not a TypeScript enum alone. */
  @Column({ name: 'status', type: 'varchar', length: 16, default: 'ACTIVE' })
  status: string;

  /**
   * How this organization came to exist — `PRIVY_SIGNUP` today.
   *
   * Recorded rather than assumed because the credential-file organizations
   * that predate this table have no row here at all, and the first question
   * anyone will ask of a tenant list is which of these are real signups.
   */
  @Column({ name: 'created_via', type: 'varchar', length: 32 })
  createdVia: string;

  /**
   * The public namespace, `@acme` (design spec §7.1): lowercase, unique
   * ignoring case. Never an email, a wallet or a real name.
   */
  @Column({ name: 'handle', type: 'varchar', length: 24, nullable: true })
  handle: string | null;

  /** `handleSkeleton(handle)`: unique, so no two handles read alike. */
  @Column({ name: 'handle_skeleton', type: 'varchar', length: 24, nullable: true })
  handleSkeleton: string | null;

  /** Set by the first UNLISTED or PUBLIC share; after it only an operator renames. */
  @Column({ name: 'handle_locked_at', type: 'timestamptz', nullable: true })
  handleLockedAt: Date | null;

  /** `ACTIVE` | `FROZEN` — a frozen handle serves nothing. `null` without a handle. */
  @Column({ name: 'handle_status', type: 'varchar', length: 16, nullable: true })
  handleStatus: string | null;
}
