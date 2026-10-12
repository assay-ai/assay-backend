import { privateKeyToAccount } from 'viem/accounts';

import { AgentDelegateService } from '@modules/account/services/agent-delegate.service';
import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { EvmChainAdapter } from '@modules/chains/evm/evm-chain.adapter';
import { AccountId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';

import { deployment } from '../chains/evm/evm-fixtures';

const CHAIN = CHAIN_IDS.ROBINHOOD_TESTNET;
const delegateKey = privateKeyToAccount(`0x${'d1'.repeat(32)}`);
const otherKey = privateKeyToAccount(`0x${'e2'.repeat(32)}`);

class FakeRedis {
  readonly store = new Map<string, string>();
  async set(key: string, value: string) {
    this.store.set(key, value);
    return 'OK';
  }
  async getdel(key: string) {
    const value = this.store.get(key) ?? null;
    this.store.delete(key);
    return value;
  }
}

interface FakeRow {
  delegateAccount: string | null;
  delegateBoundAt: Date | null;
  revokedAt?: Date | null;
  expiresAt?: Date | null;
}

class FakeCredentials {
  readonly rows = new Map<string, FakeRow>();
  updates: { criteria: unknown; patch: unknown }[] = [];
  async findOneBy({ id }: { id: string }) {
    return this.rows.get(id) ?? null;
  }
  async update(
    criteria: { organizationId: string; id: string },
    patch: { delegateAccount: string; delegateBoundAt: Date },
  ) {
    this.updates.push({ criteria, patch });
    this.rows.set(criteria.id, { ...this.rows.get(criteria.id), ...patch });
  }
  /** Mirrors the repository: other, not revoked, same key case-insensitively. */
  private holders(delegate: string, except: string) {
    return [...this.rows.entries()].filter(
      ([id, row]) =>
        id !== except &&
        !row.revokedAt &&
        row.delegateAccount?.toLowerCase() === delegate.toLowerCase(),
    );
  }
  async findOtherDelegateHolders(delegate: string, except: string) {
    return this.holders(delegate, except).map(([id, row]) => ({ id, ...row }));
  }
  async releaseDelegateFromExpired(delegate: string, except: string) {
    for (const [id, row] of this.holders(delegate, except)) {
      if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
        this.rows.set(id, { ...row, delegateAccount: null, delegateBoundAt: null });
      }
    }
  }
}

const session = (overrides: Partial<McpSession> = {}): McpSession => ({
  credentialId: 'cred-1',
  organizationId: 'org-1',
  agentId: 'agent-1',
  agentAccount: `${CHAIN}:0x18103e1D79257c695B2FBbd4b346CD2Ba7927296` as AccountId,
  chainId: CHAIN,
  label: null,
  callerKind: McpCallerKind.AGENT,
  ...overrides,
});

/**
 * The agent proves it holds its delegate key before its credential is bound to
 * it: a single-use challenge, signed by THAT key, verified by the EVM adapter.
 */
describe('AgentDelegateService — binding a credential to its delegate key', () => {
  let redis: FakeRedis;
  let credentials: FakeCredentials;
  let service: AgentDelegateService;

  beforeEach(() => {
    redis = new FakeRedis();
    credentials = new FakeCredentials();
    const adapter = new EvmChainAdapter(new Map(), new Map([[CHAIN, deployment(CHAIN)]]), [CHAIN]);
    service = new AgentDelegateService(
      credentials as never,
      new ChainAdapterRegistry([adapter], [CHAIN]),
      redis as never,
    );
  });

  async function signWith(
    challenge: Awaited<ReturnType<AgentDelegateService['challenge']>>,
    signer = delegateKey,
  ) {
    const typed = challenge.typedData as {
      domain: { name: string; version: string; chainId: string };
      types: Record<string, { name: string; type: string }[]>;
      primaryType: string;
      message: Record<string, string>;
    };
    const signature = await signer.signTypedData({
      domain: { ...typed.domain, chainId: Number(typed.domain.chainId) },
      types: typed.types,
      primaryType: typed.primaryType,
      message: typed.message,
    } as never);
    return { challenge, signature };
  }

  async function signChallenge(signer = delegateKey, s = session()) {
    const challenge = await service.challenge(s, delegateKey.address.toLowerCase());
    const typed = challenge.typedData as {
      domain: { name: string; version: string; chainId: string; verifyingContract: `0x${string}` };
      types: Record<string, { name: string; type: string }[]>;
      primaryType: string;
      message: Record<string, string>;
    };
    const signature = await signer.signTypedData({
      domain: { ...typed.domain, chainId: Number(typed.domain.chainId) },
      types: typed.types,
      primaryType: typed.primaryType,
      message: typed.message,
    } as never);
    return { challenge, signature };
  }

  it('binds the key after a signature by that key, normalised to EIP-55', async () => {
    const { challenge, signature } = await signChallenge();
    expect(challenge.delegate).toBe(`${CHAIN}:${delegateKey.address}`);
    expect(challenge.typedData).toMatchObject({ primaryType: 'DelegateBinding' });

    const bound = await service.bind(session(), challenge.challengeId, signature);
    expect(bound).toMatchObject({
      credentialId: 'cred-1',
      delegate: `${CHAIN}:${delegateKey.address}`,
    });
    expect(credentials.updates).toHaveLength(1);
    expect(credentials.updates[0].criteria).toEqual({ organizationId: 'org-1', id: 'cred-1' });
    expect((await service.current(session())).delegate).toBe(`${CHAIN}:${delegateKey.address}`);
  });

  it('refuses a signature by any other key, and binds nothing', async () => {
    const { challenge, signature } = await signChallenge(otherKey);
    await expect(service.bind(session(), challenge.challengeId, signature)).rejects.toMatchObject({
      errorCode: 'ACCOUNT_DELEGATE_SIGNATURE_INVALID',
    });
    expect(credentials.updates).toHaveLength(0);
  });

  it('consumes a challenge on its first use', async () => {
    const { challenge, signature } = await signChallenge(otherKey);
    await expect(service.bind(session(), challenge.challengeId, signature)).rejects.toBeDefined();
    await expect(service.bind(session(), challenge.challengeId, signature)).rejects.toMatchObject({
      errorCode: 'ACCOUNT_DELEGATE_CHALLENGE_INVALID',
    });
  });

  it('refuses a challenge issued to another credential', async () => {
    const { challenge, signature } = await signChallenge();
    await expect(
      service.bind(session({ credentialId: 'cred-2' }), challenge.challengeId, signature),
    ).rejects.toMatchObject({ errorCode: 'ACCOUNT_DELEGATE_CHALLENGE_INVALID' });
    expect(credentials.updates).toHaveLength(0);
  });

  /** Review S3-8: one live challenge per credential, so a loop holds one key. */
  it('keeps one live challenge per credential: a new one replaces the last', async () => {
    const first = await signChallenge();
    const second = await signChallenge();
    expect(redis.store.size).toBe(1);
    await expect(
      service.bind(session(), first.challenge.challengeId, first.signature),
    ).rejects.toMatchObject({
      errorCode: 'ACCOUNT_DELEGATE_CHALLENGE_INVALID',
    });
    // The failed attempt consumed the live one too: a challenge is good for one attempt.
    await expect(
      service.bind(session(), second.challenge.challengeId, second.signature),
    ).rejects.toMatchObject({
      errorCode: 'ACCOUNT_DELEGATE_CHALLENGE_INVALID',
    });
    const third = await signChallenge();
    await expect(
      service.bind(session(), third.challenge.challengeId, third.signature),
    ).resolves.toBeDefined();
  });

  /** Review S3-14: the binding is signed under its own domain, never the escrow's. */
  it('signs the binding under its own domain, with no verifyingContract', async () => {
    const challenge = await service.challenge(session(), delegateKey.address);
    expect((challenge.typedData as { domain: unknown }).domain).toEqual({
      name: 'GoAssay Agent Binding',
      version: '1',
      chainId: '46630',
    });
  });

  it('refuses an expired challenge', async () => {
    const { challenge, signature } = await signChallenge();
    const key = 'agent-delegate-challenge:cred-1';
    const stored = JSON.parse(redis.store.get(key) as string);
    redis.store.set(
      key,
      JSON.stringify({ ...stored, expiresAt: Math.floor(Date.now() / 1000) - 1 }),
    );
    await expect(service.bind(session(), challenge.challengeId, signature)).rejects.toMatchObject({
      errorCode: 'ACCOUNT_DELEGATE_CHALLENGE_INVALID',
    });
  });

  /** D1-S03: one key, one live credential — across agents and organizations. */
  describe('a key already bound to another credential', () => {
    const delegate = `${CHAIN}:${delegateKey.address}`;

    it('refuses to bind it to a second live credential, and binds nothing', async () => {
      credentials.rows.set('cred-other', {
        delegateAccount: delegate,
        delegateBoundAt: new Date(),
      });
      const s = session({ credentialId: 'cred-2', organizationId: 'org-2' });
      const challenge = await service.challenge(s, delegateKey.address);
      const { signature } = await signWith(challenge);
      await expect(service.bind(s, challenge.challengeId, signature)).rejects.toMatchObject({
        errorCode: 'ACCOUNT_DELEGATE_ALREADY_BOUND',
        statusCode: 409,
      });
      expect(credentials.updates).toHaveLength(0);
      expect(credentials.rows.get('cred-other')?.delegateAccount).toBe(delegate);
    });

    it('compares the key case-insensitively', async () => {
      credentials.rows.set('cred-other', {
        delegateAccount: delegate.toLowerCase(),
        delegateBoundAt: new Date(),
      });
      const { challenge, signature } = await signChallenge();
      await expect(service.bind(session(), challenge.challengeId, signature)).rejects.toMatchObject(
        {
          errorCode: 'ACCOUNT_DELEGATE_ALREADY_BOUND',
        },
      );
    });

    it('still lets the holder re-bind its own key', async () => {
      credentials.rows.set('cred-1', { delegateAccount: delegate, delegateBoundAt: new Date(0) });
      const { challenge, signature } = await signChallenge();
      await expect(
        service.bind(session(), challenge.challengeId, signature),
      ).resolves.toMatchObject({
        delegate,
      });
    });

    it('is not blocked by a REVOKED holder', async () => {
      credentials.rows.set('cred-other', {
        delegateAccount: delegate,
        delegateBoundAt: new Date(),
        revokedAt: new Date(),
      });
      const { challenge, signature } = await signChallenge();
      await expect(
        service.bind(session(), challenge.challengeId, signature),
      ).resolves.toBeDefined();
    });

    it('releases an EXPIRED holder and binds', async () => {
      credentials.rows.set('cred-other', {
        delegateAccount: delegate,
        delegateBoundAt: new Date(),
        expiresAt: new Date(Date.now() - 1000),
      });
      const { challenge, signature } = await signChallenge();
      await expect(
        service.bind(session(), challenge.challengeId, signature),
      ).resolves.toBeDefined();
      expect(credentials.rows.get('cred-other')?.delegateAccount).toBeNull();
    });

    it('answers a lost race on the unique index as ALREADY_BOUND', async () => {
      credentials.update = async () => {
        throw Object.assign(new Error('duplicate key'), {
          code: '23505',
          constraint: 'uq_agent_credentials_delegate_live',
        });
      };
      const { challenge, signature } = await signChallenge();
      await expect(service.bind(session(), challenge.challengeId, signature)).rejects.toMatchObject(
        {
          errorCode: 'ACCOUNT_DELEGATE_ALREADY_BOUND',
        },
      );
    });

    it('checks only after the proof: a wrong key learns nothing', async () => {
      credentials.rows.set('cred-other', {
        delegateAccount: delegate,
        delegateBoundAt: new Date(),
      });
      const { challenge, signature } = await signChallenge(otherKey);
      await expect(service.bind(session(), challenge.challengeId, signature)).rejects.toMatchObject(
        {
          errorCode: 'ACCOUNT_DELEGATE_SIGNATURE_INVALID',
        },
      );
    });
  });

  it.each([McpCallerKind.HUMAN, McpCallerKind.CONFIG])(
    'is agent-only: a %s session is refused',
    async (kind) => {
      await expect(
        service.challenge(session({ callerKind: kind }), delegateKey.address),
      ).rejects.toMatchObject({
        errorCode: 'ACCOUNT_DELEGATE_BINDING_AGENT_ONLY',
      });
    },
  );

  it('refuses a chain without voucher delegation', async () => {
    const solana = { resolve: () => ({ toAccountId: jest.fn() }) };
    const onSolana = new AgentDelegateService(
      credentials as never,
      solana as never,
      redis as never,
    );
    await expect(onSolana.challenge(session(), delegateKey.address)).rejects.toMatchObject({
      errorCode: 'ACCOUNT_DELEGATE_BINDING_UNSUPPORTED',
    });
  });
});
