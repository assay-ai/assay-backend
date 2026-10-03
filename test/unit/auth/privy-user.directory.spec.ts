import { EgressHttpClient } from '@shared/network/egress';
import { PrivyUserDirectory } from '@modules/auth/services/privy-user.directory';

import { FakeEgressHttpClient, okResponse } from './helpers/fake-egress';
import { TEST_PRIVY_CONFIG, withConfig } from './helpers/privy-tokens';

const EMBEDDED = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const EXTERNAL = '9EKjab7PX483JSwowmhq7BunAgadhautYVgCqbwc6nbM';

/**
 * The one call that uses the app secret.
 *
 * Two things are asserted that a docstring cannot enforce: the secret goes to
 * this endpoint and no other, and every failure degrades to "no wallet linked"
 * rather than to a failed login — because a *secondary* enrichment call must
 * not be able to make Privy's API availability a precondition for reading a
 * dashboard.
 */
describe('PrivyUserDirectory — reads linked wallets, fails soft, never fails a login', () => {
  function build(egress: FakeEgressHttpClient, config = TEST_PRIVY_CONFIG) {
    return new PrivyUserDirectory(egress as unknown as EgressHttpClient, config);
  }

  function userBody(accounts: unknown[]) {
    return JSON.stringify({ id: 'did:privy:cabc123', linked_accounts: accounts });
  }

  it('prefers the embedded Solana wallet over a linked external one', async () => {
    const egress = new FakeEgressHttpClient().respondWith(() =>
      okResponse(
        200,
        userBody([
          {
            type: 'wallet',
            chain_type: 'solana',
            address: EXTERNAL,
            wallet_client_type: 'phantom',
          },
          { type: 'wallet', chain_type: 'solana', address: EMBEDDED, wallet_client_type: 'privy' },
          { type: 'email', address: 'dan@example.com' },
        ]),
      ),
    );

    await expect(build(egress).lookup('did:privy:cabc123')).resolves.toEqual({
      solanaAddress: EMBEDDED,
      evmAddress: null,
      email: 'dan@example.com',
    });
  });

  it('reads the EVM wallet too, embedded preferred, and keeps the two apart', async () => {
    // One identity, two embedded wallets. Reading only the Solana one is
    // what put a base58 address under `eip155:46630` on the first real EVM
    // login: `AgentProvisioningService` pasted whichever address it was given
    // onto the configured chain.
    const egress = new FakeEgressHttpClient().respondWith(() =>
      okResponse(
        200,
        userBody([
          {
            type: 'wallet',
            chain_type: 'ethereum',
            address: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
            wallet_client_type: 'metamask',
          },
          {
            type: 'wallet',
            chain_type: 'ethereum',
            address: '0x66d7CA4cD09C65197B2f3239c1fe79631747dd00',
            wallet_client_type: 'privy',
          },
          { type: 'wallet', chain_type: 'solana', address: EMBEDDED, wallet_client_type: 'privy' },
        ]),
      ),
    );

    await expect(build(egress).lookup('did:privy:cabc123')).resolves.toEqual({
      solanaAddress: EMBEDDED,
      evmAddress: '0x66d7CA4cD09C65197B2f3239c1fe79631747dd00',
      email: null,
    });
  });

  it('refuses an EVM address that is not 0x + 40 hex', async () => {
    const egress = new FakeEgressHttpClient().respondWith(() =>
      okResponse(
        200,
        userBody([
          { type: 'wallet', chain_type: 'ethereum', address: '0xabc', wallet_client_type: 'privy' },
        ]),
      ),
    );

    await expect(build(egress).lookup('did:privy:cabc123')).resolves.toEqual({
      solanaAddress: null,
      evmAddress: null,
      email: null,
    });
  });

  it('refuses an address that is not plausibly base58, rather than storing junk as an account', async () => {
    const egress = new FakeEgressHttpClient().respondWith(() =>
      okResponse(
        200,
        userBody([{ type: 'wallet', chain_type: 'solana', address: 'not a solana address!' }]),
      ),
    );

    await expect(build(egress).lookup('did:privy:cabc123')).resolves.toEqual({
      solanaAddress: null,
      evmAddress: null,
      email: null,
    });
  });

  it('sends the app secret to this endpoint as Basic auth and follows no redirects', async () => {
    const egress = new FakeEgressHttpClient().respondWith(() => okResponse(200, userBody([])));

    await build(egress).lookup('did:privy:cabc123');

    const request = egress.lastRequest;
    expect(request?.url).toBe('https://auth.privy.io/api/v1/users/did%3Aprivy%3Acabc123');
    expect(request?.headers?.authorization).toBe(
      `Basic ${Buffer.from('test-app-id:test-app-secret').toString('base64')}`,
    );
    expect(request?.headers?.['privy-app-id']).toBe('test-app-id');
    expect(request?.policy?.limits.maxRedirects).toBe(0);
  });

  it('returns null — and makes no call at all — when the lookup is switched off', async () => {
    const egress = new FakeEgressHttpClient();

    await expect(
      build(egress, withConfig({ userLookupEnabled: false })).lookup('did:privy:cabc123'),
    ).resolves.toBeNull();

    expect(egress.requests).toEqual([]);
  });

  it('makes no call when there is no app secret to make it with', async () => {
    const egress = new FakeEgressHttpClient();

    await expect(
      build(egress, withConfig({ appSecret: null })).lookup('did:privy:cabc123'),
    ).resolves.toBeNull();

    expect(egress.requests).toEqual([]);
  });

  it('degrades to null on a non-200, a transport failure and unparseable JSON', async () => {
    const notFound = new FakeEgressHttpClient().respondWith(() => okResponse(404, 'no such user'));
    const broken = new FakeEgressHttpClient().respondWith(() => {
      throw new Error('connection reset');
    });
    const garbage = new FakeEgressHttpClient().respondWith(() => okResponse(200, '<html>'));

    await expect(build(notFound).lookup('did:privy:cabc123')).resolves.toBeNull();
    await expect(build(broken).lookup('did:privy:cabc123')).resolves.toBeNull();
    await expect(build(garbage).lookup('did:privy:cabc123')).resolves.toBeNull();
  });

  it('tolerates a response with no linked_accounts array', async () => {
    const egress = new FakeEgressHttpClient().respondWith(() =>
      okResponse(200, JSON.stringify({ id: 'did:privy:cabc123' })),
    );

    await expect(build(egress).lookup('did:privy:cabc123')).resolves.toEqual({
      solanaAddress: null,
      evmAddress: null,
      email: null,
    });
  });
});
