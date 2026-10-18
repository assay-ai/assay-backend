import { isForbiddenKey, redact, REDACTED } from '@shared/observability';

/**
 * The forbidden logging list (response bodies, private key material, session
 * tokens, full voucher signatures) and the six env var names docs/architecture.md
 * names outright: `VERIFIER_SIGNING_KEYS`, `EXPOSURE_AUTHORITY_SIGNING_KEY`,
 * `JWT_SECRET`, `VERIFICATION_SAMPLING_SECRET`, `REDIS_PASSWORD`,
 * `DATABASE_PASSWORD`, an `Authorization: Bearer …` value, and the raw
 * agent-credential token (`prefix` / `tokenHash` are the two explicit
 * exceptions — `agent-credential.entity.ts`).
 */
describe('isForbiddenKey', () => {
  it.each([
    'VERIFIER_SIGNING_KEYS',
    'verifierSigningKeys',
    'EXPOSURE_AUTHORITY_SIGNING_KEY',
    'exposureAuthoritySigningKey',
    'JWT_SECRET',
    'jwtSecret',
    'VERIFICATION_SAMPLING_SECRET',
    'verificationSamplingSecret',
    'REDIS_PASSWORD',
    'redisPassword',
    'DATABASE_PASSWORD',
    'databasePassword',
    'authorization',
    'Authorization',
    'apiKey',
    'cookie',
  ])('forbids %s', (key) => {
    expect(isForbiddenKey(key)).toBe(true);
  });

  it.each([
    'token', // the raw agent-credential secret — create-agent-credential.dto.ts
    'accessToken',
    'refreshToken',
    'sessionToken',
    'bearerToken',
    'signature', // voucher.types.ts's Voucher.signature; verifier-signing-log's attestation
    'body',
    'requestBody',
    'responseBody',
    'rawBody',
    // OAuth (R-OA-27): tokens, the code, the PKCE verifier and the consent request id.
    'access_token',
    'refresh_token',
    'code_verifier',
    'codeVerifier',
    'code_challenge',
    'client_secret',
    'rid',
    'requestId',
    'request_id',
  ])('forbids the exact field %s', (key) => {
    expect(isForbiddenKey(key)).toBe(true);
  });

  it.each(['tokenHash', 'token_hash', 'prefix'])(
    'never forbids %s — the two fields agent-credential.entity.ts calls safe',
    (key) => {
      expect(isForbiddenKey(key)).toBe(false);
    },
  );

  it.each([
    'funderTokenAccount',
    'restorerTokenAccount',
    'executionSignature',
    'reversalSignature',
    'producedSignature',
    'nextPageToken',
    'tokenId',
    'serverRequestId',
    'organizationId',
    'intentId',
    'amount',
  ])('does not forbid the public/operational field %s', (key) => {
    expect(isForbiddenKey(key)).toBe(false);
  });
});

describe('redact', () => {
  it('passes primitives through unchanged', () => {
    expect(redact('hello')).toBe('hello');
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
    expect(redact(true)).toBe(true);
  });

  it('leaves Date and RegExp values alone', () => {
    const date = new Date('2026-08-22T00:00:00Z');
    expect(redact(date)).toBe(date);
    const regex = /abc/;
    expect(redact(regex)).toBe(regex);
  });

  it('blanks a forbidden key at the top level, structurally — not by scanning the rendered string', () => {
    const result = redact({ intentId: 'pi_1', token: 'assay_live_secret' }) as Record<
      string,
      unknown
    >;
    expect(result.intentId).toBe('pi_1');
    expect(result.token).toBe(REDACTED);
  });

  it('blanks a forbidden key at any nesting depth', () => {
    const result = redact({
      env: { VERIFIER_SIGNING_KEYS: 'super-secret', DATABASE_PASSWORD: 'p' },
      request: { headers: { authorization: 'Bearer abc.def.ghi' } },
    }) as any;

    expect(result.env.VERIFIER_SIGNING_KEYS).toBe(REDACTED);
    expect(result.env.DATABASE_PASSWORD).toBe(REDACTED);
    expect(result.request.headers.authorization).toBe(REDACTED);
  });

  it('keeps prefix and tokenHash alongside a redacted sibling', () => {
    const result = redact({
      prefix: 'assay_live_8f',
      tokenHash: 'abcd1234',
      token: 'assay_live_8fK2secretvalue',
    }) as Record<string, unknown>;

    expect(result.prefix).toBe('assay_live_8f');
    expect(result.tokenHash).toBe('abcd1234');
    expect(result.token).toBe(REDACTED);
  });

  it('redacts inside arrays without dropping non-forbidden siblings', () => {
    const result = redact([
      { id: 1, secret: 'a' },
      { id: 2, secret: 'b' },
    ]) as Array<Record<string, unknown>>;

    expect(result).toEqual([
      { id: 1, secret: REDACTED },
      { id: 2, secret: REDACTED },
    ]);
  });

  it('keeps a public Solana transaction signature and token account readable', () => {
    const result = redact({
      executionSignature: '5j7sSignatureBase58...',
      funderTokenAccount: 'FunderTokenAccountAddress...',
    }) as Record<string, unknown>;

    expect(result.executionSignature).toBe('5j7sSignatureBase58...');
    expect(result.funderTokenAccount).toBe('FunderTokenAccountAddress...');
  });

  it('never logs a response body under any of its common field names', () => {
    const result = redact({
      body: { secretField: 'irrelevant, blanked anyway by the parent key' },
      requestBody: 'raw text',
      responseBody: { ok: true },
      rawBody: Buffer.from('x'),
    }) as Record<string, unknown>;

    expect(result.body).toBe(REDACTED);
    expect(result.requestBody).toBe(REDACTED);
    expect(result.responseBody).toBe(REDACTED);
    expect(result.rawBody).toBe(REDACTED);
  });

  it('serialises an Error to a plain object with name/message/stack and redacts its own extra fields', () => {
    class WithSecret extends Error {
      privateKey = 'do-not-log-me';
      intentId = 'pi_1';
    }
    const result = redact(new WithSecret('boom')) as Record<string, unknown>;

    expect(result.name).toBe('Error');
    expect(result.message).toBe('boom');
    expect(typeof result.stack).toBe('string');
    expect(result.privateKey).toBe(REDACTED);
    expect(result.intentId).toBe('pi_1');
  });

  it('replaces a circular reference rather than throwing or looping forever', () => {
    const node: Record<string, unknown> = { id: 'n1' };
    node.self = node;

    const result = redact(node) as Record<string, unknown>;
    expect(result.id).toBe('n1');
    expect(result.self).toBe('[CIRCULAR]');
  });

  it('truncates a pathologically deep payload instead of recursing forever', () => {
    let deepest: Record<string, unknown> = { bottom: true };
    for (let i = 0; i < 20; i += 1) {
      deepest = { nested: deepest };
    }

    expect(() => redact(deepest)).not.toThrow();
  });

  it('does not mutate the input', () => {
    const input = { token: 'secret', nested: { authorization: 'Bearer x' } };
    const clone = JSON.parse(JSON.stringify(input));

    redact(input);

    expect(input).toEqual(clone);
  });

  // ── the value backstop (R-OA-27) ───────────────────────────────────────────

  const AT = 'assay_at_' + 'A'.repeat(20) + 'b-c_d' + 'E'.repeat(18);
  const RT = 'assay_rt_' + 'Zz09_-'.repeat(7) + 'q';
  const AC = 'assay_ac_' + 'x'.repeat(43);
  const SK = 'assay_sk_live_' + 'k'.repeat(40);
  const SIG = '0x' + 'ab'.repeat(65);

  it('replaces assay_rt_… in a free-text message', () => {
    const result = redact({ message: `refresh with ${RT} failed` }) as Record<string, unknown>;
    expect(result.message).toBe(`refresh with ${REDACTED} failed`);
  });

  it.each([
    ['an access token', AT],
    ['an authorization code', AC],
    ['an API key', SK],
    ['a 65-byte signature', SIG],
  ])('replaces %s wherever it appears in a string', (_label, secret) => {
    expect(redact(`a ${secret} b`)).toBe(`a ${REDACTED} b`);
    expect(redact({ nested: [{ note: `x=${secret}` }] })).toEqual({
      nested: [{ note: `x=${REDACTED}` }],
    });
  });

  it('replaces a secret in an Error message and stack', () => {
    const result = redact(new Error(`bad token ${AT}`)) as Record<string, unknown>;
    expect(result.message).toBe(`bad token ${REDACTED}`);
    expect(String(result.stack)).not.toContain(AT);
  });

  it('keeps a 32-byte hex value (a transaction hash) and an API-key prefix readable', () => {
    const txHash = '0x' + 'cd'.repeat(32);
    expect(redact(`tx ${txHash}`)).toBe(`tx ${txHash}`);
    expect(redact({ prefix: 'assay_sk_live_ab12cd' })).toEqual({ prefix: 'assay_sk_live_ab12cd' });
  });

  it('keeps an error-code shaped code (ECONNREFUSED, a Postgres code) and blanks any other', () => {
    expect(redact({ code: 'ECONNREFUSED' })).toEqual({ code: 'ECONNREFUSED' });
    expect(redact({ code: '23505' })).toEqual({ code: '23505' });
    expect(redact({ code: AC })).toEqual({ code: REDACTED });
    expect(redact({ code: 'q1W2e3R4t5' })).toEqual({ code: REDACTED });
  });
});
