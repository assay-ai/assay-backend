import { privateKeyToAccount } from 'viem/accounts';

import { AgentDelegateService } from '@modules/account/services/agent-delegate.service';
import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { EvmChainAdapter } from '@modules/chains/evm/evm-chain.adapter';
import { AccountId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { EscrowDelegationStatus } from '@modules/settlement/ports/escrow-delegation.port';
import { EscrowDelegationWithUnsettled } from '@modules/settlement/services/escrow-delegation.service';

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
  pendingDelegateAccount?: string | null;
  pendingDelegateRequestedAt?: Date | null;
  revokedAt?: Date | null;
  expiresAt?: Date | null;
}

class FakeCredentials {
  readonly rows = new Map<string, FakeRow>();
  updates: { criteria: unknown; patch: unknown }[] = [];
  async findOneBy({ id }: { id: string }) {
    return this.rows.get(id) ?? null;
  }
  async update(criteria: { organizationId: string; id: string }, patch: Partial<FakeRow>) {
    this.updates.push({ criteria, patch });
    this.rows.set(criteria.id, { ...this.rows.get(criteria.id), ...patch });
  }
  /** Mirrors the repository: other, not revoked, same key case-insensitively. */
  private holders(delegate: string, except: string) {
    return [...this.rows.entries()].filter(
      ([id, row]) =>
        id !== except &&
        !row.revokedAt &&
        (row.delegateAccount?.toLowerCase() === delegate.toLowerCase() ||
          row.pendingDelegateAccount?.toLowerCase() === delegate.toLowerCase()),
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

/** The payer's standing delegations, as `EscrowDelegationService.list` reads them from the chain. */
class FakeDelegations {
  standing: EscrowDelegationWithUnsettled[] = [];
  readonly reads: AccountId[] = [];
  failure: Error | null = null;
  async list(payer: AccountId) {
    this.reads.push(payer);
    if (this.failure) throw this.failure;
    return this.standing;
  }
}

const standing = (
  delegate: string,
  status: EscrowDelegationStatus = EscrowDelegationStatus.ACTIVE,
): EscrowDelegationWithUnsettled =>
  ({
    delegate: delegate as AccountId,
    maxVoucherAmount: 500_000n,
    maxPerWindow: 5_000_000n,
    spentInWindow: 1_250n,
    validUntil: 1_900_000_000n,
    status,
    unsettled: {},
  }) as unknown as EscrowDelegationWithUnsettled;

const session = (overrides: Partial<McpSession> = {}): McpSession => ({
  credentialId: 'cred-1',
  organizationId: 'org-1',
  agentId: 'agent-1',
  agentAccount: `${CHAIN}:0x18103e1D79257c695B2FBbd4b346CD2Ba7927296` as AccountId,
  chainId: CHAIN,
  label: null,
  callerKind: McpCallerKind.AGENT,
  paymentsAllowed: true,
  storedCredential: true,
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
  let delegations: FakeDelegations;

  beforeEach(() => {
    redis = new FakeRedis();
    credentials = new FakeCredentials();
    delegations = new FakeDelegations();
    const adapter = new EvmChainAdapter(new Map(), new Map([[CHAIN, deployment(CHAIN)]]), [CHAIN]);
    service = new AgentDelegateService(
      credentials as never,
      new ChainAdapterRegistry([adapter], [CHAIN]),
      redis as never,
      delegations as never,
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

  describe('rebinding: a new key never silently replaces a bound one (D3)', () => {
    const A = `${CHAIN}:${delegateKey.address}`;
    const B = `${CHAIN}:${otherKey.address}`;

    async function bindOther(s = session()) {
      const challenge = await service.challenge(s, otherKey.address);
      const { signature } = await signWith(challenge, otherKey);
      return service.bind(s, challenge.challengeId, signature);
    }

    it('the first key binds at once (status ACTIVE)', async () => {
      const { challenge, signature } = await signChallenge();
      const bound = await service.bind(session(), challenge.challengeId, signature);
      expect(bound).toMatchObject({ status: 'ACTIVE', delegate: A, pendingDelegate: null });
    });

    it('a second key waits for approval; the bound key stays and keeps signing', async () => {
      credentials.rows.set('cred-1', {
        delegateAccount: A,
        delegateBoundAt: new Date('2026-10-01T00:00:00.000Z'),
      });

      const answer = await bindOther();

      expect(answer).toMatchObject({
        status: 'PENDING_APPROVAL',
        delegate: A,
        boundAt: '2026-10-01T00:00:00.000Z',
        pendingDelegate: B,
      });
      expect(answer.pendingSince).toEqual(expect.any(String));
      const row = credentials.rows.get('cred-1')!;
      expect(row.delegateAccount).toBe(A);
      expect(row.pendingDelegateAccount).toBe(B);
      expect(await service.bindingStatus(session())).toMatchObject({
        bound: true,
        delegate: A,
        pendingDelegate: B,
      });
    });

    it('a newer proof replaces an older pending key, never the bound one', async () => {
      const C = `${CHAIN}:0x1111111111111111111111111111111111111111`;
      credentials.rows.set('cred-1', {
        delegateAccount: A,
        delegateBoundAt: new Date('2026-10-01T00:00:00.000Z'),
        pendingDelegateAccount: C,
        pendingDelegateRequestedAt: new Date('2026-10-02T00:00:00.000Z'),
      });

      await bindOther();

      expect(credentials.rows.get('cred-1')).toMatchObject({
        delegateAccount: A,
        pendingDelegateAccount: B,
      });
    });

    it('proving the bound key again is no rebinding (status ACTIVE)', async () => {
      credentials.rows.set('cred-1', {
        delegateAccount: A,
        delegateBoundAt: new Date('2026-10-01T00:00:00.000Z'),
      });
      const { challenge, signature } = await signChallenge();

      const answer = await service.bind(session(), challenge.challengeId, signature);

      expect(answer).toMatchObject({ status: 'ACTIVE', delegate: A, pendingDelegate: null });
    });

    it('refuses a pending key another live credential already waits with', async () => {
      credentials.rows.set('cred-1', { delegateAccount: A, delegateBoundAt: new Date() });
      credentials.rows.set('cred-2', {
        delegateAccount: null,
        delegateBoundAt: null,
        pendingDelegateAccount: B,
        pendingDelegateRequestedAt: new Date(),
      });

      await expect(bindOther()).rejects.toMatchObject({
        errorCode: 'ACCOUNT_DELEGATE_ALREADY_BOUND',
      });
      expect(credentials.rows.get('cred-1')!.pendingDelegateAccount).toBeUndefined();
    });
  });

  describe('GET /agents/me/delegate — the agent label and paidCalls (§7.10 item 1, R-PAY-3)', () => {
    const DELEGATE = `${CHAIN}:${delegateKey.address}`;
    const bound = () =>
      credentials.rows.set('cred-1', {
        delegateAccount: DELEGATE,
        delegateBoundAt: new Date('2026-10-01T00:00:00.000Z'),
      });

    it('no delegate bound → paidCalls null, the label beside the credential id, no chain read', async () => {
      expect(await service.current(session({ label: 'research bot' }))).toEqual({
        credentialId: 'cred-1',
        agentLabel: 'research bot',
        delegate: null,
        boundAt: null,
        paidCalls: null,
        paidCallsUnknown: false,
        pendingDelegate: null,
        pendingSince: null,
      });
      expect(delegations.reads).toEqual([]);
    });

    it("an authorised key → ACTIVE with the caps, read from the payer's delegations", async () => {
      bound();
      delegations.standing = [standing(`${CHAIN}:${otherKey.address}`), standing(DELEGATE)];
      expect(await service.current(session())).toEqual({
        credentialId: 'cred-1',
        agentLabel: null,
        delegate: DELEGATE,
        boundAt: '2026-10-01T00:00:00.000Z',
        paidCalls: {
          status: 'ACTIVE',
          maxVoucherAmount: '500000',
          maxPerWindow: '5000000',
          spentInWindow: '1250',
          validUntil: new Date(1_900_000_000 * 1000).toISOString(),
        },
        paidCallsUnknown: false,
        pendingDelegate: null,
        pendingSince: null,
      });
      expect(delegations.reads).toEqual([session().agentAccount]);
    });

    it('chain read fails → the stored binding still answers, paidCalls null and marked unknown', async () => {
      bound();
      delegations.failure = new Error('RPC timeout');
      expect(await service.current(session({ label: 'research bot' }))).toEqual({
        credentialId: 'cred-1',
        agentLabel: 'research bot',
        delegate: DELEGATE,
        boundAt: '2026-10-01T00:00:00.000Z',
        paidCalls: null,
        paidCallsUnknown: true,
        pendingDelegate: null,
        pendingSince: null,
      });
    });

    it('matches the bound key in any spelling of its address', async () => {
      bound();
      delegations.standing = [standing(`${CHAIN}:${delegateKey.address.toLowerCase()}`)];
      expect((await service.current(session())).paidCalls?.status).toBe('ACTIVE');
    });

    it('past validUntil → EXPIRED with its caps', async () => {
      bound();
      delegations.standing = [standing(DELEGATE, EscrowDelegationStatus.EXPIRED)];
      expect((await service.current(session())).paidCalls).toMatchObject({
        status: 'EXPIRED',
        maxPerWindow: '5000000',
      });
    });

    it("bound but not authorised (or revoked) → NONE; another key's grant is never shown", async () => {
      bound();
      delegations.standing = [standing(`${CHAIN}:${otherKey.address}`)];
      expect((await service.current(session())).paidCalls).toEqual({
        status: 'NONE',
        maxVoucherAmount: null,
        maxPerWindow: null,
        spentInWindow: null,
        validUntil: null,
      });
    });

    it('returns the stored label exactly: the server does not escape it (the proxy sanitises on print)', async () => {
      const label = 'bot <b>"x"</b> \u00e9';
      expect((await service.current(session({ label }))).agentLabel).toBe(label);
    });

    it('bind answers with the agent label too', async () => {
      const { challenge, signature } = await signChallenge();
      const answer = await service.bind(
        session({ label: 'research bot' }),
        challenge.challengeId,
        signature,
      );
      expect(answer).toMatchObject({ credentialId: 'cred-1', agentLabel: 'research bot' });
    });
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
  describe('GET /agents/me/delegate/status — the binding alone, no chain read', () => {
    const DELEGATE = `${CHAIN}:${delegateKey.address}`;

    it('is current() without paidCalls, and never reads the chain', async () => {
      credentials.rows.set('cred-1', {
        delegateAccount: DELEGATE,
        delegateBoundAt: new Date('2026-10-01T00:00:00.000Z'),
      });
      delegations.standing = [standing(DELEGATE)];

      const status = await service.bindingStatus(session({ label: 'research bot' }));
      const reads = delegations.reads.length;
      const binding: Record<string, unknown> = {
        ...(await service.current(session({ label: 'research bot' }))),
      };
      delete binding.paidCalls;
      delete binding.paidCallsUnknown;

      expect(reads).toBe(0);
      expect(status).toEqual({ ...binding, bound: true });
      expect(status).toEqual({
        credentialId: 'cred-1',
        agentLabel: 'research bot',
        bound: true,
        delegate: DELEGATE,
        boundAt: '2026-10-01T00:00:00.000Z',
        pendingDelegate: null,
        pendingSince: null,
      });
    });

    it('says bound: false when no key is bound', async () => {
      expect(await service.bindingStatus(session())).toEqual({
        credentialId: 'cred-1',
        agentLabel: null,
        bound: false,
        delegate: null,
        boundAt: null,
        pendingDelegate: null,
        pendingSince: null,
      });
    });

    it('refuses a person and a config token, as current() does', async () => {
      await expect(
        service.bindingStatus(session({ callerKind: McpCallerKind.HUMAN })),
      ).rejects.toMatchObject({ errorCode: 'ACCOUNT_DELEGATE_BINDING_AGENT_ONLY' });
      await expect(
        service.bindingStatus(session({ storedCredential: undefined })),
      ).rejects.toMatchObject({ errorCode: 'ACCOUNT_DELEGATE_BINDING_AGENT_ONLY' });
      await expect(
        service.bindingStatus(session({ paymentsAllowed: false })),
      ).rejects.toMatchObject({ errorCode: 'ACCOUNT_DELEGATE_CLIENT_NOT_ALLOWED' });
    });
  });

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

  it('is refused to a config-file machine token: no stored credential backs it (N-1)', async () => {
    await expect(
      service.challenge(
        session({ credentialId: 'cred-demo-agent', storedCredential: undefined }),
        delegateKey.address,
      ),
    ).rejects.toMatchObject({ errorCode: 'ACCOUNT_DELEGATE_BINDING_AGENT_ONLY' });
  });

  /**
   * R-OA-22 (defence in depth): only API keys and `assay-mcp` grants may bind a
   * payment key. Payments need `paymentsAllowed === true`, so a session that
   * lacks the field is refused like one that says false (fail closed).
   */
  describe('a session without paymentsAllowed === true', () => {
    function spies() {
      return [
        jest.spyOn(redis, 'set'),
        jest.spyOn(redis, 'getdel'),
        jest.spyOn(credentials, 'findOneBy'),
        jest.spyOn(credentials, 'update'),
        jest.spyOn(credentials, 'findOtherDelegateHolders'),
        jest.spyOn(credentials, 'releaseDelegateFromExpired'),
      ];
    }

    const refused: Array<[string, Partial<McpSession>]> = [
      ['false (a third-party OAuth grant)', { paymentsAllowed: false }],
      ['missing', { paymentsAllowed: undefined }],
    ];

    it.each(refused)(
      'paymentsAllowed %s → challenge, bind and current refused before any Redis or DB access',
      async (_label, overrides) => {
        const watched = spies();
        const s = session(overrides);

        await expect(service.challenge(s, delegateKey.address)).rejects.toMatchObject({
          errorCode: 'ACCOUNT_DELEGATE_CLIENT_NOT_ALLOWED',
          statusCode: 403,
        });
        await expect(service.bind(s, 'challenge-1', '0xsig')).rejects.toMatchObject({
          errorCode: 'ACCOUNT_DELEGATE_CLIENT_NOT_ALLOWED',
        });
        await expect(service.current(s)).rejects.toMatchObject({
          errorCode: 'ACCOUNT_DELEGATE_CLIENT_NOT_ALLOWED',
        });

        for (const spy of watched) expect(spy).not.toHaveBeenCalled();
        expect(redis.store.size).toBe(0);
      },
    );

    it('paymentsAllowed true → challenge and bind proceed', async () => {
      const { challenge, signature } = await signChallenge(
        delegateKey,
        session({ paymentsAllowed: true }),
      );
      const bound = await service.bind(
        session({ paymentsAllowed: true }),
        challenge.challengeId,
        signature,
      );
      expect(bound.delegate).toBe(`${CHAIN}:${delegateKey.address}`);
    });

    it('a config-file token is still refused as agent-only first', async () => {
      await expect(
        service.challenge(
          session({ storedCredential: undefined, paymentsAllowed: false }),
          delegateKey.address,
        ),
      ).rejects.toMatchObject({ errorCode: 'ACCOUNT_DELEGATE_BINDING_AGENT_ONLY' });
    });
  });

  it('refuses a chain without voucher delegation', async () => {
    const solana = { resolve: () => ({ toAccountId: jest.fn() }) };
    const onSolana = new AgentDelegateService(
      credentials as never,
      solana as never,
      redis as never,
      delegations as never,
    );
    await expect(onSolana.challenge(session(), delegateKey.address)).rejects.toMatchObject({
      errorCode: 'ACCOUNT_DELEGATE_BINDING_UNSUPPORTED',
    });
  });
});
