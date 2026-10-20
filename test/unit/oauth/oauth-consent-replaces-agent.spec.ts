import { OAuthClientKind } from '@database/postgres/entities/oauth-client.entity';
import { CredentialIssuedVia } from '@database/postgres/entities/agent-credential.entity';
import { OAuthConsentService } from '@modules/oauth/services/oauth-consent.service';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';

/**
 * A re-login (`assay_replaces`) replaces the same agent's connection. Approving
 * it as another agent would leave the old grant holding the payment key, and
 * assay-mcp's rebind would then fail with ACCOUNT_DELEGATE_ALREADY_BOUND.
 */
const ORG = 'org-1';
const RID = 'rid-1';
const OLD_AGENT = '11111111-1111-4111-8111-111111111111';
const NEW_AGENT = '22222222-2222-4222-8222-222222222222';
const GRANT = '33333333-3333-4333-8333-333333333333';
const BUILTIN = { id: 'client-row-1', clientId: 'builtin', kind: OAuthClientKind.BUILTIN };

function agentRow(id: string, label: string | null) {
  return {
    id,
    label,
    organizationId: ORG,
    status: 'ACTIVE',
    primaryAccountId: `eip155:1:0x${id.slice(0, 8)}`,
    chainId: 'eip155:1',
  };
}

function build(options: { grant?: { agentId: string; live: boolean } | null } = {}) {
  const grant =
    options.grant === null
      ? null
      : {
          id: GRANT,
          name: 'Assay app on this Mac',
          organizationId: ORG,
          agentId: options.grant?.agentId ?? OLD_AGENT,
          oauthClientId: BUILTIN.id,
          issuedVia: CredentialIssuedVia.OAUTH,
          accessMode: null,
          allowedToolsets: null,
          allowedToolIds: null,
          revokedAt: options.grant?.live === false ? new Date(Date.now() - 1000) : null,
          expiresAt: null,
        };
  const agents = [agentRow(OLD_AGENT, 'Laptop agent'), agentRow(NEW_AGENT, null)];
  const request = {
    oauthClientId: BUILTIN.id,
    redirectUri: 'http://127.0.0.1:5000/cb',
    scope: 'mcp',
    device: 'this Mac',
    createdAt: Date.now(),
    replaces: GRANT,
  };
  const decide = jest.fn().mockResolvedValue('ok');
  const service = new OAuthConsentService(
    { bind: jest.fn().mockResolvedValue({ status: 'ok', request }), decide } as never,
    {
      findById: jest.fn().mockResolvedValue(BUILTIN),
      displayFor: jest.fn(() => ({
        name: 'Assay app',
        registrableDomain: null,
        host: null,
        verified: true,
        returnTo: { kind: 'loopback', display: 'this computer' },
      })),
      isPaymentClient: jest.fn(() => true),
    } as never,
    {
      find: jest.fn().mockResolvedValue(agents),
      findOne: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(agents.find((agent) => agent.id === where.id) ?? null),
      ),
    } as never,
    { findById: jest.fn().mockResolvedValue({ id: ORG, status: 'ACTIVE' }) } as never,
    {
      findOne: jest.fn().mockResolvedValue(grant),
      countLiveOAuthByAgent: jest.fn().mockResolvedValue(new Map()),
      countLiveOAuthForAgent: jest.fn().mockResolvedValue(1),
    } as never,
    { find: jest.fn().mockResolvedValue([]) } as never,
    { incConsent: jest.fn().mockResolvedValue(undefined) } as never,
    { platformAgentDailyLimit: 10 },
    { issuer: 'https://mcp.example.test' },
  );
  const session = { organizationId: ORG, agentId: 'person-1' } as unknown as McpSession;
  return { service, session, decide };
}

describe('OAuthConsentService — a re-login stays on the replaced agent', () => {
  it('names the agent of the live replaced grant in replacesAgent', async () => {
    const { service, session } = build();

    const dto = await service.read(session, RID);

    expect(dto.replacesAgent).toEqual({ id: OLD_AGENT, name: 'Laptop agent' });
  });

  it('replacesAgent is null when nothing is replaced or the replaced grant is dead', async () => {
    for (const grant of [null, { agentId: OLD_AGENT, live: false }]) {
      const { service, session } = build({ grant });
      expect((await service.read(session, RID)).replacesAgent).toBeNull();
    }
  });

  it('falls back to "Unnamed agent" for an agent without a label', async () => {
    const { service, session } = build({ grant: { agentId: NEW_AGENT, live: true } });

    expect((await service.read(session, RID)).replacesAgent).toEqual({
      id: NEW_AGENT,
      name: 'Unnamed agent',
    });
  });

  it('refuses approval as another agent with 409 OAUTH_REPLACE_AGENT_MISMATCH', async () => {
    const { service, session, decide } = build();

    const refusal = (await service
      .approve(session, RID, { agentId: NEW_AGENT, name: 'Assay app' })
      .catch((error: unknown) => error)) as {
      errorCode: string;
      statusCode: number;
      message: string;
    };

    expect(refusal).toMatchObject({ errorCode: 'OAUTH_REPLACE_AGENT_MISMATCH', statusCode: 409 });
    expect(refusal.message).toBe(
      "This sign-in replaces Laptop agent's connection. Sign out first to connect another agent.",
    );
    expect(decide).not.toHaveBeenCalled();
  });

  it('approves as the same agent and carries the replaced grant', async () => {
    const { service, session, decide } = build();

    await service.approve(session, RID, { agentId: OLD_AGENT, name: 'Assay app' });

    expect(decide).toHaveBeenCalledWith(RID, ORG, expect.objectContaining({ replaces: GRANT }));
  });

  it('a dead replaced grant of another agent is dropped, not refused', async () => {
    const { service, session, decide } = build({ grant: { agentId: OLD_AGENT, live: false } });

    await service.approve(session, RID, { agentId: NEW_AGENT, name: 'Assay app' });

    expect(decide).toHaveBeenCalledWith(RID, ORG, expect.objectContaining({ replaces: null }));
  });
});
