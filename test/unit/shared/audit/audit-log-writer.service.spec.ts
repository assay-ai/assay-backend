import { DataSource, EntityManager } from 'typeorm';

import { AuditLogEntryEntity } from '@database/postgres/entities/audit-log-entry.entity';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { AuditEntryInput, AuditLogWriter, auditActorOf, changedFields } from '@shared/audit';
import { RequestContext } from '@shared/observability';

const ORG = '11111111-1111-4111-8111-111111111111';

function entry(overrides: Partial<AuditEntryInput> = {}): AuditEntryInput {
  return {
    organizationId: ORG,
    actor: { type: 'user', id: 'login-1' },
    action: 'credential.revoked',
    resourceType: 'agent_credential',
    resourceId: 'cred-1',
    before: { revokedAt: null },
    after: { revokedAt: '2026-10-14T00:00:00.000Z' },
    ...overrides,
  };
}

function build(insert = jest.fn().mockResolvedValue(undefined)) {
  const ambient = { insert: jest.fn().mockResolvedValue(undefined) };
  const writer = new AuditLogWriter({ manager: ambient } as unknown as DataSource);
  const manager = { insert } as unknown as EntityManager;
  return { writer, manager, insert, ambient };
}

function session(callerKind: McpCallerKind): McpSession {
  return {
    credentialId: 'credential-1',
    organizationId: ORG,
    agentId: 'agent-1',
    callerKind,
  } as McpSession;
}

describe('AuditLogWriter.record', () => {
  it('appends one row through the given transaction manager', async () => {
    const { writer, manager, insert, ambient } = build();
    await writer.record(manager, entry());

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(AuditLogEntryEntity, {
      organizationId: ORG,
      actorType: 'user',
      actorId: 'login-1',
      action: 'credential.revoked',
      resourceType: 'agent_credential',
      resourceId: 'cred-1',
      before: { revokedAt: null },
      after: { revokedAt: '2026-10-14T00:00:00.000Z' },
      ipAddress: null,
      userAgent: null,
      requestId: null,
    });
    expect(ambient.insert).not.toHaveBeenCalled();
  });

  it('stamps the ambient request id', async () => {
    const { writer, manager, insert } = build();
    await RequestContext.run({ requestId: 'req-42', organizationId: ORG }, () =>
      writer.record(manager, entry()),
    );
    expect(insert.mock.calls[0][1]).toMatchObject({ requestId: 'req-42' });
  });

  it('stores null for an omitted before/after', async () => {
    const { writer, manager, insert } = build();
    await writer.record(manager, entry({ before: undefined, after: undefined }));
    expect(insert.mock.calls[0][1]).toMatchObject({ before: null, after: null });
  });

  it.each(['token', 'tokenHash', 'signature', 'clientSecret', 'password', 'privateKey'])(
    'refuses a %s key rather than storing a secret',
    async (key) => {
      const { writer, manager, insert } = build();
      await expect(writer.record(manager, entry({ after: { [key]: 'x' } }))).rejects.toThrow(
        /must not be recorded/,
      );
      await expect(writer.record(manager, entry({ before: { [key]: 'x' } }))).rejects.toThrow(
        /must not be recorded/,
      );
      expect(insert).not.toHaveBeenCalled();
    },
  );

  it('lets a failed insert propagate, so the surrounding transaction rolls back', async () => {
    const { writer, manager } = build(jest.fn().mockRejectedValue(new Error('db down')));
    await expect(writer.record(manager, entry())).rejects.toThrow('db down');
  });
});

describe('AuditLogWriter.recordAfterCommit', () => {
  it('writes on the data source itself', async () => {
    const { writer, ambient } = build();
    await writer.recordAfterCommit(entry());
    expect(ambient.insert).toHaveBeenCalledWith(
      AuditLogEntryEntity,
      expect.objectContaining({ organizationId: ORG, action: 'credential.revoked' }),
    );
  });

  it('never throws, and logs the lost entry at error', async () => {
    const { writer, ambient } = build();
    ambient.insert.mockRejectedValue(new Error('db down'));
    const error = jest.spyOn((writer as any).logger, 'error').mockImplementation(() => undefined);

    await expect(writer.recordAfterCommit(entry())).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/credential\.revoked.*NOT recorded/));
  });
});

describe('auditActorOf', () => {
  it('names an agent credential as the agent', () => {
    expect(auditActorOf(session(McpCallerKind.AGENT))).toEqual({ type: 'agent', id: 'agent-1' });
  });

  it.each([McpCallerKind.HUMAN, McpCallerKind.CONFIG])(
    'names a %s session as a user, by the credential it presented',
    (kind) => {
      expect(auditActorOf(session(kind))).toEqual({ type: 'user', id: 'credential-1' });
    },
  );
});

describe('changedFields', () => {
  it('keeps only the keys whose value changed', () => {
    expect(
      changedFields(
        { paused: false, dailyCap: '10', allowedTools: ['a'], monthlyCap: null },
        { paused: true, dailyCap: '10', allowedTools: ['a'], monthlyCap: null },
      ),
    ).toEqual({ before: { paused: false }, after: { paused: true } });
  });

  it('treats a cleared value as a change to null', () => {
    expect(changedFields({ dailyCap: '10' }, { dailyCap: null })).toEqual({
      before: { dailyCap: '10' },
      after: { dailyCap: null },
    });
  });
});
