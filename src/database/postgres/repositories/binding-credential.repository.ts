import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, Not, In } from 'typeorm';

import { BindingCredentialEntity } from '../entities/binding-credential.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/** `binding_credentials`. Every method filters by organization as well as binding. */
@Injectable()
export class BindingCredentialRepository extends OrganizationScopedRepository<BindingCredentialEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(BindingCredentialEntity, dataSource);
  }

  /**
   * Replaces the set for `(bindingId, origin)` in one statement:
   * `INSERT … ON CONFLICT (binding_id, origin) DO UPDATE`, so two concurrent
   * PUTs both succeed and the last one wins, instead of one of them hitting the
   * primary key. The update only applies to a row of the same organization: a
   * row another organization somehow holds at the same key is left alone and
   * the call throws.
   */
  async replace(
    organizationId: string,
    row: BindingCredentialRow,
  ): Promise<BindingCredentialEntity> {
    return this.manager.transaction(async (manager) => {
      const written: unknown[] = await manager.query(
        `INSERT INTO binding_credentials
           (binding_id, origin, organization_id, kek_id, wrapped_dek, dek_iv, ciphertext, iv,
            header_names, value_hints, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (binding_id, origin) DO UPDATE
            SET kek_id = EXCLUDED.kek_id,
                wrapped_dek = EXCLUDED.wrapped_dek,
                dek_iv = EXCLUDED.dek_iv,
                ciphertext = EXCLUDED.ciphertext,
                iv = EXCLUDED.iv,
                header_names = EXCLUDED.header_names,
                value_hints = EXCLUDED.value_hints,
                updated_by = EXCLUDED.updated_by,
                updated_at = now()
          WHERE binding_credentials.organization_id = EXCLUDED.organization_id
         RETURNING binding_id`,
        [
          row.bindingId,
          row.origin,
          organizationId,
          row.kekId,
          row.wrappedDek,
          row.dekIv,
          row.ciphertext,
          row.iv,
          row.headerNames,
          row.valueHints,
          row.updatedBy,
        ],
      );
      if (written.length !== 1) {
        throw new Error('binding_credentials row is held by another organization');
      }
      return manager.findOneByOrFail(BindingCredentialEntity, {
        organizationId,
        bindingId: row.bindingId,
        origin: row.origin,
      });
    });
  }

  async findForBinding(
    organizationId: string,
    bindingId: string,
  ): Promise<BindingCredentialEntity[]> {
    return this.find({ where: { organizationId, bindingId }, order: { origin: 'ASC' } });
  }

  async findForOrigin(
    organizationId: string,
    bindingId: string,
    origin: string,
  ): Promise<BindingCredentialEntity | null> {
    return this.findOneBy({ organizationId, bindingId, origin });
  }

  async removeOrigin(organizationId: string, bindingId: string, origin: string): Promise<void> {
    await this.delete({ organizationId, bindingId, origin });
  }

  /** Deletes every origin of the binding not in `keepOrigins`; returns what was removed. */
  async pruneExcept(
    manager: EntityManager,
    organizationId: string,
    bindingId: string,
    keepOrigins: readonly string[],
  ): Promise<Array<{ origin: string; headerNames: string[] }>> {
    const where = {
      organizationId,
      bindingId,
      ...(keepOrigins.length > 0 ? { origin: Not(In([...keepOrigins])) } : {}),
    };
    const doomed = await manager.find(BindingCredentialEntity, {
      select: { origin: true, headerNames: true },
      where,
    });
    if (doomed.length > 0) await manager.delete(BindingCredentialEntity, where);
    return doomed.map(({ origin, headerNames }) => ({ origin, headerNames }));
  }
}

export type BindingCredentialRow = Pick<
  BindingCredentialEntity,
  | 'bindingId'
  | 'origin'
  | 'kekId'
  | 'wrappedDek'
  | 'dekIv'
  | 'ciphertext'
  | 'iv'
  | 'headerNames'
  | 'valueHints'
  | 'updatedBy'
>;
