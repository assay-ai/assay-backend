import { ActiveBlockRow } from '@database/postgres/repositories/account-block.repository';
import { AccountErrorCode } from '@modules/account/errors/account.errors';
import { BlockedRole, BlockSubjectKind, subjectKey } from '@modules/blocklist/domain/account-block';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';

const ORG = '08773f92-21cd-4e53-8348-d3ef1dcc8378';
const OTHER_ORG = 'b7c4e1a0-3f28-4d55-9c61-2a8e5f0d4b39';
const WALLET = 'eip155:84532:0xa271a3407d3302f4b4fbe469b9188487cedd7d45';
const CHANNEL = 'test-blocklist:changed';

function row(kind: BlockSubjectKind, subject: string, id = `block-${subject}`): ActiveBlockRow {
  return {
    id,
    subjectKind: kind,
    subject,
    subjectKey: subjectKey(kind, subject) as string,
    reasonCode: 'LEAKED_KEY',
    blockedAt: new Date('2026-10-14T00:00:00.000Z'),
  };
}

class FakeRedis {
  readonly published: [string, string][] = [];
  readonly listeners: ((channel: string, message: string) => void)[] = [];
  subscribed: string[] = [];
  publishFails = false;

  async publish(channel: string, message: string) {
    if (this.publishFails) throw new Error('redis down');
    this.published.push([channel, message]);
    return 1;
  }
  async subscribe(channel: string) {
    this.subscribed.push(channel);
    return 1;
  }
  async unsubscribe() {
    return 1;
  }
  on(_event: string, listener: (channel: string, message: string) => void) {
    this.listeners.push(listener);
  }
  disconnect() {}
  deliver(channel: string) {
    for (const listener of this.listeners) listener(channel, 'blocked');
  }
}

function build(rows: ActiveBlockRow[] = []) {
  const table = { rows, fails: false, reads: 0, beforeAnswer: null as null | (() => void) };
  const repository = {
    findActive: async () => {
      table.reads += 1;
      if (table.fails) throw new Error('database down');
      const answer = [...table.rows];
      table.beforeAnswer?.();
      return answer;
    },
  };
  const redis = new FakeRedis();
  const subscriber = new FakeRedis();
  const service = new AccountBlocklistService(
    repository as never,
    redis as never,
    subscriber as never,
    { channel: CHANNEL, pollIntervalMs: 60_000 },
  );
  return { service, table, redis, subscriber };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('AccountBlocklistService', () => {
  it('loads the active blocks at boot and answers from memory', async () => {
    const { service, table } = build([
      row(BlockSubjectKind.ORGANIZATION, ORG),
      row(BlockSubjectKind.WALLET, WALLET),
    ]);
    await service.onModuleInit();

    expect(service.organizationBlock(ORG)?.blockId).toBe(`block-${ORG}`);
    expect(service.organizationBlock(ORG.toUpperCase())).not.toBeNull();
    expect(service.organizationBlock(OTHER_ORG)).toBeNull();
    // Another chain of the namespace, checksummed: the same key.
    expect(
      service.walletBlock('eip155:8453:0xA271A3407D3302f4b4Fbe469b9188487cedd7d45'),
    ).not.toBeNull();
    expect(service.walletBlock(null)).toBeNull();
    expect(service.walletBlock('garbage')).toBeNull();
    expect(table.reads).toBe(1);

    await service.onModuleDestroy();
  });

  it('applies a local write at once, before any refresh, and announces it', async () => {
    const { service, table, redis } = build();
    await service.onModuleInit();
    const readsBefore = table.reads;

    const pending = service.applied({
      kind: 'blocked',
      row: row(BlockSubjectKind.ORGANIZATION, ORG),
    });
    // Synchronously visible: the next request on this instance is refused.
    expect(service.organizationBlock(ORG)).not.toBeNull();
    await pending;

    expect(redis.published).toEqual([[CHANNEL, 'blocked']]);
    expect(table.reads).toBe(readsBefore);

    await service.applied({
      kind: 'unblocked',
      subjectKind: BlockSubjectKind.ORGANIZATION,
      subjectKey: ORG,
    });
    expect(service.organizationBlock(ORG)).toBeNull();
    await service.onModuleDestroy();
  });

  it('keeps a committed write when Redis cannot announce it', async () => {
    const { service, redis } = build();
    redis.publishFails = true;

    await expect(
      service.applied({ kind: 'blocked', row: row(BlockSubjectKind.WALLET, WALLET) }),
    ).resolves.toBeUndefined();
    expect(service.walletBlock(WALLET)).not.toBeNull();
  });

  it('re-reads the table when another instance announces a change', async () => {
    const { service, table, subscriber } = build();
    await service.onModuleInit();
    expect(subscriber.subscribed).toEqual([CHANNEL]);
    expect(service.organizationBlock(ORG)).toBeNull();

    table.rows.push(row(BlockSubjectKind.ORGANIZATION, ORG));
    subscriber.deliver('some-other-channel');
    await flush();
    expect(service.organizationBlock(ORG)).toBeNull();

    subscriber.deliver(CHANNEL);
    await flush();
    expect(service.organizationBlock(ORG)).not.toBeNull();
    await service.onModuleDestroy();
  });

  it('polls on its own, so a lost message delays a block by one interval at most', async () => {
    jest.useFakeTimers();
    try {
      const { service, table } = build();
      await service.onModuleInit();
      table.rows.push(row(BlockSubjectKind.WALLET, WALLET));

      await jest.advanceTimersByTimeAsync(60_000);
      expect(service.walletBlock(WALLET)).not.toBeNull();
      await service.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the last copy when the database cannot be read', async () => {
    const { service, table } = build([row(BlockSubjectKind.ORGANIZATION, ORG)]);
    await service.refresh();
    table.fails = true;

    await expect(service.refresh()).rejects.toThrow('database down');
    expect(service.organizationBlock(ORG)).not.toBeNull();
  });

  it('boots, empty, when the database is down at boot', async () => {
    const { service, table } = build([row(BlockSubjectKind.ORGANIZATION, ORG)]);
    table.fails = true;

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(service.organizationBlock(ORG)).toBeNull();
    expect(service.snapshotAgeMs()).toBe(Number.POSITIVE_INFINITY);
    await service.onModuleDestroy();
  });

  it('does not let a read that started before a local write undo it', async () => {
    const { service, table } = build();
    // The read is answered (empty) after the block was applied locally; the
    // service must read again rather than install the stale answer.
    table.beforeAnswer = () => {
      table.beforeAnswer = null;
      void service.applied({ kind: 'blocked', row: row(BlockSubjectKind.ORGANIZATION, ORG) });
      table.rows.push(row(BlockSubjectKind.ORGANIZATION, ORG));
    };

    await service.refresh();

    expect(service.organizationBlock(ORG)).not.toBeNull();
    expect(table.reads).toBe(2);
  });

  describe('assertNotBlocked', () => {
    it('names the role of the first blocked party, never the reason', async () => {
      const { service } = build([row(BlockSubjectKind.WALLET, WALLET)]);
      await service.refresh();

      let thrown: unknown;
      try {
        service.assertNotBlocked([
          { role: BlockedRole.ORGANIZATION, kind: BlockSubjectKind.ORGANIZATION, subject: ORG },
          { role: BlockedRole.PAYEE, kind: BlockSubjectKind.WALLET, subject: WALLET },
        ]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({
        errorCode: AccountErrorCode.ACCOUNT_BLOCKED,
        statusCode: 403,
        context: { role: BlockedRole.PAYEE, subjectKind: BlockSubjectKind.WALLET },
      });
      expect(String((thrown as Error).message)).not.toContain('LEAKED_KEY');
    });

    it('skips absent parties and passes when nobody is blocked', async () => {
      const { service } = build([row(BlockSubjectKind.ORGANIZATION, OTHER_ORG)]);
      await service.refresh();

      expect(() =>
        service.assertNotBlocked([
          { role: BlockedRole.ORGANIZATION, kind: BlockSubjectKind.ORGANIZATION, subject: ORG },
          { role: BlockedRole.DELEGATE, kind: BlockSubjectKind.WALLET, subject: null },
          { role: BlockedRole.PAYEE, kind: BlockSubjectKind.WALLET, subject: undefined },
        ]),
      ).not.toThrow();
    });
  });
});
