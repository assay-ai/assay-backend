import { McpCallerKind } from '@modules/mcp/ports/mcp-session.port';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { CredentialSessionResolver } from '@modules/auth/services/credential-session.resolver';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { FakeAgentRepository, buildAgent } from './helpers/fake-agent-repository';
import {
  FakeAgentCredentialRepository,
  buildCredential,
} from './helpers/fake-agent-credential-repository';

const ACCOUNT =
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const CHAIN = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

/**
 * The seam every stored-credential source shares: an `agent_credentials` row,
 * however it was found (API-key hash or OAuth access token), becomes one
 * session shape through the same checks. Only `paymentsAllowed` is the
 * caller's to choose.
 */
describe('CredentialSessionResolver — one credential row, one session shape', () => {
  function build() {
    const credentials = new FakeAgentCredentialRepository();
    const agents = new FakeAgentRepository();
    const resolver = new CredentialSessionResolver(
      credentials as unknown as AgentCredentialRepository,
      agents as unknown as AgentRepository,
    );
    return { resolver, credentials, agents };
  }

  function seedLinkedAgent(
    agents: FakeAgentRepository,
    overrides = {},
    organizationStatus = 'ACTIVE',
  ) {
    return agents.seed(
      buildAgent({
        id: 'agent-1',
        organizationId: 'org-1',
        primaryAccountId: ACCOUNT,
        chainId: CHAIN,
        label: 'ci-deploy',
        ...overrides,
      }),
      organizationStatus,
    );
  }

  it('refuses a credential whose organization is suspended with AUTH_ORGANIZATION_SUSPENDED', async () => {
    const { resolver, agents } = build();
    seedLinkedAgent(agents, {}, 'SUSPENDED');

    await expectErrorCodeAsync(
      () => resolver.sessionFor(buildCredential(), { paymentsAllowed: true }),
      'AUTH_ORGANIZATION_SUSPENDED',
    );
  });

  it('refuses a credential naming an agent of another organization as MCP_CREDENTIAL_INVALID', async () => {
    const { resolver, agents } = build();
    seedLinkedAgent(agents, { organizationId: 'org-2' });

    await expectErrorCodeAsync(
      () => resolver.sessionFor(buildCredential(), { paymentsAllowed: true }),
      'MCP_CREDENTIAL_INVALID',
    );
  });

  it('refuses an expired credential as MCP_CREDENTIAL_INVALID, before any agent read', async () => {
    const { resolver, agents } = build();
    seedLinkedAgent(agents);

    await expectErrorCodeAsync(
      () =>
        resolver.sessionFor(buildCredential({ expiresAt: new Date('2020-01-01T00:00:00Z') }), {
          paymentsAllowed: true,
        }),
      'MCP_CREDENTIAL_INVALID',
    );
    // An inactive row costs no second query, so it times like an unknown token.
    expect(agents.findByIdWithOrganizationCalls).toBe(0);
  });

  it('refuses a revoked credential as MCP_CREDENTIAL_INVALID, before any agent read', async () => {
    const { resolver, agents } = build();
    seedLinkedAgent(agents);

    await expectErrorCodeAsync(
      () =>
        resolver.sessionFor(buildCredential({ revokedAt: new Date('2026-08-01T00:00:00Z') }), {
          paymentsAllowed: true,
        }),
      'MCP_CREDENTIAL_INVALID',
    );
    expect(agents.findByIdWithOrganizationCalls).toBe(0);
  });

  it.each([true, false])('copies paymentsAllowed=%s from opts', async (paymentsAllowed) => {
    const { resolver, agents } = build();
    seedLinkedAgent(agents);

    const session = await resolver.sessionFor(buildCredential({ id: 'cred-42' }), {
      paymentsAllowed,
    });

    expect(session).toEqual({
      credentialId: 'cred-42',
      storedCredential: true,
      organizationId: 'org-1',
      agentId: 'agent-1',
      agentAccount: ACCOUNT,
      chainId: CHAIN,
      label: 'ci-deploy',
      callerKind: McpCallerKind.AGENT,
      delegateAccount: null,
      paymentsAllowed,
      scopes: ['tools:call', 'payments', 'activity:read'],
    });
  });

  it('stamps last_used_at scoped by organizationId', async () => {
    const { resolver, credentials, agents } = build();
    seedLinkedAgent(agents);

    await resolver.sessionFor(buildCredential({ id: 'cred-42' }), { paymentsAllowed: true });
    // Fire-and-forget: give the un-awaited promise a tick to settle.
    await Promise.resolve();

    expect(credentials.updateCalls).toHaveLength(1);
    expect(credentials.updateCalls[0]!.criteria).toEqual({
      organizationId: 'org-1',
      id: 'cred-42',
    });
    expect((credentials.updateCalls[0]!.patch as { lastUsedAt: Date }).lastUsedAt).toBeInstanceOf(
      Date,
    );
  });

  it('does not let a failed last_used_at stamp reject sessionFor', async () => {
    const { resolver, credentials, agents } = build();
    seedLinkedAgent(agents);
    credentials.failNextUpdate = true;

    const session = await resolver.sessionFor(buildCredential({ id: 'cred-42' }), {
      paymentsAllowed: true,
    });
    // Let the rejected, un-awaited stamp settle.
    await Promise.resolve();

    expect(credentials.updateCalls).toHaveLength(1);
    expect(session).toEqual({
      credentialId: 'cred-42',
      storedCredential: true,
      organizationId: 'org-1',
      agentId: 'agent-1',
      agentAccount: ACCOUNT,
      chainId: CHAIN,
      label: 'ci-deploy',
      callerKind: McpCallerKind.AGENT,
      delegateAccount: null,
      paymentsAllowed: true,
      scopes: ['tools:call', 'payments', 'activity:read'],
    });
  });

  describe('scopes', () => {
    it("carries the row's scopes, dropping any value outside the vocabulary", async () => {
      const { resolver, agents } = build();
      seedLinkedAgent(agents);

      const session = await resolver.sessionFor(
        buildCredential({ scopes: ['activity:read', 'admin', 'reports:write'] }),
        { paymentsAllowed: true },
      );

      expect(session.scopes).toEqual(['activity:read', 'reports:write']);
    });

    it('a row without payments is free-only, whatever the source allows', async () => {
      const { resolver, agents } = build();
      seedLinkedAgent(agents);

      const session = await resolver.sessionFor(buildCredential({ scopes: ['tools:call'] }), {
        paymentsAllowed: true,
      });

      expect(session.paymentsAllowed).toBe(false);
      expect(session.scopes).toEqual(['tools:call']);
      // The paid-call path refuses it by scope (M2).
      expect(session.paymentsScopeMissing).toBe(true);
    });

    it('a session that may not pay carries no payment key, whatever the row holds (M2)', async () => {
      const { resolver, agents } = build();
      seedLinkedAgent(agents);
      const row = buildCredential({
        scopes: ['tools:call'],
        delegateAccount: `${CHAIN}:0x00000000000000000000000000000000000000d1`,
      });

      const session = await resolver.sessionFor(row, { paymentsAllowed: true });

      expect(session.delegateAccount).toBeNull();
    });

    it('payments does not lift a source that refuses payments (third-party OAuth)', async () => {
      const { resolver, agents } = build();
      seedLinkedAgent(agents);

      const session = await resolver.sessionFor(buildCredential(), { paymentsAllowed: false });

      expect(session.paymentsAllowed).toBe(false);
      // The source's own answer stands: no scope refusal for a third-party grant.
      expect(session.paymentsScopeMissing).toBeUndefined();
    });

    it('a row with no scopes may do nothing', async () => {
      const { resolver, agents } = build();
      seedLinkedAgent(agents);

      const session = await resolver.sessionFor(buildCredential({ scopes: [] }), {
        paymentsAllowed: true,
      });

      expect(session.scopes).toEqual([]);
      expect(session.paymentsAllowed).toBe(false);
    });
  });
});
