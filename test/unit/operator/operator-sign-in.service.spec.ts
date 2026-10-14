import { Logger } from '@nestjs/common';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { OperatorSessionStore } from '@modules/operator/auth/operator-session.store';
import {
  OPERATOR_SIGN_IN_STATEMENT,
  OperatorSignInConfig,
} from '@modules/operator/auth/operator-sign-in.config';
import { OperatorSignInService } from '@modules/operator/auth/operator-sign-in.service';
import { WalletOperatorSessionSource } from '@modules/operator/auth/wallet-operator-session.source';
import {
  OPERATOR_AUTH_MAX_FAILURES,
  OPERATOR_CHALLENGE_MAX_PER_WINDOW,
  OperatorAuthThrottle,
} from '@modules/operator/services/operator-auth-throttle.service';
import { OperatorService } from '@modules/operator/services/operator.service';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { buildOperator, FakeOperatorRepository } from './helpers/fake-operator-repository';
import { FakeOperatorRedis } from './helpers/fake-operator-redis';

const CONFIG: OperatorSignInConfig = {
  domain: 'console.goassay.test',
  uri: 'https://console.goassay.test/operator',
  chainId: 46630,
  sessionTtlSeconds: 8 * 3600,
};
const IP = '203.0.113.7';

function build() {
  const redis = new FakeOperatorRedis();
  const repo = new FakeOperatorRepository();
  const directory = new OperatorService(repo as never, { get: () => undefined } as never);
  const store = new OperatorSessionStore(redis as never);
  const throttle = new OperatorAuthThrottle(redis as never);
  const signIn = new OperatorSignInService(
    redis as never,
    CONFIG,
    repo as never,
    directory,
    store,
    throttle,
  );
  const sessions = new WalletOperatorSessionSource(store, directory, repo as never);
  return { redis, repo, directory, store, signIn, sessions };
}

function wallet() {
  return privateKeyToAccount(generatePrivateKey());
}

describe('OperatorSignInService — sign in with a wallet', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  async function operatorWallet(ctx: ReturnType<typeof build>, status = 'ACTIVE') {
    const account = wallet();
    ctx.repo.seed(
      buildOperator({
        id: `op-${account.address.slice(2, 10)}`,
        subject: `${account.address.slice(2, 8)}@`,
        walletAddress: account.address.toLowerCase(),
        status,
      }),
    );
    return account;
  }

  it('issues the EIP-4361 message the frontend must sign', async () => {
    const { signIn } = build();
    const account = wallet();

    const challenge = await signIn.challenge(account.address.toLowerCase(), IP);

    const lines = challenge.message.split('\n');
    expect(lines[0]).toBe('console.goassay.test wants you to sign in with your Ethereum account:');
    // EIP-55 checksummed, whatever case was asked for.
    expect(lines[1]).toBe(account.address);
    expect(lines[3]).toBe(OPERATOR_SIGN_IN_STATEMENT);
    expect(challenge.message).toContain('\nURI: https://console.goassay.test/operator\n');
    expect(challenge.message).toContain('\nVersion: 1\n');
    expect(challenge.message).toContain('\nChain ID: 46630\n');
    expect(challenge.message).toContain(`\nNonce: ${challenge.nonce}\n`);
    expect(challenge.message).toMatch(/\nIssued At: .+\nExpiration Time: .+$/);
    expect(challenge.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(300_000);
  });

  it('signs an active operator in, and the session resolves to their row', async () => {
    const ctx = build();
    const account = await operatorWallet(ctx);
    const { message } = await ctx.signIn.challenge(account.address, IP);

    const result = await ctx.signIn.verify(message, await account.signMessage({ message }), IP);

    expect(result.operator.walletAddress).toBe(account.address.toLowerCase());
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The token itself is never stored, only its digest.
    expect(ctx.redis.keys().some((key) => key.includes(result.token))).toBe(false);
    const session = await ctx.sessions.resolve(result.token);
    expect(session.walletAddress).toBe(account.address.toLowerCase());
  });

  it('refuses a signature by another wallet', async () => {
    const ctx = build();
    const account = await operatorWallet(ctx);
    const { message } = await ctx.signIn.challenge(account.address, IP);

    await expectErrorCodeAsync(
      async () => ctx.signIn.verify(message, await wallet().signMessage({ message }), IP),
      'OPERATOR_CREDENTIAL_INVALID',
    );
  });

  it('refuses a reused nonce', async () => {
    const ctx = build();
    const account = await operatorWallet(ctx);
    const { message } = await ctx.signIn.challenge(account.address, IP);
    const signature = await account.signMessage({ message });

    await ctx.signIn.verify(message, signature, IP);
    await expectErrorCodeAsync(
      () => ctx.signIn.verify(message, signature, IP),
      'OPERATOR_CREDENTIAL_INVALID',
    );
  });

  it('refuses an expired message', async () => {
    const ctx = build();
    const account = await operatorWallet(ctx);
    const { message } = await ctx.signIn.challenge(account.address, IP);
    const signature = await account.signMessage({ message });

    const later = Date.now() + 301_000;
    jest.spyOn(Date, 'now').mockReturnValue(later);
    ctx.redis.now = () => later;

    await expectErrorCodeAsync(
      () => ctx.signIn.verify(message, signature, IP),
      'OPERATOR_CREDENTIAL_INVALID',
    );
  });

  it('refuses a message for another domain, even signed by the operator', async () => {
    const ctx = build();
    const account = await operatorWallet(ctx);
    const { message } = await ctx.signIn.challenge(account.address, IP);
    const forged = message.replace('console.goassay.test wants', 'evil.example wants');

    await expectErrorCodeAsync(
      async () => ctx.signIn.verify(forged, await account.signMessage({ message: forged }), IP),
      'OPERATOR_CREDENTIAL_INVALID',
    );
  });

  it('refuses a good signature by a wallet that is not an operator, with 403', async () => {
    const ctx = build();
    const stranger = wallet();
    const { message } = await ctx.signIn.challenge(stranger.address, IP);

    await expectErrorCodeAsync(
      async () => ctx.signIn.verify(message, await stranger.signMessage({ message }), IP),
      'OPERATOR_NOT_AUTHORIZED',
    );
  });

  it.each(['SUSPENDED', 'REMOVED'])('refuses a %s operator at sign-in', async (status) => {
    const ctx = build();
    const account = await operatorWallet(ctx, status);
    const { message } = await ctx.signIn.challenge(account.address, IP);

    await expectErrorCodeAsync(
      async () => ctx.signIn.verify(message, await account.signMessage({ message }), IP),
      'OPERATOR_NOT_AUTHORIZED',
    );
  });

  it('ends the session of an operator removed mid-session, on the next request', async () => {
    const ctx = build();
    const account = await operatorWallet(ctx);
    const { message } = await ctx.signIn.challenge(account.address, IP);
    const { token, operator } = await ctx.signIn.verify(
      message,
      await account.signMessage({ message }),
      IP,
    );
    await ctx.sessions.resolve(token);

    const row = await ctx.repo.findById(operator.id);
    Object.assign(row!, { status: 'REMOVED', removedAt: new Date() });
    // What the directory does on removal: this instance's cache entry goes,
    // and every session of the operator is revoked.
    ctx.directory.invalidate(operator.id);

    await expectErrorCodeAsync(() => ctx.sessions.resolve(token), 'OPERATOR_NOT_AUTHORIZED');
    // And the session is gone for good, not only refused this once.
    await expectErrorCodeAsync(() => ctx.sessions.resolve(token), 'OPERATOR_CREDENTIAL_INVALID');
  });

  it('revokes every session of an operator at once, whatever any cache holds', async () => {
    const ctx = build();
    const account = await operatorWallet(ctx);
    const tokens: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const { message } = await ctx.signIn.challenge(account.address, IP);
      tokens.push(
        (await ctx.signIn.verify(message, await account.signMessage({ message }), IP)).token,
      );
    }
    const operatorId = (await ctx.sessions.resolve(tokens[0])).operatorId;

    await ctx.store.revokeAll(operatorId);

    for (const token of tokens) {
      await expectErrorCodeAsync(() => ctx.sessions.resolve(token), 'OPERATOR_CREDENTIAL_INVALID');
    }
  });

  it('logs out: the session no longer resolves', async () => {
    const ctx = build();
    const account = await operatorWallet(ctx);
    const { message } = await ctx.signIn.challenge(account.address, IP);
    const { token } = await ctx.signIn.verify(message, await account.signMessage({ message }), IP);

    await ctx.signIn.logout(token);

    await expectErrorCodeAsync(() => ctx.sessions.resolve(token), 'OPERATOR_CREDENTIAL_INVALID');
    // Idempotent.
    await expect(ctx.signIn.logout(token)).resolves.toBeUndefined();
  });

  it('throttles failed verifications per wallet, across addresses', async () => {
    const ctx = build();
    const account = await operatorWallet(ctx);

    for (let attempt = 0; attempt < OPERATOR_AUTH_MAX_FAILURES; attempt += 1) {
      const { message } = await ctx.signIn.challenge(account.address, `198.51.100.${attempt}`);
      await ctx.signIn
        .verify(message, await wallet().signMessage({ message }), `198.51.100.${attempt}`)
        .catch(() => undefined);
    }

    // Even with a good signature, from a fresh address.
    const { message } = await ctx.signIn.challenge(account.address, '192.0.2.1');
    await expectErrorCodeAsync(
      async () => ctx.signIn.verify(message, await account.signMessage({ message }), '192.0.2.1'),
      'OPERATOR_AUTH_RATE_LIMITED',
    );
  });

  it('does not count a made-up message against the wallet it names', async () => {
    const ctx = build();
    const victim = await operatorWallet(ctx);
    const { message: real } = await ctx.signIn.challenge(victim.address, '192.0.2.1');

    for (let attempt = 0; attempt < OPERATOR_AUTH_MAX_FAILURES; attempt += 1) {
      const forged = real.replace(/Nonce: \w+/, `Nonce: forged${attempt}nonce`);
      await ctx.signIn
        .verify(forged, await wallet().signMessage({ message: forged }), `198.51.100.${attempt}`)
        .catch(() => undefined);
    }

    const result = await ctx.signIn.verify(
      real,
      await victim.signMessage({ message: real }),
      '192.0.2.1',
    );
    expect(result.operator.walletAddress).toBe(victim.address.toLowerCase());
  });

  it('throttles failed verifications per client address, across wallets', async () => {
    const ctx = build();

    for (let attempt = 0; attempt < OPERATOR_AUTH_MAX_FAILURES; attempt += 1) {
      const target = wallet();
      const { message } = await ctx.signIn.challenge(target.address, IP);
      await ctx.signIn
        .verify(message, await wallet().signMessage({ message }), IP)
        .catch(() => undefined);
    }

    await expectErrorCodeAsync(
      () => ctx.signIn.challenge(wallet().address, IP),
      'OPERATOR_AUTH_RATE_LIMITED',
    );
  });

  it('throttles challenge issuance per client address', async () => {
    const ctx = build();
    for (let i = 0; i < OPERATOR_CHALLENGE_MAX_PER_WINDOW; i += 1) {
      await ctx.signIn.challenge(wallet().address, IP);
    }

    await expectErrorCodeAsync(
      () => ctx.signIn.challenge(wallet().address, IP),
      'OPERATOR_AUTH_RATE_LIMITED',
    );
    // Another address is not affected, and the victim's wallet still gets one.
    await expect(ctx.signIn.challenge(wallet().address, '192.0.2.1')).resolves.toBeDefined();
  });

  it('refuses every sign-in when no domain is configured', async () => {
    const ctx = build();
    const unconfigured = new OperatorSignInService(
      ctx.redis as never,
      { ...CONFIG, domain: '' },
      ctx.repo as never,
      ctx.directory,
      ctx.store,
      new OperatorAuthThrottle(ctx.redis as never),
    );
    await expectErrorCodeAsync(
      () => unconfigured.challenge(wallet().address, IP),
      'OPERATOR_CREDENTIAL_INVALID',
    );
  });
});
