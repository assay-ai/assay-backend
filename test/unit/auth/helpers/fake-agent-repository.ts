import { randomUUID } from 'node:crypto';

import { AgentEntity } from '@database/postgres/entities/agent.entity';
import {
  AgentWithOrganization,
  ProvisionAgentInput,
} from '@database/postgres/repositories/agent.repository';

export function buildAgent(overrides: Partial<AgentEntity> = {}): AgentEntity {
  return {
    id: 'agent-1',
    organizationId: 'org-1',
    privyUserId: 'did:privy:test-subject',
    email: null,
    label: null,
    status: 'ACTIVE',
    primaryAccountId: null,
    chainId: null,
    lastLoginAt: null,
    createdAt: new Date('2026-08-20T10:00:00.000Z'),
    updatedAt: new Date('2026-08-20T10:00:00.000Z'),
    version: 1,
    ...overrides,
  } as unknown as AgentEntity;
}

/**
 * An in-memory `AgentRepository` that holds rows.
 *
 * Per the house rule in `test/unit/`: no `jest.mock` of a repository. What
 * these tests need to assert is what the rows end up saying — that a first
 * login created exactly one organization, that a linked account was actually
 * written, that a lost race resolved onto the *winner's* row — and only
 * something holding state can answer any of that.
 */
export class FakeAgentRepository {
  readonly rows = new Map<string, AgentEntity>();
  readonly organizations = new Map<string, { id: string; name: string; status: string }>();

  /** Every `createWithOrganization` call, in order. */
  readonly creates: ProvisionAgentInput[] = [];
  readonly loginStamps: Array<{ id: string; at: Date }> = [];

  /**
   * Simulates losing the unique-index race: the first create raises `23505`,
   * and whatever `seedOnConflict` holds is what the re-read finds.
   */
  failNextCreateWithUniqueViolation = false;
  seedOnConflict: AgentEntity | null = null;

  /** Makes `linkPrimaryAccount` reject — a link that failed mid-request. */
  linkFails = false;
  /** Makes `stampLogin` reject — the best-effort write that must not fail a login. */
  stampFails = false;

  /** How many times `findByIdWithOrganization` ran — the credential join. */
  findByIdWithOrganizationCalls = 0;

  seed(agent: AgentEntity, organizationStatus = 'ACTIVE'): AgentEntity {
    this.rows.set(agent.privyUserId, agent);
    this.organizations.set(agent.organizationId, {
      id: agent.organizationId,
      name: 'seeded',
      status: organizationStatus,
    });
    return agent;
  }

  findByPrivyUserId(privyUserId: string): Promise<AgentEntity | null> {
    return Promise.resolve(this.rows.get(privyUserId) ?? null);
  }

  /** `rows` is keyed by DID, not by id — this is `DbCredentialMcpSessionSource`'s join. */
  findById(id: string): Promise<AgentEntity | null> {
    for (const agent of this.rows.values()) {
      if (agent.id === id) return Promise.resolve(agent);
    }
    return Promise.resolve(null);
  }

  findByIdWithOrganization(id: string): Promise<AgentWithOrganization | null> {
    this.findByIdWithOrganizationCalls += 1;
    for (const agent of this.rows.values()) {
      if (agent.id !== id) continue;
      return Promise.resolve({
        agent,
        organizationStatus: this.organizations.get(agent.organizationId)?.status ?? 'ACTIVE',
      });
    }
    return Promise.resolve(null);
  }

  findWithOrganization(privyUserId: string): Promise<AgentWithOrganization | null> {
    const agent = this.rows.get(privyUserId);
    if (!agent) return Promise.resolve(null);

    return Promise.resolve({
      agent,
      organizationStatus: this.organizations.get(agent.organizationId)?.status ?? 'ACTIVE',
    });
  }

  createWithOrganization(input: ProvisionAgentInput): Promise<AgentEntity> {
    this.creates.push(input);

    if (this.failNextCreateWithUniqueViolation) {
      this.failNextCreateWithUniqueViolation = false;
      if (this.seedOnConflict) this.seed(this.seedOnConflict);
      // The shape node-postgres raises and TypeORM re-throws.
      return Promise.reject(Object.assign(new Error('duplicate key value'), { code: '23505' }));
    }

    const organizationId = randomUUID();
    this.organizations.set(organizationId, {
      id: organizationId,
      name: input.organizationName,
      status: 'ACTIVE',
    });

    const agent = buildAgent({
      id: randomUUID(),
      organizationId,
      privyUserId: input.privyUserId,
      email: input.email,
      label: input.label,
      lastLoginAt: new Date(),
    });

    this.rows.set(agent.privyUserId, agent);
    return Promise.resolve(agent);
  }

  stampLogin(id: string, at: Date): Promise<void> {
    this.loginStamps.push({ id, at });
    return this.stampFails ? Promise.reject(new Error('stamp failed')) : Promise.resolve();
  }

  linkPrimaryAccount(id: string, accountId: string, chainId: string): Promise<void> {
    if (this.linkFails) return Promise.reject(new Error('link failed'));

    for (const agent of this.rows.values()) {
      // Mirrors the real `WHERE primary_account_id IS NULL`: a row that already
      // has an account is not repointed at another address.
      if (agent.id === id && agent.primaryAccountId === null) {
        agent.primaryAccountId = accountId;
        agent.chainId = chainId;
      }
    }
    return Promise.resolve();
  }
}
