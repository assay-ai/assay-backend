import { McpCallerKind } from '@modules/mcp/ports/mcp-session.port';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { DbCredentialMcpSessionSource } from '@modules/auth/services/db-credential-mcp-session.source';
import { digestToken } from '@shared/crypto/token-digest';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { FakeAgentRepository, buildAgent } from './helpers/fake-agent-repository';
import {
  FakeAgentCredentialRepository,
  buildCredential,
} from './helpers/fake-agent-credential-repository';

const TOKEN = 'x402_sk_live_abcdefghijklmnopqrstuvwxyz012345';
const ACCOUNT =
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const CHAIN = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

/**
 * `agent_credentials` tokens, resolved to a session (the third session
 * source). This closes the gap `POST /agents/:agentId/credentials` opened:
 * the token it mints has never been readable by anything until now.
 */
describe('DbCredentialMcpSessionSource — the credential a user actually created', () => {
  function build() {
    const credentials = new FakeAgentCredentialRepository();
    const agents = new FakeAgentRepository();
    const source = new DbCredentialMcpSessionSource(
      credentials as unknown as AgentCredentialRepository,
      agents as unknown as AgentRepository,
    );
    return { source, credentials, agents };
  }

  function seedLinkedAgent(agents: FakeAgentRepository, overrides = {}) {
    return agents.seed(
      buildAgent({
        id: 'agent-1',
        organizationId: 'org-1',
        primaryAccountId: ACCOUNT,
        chainId: CHAIN,
        label: 'ci-deploy',
        ...overrides,
      }),
    );
  }

  it('refuses a token without the x402_sk_live_ prefix — the chain must be able to continue', async () => {
    const { source } = build();

    await expectErrorCodeAsync(
      () => source.resolve('a-jwt-shaped-privy.token.here'),
      'MCP_CREDENTIAL_INVALID',
    );
  });

  it('refuses a null bearer token', async () => {
    const { source } = build();

    await expectErrorCodeAsync(() => source.resolve(null), 'MCP_CREDENTIAL_INVALID');
  });

  it('refuses a well-formed token that names no credential', async () => {
    const { source } = build();

    await expectErrorCodeAsync(() => source.resolve(TOKEN), 'MCP_CREDENTIAL_INVALID');
  });

  it('refuses a revoked credential', async () => {
    const { source, credentials, agents } = build();
    seedLinkedAgent(agents);
    credentials.seed(
      buildCredential({
        tokenHash: digestToken(TOKEN),
        revokedAt: new Date('2026-08-01T00:00:00Z'),
      }),
    );

    await expectErrorCodeAsync(() => source.resolve(TOKEN), 'MCP_CREDENTIAL_INVALID');
  });

  it('refuses an expired credential', async () => {
    const { source, credentials, agents } = build();
    seedLinkedAgent(agents);
    credentials.seed(
      buildCredential({
        tokenHash: digestToken(TOKEN),
        expiresAt: new Date('2020-01-01T00:00:00Z'),
      }),
    );

    await expectErrorCodeAsync(() => source.resolve(TOKEN), 'MCP_CREDENTIAL_INVALID');
  });

  it('refuses a credential naming an agent that does not exist — not a 404', async () => {
    const { source, credentials } = build();
    credentials.seed(buildCredential({ tokenHash: digestToken(TOKEN), agentId: 'no-such-agent' }));

    await expectErrorCodeAsync(() => source.resolve(TOKEN), 'MCP_CREDENTIAL_INVALID');
  });

  it('refuses an agent with no linked wallet', async () => {
    const { source, credentials, agents } = build();
    seedLinkedAgent(agents, { primaryAccountId: null, chainId: null });
    credentials.seed(buildCredential({ tokenHash: digestToken(TOKEN) }));

    await expectErrorCodeAsync(() => source.resolve(TOKEN), 'AUTH_WALLET_NOT_LINKED');
  });

  it('refuses a suspended agent', async () => {
    const { source, credentials, agents } = build();
    seedLinkedAgent(agents, { status: 'SUSPENDED' });
    credentials.seed(buildCredential({ tokenHash: digestToken(TOKEN) }));

    await expectErrorCodeAsync(() => source.resolve(TOKEN), 'AUTH_AGENT_SUSPENDED');
  });

  it('resolves a valid credential to a session with all six fields correct', async () => {
    const { source, credentials, agents } = build();
    seedLinkedAgent(agents);
    credentials.seed(buildCredential({ id: 'cred-42', tokenHash: digestToken(TOKEN) }));

    const session = await source.resolve(TOKEN);

    expect(session).toEqual({
      credentialId: 'cred-42',
      organizationId: 'org-1',
      agentId: 'agent-1',
      agentAccount: ACCOUNT,
      chainId: CHAIN,
      label: 'ci-deploy',
      // a machine credential is never a person (BUG-J-BUY-07)
      callerKind: McpCallerKind.AGENT,
      // No delegate key bound to this credential yet.
      delegateAccount: null,
    });
  });

  it('carries the delegate key the credential proved it holds, so the MCP session knows its signer', async () => {
    const { source, credentials, agents } = build();
    seedLinkedAgent(agents);
    const delegate = `${CHAIN}:0x5555555555555555555555555555555555555555`;
    credentials.seed(
      buildCredential({
        id: 'cred-43',
        tokenHash: digestToken(TOKEN),
        delegateAccount: delegate,
        delegateBoundAt: new Date(),
      }),
    );

    const session = await source.resolve(TOKEN);

    expect(session.delegateAccount).toBe(delegate);
  });

  it('stamps last_used_at with organizationId in the update criteria', async () => {
    const { source, credentials, agents } = build();
    seedLinkedAgent(agents);
    credentials.seed(buildCredential({ id: 'cred-42', tokenHash: digestToken(TOKEN) }));

    await source.resolve(TOKEN);
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

  it('does not let a failed stamp reject the whole resolve', async () => {
    const { source, credentials, agents } = build();
    seedLinkedAgent(agents);
    credentials.seed(buildCredential({ tokenHash: digestToken(TOKEN) }));
    credentials.failNextUpdate = true;

    await expect(source.resolve(TOKEN)).resolves.toBeDefined();
  });
});
