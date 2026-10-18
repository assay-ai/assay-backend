import { Logger } from '@nestjs/common';

import { DataSource } from 'typeorm';

import { sweepRevokedCredentialTokens } from '@modules/oauth/services/oauth-grant.writer';

const CREDENTIAL_ID = '33333333-3333-4333-8333-333333333333';

/**
 * R-OA-23's post-commit sweep is best effort: every caller runs it after its
 * revocation committed, and the cleanup job is the backstop. A failure must
 * be logged and never thrown, or it would fail a committed operation and skip
 * the steps after it (review of Task 1.8, N1).
 */
function executor(query: jest.Mock): Pick<DataSource, 'query'> {
  return { query } as unknown as Pick<DataSource, 'query'>;
}

describe('sweepRevokedCredentialTokens', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('revokes the refresh tokens, then the access tokens, of a revoked credential', async () => {
    const query = jest.fn().mockResolvedValue([]);

    await expect(sweepRevokedCredentialTokens(executor(query), CREDENTIAL_ID)).resolves.toBe(true);

    expect(query.mock.calls.map(([sql]) => (sql as string).match(/UPDATE "(\w+)"/)?.[1])).toEqual([
      'oauth_refresh_tokens',
      'oauth_access_tokens',
    ]);
    for (const [sql, params] of query.mock.calls) {
      expect(sql).toMatch(/c\."revoked_at" IS NOT NULL AND t\."revoked_at" IS NULL/);
      expect(params).toEqual([CREDENTIAL_ID]);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['the refresh-token statement', 0],
    ['the access-token statement', 1],
  ])('a failure of %s is logged, never thrown', async (_label, failing) => {
    let call = 0;
    const query = jest.fn(async (): Promise<unknown[]> => {
      if (call++ === failing) throw new Error('deadlock detected');
      return [];
    });

    await expect(sweepRevokedCredentialTokens(executor(query), CREDENTIAL_ID)).resolves.toBe(false);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('post-commit token sweep failed');
    expect(warn.mock.calls[0][0]).toContain(CREDENTIAL_ID);
  });
});
