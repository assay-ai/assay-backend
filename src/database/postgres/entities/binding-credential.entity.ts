import {
  BaseEntity,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * One envelope-encrypted credential header set for one binding and one origin.
 *
 * Keyed on `(binding_id, origin)`, so it does not extend the organization-scoped
 * bases (they force a uuid `id`). `organizationId` is still mandatory and every
 * query filters on it. The GCM auth tag is the last 16 bytes of `ciphertext` and
 * of `wrappedDek`. `headerNames` and `valueHints` are plaintext by design: they
 * are what the console lists, and the hint is at most 4 characters.
 */
@Entity('binding_credentials')
@Index('idx_binding_credentials_organization_id', ['organizationId'])
export class BindingCredentialEntity extends BaseEntity {
  @PrimaryColumn({ name: 'binding_id', type: 'uuid' })
  bindingId: string;

  @PrimaryColumn({ name: 'origin', type: 'varchar', length: 2048 })
  origin: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'kek_id', type: 'varchar', length: 64 })
  kekId: string;

  @Column({ name: 'wrapped_dek', type: 'bytea' })
  wrappedDek: Buffer;

  @Column({ name: 'dek_iv', type: 'bytea' })
  dekIv: Buffer;

  @Column({ name: 'ciphertext', type: 'bytea' })
  ciphertext: Buffer;

  @Column({ name: 'iv', type: 'bytea' })
  iv: Buffer;

  @Column({ name: 'header_names', type: 'varchar', length: 64, array: true })
  headerNames: string[];

  @Column({ name: 'value_hints', type: 'varchar', length: 4, array: true })
  valueHints: Array<string | null>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @Column({ name: 'updated_by', type: 'varchar', length: 128 })
  updatedBy: string;
}
