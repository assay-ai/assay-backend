import { DataSource, ObjectLiteral } from 'typeorm';
import { OrganizationScopedRepository } from '@database/postgres/repositories/organization-scoped.repository';
import { OrganizationErrorCode } from '@shared/errors/organization-scope.errors';
import { AppError } from '@shared/errors/app-errors';

const ORG = '3f1c8d2a-0000-4000-8000-000000000001';

class FakeIntentEntity {
  id: string;
  organizationId: string;
  status: string;
}

/**
 * The repository is exercised against a stubbed EntityManager rather than a
 * live Postgres: the guard's whole contract is that it refuses BEFORE the
 * statement reaches the database, so the assertion that matters is that the
 * manager was never called.
 */
function buildRepository() {
  const manager = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    count: jest.fn().mockResolvedValue(0),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    insert: jest.fn().mockResolvedValue({ identifiers: [] }),
    save: jest.fn().mockImplementation((_target: unknown, entity: unknown) => entity),
    createQueryBuilder: jest.fn(),
    // TypeORM's Repository resolves `this.metadata` through the manager's
    // connection on every delegated call.
    connection: {
      getMetadata: () => ({ target: FakeIntentEntity, name: 'FakeIntentEntity' }),
    },
  };

  const dataSource = { manager } as unknown as DataSource;

  class TestRepository extends OrganizationScopedRepository<ObjectLiteral> {
    constructor() {
      super(FakeIntentEntity, dataSource);
    }
  }

  return { repository: new TestRepository(), manager };
}

async function codeOfRejection(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return (error as AppError).errorCode;
  }
  throw new Error('expected the repository to reject, but it resolved');
}

describe('OrganizationScopedRepository', () => {
  describe('reads', () => {
    it('refuses find() without organizationId and never reaches the database', async () => {
      const { repository, manager } = buildRepository();

      await expect(repository.find({ where: { status: 'CREATED' } })).rejects.toMatchObject({
        errorCode: OrganizationErrorCode.ORGANIZATION_SCOPE_MISSING,
        statusCode: 500,
      });
      expect(manager.find).not.toHaveBeenCalled();
    });

    it('refuses a bare find() with no options', async () => {
      const { repository, manager } = buildRepository();

      expect(await codeOfRejection(() => repository.find())).toBe(
        OrganizationErrorCode.ORGANIZATION_SCOPE_MISSING,
      );
      expect(manager.find).not.toHaveBeenCalled();
    });

    it('lets a scoped find() through to the database', async () => {
      const { repository, manager } = buildRepository();

      await expect(
        repository.find({ where: { organizationId: ORG, status: 'CREATED' } }),
      ).resolves.toEqual([]);
      expect(manager.find).toHaveBeenCalledTimes(1);
    });

    it('refuses findOneBy() without organizationId', async () => {
      const { repository, manager } = buildRepository();

      expect(await codeOfRejection(() => repository.findOneBy({ id: 'row-1' }))).toBe(
        OrganizationErrorCode.ORGANIZATION_SCOPE_MISSING,
      );
      expect(manager.findOne).not.toHaveBeenCalled();
    });
  });

  describe('writes', () => {
    it('refuses update() addressed by a bare primary key', async () => {
      const { repository, manager } = buildRepository();

      // `ScopedCriteria` already makes this a COMPILE error — that is the first
      // line of defence. The cast strips the types to prove the runtime guard
      // holds too, which is what protects callers reaching this through `any`
      // (a DTO field, a JSON body, a loosely-typed helper).
      expect(
        await codeOfRejection(() => (repository as any).update('row-1', { status: 'SETTLED' })),
      ).toBe(OrganizationErrorCode.ORGANIZATION_SCOPE_MISSING);
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('allows update() addressed by { organizationId, id }', async () => {
      const { repository, manager } = buildRepository();

      await repository.update({ organizationId: ORG, id: 'row-1' }, { status: 'SETTLED' });
      expect(manager.update).toHaveBeenCalledTimes(1);
    });

    it('refuses insert() of a row with no organizationId', async () => {
      const { repository, manager } = buildRepository();

      expect(await codeOfRejection(() => repository.insert({ status: 'CREATED' }))).toBe(
        OrganizationErrorCode.ORGANIZATION_SCOPE_MISSING_ON_WRITE,
      );
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('refuses delete() without organizationId', async () => {
      const { repository, manager } = buildRepository();

      expect(await codeOfRejection(() => repository.delete({ status: 'CREATED' }))).toBe(
        OrganizationErrorCode.ORGANIZATION_SCOPE_MISSING,
      );
      expect(manager.delete).not.toHaveBeenCalled();
    });
  });

  describe('operations with no scoped form', () => {
    it.each([
      ['updateAll', (r: any) => r.updateAll({ status: 'X' })],
      ['deleteAll', (r: any) => r.deleteAll()],
      ['clear', (r: any) => r.clear()],
      ['query', (r: any) => r.query('SELECT 1')],
      ['findByIds', (r: any) => r.findByIds(['a'])],
      ['findOneById', (r: any) => r.findOneById('a')],
    ])('refuses %s outright', async (_name, call) => {
      const { repository } = buildRepository();

      expect(await codeOfRejection(() => call(repository))).toBe(
        OrganizationErrorCode.ORGANIZATION_SCOPE_UNSCOPED_OPERATION,
      );
    });
  });

  describe('query builder', () => {
    function fakeQueryBuilder(sql: string) {
      const qb: any = {
        getQuery: () => sql,
        getMany: jest.fn().mockResolvedValue([]),
        getOne: jest.fn().mockResolvedValue(null),
      };
      // Chained builder methods return the builder itself, like TypeORM's.
      qb.where = jest.fn(() => qb);
      qb.andWhere = jest.fn(() => qb);
      return qb;
    }

    it('refuses getMany() when the built SQL never constrains organization_id', async () => {
      const { repository, manager } = buildRepository();
      const qb = fakeQueryBuilder('SELECT * FROM intents i WHERE i.status = $1');
      manager.createQueryBuilder.mockReturnValue(qb);

      expect(await codeOfRejection(() => repository.createQueryBuilder('i').getMany())).toBe(
        OrganizationErrorCode.ORGANIZATION_SCOPE_MISSING,
      );
      expect(qb.getMany).not.toHaveBeenCalled();
    });

    it('allows getMany() when the built SQL constrains organization_id', async () => {
      const { repository, manager } = buildRepository();
      const qb = fakeQueryBuilder(
        'SELECT * FROM intents i WHERE i.organization_id = $1 AND i.status = $2',
      );
      manager.createQueryBuilder.mockReturnValue(qb);

      await expect(repository.createQueryBuilder('i').getMany()).resolves.toEqual([]);
      expect(qb.getMany).toHaveBeenCalledTimes(1);
    });

    it('keeps guarding after a chained .where() — the chain must not hand back the raw builder', async () => {
      const { repository, manager } = buildRepository();
      const qb = fakeQueryBuilder('SELECT * FROM intents i WHERE i.status = $1');
      manager.createQueryBuilder.mockReturnValue(qb);

      const chained = repository.createQueryBuilder('i').where('i.status = :status');

      expect(await codeOfRejection(() => chained.getMany())).toBe(
        OrganizationErrorCode.ORGANIZATION_SCOPE_MISSING,
      );
      expect(qb.getMany).not.toHaveBeenCalled();
    });
  });
});
