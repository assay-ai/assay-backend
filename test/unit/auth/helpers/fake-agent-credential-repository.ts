import { AgentCredentialEntity } from '@database/postgres/entities/agent-credential.entity';

export function buildCredential(
  overrides: Partial<AgentCredentialEntity> = {},
): AgentCredentialEntity {
  return {
    id: 'cred-1',
    organizationId: 'org-1',
    agentId: 'agent-1',
    name: 'CI deploy',
    prefix: 'x402_sk_live_abcd1234',
    tokenHash: 'digest-placeholder',
    scopes: [],
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    revokedBy: null,
    rotatedFromId: null,
    createdAt: new Date('2026-08-20T10:00:00.000Z'),
    updatedAt: new Date('2026-08-20T10:00:00.000Z'),
    version: 1,
    ...overrides,
  } as unknown as AgentCredentialEntity;
}

/**
 * An in-memory `AgentCredentialRepository` — same house rule as
 * `FakeAgentRepository`: no `jest.mock` of a repository. What
 * `DbCredentialMcpSessionSource`'s tests need to assert is that the stamp
 * criteria actually carried `organizationId`, which only something holding
 * calls (not just rows) can answer.
 */
export class FakeAgentCredentialRepository {
  readonly rows = new Map<string, AgentCredentialEntity>();
  readonly updateCalls: Array<{ criteria: unknown; patch: unknown }> = [];

  /** Makes `update` reject, the way `ORGANIZATION_SCOPE_MISSING` would. */
  failNextUpdate = false;

  seed(credential: AgentCredentialEntity): AgentCredentialEntity {
    this.rows.set(credential.tokenHash, credential);
    return credential;
  }

  findByTokenHash(tokenHash: string): Promise<AgentCredentialEntity | null> {
    return Promise.resolve(this.rows.get(tokenHash) ?? null);
  }

  update(criteria: unknown, patch: unknown): Promise<{ affected: number }> {
    this.updateCalls.push({ criteria, patch });
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      return Promise.reject(new Error('ORGANIZATION_SCOPE_MISSING'));
    }
    return Promise.resolve({ affected: 1 });
  }
}
