import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import {
  SessionSourceMode,
  parseSessionSourceMode,
} from '@modules/auth/domain/session-source-mode';
import { AuthErrors } from '@modules/auth/errors/auth.errors';
import {
  CompositeMcpSessionSource,
  createSessionSource,
} from '@modules/auth/services/composite-mcp-session.source';
import { CredentialSessionResolver } from '@modules/auth/services/credential-session.resolver';
import { DbCredentialMcpSessionSource } from '@modules/auth/services/db-credential-mcp-session.source';
import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import { McpSession, McpSessionPort } from '@modules/mcp/ports/mcp-session.port';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { FakeAgentCredentialRepository } from './helpers/fake-agent-credential-repository';
import { FakeAgentRepository } from './helpers/fake-agent-repository';

const SESSION = {
  credentialId: 'cred-1',
  organizationId: 'org-1',
  agentId: 'agent-1',
  agentAccount: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:9WzD',
  chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  label: null,
} as unknown as McpSession;

/** Answers for one token and declines everything else, recording what it saw. */
class StubSource implements McpSessionPort {
  readonly seen: Array<string | null> = [];

  constructor(
    private readonly accepts: string | null,
    private readonly session: McpSession = SESSION,
    private readonly refusal: Error = McpErrors.credentialInvalid(),
  ) {}

  resolve(bearerToken: string | null): Promise<McpSession> {
    this.seen.push(bearerToken);
    if (bearerToken !== this.accepts) return Promise.reject(this.refusal);
    return Promise.resolve(this.session);
  }
}

/**
 * Both issuers at once.
 *
 * The behaviour that matters is which failures move on and which stop: "I do
 * not recognise this credential" is the only one that gets to try the next
 * source, because everything else is either a fact about an identified caller
 * or the fail-closed branch.
 */
describe('CompositeMcpSessionSource — one port, two issuers, one refusal', () => {
  it('accepts a token the first source recognises without consulting the second', async () => {
    const first = new StubSource('config-token');
    const second = new StubSource('privy-token');

    await expect(
      new CompositeMcpSessionSource([first, second]).resolve('config-token'),
    ).resolves.toBeDefined();

    expect(second.seen).toEqual([]);
  });

  it('falls through to the second source when the first does not recognise the token', async () => {
    const first = new StubSource('config-token');
    const second = new StubSource('privy-token');

    const session = await new CompositeMcpSessionSource([first, second]).resolve('privy-token');

    expect(session.organizationId).toBe('org-1');
    expect(first.seen).toEqual(['privy-token']);
  });

  it('raises the generic refusal when every source declines', async () => {
    const composite = new CompositeMcpSessionSource([
      new StubSource('config-token'),
      new StubSource('privy-token'),
    ]);

    await expectErrorCodeAsync(() => composite.resolve('neither'), 'MCP_CREDENTIAL_INVALID');
  });

  it('stops at a wallet-not-linked refusal instead of degrading it into a 401', async () => {
    const privy = new StubSource('privy-token', SESSION, AuthErrors.walletNotLinked());
    const composite = new CompositeMcpSessionSource([new StubSource('config-token'), privy]);

    await expectErrorCodeAsync(() => composite.resolve('anything'), 'AUTH_WALLET_NOT_LINKED');
  });

  it('propagates the fail-closed outage rather than reporting it as a bad credential', async () => {
    const privy = new StubSource('privy-token', SESSION, AuthErrors.identityProviderUnavailable());
    const composite = new CompositeMcpSessionSource([new StubSource('config-token'), privy]);

    await expectErrorCodeAsync(
      () => composite.resolve('anything'),
      'AUTH_IDENTITY_PROVIDER_UNAVAILABLE',
    );
  });

  it('refuses a missing token without pretending either source might want it', async () => {
    const composite = new CompositeMcpSessionSource([
      new StubSource('config-token'),
      new StubSource('privy-token'),
    ]);

    await expectErrorCodeAsync(() => composite.resolve(null), 'MCP_CREDENTIAL_INVALID');
  });
});

describe('createSessionSource — AUTH_SESSION_SOURCE decides, and the default is unchanged behaviour', () => {
  const config = new StubSource('config-token');
  const db = new StubSource('db-token');
  const oauth = new StubSource('oauth-token');
  const privy = new StubSource('privy-token');

  it('binds config only, by default and by name', () => {
    expect(createSessionSource(SessionSourceMode.CONFIG, { config, db, oauth, privy })).toBe(
      config,
    );
    expect(parseSessionSourceMode(undefined)).toBe(SessionSourceMode.CONFIG);
    expect(parseSessionSourceMode('nonsense')).toBe(SessionSourceMode.CONFIG);
  });

  it('binds privy only', () => {
    expect(createSessionSource(SessionSourceMode.PRIVY, { config, db, oauth, privy })).toBe(privy);
    expect(parseSessionSourceMode('privy')).toBe(SessionSourceMode.PRIVY);
  });

  it('binds db only', () => {
    expect(createSessionSource(SessionSourceMode.DB, { config, db, oauth, privy })).toBe(db);
    expect(parseSessionSourceMode('db')).toBe(SessionSourceMode.DB);
  });

  it('binds all four in both mode: config, db, oauth, privy', async () => {
    const source = createSessionSource(SessionSourceMode.BOTH, { config, db, oauth, privy });
    expect(source).toBeInstanceOf(CompositeMcpSessionSource);

    await expect(source.resolve('config-token')).resolves.toBeDefined();
    await expect(source.resolve('db-token')).resolves.toBeDefined();
    await expect(source.resolve('oauth-token')).resolves.toBeDefined();
    await expect(source.resolve('privy-token')).resolves.toBeDefined();
    expect(parseSessionSourceMode('both')).toBe(SessionSourceMode.BOTH);
  });

  it('both order is config, db, oauth, privy', async () => {
    const order: string[] = [];
    const recording = (name: string): McpSessionPort => ({
      resolve: () => {
        order.push(name);
        return Promise.reject(McpErrors.credentialInvalid());
      },
    });

    const source = createSessionSource(SessionSourceMode.BOTH, {
      config: recording('config'),
      db: recording('db'),
      oauth: recording('oauth'),
      privy: recording('privy'),
    });

    await expectErrorCodeAsync(() => source.resolve('unknown'), 'MCP_CREDENTIAL_INVALID');
    expect(order).toEqual(['config', 'db', 'oauth', 'privy']);
  });

  it('includes the OAuth source only in both mode (OAuth needs the Privy consent)', async () => {
    for (const mode of [SessionSourceMode.CONFIG, SessionSourceMode.DB, SessionSourceMode.PRIVY]) {
      const source = createSessionSource(mode, { config, db, oauth, privy });
      await expectErrorCodeAsync(() => source.resolve('oauth-token'), 'MCP_CREDENTIAL_INVALID');
    }
  });
});

/**
 * The db source's prefix refusal is what makes this chain work at all —
 * see `DbCredentialMcpSessionSource`'s own docstring on why the check has to
 * happen before any database lookup.
 */
describe('DbCredentialMcpSessionSource ahead of Privy in the chain', () => {
  it('lets a JWT-shaped token fall through the db source and reach Privy', async () => {
    const credentials = new FakeAgentCredentialRepository() as unknown as AgentCredentialRepository;
    const db = new DbCredentialMcpSessionSource(
      credentials,
      new CredentialSessionResolver(
        credentials,
        new FakeAgentRepository() as unknown as AgentRepository,
      ),
    );
    const jwtShaped = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJkaWQ6cHJpdnk6eCJ9.sig';
    const privy = new StubSource(jwtShaped);

    const session = await new CompositeMcpSessionSource([db, privy]).resolve(jwtShaped);

    expect(session).toEqual(SESSION);
    expect(privy.seen).toEqual([jwtShaped]);
  });
});
