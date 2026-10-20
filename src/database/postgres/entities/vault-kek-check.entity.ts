import { BaseEntity, Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * The key-check value of one vault KEK id (see `kekCheckValue`), written the
 * first time the id is loaded. Platform data, not tenant data.
 */
@Entity('vault_kek_checks')
export class VaultKekCheckEntity extends BaseEntity {
  @PrimaryColumn({ name: 'kek_id', type: 'varchar', length: 64 })
  kekId: string;

  /** 16 bytes. */
  @Column({ name: 'kcv', type: 'bytea' })
  kcv: Buffer;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
