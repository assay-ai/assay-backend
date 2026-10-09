import { AccountId, CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import {
  DEFAULT_RELAYED_INTENT_RATE_LIMITS,
  RelayedIntentRateLimits,
  decideRelayedIntentRate,
} from '@modules/settlement/domain/relayed-intent-rate-limit';
import { RelayedIntentRateLimiter } from '@modules/settlement/services/relayed-intent-rate-limiter.service';

/**
 * The bound on how much of the relayer's ETH one caller may spend.
 *
 * The pre-flight already makes an *invalid* submission cost an RPC round trip
 * instead of gas — a replay is caught by `BadNonce` before anything is sent.
 * This is the control for the case the pre-flight cannot help with: a buyer
 * signing a fresh, entirely valid request at each new `authNonce` and posting
 * it in a loop. Every one of those lands and every one costs ~65,000 gas.
 */
const ACCOUNT: AccountId = toAccountId(
  CHAIN_IDS.ROBINHOOD_TESTNET,
  '0x1b89caB90cbc71bBFad47E45707D17787cf91dD1',
);
const ORG = '7e3a94c1-5b62-4d08-9f37-2c81e6a0b5d4';

const LIMITS: RelayedIntentRateLimits = {
  windowSeconds: 3600,
  perAccount: 3,
  perOrganization: 5,
};

function caught(error: unknown): { code?: string; status?: number; message: string } {
  const candidate = error as { errorCode?: string; statusCode?: number; message: string };
  return { code: candidate.errorCode, status: candidate.statusCode, message: candidate.message };
}

/**
 * A Redis stand-in that counts the way the real one does: a sorted set per key,
 * the window trimmed by score, and `zcard` AFTER the insert.
 *
 * Written rather than mocked to a fixed number, because the property under test
 * is that the count INCLUDES the attempt being decided — a `zcard` stub
 * returning a constant would pass whether or not it did.
 */
function fakeRedis(options: { failOn?: 'exec' | 'throw' | 'null' } = {}) {
  const sets = new Map<string, { score: number; member: string }[]>();

  return {
    sets,
    multi() {
      const ops: (() => void)[] = [];
      const reads: (() => number)[] = [];
      const order: ('write' | 'read')[] = [];
      const api = {
        zremrangebyscore(key: string, _min: string, max: number) {
          ops.push(() => {
            sets.set(
              key,
              (sets.get(key) ?? []).filter((entry) => entry.score > max),
            );
          });
          order.push('write');
          return api;
        },
        zadd(key: string, score: number, member: string) {
          ops.push(() => {
            sets.set(key, [...(sets.get(key) ?? []), { score, member }]);
          });
          order.push('write');
          return api;
        },
        zcard(key: string) {
          reads.push(() => (sets.get(key) ?? []).length);
          order.push('read');
          return api;
        },
        pexpire() {
          ops.push(() => undefined);
          order.push('write');
          return api;
        },
        async exec(): Promise<[Error | null, unknown][] | null> {
          if (options.failOn === 'throw') throw new Error('Connection is closed.');
          if (options.failOn === 'null') return null;
          let writes = 0;
          let readIndex = 0;
          const replies: [Error | null, unknown][] = [];
          for (const kind of order) {
            if (kind === 'write') {
              ops[writes++]();
              replies.push([null, 'OK']);
            } else {
              replies.push(
                options.failOn === 'exec'
                  ? [new Error('WRONGTYPE'), null]
                  : [null, reads[readIndex++]()],
              );
            }
          }
          return replies;
        },
      };
      return api;
    },
  };
}

function limiter(redis: ReturnType<typeof fakeRedis>, limits: RelayedIntentRateLimits = LIMITS) {
  return new RelayedIntentRateLimiter(redis as never, limits);
}

describe('decideRelayedIntentRate', () => {
  /**
   * `observed` includes the attempt being decided. Deciding on the count BEFORE
   * the increment lets exactly `limit + 1` through — the classic off-by-one that
   * makes a ceiling of 10 mean 11, and that no test asserting "the 12th is
   * refused" would ever notice.
   */
  it('allows exactly `limit` attempts and refuses the next', () => {
    expect(decideRelayedIntentRate([{ scope: 'account:a', observed: 3, limit: 3 }])).toBeNull();
    expect(decideRelayedIntentRate([{ scope: 'account:a', observed: 4, limit: 3 }])).toEqual({
      scope: 'account:a',
      observed: 4,
      limit: 3,
    });
  });

  it('names the FIRST breached scope, so the narrower one is what a caller is told', () => {
    const breached = decideRelayedIntentRate([
      { scope: 'account:a', observed: 9, limit: 3 },
      { scope: 'organization:o', observed: 9, limit: 5 },
    ]);
    expect(breached?.scope).toBe('account:a');
  });

  it('refuses on the organization scope even when the account is well inside its own', () => {
    const breached = decideRelayedIntentRate([
      { scope: 'account:a', observed: 1, limit: 3 },
      { scope: 'organization:o', observed: 6, limit: 5 },
    ]);
    expect(breached?.scope).toBe('organization:o');
  });

  it('ships a default that is not accidentally unbounded', () => {
    expect(DEFAULT_RELAYED_INTENT_RATE_LIMITS.perAccount).toBeGreaterThan(0);
    expect(DEFAULT_RELAYED_INTENT_RATE_LIMITS.perAccount).toBeLessThanOrEqual(
      DEFAULT_RELAYED_INTENT_RATE_LIMITS.perOrganization,
    );
    expect(DEFAULT_RELAYED_INTENT_RATE_LIMITS.windowSeconds).toBeGreaterThan(0);
  });
});

describe('RelayedIntentRateLimiter, counting', () => {
  it('admits up to the per-account ceiling and refuses the one after it', async () => {
    const service = limiter(fakeRedis());

    for (let i = 0; i < LIMITS.perAccount; i += 1) {
      await expect(service.admit(ACCOUNT, ORG)).resolves.toBeUndefined();
    }

    const error = await service.admit(ACCOUNT, ORG).catch((e: unknown) => e);
    expect(caught(error).code).toBe('SETTLEMENT_RELAYED_INTENT_RATE_LIMITED');
    expect(caught(error).status).toBe(429);
    expect(caught(error).message).toContain(`account:${ACCOUNT}`);
  });

  /**
   * A refused attempt still counts. Without this an attacker parked at the
   * ceiling gets an unlimited number of further attempts for free — and each one
   * still costs an `eth_estimateGas` against the node, which is the RPC budget
   * this also protects. Measured as: the count keeps climbing past the ceiling.
   */
  it('counts attempts it refused', async () => {
    const redis = fakeRedis();
    const service = limiter(redis);

    for (let i = 0; i < LIMITS.perAccount + 3; i += 1) {
      await service.admit(ACCOUNT, ORG).catch(() => undefined);
    }

    expect(redis.sets.get(`settlement:relayed-intent:rate:account:${ACCOUNT}`)).toHaveLength(
      LIMITS.perAccount + 3,
    );
  });

  /**
   * The account ceiling alone is defeated by a tenant holding several buyer
   * accounts. Three accounts, two submissions each, is six against an
   * organization ceiling of five.
   */
  it('refuses on the organization scope when several accounts share one tenant', async () => {
    const service = limiter(fakeRedis());
    const accounts = [
      toAccountId(CHAIN_IDS.ROBINHOOD_TESTNET, '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc'),
      toAccountId(CHAIN_IDS.ROBINHOOD_TESTNET, '0x976EA74026E726554dB657fA54763abd0C3a0aa9'),
      toAccountId(CHAIN_IDS.ROBINHOOD_TESTNET, '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955'),
    ];

    const outcomes: string[] = [];
    for (let round = 0; round < 2; round += 1) {
      for (const account of accounts) {
        outcomes.push(
          await service
            .admit(account, ORG)
            .then(() => 'ok')
            .catch((e: unknown) => caught(e).code ?? 'unknown'),
        );
      }
    }

    // Five through, the sixth refused — and refused on the ORGANIZATION, because
    // no single account got past two of its own three.
    expect(outcomes.slice(0, 5)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(outcomes[5]).toBe('SETTLEMENT_RELAYED_INTENT_RATE_LIMITED');
  });

  it('keeps one organization out of another’s budget', async () => {
    const service = limiter(fakeRedis());
    for (let i = 0; i < LIMITS.perOrganization + 2; i += 1) {
      await service.admit(ACCOUNT, ORG).catch(() => undefined);
    }

    const other = toAccountId(
      CHAIN_IDS.ROBINHOOD_TESTNET,
      '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
    );
    await expect(service.admit(other, 'a-different-organization')).resolves.toBeUndefined();
  });

  it('drops attempts that fell out of the window', async () => {
    const redis = fakeRedis();
    const service = limiter(redis);

    const key = `settlement:relayed-intent:rate:account:${ACCOUNT}`;
    // Three attempts from two hours ago, against a one-hour window.
    redis.sets.set(
      key,
      [1, 2, 3].map((n) => ({ score: Date.now() - 7_200_000 - n, member: `old-${n}` })),
    );

    await expect(service.admit(ACCOUNT, ORG)).resolves.toBeUndefined();
    expect(redis.sets.get(key)).toHaveLength(1);
  });
});

describe('RelayedIntentRateLimiter fails CLOSED', () => {
  /**
   * The opposite of the usual choice for a rate limiter, and deliberate: the
   * unavailable-therefore-permitted branch is the one an attacker steers you
   * into, and knocking Redis over is easier than anything else on this path.
   *
   * Three ways the counter can fail to run, each answering the same way.
   */
  it.each([
    ['the connection throws', 'throw' as const],
    ['the MULTI is discarded', 'null' as const],
    ['a command inside the MULTI errors', 'exec' as const],
  ])('refuses when %s', async (_case, failOn) => {
    const service = limiter(fakeRedis({ failOn }));

    const error = await service.admit(ACCOUNT, ORG).catch((e: unknown) => e);

    expect(caught(error).code).toBe('SETTLEMENT_RELAYED_INTENT_UNAVAILABLE');
    expect(caught(error).status).toBe(503);
    // Says what a buyer can do about it, because the answer is "wait" and not
    // "re-sign" — the signature is unaffected.
    expect(caught(error).message).toContain('still valid');
  });
});
