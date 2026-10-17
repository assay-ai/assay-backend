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
   * Replaces the set for `(bindingId, origin)`. Delete-then-insert in one
   * transaction, both scoped to the organization: a row another organization
   * somehow holds at the same key makes the insert fail on the primary key
   * instead of being overwritten.
   */
  async replace(
    organizationId: string,
    row: BindingCredentialRow,
  ): Promise<BindingCredentialEntity> {
    return this.manager.transaction(async (manager) => {
      await manager.delete(BindingCredentialEntity, {
        organizationId,
        bindingId: row.bindingId,
        origin: row.origin,
      });
      return manager.save(manager.create(BindingCredentialEntity, { ...row, organizationId }));
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

  /** Deletes every origin of the binding not in `keepOrigins`; returns the count. */
  async pruneExcept(
    manager: EntityManager,
    organizationId: string,
    bindingId: string,
    keepOrigins: readonly string[],
  ): Promise<number> {
    const result = await manager.delete(BindingCredentialEntity, {
      organizationId,
      bindingId,
      ...(keepOrigins.length > 0 ? { origin: Not(In([...keepOrigins])) } : {}),
    });
    return result.affected ?? 0;
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
