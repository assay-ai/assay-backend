import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConfigOperatorSessionSource,
  OperatorCredentialSnapshot,
  loadOperatorCredentials,
} from '@modules/operator/services/config-operator-session.source';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { FakeOperatorRepository, buildOperator } from './helpers/fake-operator-repository';

/**
 * The operator credential check.
 *
 * Mirrors `test/unit/mcp/mcp-session.spec.ts` — same shape, same "does it
 * refuse" discipline — plus the one thing this source does that
 * `ConfigMcpSessionSource` never has to: the authority is read from a table,
 * fresh, on every resolve, so a suspension takes effect without a new
 * credential file ever being deployed.
 */
describe('ConfigOperatorSessionSource — the token names a subject, the table names the authority', () => {
  function build(snapshot: OperatorCredentialSnapshot, repo = new FakeOperatorRepository()) {
    return { source: new ConfigOperatorSessionSource(snapshot, repo as never), repo };
  }

  it('resolves a configured token to the active operator behind its subject', async () => {
    const { source, repo } = build({ tok_live_abc: { subject: 'dan@' } });
    repo.seed(
      buildOperator({
        id: 'op-dan',
        subject: 'dan@',
        displayName: 'Dan',
        email: 'dan@example.com',
        roles: ['ADJ'],
        authorityLimitMinor: '5000000',
        status: 'ACTIVE',
      }),
    );

    const session = await source.resolve('tok_live_abc');

    expect(session).toEqual({
      operatorId: 'op-dan',
      subject: 'dan@',
      displayName: 'Dan',
      email: 'dan@example.com',
      roles: ['ADJ'],
      authorityLimitMinor: '5000000',
    });
  });

  it('stamps last_seen_at on a successful resolve, without failing the request when the stamp fails', async () => {
    const { source, repo } = build({ tok_live_abc: { subject: 'dan@' } });
    repo.seed(buildOperator({ id: 'op-dan', subject: 'dan@' }));
    repo.updateFails = true;

    await expect(source.resolve('tok_live_abc')).resolves.toMatchObject({ operatorId: 'op-dan' });

    // Give the fire-and-forget stamp a tick to run and reject.
    await Promise.resolve();
    expect(repo.updates).toHaveLength(1);
    expect(repo.updates[0]).toMatchObject({ id: 'op-dan' });
  });

  it('refuses an absent token', async () => {
    const { source } = build({ tok_live_abc: { subject: 'dan@' } });
    await expectErrorCodeAsync(() => source.resolve(null), 'OPERATOR_CREDENTIAL_INVALID');
  });

  it('refuses an unknown token', async () => {
    const { source } = build({ tok_live_abc: { subject: 'dan@' } });
    await expectErrorCodeAsync(() => source.resolve('tok_live_xyz'), 'OPERATOR_CREDENTIAL_INVALID');
  });

  it('refuses every token when nothing is configured (missing OPERATOR_CREDENTIALS_FILE)', async () => {
    const { source } = build({});
    await expectErrorCodeAsync(() => source.resolve('tok_live_abc'), 'OPERATOR_CREDENTIAL_INVALID');
  });

  it('refuses a token whose subject was never provisioned in `operators`', async () => {
    const { source } = build({ tok_live_abc: { subject: 'ghost@' } });
    // No repo.seed() — the token is genuine but the table has no such subject.
    await expectErrorCodeAsync(() => source.resolve('tok_live_abc'), 'OPERATOR_CREDENTIAL_INVALID');
  });

  it('refuses a suspended operator despite a valid token', async () => {
    const { source, repo } = build({ tok_live_abc: { subject: 'dan@' } });
    repo.seed(
      buildOperator({
        id: 'op-dan',
        subject: 'dan@',
        status: 'SUSPENDED',
        suspendedAt: new Date('2026-08-20T00:00:00.000Z'),
      }),
    );

    await expectErrorCodeAsync(() => source.resolve('tok_live_abc'), 'OPERATOR_SUSPENDED');
  });

  it('distinguishes two tokens that share a prefix, in both directions', async () => {
    const { source, repo } = build({
      tok_common_1: { subject: 'short@' },
      tok_common_12: { subject: 'long@' },
    });
    repo.seed(buildOperator({ id: 'op-short', subject: 'short@' }));
    repo.seed(buildOperator({ id: 'op-long', subject: 'long@' }));

    const short = await source.resolve('tok_common_1');
    const long = await source.resolve('tok_common_12');

    expect(short.operatorId).toBe('op-short');
    expect(long.operatorId).toBe('op-long');
  });

  it('refuses a token that is a strict prefix of a valid one', async () => {
    const { source, repo } = build({ tok_common_12: { subject: 'long@' } });
    repo.seed(buildOperator({ id: 'op-long', subject: 'long@' }));

    await expectErrorCodeAsync(() => source.resolve('tok_common_1'), 'OPERATOR_CREDENTIAL_INVALID');
  });
});

/** 32 characters: the shortest plaintext token the loader accepts. */
const LONG_TOKEN = 'tok_live_0123456789abcdefghijklmn';

describe('loadOperatorCredentials', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'operator-credentials-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // `path` DEFAULTS to `process.env.OPERATOR_CREDENTIALS_FILE`, so passing
  // `undefined` explicitly does not bypass the environment — it selects it.
  // And `test/setup-env.ts` loads the real `.env`. So this case only ever
  // passed on a machine that happened not to configure an operator credential
  // file, and it went red the day one did. Control the variable instead.
  it('returns an empty snapshot when the env var is unset', () => {
    const saved = process.env.OPERATOR_CREDENTIALS_FILE;
    delete process.env.OPERATOR_CREDENTIALS_FILE;
    try {
      expect(loadOperatorCredentials()).toEqual({});
    } finally {
      if (saved !== undefined) process.env.OPERATOR_CREDENTIALS_FILE = saved;
    }
  });

  it('reads the env var when no path is passed', () => {
    const path = join(dir, 'from-env.json');
    writeFileSync(path, JSON.stringify({ [LONG_TOKEN]: { subject: 'env@' } }));

    const saved = process.env.OPERATOR_CREDENTIALS_FILE;
    process.env.OPERATOR_CREDENTIALS_FILE = path;
    try {
      expect(loadOperatorCredentials()).toEqual({ [LONG_TOKEN]: { subject: 'env@' } });
    } finally {
      if (saved === undefined) delete process.env.OPERATOR_CREDENTIALS_FILE;
      else process.env.OPERATOR_CREDENTIALS_FILE = saved;
    }
  });

  it('loads a valid token → { subject } map', () => {
    const path = join(dir, 'credentials.json');
    writeFileSync(path, JSON.stringify({ [LONG_TOKEN]: { subject: 'dan@' } }));

    expect(loadOperatorCredentials(path)).toEqual({ [LONG_TOKEN]: { subject: 'dan@' } });
  });

  it('throws at load when the file is not a JSON object (an array)', () => {
    const path = join(dir, 'credentials.json');
    writeFileSync(path, JSON.stringify(['not', 'an', 'object']));

    expect(() => loadOperatorCredentials(path)).toThrow();
  });

  it('throws at load when the file is not valid JSON at all', () => {
    const path = join(dir, 'credentials.json');
    writeFileSync(path, '{ not json');

    expect(() => loadOperatorCredentials(path)).toThrow();
  });

  it('never quotes the file in the error when the JSON is malformed', () => {
    const path = join(dir, 'credentials.json');
    // A token followed by a syntax error: Node's own message would quote it.
    writeFileSync(path, `{ "${LONG_TOKEN}": { "subject": "dan@" }, oops`);

    let message = '';
    try {
      loadOperatorCredentials(path);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('operator credentials file is not valid JSON');
  });

  it('refuses a plaintext token shorter than 32 characters, without printing it', () => {
    const path = join(dir, 'credentials.json');
    const short = 'tok_short_0123456789abcdefghijk'; // 31 characters
    writeFileSync(
      path,
      JSON.stringify({ [LONG_TOKEN]: { subject: 'a@' }, [short]: { subject: 'b@' } }),
    );

    let message = '';
    try {
      loadOperatorCredentials(path);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('entry 2');
    expect(message).toContain('shorter than 32 characters');
    expect(message).not.toContain(short);
    expect(message).not.toContain(LONG_TOKEN);
  });

  it('accepts a sha256: digest key and refuses a malformed one', () => {
    const path = join(dir, 'credentials.json');
    const digest = createHash('sha256').update(LONG_TOKEN).digest('hex');
    writeFileSync(path, JSON.stringify({ [`sha256:${digest}`]: { subject: 'dan@' } }));
    expect(loadOperatorCredentials(path)).toEqual({ [`sha256:${digest}`]: { subject: 'dan@' } });

    writeFileSync(path, JSON.stringify({ 'sha256:abc123': { subject: 'dan@' } }));
    expect(() => loadOperatorCredentials(path)).toThrow(/64 hex characters/);
  });
});

describe('ConfigOperatorSessionSource — digest keys', () => {
  it('authenticates the token behind a sha256: key, and not the digest itself', async () => {
    const digest = createHash('sha256').update(LONG_TOKEN).digest('hex');
    const repo = new FakeOperatorRepository();
    repo.seed(buildOperator({ id: 'op-dan', subject: 'dan@' }));
    const source = new ConfigOperatorSessionSource(
      { [`sha256:${digest.toUpperCase()}`]: { subject: 'dan@' } },
      repo as never,
    );

    await expect(source.resolve(LONG_TOKEN)).resolves.toMatchObject({ operatorId: 'op-dan' });
    await expectErrorCodeAsync(() => source.resolve(digest), 'OPERATOR_CREDENTIAL_INVALID');
    await expectErrorCodeAsync(
      () => source.resolve(`sha256:${digest}`),
      'OPERATOR_CREDENTIAL_INVALID',
    );
  });
});
