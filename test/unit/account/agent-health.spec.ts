import { HealthCredential, agentHealth } from '@modules/account/domain/agent-health';

const NOW = new Date('2026-10-20T12:00:00.000Z');

function key(overrides: Partial<HealthCredential>): HealthCredential {
  return {
    revokedAt: null,
    expiresAt: null,
    lastUsedAt: null,
    delegateAccount: null,
    ...overrides,
  };
}

const at = (iso: string) => new Date(iso);

describe('agentHealth — the facts the dashboard derives from an agent’s keys', () => {
  it('is all zero and null for an agent with no key', () => {
    expect(agentHealth([], NOW)).toEqual({
      evaluatedAt: NOW.toISOString(),
      liveKeyCount: 0,
      unrevokedKeyCount: 0,
      keyBound: false,
      boundKeyCount: 0,
      firstCallSeen: false,
      lastUsedAt: null,
      earliestLastUsedAt: null,
      lastUsedAtAnyKey: null,
    });
  });

  it('keeps the two meanings of live apart: expired counts as unrevoked, not live', () => {
    const health = agentHealth(
      [
        key({ lastUsedAt: at('2026-10-19T08:00:00.000Z') }),
        key({
          expiresAt: at('2026-10-20T11:59:59.999Z'),
          lastUsedAt: at('2026-10-12T08:00:00.000Z'),
        }),
        key({
          revokedAt: at('2026-10-20T09:00:00.000Z'),
          lastUsedAt: at('2026-10-20T08:00:00.000Z'),
        }),
      ],
      NOW,
    );
    expect(health).toMatchObject({
      liveKeyCount: 1,
      unrevokedKeyCount: 2,
      firstCallSeen: true,
      lastUsedAt: '2026-10-19T08:00:00.000Z',
      earliestLastUsedAt: '2026-10-12T08:00:00.000Z',
      lastUsedAtAnyKey: '2026-10-20T08:00:00.000Z',
    });
  });

  it('counts a key as live until the instant it expires', () => {
    expect(agentHealth([key({ expiresAt: NOW })], NOW).liveKeyCount).toBe(0);
    expect(agentHealth([key({ expiresAt: new Date(NOW.getTime() + 1) })], NOW).liveKeyCount).toBe(
      1,
    );
  });

  it('is bound only through a live key', () => {
    const bound = 'eip155:46630:0x0000000000000000000000000000000000000002';
    expect(agentHealth([key({ delegateAccount: bound })], NOW)).toMatchObject({
      keyBound: true,
      boundKeyCount: 1,
    });
    expect(
      agentHealth([key({ delegateAccount: bound, revokedAt: at('2026-10-01T00:00:00Z') })], NOW),
    ).toMatchObject({ keyBound: false, boundKeyCount: 0 });
    expect(
      agentHealth([key({ delegateAccount: bound, expiresAt: at('2026-10-01T00:00:00Z') })], NOW),
    ).toMatchObject({ keyBound: false, boundKeyCount: 0 });
  });

  it('has seen no first call when only a revoked key was used', () => {
    expect(
      agentHealth(
        [
          key({}),
          key({ revokedAt: at('2026-10-01T00:00:00Z'), lastUsedAt: at('2026-09-30T00:00:00Z') }),
        ],
        NOW,
      ),
    ).toMatchObject({
      firstCallSeen: false,
      lastUsedAt: null,
      lastUsedAtAnyKey: '2026-09-30T00:00:00.000Z',
    });
  });
});
