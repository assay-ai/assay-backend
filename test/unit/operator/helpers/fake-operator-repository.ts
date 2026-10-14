import { OperatorEntity } from '@database/postgres/entities/operator.entity';

export function buildOperator(overrides: Partial<OperatorEntity> = {}): OperatorEntity {
  return {
    id: 'op-1',
    subject: 'dan@',
    displayName: 'Dan',
    email: 'dan@example.com',
    roles: [],
    authorityLimitMinor: null,
    walletAddress: null,
    status: 'ACTIVE',
    suspendedAt: null,
    removedAt: null,
    lastSeenAt: null,
    createdAt: new Date('2026-08-10T10:00:00.000Z'),
    updatedAt: new Date('2026-08-10T10:00:00.000Z'),
    version: 1,
    ...overrides,
  } as unknown as OperatorEntity;
}

/**
 * An in-memory stand-in for `OperatorRepository` — just the finders and the
 * one write `WalletOperatorSessionSource` and `OperatorService` actually
 * call. Same technique as `test/unit/notification/helpers/fake-redis.ts`: a
 * fake that models state (rows keyed by subject and id, recorded updates)
 * proves what a real repository hides, rather than asserting on call
 * arguments alone.
 */
export class FakeOperatorRepository {
  private readonly byId = new Map<string, OperatorEntity>();
  private readonly bySubject = new Map<string, OperatorEntity>();
  readonly updates: Array<{ id: string; fields: Record<string, unknown> }> = [];
  /** Set to make `update` reject — standing in for a stamp that failed mid-request. */
  updateFails = false;

  seed(operator: OperatorEntity): OperatorEntity {
    this.byId.set(operator.id, operator);
    this.bySubject.set(operator.subject, operator);
    return operator;
  }

  findBySubject(subject: string): Promise<OperatorEntity | null> {
    return Promise.resolve(this.bySubject.get(subject) ?? null);
  }

  findByWallet(address: string): Promise<OperatorEntity | null> {
    const wallet = address.toLowerCase();
    return Promise.resolve([...this.byId.values()].find((o) => o.walletAddress === wallet) ?? null);
  }

  findById(id: string): Promise<OperatorEntity | null> {
    return Promise.resolve(this.byId.get(id) ?? null);
  }

  listAll(): Promise<OperatorEntity[]> {
    return Promise.resolve([...this.byId.values()]);
  }

  update(criteria: { id: string }, fields: Record<string, unknown>): Promise<{ affected: number }> {
    this.updates.push({ id: criteria.id, fields });
    if (this.updateFails) {
      return Promise.reject(new Error('operator update failed'));
    }
    return Promise.resolve({ affected: 1 });
  }
}
