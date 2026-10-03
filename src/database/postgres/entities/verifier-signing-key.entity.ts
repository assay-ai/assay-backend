import { Column, Entity, Index } from 'typeorm';

// Relative, not `@modules/*`, and it has to stay that way: `postgres.data-source.ts`
// loads these entity files as TypeScript for the migration CLI, which runs
// without `tsconfig-paths`. An aliased import here breaks `yarn migration:run`
// for the whole schema, not just this table.
import { SigningKeyState } from '../../../modules/verification/signing/domain/key-lifecycle';
import { SignerBackend } from '../../../modules/verification/signing/ports/signer.port';

import { AbstractEntityWithoutSoftDelete } from './abstract.entity';

/**
 * The verifier signing keys this deployment knows about, and which one signs.
 *
 * ## Why this table has no `organization_id`
 *
 * `docs/architecture.md` §Multi-Organization Scoping puts `organizationId` on every
 * *business* table and reserves `AbstractEntity` for "tables that genuinely
 * belong to no organization". This is one of the few. There is one verifier
 * identity per deployment, it signs on behalf of the platform rather than of any
 * tenant, and a tenant column here would have to be filled with an invented
 * value on every row — which is worse than not having it, because the next
 * person to read the schema would believe the key was somebody's.
 *
 * ## What it is authoritative for, and what it is not
 *
 * Authoritative for: *which key this platform signs with next*. That is a local
 * operational choice and this is where it is made.
 *
 * Not authoritative for: *whether a signature counts*. The on-chain registry
 * decides that, `VerifierKeyDirectory` checks it on every use, and the
 * settlement program checks it again when a slash is submitted. A row here that
 * says `ACTIVE` for a key the chain has revoked buys an attacker nothing beyond
 * making this platform waste effort producing attestations that will be
 * rejected — which is the containment that makes a verifier key compromise
 * survivable, and it is worth keeping in mind when reading anything below.
 *
 * ## Soft delete is absent on purpose
 *
 * A key's history is the evidence in a compromise investigation. `deleted_at`
 * is an affordance for making a key disappear while the row count still looks
 * right — the same argument `audit-log-entry.entity.ts` makes. Keys leave by
 * moving to `REVOKED`, which is terminal here and on-chain.
 */
@Entity('verifier_signing_keys')
@Index('idx_verifier_signing_keys_state', ['state'])
export class VerifierSigningKeyEntity extends AbstractEntityWithoutSoftDelete {
  /**
   * Our stable name for the key — `verifier-2026-08`. Unique, and the join key
   * for every line in `verifier_signing_log`.
   */
  @Column({ name: 'key_id', type: 'varchar', length: 64, unique: true })
  keyId: string;

  /**
   * Where the material actually lives. Recorded per key rather than read from
   * config, because a rotation from the env backend to a KMS means two keys
   * with two different custody stories are live at once — which is exactly the
   * migration this column exists to make legible.
   */
  @Column({ name: 'backend', type: 'varchar', length: 16 })
  backend: SignerBackend;

  /** The backend's locator — env var name, KMS ARN, Vault path. Never a secret. */
  @Column({ name: 'backend_ref', type: 'varchar', length: 256 })
  backendRef: string;

  /**
   * The raw public key, hex, lowercase. 64 characters for ed25519; the column
   * is 256 so an uncompressed secp256k1 key (130) also fits.
   *
   * Hex rather than base58 so the column means the same thing when a second
   * chain exists; `chain_address` carries the chain's own rendering. Unique,
   * because two rows for one key would make "which key signed this" ambiguous
   * in the one table that has to answer it.
   */
  @Column({ name: 'public_key', type: 'varchar', length: 256, unique: true })
  publicKey: string;

  /**
   * CAIP-2. **Which chain this key signs for**.
   *
   * NOT NULL, and the partial unique index is
   * `(chain_id) WHERE state = 'ACTIVE'` — one active key per chain rather than
   * one per table, which is what it was before multichain support and what
   * would have retired the Solana key the moment an EVM one was enrolled. A key
   * with no chain is a key `resolveSignableKey(chainId)` cannot answer with, so
   * there is no nullable state for it to be in.
   *
   * A plain `string` rather than the branded `ChainId`, per the convention every
   * other entity here follows: these files are loaded by the TypeORM CLI
   * without `tsconfig-paths`, so nothing in `@modules/*` may be reachable from
   * them. The branding is applied at the repository boundary.
   */
  @Column({ name: 'chain_id', type: 'varchar', length: 64 })
  chainId: string;

  /**
   * The same key in the chain's own notation — base58 on Solana, `0x…` on
   * eip155. What the registry is keyed by.
   *
   * The doc comment used to say CAIP-10. It is not: every value on the live
   * table is a bare address with no `chainId:` prefix, which is why
   * `1759400000000-verifier-keys-per-chain.ts` does **not** derive
   * {@link chainId} from it.
   */
  @Column({ name: 'chain_address', type: 'varchar', length: 256, nullable: true })
  chainAddress: string | null;

  @Column({ name: 'state', type: 'varchar', length: 16 })
  state: SigningKeyState;

  /**
   * When the on-chain registration is due to expire, as last read from the
   * chain. A cache of `VerifierKey.expires_at`, kept so the expiry warning can
   * be raised without an RPC round trip per check.
   */
  @Column({ name: 'registered_expires_at', type: 'timestamptz', nullable: true })
  registeredExpiresAt: Date | null;

  @Column({ name: 'activated_at', type: 'timestamptz', nullable: true })
  activatedAt: Date | null;

  @Column({ name: 'retired_at', type: 'timestamptz', nullable: true })
  retiredAt: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  /**
   * Why the key is in the state it is in — "scheduled 180-day rotation",
   * "suspected compromise, ticket SEC-114".
   *
   * The single most useful column in this table six months later, and the one
   * most likely to be left null. Rotation tooling fills it; nothing enforces it,
   * because a required field with nothing to say gets filled with "rotation".
   */
  @Column({ name: 'reason', type: 'varchar', length: 256, nullable: true })
  reason: string | null;
}
