import { DataSource, FindManyOptions, FindOperator } from 'typeorm';

import { ProviderChainEnrolmentEntity } from '@database/postgres/entities/provider-chain-enrolment.entity';
import { ProviderChainEnrolmentRepository } from '@database/postgres/repositories/provider-chain-enrolment.repository';

const PROVIDER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

/**
 * `ProviderChainEnrolmentRepository.findByProviders` actually reads the table.
 *
 * ## Why this file exists at all
 *
 * A reviewer's degenerate repository —
 *
 * ```ts
 * async findByProviders(providerIds: readonly string[]) {
 *   void providerIds;
 *   return [];
 * }
 * ```
 *
 * — passed `yarn lint`, `yarn build` and all 3572 unit tests. It was caught by
 * exactly four assertions, all of them in
 * `test/integration/provider/provider-chain-enrolment.integration.spec.ts`,
 * which `yarn test` does not invoke and no CI runs. A repository that reads
 * nothing therefore shipped green through every command anybody actually types.
 *
 * This file closes that inside the unit suite. It is deliberately **not** a
 * substitute for the integration spec: only that one can prove the entity's
 * column names match the migration's, because only that one goes to Postgres.
 * What this proves is narrower and is the half the degenerate exploited — that
 * a read is issued, that it names the ids it was given, and that what comes
 * back is what the database returned.
 *
 * ## The seam
 *
 * `find()` on `OrganizationScopedRepository` asserts the scope and then calls
 * TypeORM's `Repository.find`, which is `this.manager.find(this.metadata.target,
 * options)`. Stubbing `manager.find` and `manager.connection.getMetadata` — and
 * nothing else — runs the real scope assertion and the real method body, the
 * same technique `agent.repository.spec.ts` uses.
 */
function buildRepository(rows: ProviderChainEnrolmentEntity[]) {
  const calls: FindManyOptions<ProviderChainEnrolmentEntity>[] = [];
  const manager = {
    find: jest.fn(
      async (_target: unknown, options: FindManyOptions<ProviderChainEnrolmentEntity>) => {
        calls.push(options);
        return rows;
      },
    ),
    connection: {
      getMetadata: () => ({
        target: ProviderChainEnrolmentEntity,
        name: 'ProviderChainEnrolmentEntity',
      }),
    },
  };

  const dataSource = { manager } as unknown as DataSource;
  return { repository: new ProviderChainEnrolmentRepository(dataSource), manager, calls };
}

const enrolment = (organizationId: string): ProviderChainEnrolmentEntity =>
  ({ organizationId }) as ProviderChainEnrolmentEntity;

describe('ProviderChainEnrolmentRepository.findByProviders', () => {
  it('issues exactly one read, naming every provider it was given', async () => {
    const { repository, manager, calls } = buildRepository([]);

    await repository.findByProviders([PROVIDER, OTHER]);

    expect(manager.find).toHaveBeenCalledTimes(1);
    const where = calls[0].where as { organizationId: FindOperator<string> };
    // An `In` over exactly those ids — not `IsNull`, not `Not(IsNull())`, and
    // not a predicate that happens to mention the column. `In` is also what
    // keeps this read inside the organization scope guard rather than on the
    // cross-tenant allowlist.
    expect(where.organizationId).toBeInstanceOf(FindOperator);
    expect(where.organizationId.type).toBe('in');
    expect(where.organizationId.value).toEqual([PROVIDER, OTHER]);
  });

  it('returns what the database returned, unchanged', async () => {
    // The degenerate returned `[]` from a body that never asked. Pinning the
    // rows *through* means a repository that reads and then discards dies here
    // too.
    const rows = [enrolment(PROVIDER), enrolment(OTHER)];
    const { repository } = buildRepository(rows);

    await expect(repository.findByProviders([PROVIDER, OTHER])).resolves.toEqual(rows);
  });

  it('does not go to the database at all for an empty provider list', async () => {
    const { repository, manager } = buildRepository([enrolment(PROVIDER)]);

    await expect(repository.findByProviders([])).resolves.toEqual([]);

    expect(manager.find).not.toHaveBeenCalled();
  });
});
