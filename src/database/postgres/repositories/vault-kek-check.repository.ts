import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { VaultKekCheckEntity } from '../entities/vault-kek-check.entity';
import { AbstractRepository } from './abstract.repository';

/** `vault_kek_checks`. */
@Injectable()
export class VaultKekCheckRepository extends AbstractRepository<VaultKekCheckEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(VaultKekCheckEntity, dataSource);
  }

  /** The stored check value of `kekId`, or `null` when none was written yet. */
  async findKcv(kekId: string): Promise<Buffer | null> {
    const row = await this.findOneBy({ kekId });
    return row ? row.kcv : null;
  }

  /** Writes the value if the id has none; a concurrent first boot loses silently. */
  async insertIfAbsent(kekId: string, kcv: Buffer): Promise<void> {
    await this.createQueryBuilder()
      .insert()
      .into(VaultKekCheckEntity)
      .values({ kekId, kcv })
      .orIgnore()
      .execute();
  }
}
