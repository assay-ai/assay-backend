import {
  DeepPartial,
  DeleteResult,
  FindManyOptions,
  FindOneOptions,
  FindOptionsWhere,
  InsertResult,
  ObjectLiteral,
  QueryRunner,
  SaveOptions,
  SelectQueryBuilder,
  UpdateResult,
} from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { OrganizationErrors } from '@shared/errors/organization-scope.errors';
import {
  assertOrganizationScopedCriteria,
  assertOrganizationScopedFindOptions,
  assertOrganizationScopedValues,
  assertOrganizationScopedWhere,
  guardOrganizationScope,
} from '../organization-scope';
import { AbstractRepository } from './abstract.repository';

/**
 * Update/delete criteria, narrowed from TypeORM's union so a bare primary key
 * is a compile error as well as a runtime one.
 */
type ScopedCriteria<T> = FindOptionsWhere<T> | FindOptionsWhere<T>[];

/**
 * Repository base for entities extending `OrganizationScopedEntity`.
 *
 * Every read, every write and every query builder produced here must constrain
 * `organizationId`. One that does not raises `ORGANIZATION_SCOPE_MISSING`
 * *before* the statement reaches Postgres, so a forgotten predicate fails a
 * test run rather than quietly serving one tenant another tenant's payments.
 *
 * The guarded methods are `async`, so a violation arrives as a REJECTED promise
 * rather than a synchronous throw from a function whose signature promises one.
 * A synchronous throw would escape `repository.find(bad).catch(handler)` — the
 * guard would then break callers who were handling errors correctly.
 *
 * Operations with no scoped form are refused outright rather than guarded:
 * `updateAll`/`deleteAll` (TypeORM's deliberate WHERE-less writes), `clear()`
 * (TRUNCATE), the id-only `findByIds`/`findOneById`, and `query()`, whose raw
 * SQL this class cannot meaningfully inspect. Reach for `createQueryBuilder()`
 * instead — its generated SQL *is* checked.
 */
export abstract class OrganizationScopedRepository<
  T extends ObjectLiteral,
> extends AbstractRepository<T> {
  private get scope(): string {
    const target = this.entity as unknown;
    return typeof target === 'function' ? (target as { name: string }).name : String(target);
  }

  private operation(method: string): string {
    return `${this.scope}.${method}`;
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  async find(options?: FindManyOptions<T>): Promise<T[]> {
    assertOrganizationScopedFindOptions(options, this.operation('find'));
    return super.find(options);
  }

  async findBy(where: ScopedCriteria<T>): Promise<T[]> {
    assertOrganizationScopedWhere(where, this.operation('findBy'));
    return super.findBy(where);
  }

  async findAndCount(options?: FindManyOptions<T>): Promise<[T[], number]> {
    assertOrganizationScopedFindOptions(options, this.operation('findAndCount'));
    return super.findAndCount(options);
  }

  async findAndCountBy(where: ScopedCriteria<T>): Promise<[T[], number]> {
    assertOrganizationScopedWhere(where, this.operation('findAndCountBy'));
    return super.findAndCountBy(where);
  }

  async findOne(options: FindOneOptions<T>): Promise<T | null> {
    assertOrganizationScopedFindOptions(options, this.operation('findOne'));
    return super.findOne(options);
  }

  async findOneBy(where: ScopedCriteria<T>): Promise<T | null> {
    assertOrganizationScopedWhere(where, this.operation('findOneBy'));
    return super.findOneBy(where);
  }

  async findOneOrFail(options: FindOneOptions<T>): Promise<T> {
    assertOrganizationScopedFindOptions(options, this.operation('findOneOrFail'));
    return super.findOneOrFail(options);
  }

  async findOneByOrFail(where: ScopedCriteria<T>): Promise<T> {
    assertOrganizationScopedWhere(where, this.operation('findOneByOrFail'));
    return super.findOneByOrFail(where);
  }

  async count(options?: FindManyOptions<T>): Promise<number> {
    assertOrganizationScopedFindOptions(options, this.operation('count'));
    return super.count(options);
  }

  async countBy(where: ScopedCriteria<T>): Promise<number> {
    assertOrganizationScopedWhere(where, this.operation('countBy'));
    return super.countBy(where);
  }

  async exists(options?: FindManyOptions<T>): Promise<boolean> {
    assertOrganizationScopedFindOptions(options, this.operation('exists'));
    return super.exists(options);
  }

  async existsBy(where: ScopedCriteria<T>): Promise<boolean> {
    assertOrganizationScopedWhere(where, this.operation('existsBy'));
    return super.existsBy(where);
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  async insert(
    entity: QueryDeepPartialEntity<T> | QueryDeepPartialEntity<T>[],
  ): Promise<InsertResult> {
    assertOrganizationScopedValues(entity, this.operation('insert'));
    return super.insert(entity);
  }

  async save<E extends DeepPartial<T>>(entityOrEntities: any, options?: SaveOptions): Promise<any> {
    assertOrganizationScopedValues(entityOrEntities, this.operation('save'));
    return super.save(entityOrEntities as E, options);
  }

  async update(
    criteria: ScopedCriteria<T>,
    partialEntity: QueryDeepPartialEntity<T>,
  ): Promise<UpdateResult> {
    assertOrganizationScopedCriteria(criteria, this.operation('update'));
    return super.update(criteria, partialEntity);
  }

  async delete(criteria: ScopedCriteria<T>): Promise<DeleteResult> {
    assertOrganizationScopedCriteria(criteria, this.operation('delete'));
    return super.delete(criteria);
  }

  async softDelete(criteria: ScopedCriteria<T>): Promise<UpdateResult> {
    assertOrganizationScopedCriteria(criteria, this.operation('softDelete'));
    return super.softDelete(criteria);
  }

  async restore(criteria: ScopedCriteria<T>): Promise<UpdateResult> {
    assertOrganizationScopedCriteria(criteria, this.operation('restore'));
    return super.restore(criteria);
  }

  async increment(
    conditions: FindOptionsWhere<T>,
    propertyPath: string,
    value: number | string,
  ): Promise<UpdateResult> {
    assertOrganizationScopedWhere(conditions, this.operation('increment'));
    return super.increment(conditions, propertyPath, value);
  }

  async decrement(
    conditions: FindOptionsWhere<T>,
    propertyPath: string,
    value: number | string,
  ): Promise<UpdateResult> {
    assertOrganizationScopedWhere(conditions, this.operation('decrement'));
    return super.decrement(conditions, propertyPath, value);
  }

  // ── Query builder ────────────────────────────────────────────────────────

  createQueryBuilder(alias?: string, queryRunner?: QueryRunner): SelectQueryBuilder<T> {
    return guardOrganizationScope(
      super.createQueryBuilder(alias, queryRunner),
      this.operation('createQueryBuilder'),
    );
  }

  // ── Refused outright ─────────────────────────────────────────────────────

  async updateAll(): Promise<UpdateResult> {
    throw OrganizationErrors.unscopedOperation({
      operation: this.operation('updateAll'),
      detail: 'it writes every row in the table; use update({ organizationId, … })',
    });
  }

  async deleteAll(): Promise<DeleteResult> {
    throw OrganizationErrors.unscopedOperation({
      operation: this.operation('deleteAll'),
      detail: 'it deletes every row in the table; use delete({ organizationId, … })',
    });
  }

  async clear(): Promise<void> {
    throw OrganizationErrors.unscopedOperation({
      operation: this.operation('clear'),
      detail: 'TRUNCATE cannot be organization-scoped',
    });
  }

  async query<TResult = any>(): Promise<TResult> {
    throw OrganizationErrors.unscopedOperation({
      operation: this.operation('query'),
      detail: 'raw SQL bypasses the guard; use createQueryBuilder(), whose SQL is checked',
    });
  }

  async findByIds(): Promise<T[]> {
    throw OrganizationErrors.unscopedOperation({
      operation: this.operation('findByIds'),
      detail: 'ids alone name no organization; use findBy({ organizationId, id: In(ids) })',
    });
  }

  async findOneById(): Promise<T | null> {
    throw OrganizationErrors.unscopedOperation({
      operation: this.operation('findOneById'),
      detail: 'an id alone names no organization; use findOneBy({ organizationId, id })',
    });
  }
}
