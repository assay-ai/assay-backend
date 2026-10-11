import { McpCallerKind } from '@modules/mcp/ports/mcp-session.port';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { AgentProvisioningService } from '@modules/auth/services/agent-provisioning.service';
import { PrivyJwksCache } from '@modules/auth/services/privy-jwks.cache';
import { PrivyMcpSessionSource } from '@modules/auth/services/privy-mcp-session.source';
import { PrivyTokenVerifier } from '@modules/auth/services/privy-token.verifier';
import { PrivyUserDirectory } from '@modules/auth/services/privy-user.directory';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { FakeAgentRepository, buildAgent } from './helpers/fake-agent-repository';
import {
  FakeJwksCache,
  TEST_PRIVY_CONFIG,
  createSigningKey,
  mintToken,
  withConfig,
} from './helpers/privy-tokens';

const ACCOUNT =
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

/** The directory is off in these tests: what a wallet *lookup* does is its own suite's subject. */
class SilentDirectory {
  lookup(): Promise<null> {
    return Promise.resolve(null);
  }
}

/**
 * A Privy token resolved to a session.
 *
 * This is the class that replaces `ConfigMcpSessionSource`, so the tests are
 * shaped around the two things the swap must not change: the port's refusal
 * contract, and where the session's facts come from. A token names an
 * identity; every other field on the session is read from our own rows.
 */
describe('PrivyMcpSessionSource — the token names an identity, the rows name everything else', () => {
  const key = createSigningKey('kid-live');

  function build(config = TEST_PRIVY_CONFIG) {
    const agents = new FakeAgentRepository();
    const verifier = new PrivyTokenVerifier(
      FakeJwksCache.withKeys(key) as unknown as PrivyJwksCache,
      config,
    );
    const provisioning = new AgentProvisioningService(
      agents as unknown as AgentRepository,
      new SilentDirectory() as unknown as PrivyUserDirectory,
      config,
    );

    return { source: new PrivyMcpSessionSource(verifier, provisioning), agents };
  }

  function seedLinkedAgent(agents: FakeAgentRepository, overrides = {}) {
    return agents.seed(
      buildAgent({
        id: 'agent-1',
        organizationId: 'org-1',
        privyUserId: 'did:privy:test-subject',
        label: 'dan@example.com',
        primaryAccountId: ACCOUNT,
        chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
        ...overrides,
      }),
    );
  }

  it('resolves a verified token to the session its rows describe', async () => {
    const { source, agents } = build();
    seedLinkedAgent(agents);

    const session = await source.resolve(mintToken({ key }));

    expect(session).toEqual({
      credentialId: 'session-1',
      organizationId: 'org-1',
      agentId: 'agent-1',
      agentAccount: ACCOUNT,
      chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      label: 'dan@example.com',
      // a Privy login is a person
      callerKind: McpCallerKind.HUMAN,
    });
  });

  it('carries the Privy session id as credentialId — never the token', async () => {
    const { source, agents } = build();
    seedLinkedAgent(agents);
    const token = mintToken({ key, claims: { sid: 'sess-xyz' } });

    const session = await source.resolve(token);

    expect(session.credentialId).toBe('sess-xyz');
    expect(JSON.stringify(session)).not.toContain(token);
  });

  it('falls back to the DID when the token carries no session id', async () => {
    const { source, agents } = build();
    seedLinkedAgent(agents);

    const session = await source.resolve(mintToken({ key, claims: { sid: undefined } }));

    expect(session.credentialId).toBe('did:privy:test-subject');
  });

  it('refuses a missing token with the same code an unknown one gets', async () => {
    const { source, agents } = build();
    seedLinkedAgent(agents);

    await expectErrorCodeAsync(() => source.resolve(null), 'MCP_CREDENTIAL_INVALID');
    await expectErrorCodeAsync(() => source.resolve(''), 'MCP_CREDENTIAL_INVALID');
    await expectErrorCodeAsync(() => source.resolve('not-a-token'), 'MCP_CREDENTIAL_INVALID');
  });

  it('gives an expired token, a forged one and a wrong-audience one the identical refusal', async () => {
    const { source, agents } = build();
    seedLinkedAgent(agents);
    const impostor = createSigningKey('kid-live');
    const nowSeconds = Math.floor(Date.now() / 1000);

    const refusals = await Promise.all(
      [
        mintToken({ key, claims: { exp: nowSeconds - 600 } }),
        mintToken({ key: impostor }),
        mintToken({ key, claims: { aud: 'another-app' } }),
      ].map((token) => source.resolve(token).catch((error: Error) => error)),
    );

    // `toJSON` stamps a fresh timestamp, so the comparison is over what a
    // caller can actually distinguish: code, status and message.
    const rendered = refusals.map((error) => {
      const { errorCode, statusCode, message } = error as unknown as {
        errorCode: string;
        statusCode: number;
        message: string;
      };
      return JSON.stringify({ errorCode, statusCode, message });
    });

    expect(new Set(rendered).size).toBe(1);
    expect(rendered[0]).toContain('MCP_CREDENTIAL_INVALID');
  });

  it('creates the organization when a verified identity arrives for the first time', async () => {
    const { source, agents } = build();

    // No wallet, so the session itself is refused — but the tenant now exists,
    // which is the half of first-login provisioning this class owns.
    await expectErrorCodeAsync(() => source.resolve(mintToken({ key })), 'AUTH_WALLET_NOT_LINKED');

    expect(agents.rows.size).toBe(1);
    expect(agents.organizations.size).toBe(1);
  });

  it('refuses with AUTH_WALLET_NOT_LINKED rather than inventing an account', async () => {
    const { source, agents } = build();
    agents.seed(buildAgent({ privyUserId: 'did:privy:test-subject', primaryAccountId: null }));

    await expectErrorCodeAsync(() => source.resolve(mintToken({ key })), 'AUTH_WALLET_NOT_LINKED');
  });

  it('refuses a suspended agent, distinctly from a bad credential', async () => {
    const { source, agents } = build();
    seedLinkedAgent(agents, { status: 'SUSPENDED' });

    await expectErrorCodeAsync(() => source.resolve(mintToken({ key })), 'AUTH_AGENT_SUSPENDED');
  });

  it('refuses a suspended organization even when the agent itself is active', async () => {
    const { source, agents } = build();
    agents.seed(
      buildAgent({
        privyUserId: 'did:privy:test-subject',
        status: 'ACTIVE',
        primaryAccountId: ACCOUNT,
        chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      }),
      'SUSPENDED',
    );

    await expectErrorCodeAsync(
      () => source.resolve(mintToken({ key })),
      'AUTH_ORGANIZATION_SUSPENDED',
    );
  });

  it('never reads an organization or an account from the token', async () => {
    const { source, agents } = build();
    seedLinkedAgent(agents);

    const session = await source.resolve(
      mintToken({
        key,
        claims: {
          // Everything an attacker would try to name for themselves.
          organizationId: 'org-somebody-else',
          agentAccount: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:attacker',
          agentId: 'agent-somebody-else',
        },
      }),
    );

    expect(session.organizationId).toBe('org-1');
    expect(session.agentAccount).toBe(ACCOUNT);
    expect(session.agentId).toBe('agent-1');
  });

  it('refuses everything when Privy is not configured', async () => {
    const { source, agents } = build(withConfig({ appId: '' }));
    seedLinkedAgent(agents);

    await expectErrorCodeAsync(() => source.resolve(mintToken({ key })), 'MCP_CREDENTIAL_INVALID');
  });
});
