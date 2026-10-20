import {
  LastSeenKind,
  LastSeenRecorder,
  batchUpdate,
  credentialKey,
  isWellFormedKey,
} from '@shared/last-seen';
import { CredentialSessionResolver } from '@modules/auth/services/credential-session.resolver';

const ORG = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';

describe('last-seen batch writes', () => {
  it('writes every stamp of a kind in one UPDATE that never moves a column backwards', () => {
    const { sql, params } = batchUpdate(
      LastSeenKind.AGENT_LOGIN,
      new Map([
        [ID, Date.parse('2026-10-20T10:00:00.000Z')],
        [ORG, Date.parse('2026-10-20T10:00:01.000Z')],
      ]),
    );
    expect(sql).toBe(
      `UPDATE "agents" AS t SET "last_login_at" = GREATEST(COALESCE(t."last_login_at", '-infinity'::timestamptz), v.at) ` +
        `FROM unnest($1::uuid[], $2::timestamptz[]) AS v(id, at) WHERE t."id" = v.id`,
    );
    expect(params).toEqual([
      [ID, ORG],
      ['2026-10-20T10:00:00.000Z', '2026-10-20T10:00:01.000Z'],
    ]);
  });

  it('matches a credential on its organization and id', () => {
    const { sql, params } = batchUpdate(
      LastSeenKind.CREDENTIAL_USE,
      new Map([[credentialKey(ORG, ID), 0]]),
    );
    expect(sql).toContain('WHERE t."id" = v.id AND t."organization_id" = v.organization_id');
    expect(params[0]).toEqual([ORG]);
    expect(params[1]).toEqual([ID]);
  });

  it.each([
    [LastSeenKind.AGENT_LOGIN, ID, true],
    [LastSeenKind.AGENT_LOGIN, 'not-a-uuid', false],
    [LastSeenKind.AGENT_LOGIN, credentialKey(ORG, ID), false],
    [LastSeenKind.CREDENTIAL_USE, credentialKey(ORG, ID), true],
    [LastSeenKind.CREDENTIAL_USE, ID, false],
    [LastSeenKind.OPERATOR_SEEN, ID, true],
  ])('%s key %s is well formed: %s', (kind, key, expected) => {
    expect(isWellFormedKey(kind, key)).toBe(expected);
  });

  it('shows the later of the row and the buffered stamp', () => {
    const early = new Date('2026-10-20T10:00:00.000Z');
    const late = new Date('2026-10-20T10:00:05.000Z');
    expect(LastSeenRecorder.latest(early, late)).toBe(late);
    expect(LastSeenRecorder.latest(late, early)).toBe(late);
    expect(LastSeenRecorder.latest(null, late)).toBe(late);
    expect(LastSeenRecorder.latest(early, undefined)).toBe(early);
    expect(LastSeenRecorder.latest(null, undefined)).toBeNull();
  });
});

describe('CredentialSessionResolver.stampUse', () => {
  it('buffers the stamp instead of writing the row', () => {
    const update = jest.fn();
    const record = jest.fn();
    const resolver = new CredentialSessionResolver(
      { update } as never,
      {} as never,
      { record } as unknown as LastSeenRecorder,
    );

    resolver.stampUse({ organizationId: ORG, id: ID });

    expect(record).toHaveBeenCalledWith(LastSeenKind.CREDENTIAL_USE, credentialKey(ORG, ID));
    expect(update).not.toHaveBeenCalled();
  });
});
