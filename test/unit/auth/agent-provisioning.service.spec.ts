import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { PrivyClaims } from '@modules/auth/domain/privy-claims';
import {
  AgentProvisioningService,
  WALLET_REFRESH_COOLDOWN_MS,
  organizationNameFor,
} from '@modules/auth/services/agent-provisioning.service';
import {
  PrivyIdentityFacts,
  PrivyUserDirectory,
} from '@modules/auth/services/privy-user.directory';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { FakeAgentRepository, buildAgent } from './helpers/fake-agent-repository';
import { TEST_PRIVY_CONFIG, withConfig } from './helpers/privy-tokens';

/** A directory that answers with whatever the test scripted, and counts calls. */
class FakeUserDirectory {
  calls: string[] = [];
  facts: PrivyIdentityFacts | null = null;

  lookup(privyUserId: string): Promise<PrivyIdentityFacts | null> {
    this.calls.push(privyUserId);
    return Promise.resolve(this.facts);
  }
}

const CLAIMS: PrivyClaims = {
  subject: 'did:privy:cabc123',
  sessionId: 'session-1',
  expiresAt: new Date('2026-09-01T00:00:00.000Z'),
  issuedAt: new Date('2026-08-22T00:00:00.000Z'),
};

/**
 * First login creates the tenant.
 *
 * The assertions are about **rows**, not calls: how many organizations exist
 * after two logins, which organization the second request landed in, whether a
 * wallet actually got written. A mock could only say that a method was called.
 */
describe('AgentProvisioningService — the organization is created, never chosen', () => {
  function build(config = TEST_PRIVY_CONFIG) {
    const agents = new FakeAgentRepository();
    const directory = new FakeUserDirectory();
    const service = new AgentProvisioningService(
      agents as unknown as AgentRepository,
      directory as unknown as PrivyUserDirectory,
      config,
    );
    return { service, agents, directory };
  }

  it('creates exactly one organization and one agent on a first login', async () => {
    const { service, agents } = build();

    const resolved = await service.resolve(CLAIMS);

    expect(agents.rows.size).toBe(1);
    expect(agents.organizations.size).toBe(1);
    expect(resolved.agent.privyUserId).toBe('did:privy:cabc123');
    expect(resolved.agent.organizationId).toBe([...agents.organizations.keys()][0]);
    expect(resolved.organizationStatus).toBe('ACTIVE');
  });

  it('does not create a second organization on the next login', async () => {
    const { service, agents } = build();

    const first = await service.resolve(CLAIMS);
    const second = await service.resolve(CLAIMS);

    expect(agents.organizations.size).toBe(1);
    expect(second.agent.organizationId).toBe(first.agent.organizationId);
    expect(agents.creates).toHaveLength(1);
  });

  it('resolves onto the winner of a concurrent first login instead of creating a second tenant', async () => {
    const { service, agents } = build();

    const winner = buildAgent({
      id: 'agent-winner',
      organizationId: 'org-winner',
      privyUserId: CLAIMS.subject,
    });
    agents.failNextCreateWithUniqueViolation = true;
    agents.seedOnConflict = winner;

    const resolved = await service.resolve(CLAIMS);

    expect(resolved.agent.id).toBe('agent-winner');
    expect(resolved.agent.organizationId).toBe('org-winner');
  });

  it('raises AUTH_PROVISIONING_FAILED when a create fails for any other reason', async () => {
    const { service, agents } = build();
    agents.createWithOrganization = () => Promise.reject(new Error('connection terminated'));

    await expectErrorCodeAsync(() => service.resolve(CLAIMS), 'AUTH_PROVISIONING_FAILED');
  });

  it('names the new organization from the email, and falls back to the DID', () => {
    expect(organizationNameFor('dan@example.com', 'did:privy:cabc123')).toBe('dan');
    expect(organizationNameFor(null, 'did:privy:cabc123')).toBe('agent-cabc123');
  });

  it('writes the linked Solana wallet as a CAIP-10 account on the configured chain', async () => {
    const { service, agents, directory } = build();
    directory.facts = {
      solanaAddress: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
      evmAddress: null,
      email: 'dan@example.com',
    };

    const resolved = await service.resolve(CLAIMS);

    expect(resolved.agent.primaryAccountId).toBe(
      `${TEST_PRIVY_CONFIG.defaultChainId}:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM`,
    );
    expect(resolved.agent.chainId).toBe(TEST_PRIVY_CONFIG.defaultChainId);
    expect(agents.rows.get(CLAIMS.subject)?.primaryAccountId).toBe(resolved.agent.primaryAccountId);
  });

  it('leaves the account unlinked when the identity has no Solana wallet, and still logs in', async () => {
    const { service, directory } = build();
    directory.facts = { solanaAddress: null, evmAddress: null, email: 'dan@example.com' };

    const resolved = await service.resolve(CLAIMS);

    expect(resolved.agent.primaryAccountId).toBeNull();
    expect(resolved.agent.email).toBe('dan@example.com');
  });

  it('tries again on a later login for an agent that still has no wallet', async () => {
    const { service, agents, directory } = build();
    await service.resolve(CLAIMS);
    expect(directory.calls).toHaveLength(1);

    // The lookup cooldown is per identity and in-memory; a fresh service is the
    // honest way to represent "a later login", not a clock stub.
    const later = new AgentProvisioningService(
      agents as unknown as AgentRepository,
      Object.assign(new FakeUserDirectory(), {
        facts: {
          solanaAddress: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
          evmAddress: null,
          email: null,
        },
      }) as unknown as PrivyUserDirectory,
      TEST_PRIVY_CONFIG,
    );

    const resolved = await later.resolve(CLAIMS);

    expect(resolved.agent.primaryAccountId).toContain(
      '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    );
  });

  it('does not look the identity up again once an account is linked', async () => {
    const { service, agents, directory } = build();
    agents.seed(
      buildAgent({
        privyUserId: CLAIMS.subject,
        primaryAccountId: `${TEST_PRIVY_CONFIG.defaultChainId}:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM`,
        chainId: TEST_PRIVY_CONFIG.defaultChainId,
      }),
    );

    await service.resolve(CLAIMS);

    expect(directory.calls).toHaveLength(0);
  });

  it('holds a cooldown so an unlinked agent in a retry loop cannot flood Privy', async () => {
    const { service, directory } = build();

    await service.resolve(CLAIMS);
    await service.resolve(CLAIMS);
    await service.resolve(CLAIMS);

    expect(directory.calls).toHaveLength(1);
  });

  it('lets a client-triggered refresh look up again inside the 60s login cooldown', async () => {
    const { service, directory } = build();

    // The login path: creates the row, looks once, finds nothing — the race
    // this endpoint exists for.
    await service.resolve(CLAIMS);
    expect(directory.calls).toHaveLength(1);

    // The wallet appears at Privy a second later and the browser says so.
    directory.facts = {
      solanaAddress: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
      evmAddress: null,
      email: null,
    };
    const refreshed = await service.resolve(CLAIMS, { lookupCooldownMs: 0 });

    expect(directory.calls).toHaveLength(2);
    expect(refreshed.agent.primaryAccountId).toContain(
      '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    );
  });

  it('still holds the refresh to its own cooldown, so a polling client cannot flood Privy', async () => {
    const { service, directory } = build();

    await service.resolve(CLAIMS, { lookupCooldownMs: WALLET_REFRESH_COOLDOWN_MS });
    await service.resolve(CLAIMS, { lookupCooldownMs: WALLET_REFRESH_COOLDOWN_MS });
    await service.resolve(CLAIMS, { lookupCooldownMs: WALLET_REFRESH_COOLDOWN_MS });

    expect(directory.calls).toHaveLength(1);
  });

  it('never calls the directory when the lookup is switched off', async () => {
    const { service, directory } = build(withConfig({ userLookupEnabled: false }));

    await service.resolve(CLAIMS);

    expect(directory.calls).toHaveLength(0);
  });

  it('links the EVM wallet — not the Solana one — when the deployment is on eip155', async () => {
    /*
      The first real EVM login wrote
      `eip155:46630:DnTdUmwEBCitxN4tgUfaXrWRSC1JrZgTMD2uPsHC5i73` — a base58
      Solana address on an EVM chain — and every money path then refused it
      (`PAYMENT_ESCROW_NOT_OPEN … Address is not valid on this chain`). The
      address has to match the chain's namespace, never just fill its slot.
    */
    const { service, agents, directory } = build(withConfig({ defaultChainId: 'eip155:46630' }));
    directory.facts = {
      solanaAddress: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
      evmAddress: '0x66d7CA4cD09C65197B2f3239c1fe79631747dd00',
      email: null,
    };

    const resolved = await service.resolve(CLAIMS);

    expect(resolved.agent.primaryAccountId).toBe(
      'eip155:46630:0x66d7CA4cD09C65197B2f3239c1fe79631747dd00',
    );
    expect(agents.rows.get(CLAIMS.subject)?.primaryAccountId).toBe(
      'eip155:46630:0x66d7CA4cD09C65197B2f3239c1fe79631747dd00',
    );
  });

  it('leaves the account unlinked when the identity has no wallet on the configured chain', async () => {
    // Better an agent with no account — the session refuses the spending paths
    // by name — than one whose account no chain can parse.
    const { service, agents, directory } = build(withConfig({ defaultChainId: 'eip155:46630' }));
    directory.facts = {
      solanaAddress: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
      evmAddress: null,
      email: null,
    };

    const resolved = await service.resolve(CLAIMS);

    expect(resolved.agent.primaryAccountId).toBeNull();
    expect(agents.rows.get(CLAIMS.subject)?.primaryAccountId ?? null).toBeNull();
  });

  it('leaves the wallet unlinked rather than writing a chainless account id', async () => {
    const { service, directory } = build(withConfig({ defaultChainId: '' }));
    directory.facts = {
      solanaAddress: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
      evmAddress: null,
      email: null,
    };

    const resolved = await service.resolve(CLAIMS);

    expect(resolved.agent.primaryAccountId).toBeNull();
  });

  it('survives a link that fails mid-request without failing the login', async () => {
    const { service, agents, directory } = build();
    agents.linkFails = true;
    directory.facts = {
      solanaAddress: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
      evmAddress: null,
      email: null,
    };

    const resolved = await service.resolve(CLAIMS);

    expect(resolved.agent.primaryAccountId).toBeNull();
  });

  it('stamps the login without letting a failed stamp fail the request', async () => {
    const { service, agents } = build();
    agents.seed(buildAgent({ id: 'agent-seeded', privyUserId: CLAIMS.subject }));
    agents.stampFails = true;

    await expect(service.resolve(CLAIMS)).resolves.toMatchObject({
      agent: { id: 'agent-seeded' },
    });
    expect(agents.loginStamps).toEqual([{ id: 'agent-seeded', at: expect.any(Date) }]);
  });

  it('reports the tenant status the row actually carries', async () => {
    const { service, agents } = build();
    agents.seed(buildAgent({ privyUserId: CLAIMS.subject }), 'SUSPENDED');

    await expect(service.resolve(CLAIMS)).resolves.toMatchObject({
      organizationStatus: 'SUSPENDED',
    });
  });
});
