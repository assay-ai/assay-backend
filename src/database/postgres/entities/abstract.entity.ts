import {
  BeforeInsert,
  BeforeUpdate,
  CreateDateColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  VersionColumn,
  BaseEntity,
} from 'typeorm';

/**
 * Why every timestamp below says `timestamptz` out loud.
 *
 * TypeORM's `@CreateDateColumn` defaults to `timestamp WITHOUT time zone`, and
 * for most of this schema's life every table inherited that. The value stored
 * was UTC wall-clock — a UTC database writing `now()` — but the column did not
 * *say* so, and nothing downstream could tell. Two things broke as a result,
 * both invisible on a UTC host and both found by running on a UTC+5:30 one:
 *
 * 1. **node-postgres read it back as local time.** A row written at `03:00Z`
 *    was published over HTTP as `20:00Z` the previous day. Every `createdAt`
 *    the API served was shifted by the host's offset.
 * 2. **Comparing it to an instant became session-dependent.** `created_at >= :from`
 *    compares a naive column to an absolute parameter, and Postgres resolves
 *    that with the *session* time zone — so the same query over the same rows
 *    answered differently depending on where the process ran. A correct one-day
 *    window returned zero calls for a day that had six.
 *
 * (2) was first patched at one query with an `AT TIME ZONE 'UTC'` constant and
 * (1) was left open, because repairing it properly is a migration across every
 * table rather than a fix at one call site. The dashboard API adds tables, and
 * a new table copying the old convention would have made the problem one table
 * bigger — so the repair lands here, at the column, where it fixes both halves
 * at once.
 *
 * It also has to land here for a reason of its own: cursor pagination keys on
 * `created_at`. A cursor carrying a timestamp the driver shifts on the way out
 * and does not shift on the way back in is a cursor that silently skips or
 * repeats rows at every page boundary.
 *
 * Migration: `1755900000000-timestamptz-timestamps`.
 */
export abstract class AbstractEntity extends BaseEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  // 1. Soft Delete - prevent data loss when deleting data
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date;

  // 2. Optimistic Locking - prevent race condition when syncing data
  @VersionColumn({ name: 'version', default: 1 })
  version: number;

  @BeforeInsert()
  protected setCreatedAt() {
    this.createdAt = new Date();
    this.updatedAt = new Date();
  }

  @BeforeUpdate()
  protected setUpdatedAt() {
    this.updatedAt = new Date();
  }
}

/**
 * AbstractEntityWithoutSoftDelete - Base entity without soft delete functionality
 * Use this for entities where soft delete overhead is not needed (e.g., statistics tables)
 * This avoids the automatic WHERE deleted_at IS NULL filter that TypeORM adds to queries
 */
export abstract class AbstractEntityWithoutSoftDelete extends BaseEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  // Optimistic Locking - prevent race condition when syncing data
  @VersionColumn({ name: 'version', default: 1 })
  version: number;

  @BeforeInsert()
  protected setCreatedAt() {
    this.createdAt = new Date();
    this.updatedAt = new Date();
  }

  @BeforeUpdate()
  protected setUpdatedAt() {
    this.updatedAt = new Date();
  }
}
