import {
  MCP_IDEMPOTENCY_KEY_MAX_LENGTH,
  argumentsFingerprint,
  parseIdempotencyKey,
} from '@modules/mcp/domain/idempotency';
import { McpErrorCode } from '@modules/mcp/errors/mcp.errors';
import {
  DEFAULT_MCP_IDEMPOTENCY_CONFIG,
  McpIdempotencyHandle,
  McpIdempotencyScope,
  McpIdempotencyStore,
  mcpIdempotencyConfigFactory,
} from '@modules/mcp/services/mcp-idempotency.store';

import { FakeIdempotencyRedis } from './helpers/fake-idempotency-redis';

describe('assay/idempotency-key — the key and its record', () => {
  describe('parseIdempotencyKey', () => {
    it('reads an absent or null key as no key', () => {
      expect(parseIdempotencyKey(undefined)).toBeNull();
      expect(parseIdempotencyKey(null)).toBeNull();
    });

    it('accepts printable ASCII from one character to the maximum', () => {
      expect(parseIdempotencyKey('a')).toBe('a');
      expect(parseIdempotencyKey(' ~')).toBe(' ~');
      const longest = 'x'.repeat(MCP_IDEMPOTENCY_KEY_MAX_LENGTH);
      expect(parseIdempotencyKey(longest)).toBe(longest);
    });

    it.each([[''], ['x'.repeat(129)], ['tab\there'], ['naïve'], ['emoji-\u{1F600}'], [7], [true]])(
      'refuses %p with MCP_IDEMPOTENCY_KEY_INVALID',
      (raw) => {
        expect(() => parseIdempotencyKey(raw)).toThrow(
          expect.objectContaining({ errorCode: McpErrorCode.MCP_IDEMPOTENCY_KEY_INVALID }),
        );
      },
    );
  });

  describe('argumentsFingerprint', () => {
    it('is the same for the same arguments in any key order, and differs for other arguments', () => {
      const a = argumentsFingerprint({ query: 'q', options: { limit: 3, lang: 'en' } });
      const b = argumentsFingerprint({ options: { lang: 'en', limit: 3 }, query: 'q' });
      const c = argumentsFingerprint({ query: 'other' });
      expect(a).toBe(b);
      expect(a).not.toBe(c);
      expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
  });

  describe('mcpIdempotencyConfigFactory', () => {
    it('defaults to a 15-minute window and a 256 KB result cap', () => {
      expect(mcpIdempotencyConfigFactory(undefined, undefined)).toMatchObject({
        resultTtlSeconds: 900,
        maxResultBytes: 262_144,
      });
      expect(mcpIdempotencyConfigFactory('', '').resultTtlSeconds).toBe(900);
    });

    it('reads both variables', () => {
      expect(mcpIdempotencyConfigFactory(' 1800 ', '1024')).toMatchObject({
        resultTtlSeconds: 1800,
        maxResultBytes: 1024,
      });
    });

    it('accepts the one-hour ceiling and fails the boot above it', () => {
      expect(mcpIdempotencyConfigFactory('3600').resultTtlSeconds).toBe(3600);
      expect(() => mcpIdempotencyConfigFactory('3601')).toThrow(/at most 3600/);
    });

    it.each([['0'], ['-5'], ['soon'], ['1.5']])('fails the boot on %p', (raw) => {
      expect(() => mcpIdempotencyConfigFactory(raw)).toThrow(/positive integer/);
      expect(() => mcpIdempotencyConfigFactory(undefined, raw)).toThrow(/positive integer/);
    });
  });

  describe('McpIdempotencyStore', () => {
    const SCOPE: McpIdempotencyScope = {
      organizationId: 'org-1',
      agentId: 'agent-1',
      key: 'key-1',
      toolId: 'tool-1',
      fingerprint: 'sha256:aa',
    };

    function store() {
      const redis = new FakeIdempotencyRedis();
      return {
        redis,
        store: new McpIdempotencyStore(redis as never, DEFAULT_MCP_IDEMPOTENCY_CONFIG),
      };
    }

    async function claimed(s: McpIdempotencyStore): Promise<McpIdempotencyHandle> {
      const claim = await s.claim(SCOPE);
      if (claim.kind !== 'CLAIMED') throw new Error(`expected CLAIMED, got ${claim.kind}`);
      return claim.handle;
    }

    it('claims with the in-flight lease and stores a result for the retry window', async () => {
      const { redis, store: s } = store();
      const handle = await claimed(s);
      expect(redis.ttls.get(handle.redisKey)).toBe(DEFAULT_MCP_IDEMPOTENCY_CONFIG.inFlightLeaseMs);

      await s.complete(handle, { output: 1 });

      expect(redis.ttls.get(handle.redisKey)).toBe(
        DEFAULT_MCP_IDEMPOTENCY_CONFIG.resultTtlSeconds * 1000,
      );
      await expect(s.claim(SCOPE)).resolves.toEqual({ kind: 'REPLAY', result: { output: 1 } });
    });

    it('names the record by organization, agent and the key digest, never the key itself', async () => {
      const { store: s } = store();
      const handle = await claimed(s);
      expect(handle.redisKey).toMatch(/^mcp:idem:org-1:agent-1:[0-9a-f]{64}$/);
      expect(handle.redisKey).not.toContain('key-1');
    });

    it('answers IN_PROGRESS for a running claim and CONFLICT for another tool or other arguments', async () => {
      const { store: s } = store();
      await claimed(s);

      await expect(s.claim(SCOPE)).resolves.toMatchObject({ kind: 'IN_PROGRESS' });
      await expect(s.claim({ ...SCOPE, toolId: 'tool-2' })).resolves.toEqual({
        kind: 'CONFLICT',
        reason: 'TOOL',
      });
      await expect(s.claim({ ...SCOPE, fingerprint: 'sha256:bb' })).resolves.toEqual({
        kind: 'CONFLICT',
        reason: 'ARGUMENTS',
      });
    });

    it('releases only its own claim', async () => {
      const { redis, store: s } = store();
      const stale = await claimed(s);
      redis.expire(stale.redisKey);
      const current = await claimed(s);

      await s.release(stale);
      await expect(s.claim(SCOPE)).resolves.toMatchObject({ kind: 'IN_PROGRESS' });

      await s.release(current);
      await expect(s.claim(SCOPE)).resolves.toMatchObject({ kind: 'CLAIMED' });
    });

    it('does not overwrite a newer claim with a stale result', async () => {
      const { redis, store: s } = store();
      const stale = await claimed(s);
      redis.expire(stale.redisKey);
      await claimed(s);

      await s.complete(stale, { output: 'stale' });

      await expect(s.claim(SCOPE)).resolves.toMatchObject({ kind: 'IN_PROGRESS' });
    });

    it('refuses rather than overwrites a record it cannot read', async () => {
      const { redis, store: s } = store();
      const handle = await claimed(s);
      redis.strings.set(handle.redisKey, 'not json');

      await expect(s.claim(SCOPE)).resolves.toMatchObject({ kind: 'IN_PROGRESS' });
    });

    it('answers UNAVAILABLE when Redis is down, and complete/release never throw', async () => {
      const { redis, store: s } = store();
      const handle = await claimed(s);
      redis.down = true;

      await expect(s.claim(SCOPE)).resolves.toEqual({ kind: 'UNAVAILABLE' });
      await expect(s.complete(handle, { output: 1 })).resolves.toBeUndefined();
      await expect(s.release(handle)).resolves.toBeUndefined();
    });
  });
});
