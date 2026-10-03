import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import {
  AgentProvisioningService,
  WALLET_REFRESH_COOLDOWN_MS,
} from '@modules/auth/services/agent-provisioning.service';
import { PrivyJwksCache } from '@modules/auth/services/privy-jwks.cache';
import { PrivyTokenVerifier } from '@modules/auth/services/privy-token.verifier';
import {
  PrivyIdentityFacts,
  PrivyUserDirectory,
} from '@modules/auth/services/privy-user.directory';
import { WalletLinkService } from '@modules/auth/services/wallet-link.service';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { FakeAgentRepository, buildAgent } from './helpers/fake-agent-repository';
import {
  FakeJwksCache,
  TEST_PRIVY_CONFIG,
  createSigningKey,
  mintToken,
} from './helpers/privy-tokens';

const ADDRESS = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const ACCOUNT = `${TEST_PRIVY_CONFIG.defaultChainId}:${ADDRESS}`;

/** Answers with whatever the test scripted, and records every call. */
class FakeUserDirectory {
  calls: string[] = [];
  facts: PrivyIdentityFacts | null = null;

  lookup(privyUserId: string): Promise<PrivyIdentityFacts | null> {
    this.calls.push(privyUserId);
    return Promise.resolve(this.facts);
  }
}

/**
 * `POST /auth/wallet/link` — the browser telling the backend the wallet is
 * there now.
 *
 * The subject of every test below is the **row**, not the response: a first
 * login writes `primary_account_id = NULL` because Privy records the wallet
 * a second or two after issuing the token, and the whole point of this route
 * is that the second attempt is allowed to run immediately instead of waiting
 * out the 60-second login cooldown.
 */
describe('WalletLinkService — the client may say the wallet arrived, and nothing more', () => {
  const key = createSigningKey('kid-live');

  function build() {
    const agents = new FakeAgentRepository();
    const directory = new FakeUserDirectory();
    const provisioning = new AgentProvisioningService(
      agents as unknown as AgentRepository,
      directory as unknown as PrivyUserDirectory,
      TEST_PRIVY_CONFIG,
    );
    const verifier = new PrivyTokenVerifier(
      FakeJwksCache.withKeys(key) as unknown as PrivyJwksCache,
      TEST_PRIVY_CONFIG,
    );

    return {
      service: new WalletLinkService(verifier, provisioning),
      agents,
      directory,
      provisioning,
    };
  }

  it('links the wallet that appeared after the token was issued, without waiting out the login cooldown', async () => {
    const { service, agents, directory, provisioning } = build();

    // The login path, losing the race: Privy has no Solana wallet yet, so the
    // row is written with no account and the 60s login cooldown starts.
    await provisioning.resolve({
      subject: 'did:privy:test-subject',
      sessionId: 'session-1',
      expiresAt: new Date(Date.now() + 3_600_000),
      issuedAt: new Date(),
    });
    expect(agents.rows.get('did:privy:test-subject')?.primaryAccountId).toBeNull();

    // Seconds later — NOT a minute — the wallet is there and the browser says
    // so. The clock is moved rather than the service rebuilt: a fresh service
    // would carry an empty cooldown map, which would pass this test without
    // the refresh path existing at all.
    directory.facts = { solanaAddress: ADDRESS, evmAddress: null, email: null };
    const start = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(start + WALLET_REFRESH_COOLDOWN_MS + 1);

    try {
      const result = await service.link(mintToken({ key }));

      expect(result).toEqual({
        linked: true,
        account: ACCOUNT,
        chainId: TEST_PRIVY_CONFIG.defaultChainId,
      });
      expect(agents.rows.get('did:privy:test-subject')?.primaryAccountId).toBe(ACCOUNT);
      expect(directory.calls).toHaveLength(2);
    } finally {
      clock.mockRestore();
    }
  });

  it('holds its own cooldown, so a client polling the route cannot flood Privy', async () => {
    const { service, directory } = build();
    directory.facts = { solanaAddress: null, evmAddress: null, email: null };

    await service.link(mintToken({ key }));
    await service.link(mintToken({ key }));
    await service.link(mintToken({ key }));

    expect(directory.calls).toHaveLength(1);
  });

  it('reports "not linked yet" rather than failing, so the client knows to ask again', async () => {
    const { service, directory } = build();
    directory.facts = { solanaAddress: null, evmAddress: null, email: null };

    await expect(service.link(mintToken({ key }))).resolves.toEqual({
      linked: false,
      account: null,
      chainId: null,
    });
  });

  it('answers from the row without a lookup once an account is linked', async () => {
    const { service, agents, directory } = build();
    agents.seed(
      buildAgent({
        privyUserId: 'did:privy:test-subject',
        primaryAccountId: ACCOUNT,
        chainId: TEST_PRIVY_CONFIG.defaultChainId,
      }),
    );

    await expect(service.link(mintToken({ key }))).resolves.toEqual({
      linked: true,
      account: ACCOUNT,
      chainId: TEST_PRIVY_CONFIG.defaultChainId,
    });
    expect(directory.calls).toHaveLength(0);
  });

  it('refuses a missing token exactly as an unverifiable one', async () => {
    const { service } = build();

    await expectErrorCodeAsync(() => service.link(null), 'MCP_CREDENTIAL_INVALID');
    await expectErrorCodeAsync(() => service.link('not-a-jwt'), 'MCP_CREDENTIAL_INVALID');
  });

  it('refuses a token signed by another key without ever touching the rows', async () => {
    const { service, agents } = build();
    const stranger = createSigningKey('kid-stranger');

    await expectErrorCodeAsync(
      () => service.link(mintToken({ key: stranger })),
      'MCP_CREDENTIAL_INVALID',
    );
    expect(agents.rows.size).toBe(0);
  });

  it('gives a suspended caller a terminal answer instead of one that invites polling', async () => {
    const { service, agents } = build();
    agents.seed(buildAgent({ privyUserId: 'did:privy:test-subject' }), 'SUSPENDED');

    await expectErrorCodeAsync(
      () => service.link(mintToken({ key })),
      'AUTH_ORGANIZATION_SUSPENDED',
    );
  });

  it('gives a suspended agent the same terminal answer', async () => {
    const { service, agents } = build();
    agents.seed(buildAgent({ privyUserId: 'did:privy:test-subject', status: 'SUSPENDED' }));

    await expectErrorCodeAsync(() => service.link(mintToken({ key })), 'AUTH_AGENT_SUSPENDED');
  });
});
