import type { Redis } from 'ioredis';

import { McpErrorCode } from '@modules/mcp/errors/mcp.errors';
import {
  AGENT_SPEND_LOCK_RENEW_MS,
  AGENT_SPEND_LOCK_TTL_MS,
  AGENT_SPEND_LOCK_WAIT_MS,
  SpendPolicyEnforcementService,
} from '@modules/spend-policy/services/spend-policy-enforcement.service';
import { SpendPolicyVelocityService } from '@modules/spend-policy/services/spend-policy-velocity.service';

import { FakeRedis } from './helpers/fake-redis';

/**
 * REGRESSION (review 2026-10-15 P-6): the caps are checked, then the hold is
 * written, as two steps. `withAgentSpendLock` makes them one per agent: a
 * second call of the same agent waits until the first has reserved.
 */
describe('SpendPolicyEnforcementService.withAgentSpendLock', () => {
  let redis: FakeRedis;
  let service: SpendPolicyEnforcementService;

  beforeEach(() => {
    redis = new FakeRedis();
    const velocity = new SpendPolicyVelocityService(redis as unknown as Redis);
    service = new SpendPolicyEnforcementService({} as never, {} as never, velocity, {
      emit: jest.fn(),
    } as never);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const lockKey = () => [...redis.strings.keys()].find((key) => key.includes('spend-lock:'));

  it('runs one critical section per agent at a time, and releases the lock after', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;

    const first = service.withAgentSpendLock('agent-1', async () => {
      order.push('first:start');
      await new Promise<void>((resolve) => (releaseFirst = resolve));
      order.push('first:end');
    });
    await new Promise((resolve) => setImmediate(resolve));
    const second = service.withAgentSpendLock('agent-1', async () => {
      order.push('second');
    });
    // A different agent is not held up.
    await service.withAgentSpendLock('agent-2', async () => {
      order.push('other-agent');
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(order).toEqual(['first:start', 'other-agent']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'other-agent', 'first:end', 'second']);
    expect(lockKey()).toBeUndefined();
    expect(redis.expiries.get(`spend-policy:velocity:spend-lock:agent-1`)).toBe(
      AGENT_SPEND_LOCK_TTL_MS,
    );
  });

  it('releases the lock when the critical section throws', async () => {
    await expect(
      service.withAgentSpendLock('agent-1', async () => {
        throw new Error('cap reached');
      }),
    ).rejects.toThrow('cap reached');
    expect(lockKey()).toBeUndefined();
  });

  it('fails closed, running nothing, when Redis is unreachable', async () => {
    redis.down = true;
    const fn = jest.fn();
    await expect(service.withAgentSpendLock('agent-1', fn)).rejects.toMatchObject({
      errorCode: McpErrorCode.MCP_VELOCITY_LIMIT_EXCEEDED,
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('refuses retryably, running nothing, when the lock stays busy past the wait', async () => {
    jest.useFakeTimers();
    redis.strings.set('spend-policy:velocity:spend-lock:agent-1', 'someone-else');
    const fn = jest.fn();
    const attempt = service.withAgentSpendLock('agent-1', fn);
    const outcome = expect(attempt).rejects.toMatchObject({
      errorCode: McpErrorCode.MCP_VELOCITY_LIMIT_EXCEEDED,
    });
    await jest.advanceTimersByTimeAsync(AGENT_SPEND_LOCK_WAIT_MS + 100);
    await outcome;
    expect(fn).not.toHaveBeenCalled();
    // Someone else's lock is not ours to release.
    expect(redis.strings.get('spend-policy:velocity:spend-lock:agent-1')).toBe('someone-else');
  });

  /**
   * Final review N-4: on rail B the locked section reads the chain (the
   * voucher signer), and a slow RPC could outlast the 15 s TTL, letting a
   * second call of the same agent in before the first one's hold existed.
   * The lock is now renewed for as long as its holder runs.
   */
  it('keeps the lock alive past its TTL while the section is still running', async () => {
    jest.useFakeTimers();
    let finish!: () => void;
    const section = service.withAgentSpendLock(
      'agent-1',
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    await jest.advanceTimersByTimeAsync(AGENT_SPEND_LOCK_TTL_MS * 3);

    const renewals = redis.commands.filter((c) => c.startsWith('renew ')).length;
    expect(renewals).toBeGreaterThanOrEqual(
      Math.floor((AGENT_SPEND_LOCK_TTL_MS * 3) / AGENT_SPEND_LOCK_RENEW_MS),
    );
    expect(AGENT_SPEND_LOCK_RENEW_MS).toBeLessThan(AGENT_SPEND_LOCK_TTL_MS / 2);

    finish();
    await section;
    const after = redis.commands.length;
    await jest.advanceTimersByTimeAsync(AGENT_SPEND_LOCK_TTL_MS);
    // Released, and no longer renewed.
    expect(lockKey()).toBeUndefined();
    expect(redis.commands.slice(after).filter((c) => c.startsWith('renew '))).toEqual([]);
  });

  it('does not renew a lock someone else now holds', async () => {
    const velocity = new SpendPolicyVelocityService(redis as unknown as Redis);
    redis.strings.set('spend-policy:velocity:spend-lock:agent-1', 'someone-else');
    redis.expiries.set('spend-policy:velocity:spend-lock:agent-1', 1);
    await velocity.renewAgentSpendLock('agent-1', 'mine', AGENT_SPEND_LOCK_TTL_MS);
    expect(redis.expiries.get('spend-policy:velocity:spend-lock:agent-1')).toBe(1);
  });
});
