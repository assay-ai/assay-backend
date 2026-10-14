import { BlockSubjectKind } from '@modules/blocklist/domain/account-block';
import {
  AccountBlocklistService,
  DEFAULT_ACCOUNT_BLOCKLIST_CONFIG,
} from '@modules/blocklist/services/account-blocklist.service';

/**
 * Audit E-7 regression (the auditor's proof, inverted): on an instance that
 * did NOT write the block, two overlapping refreshes (the poll and the pub/sub
 * message) complete out of order. The older read must not overwrite the newer
 * one; `localWrites` only guards writes made by this process, so the refresh
 * generation does.
 */
describe('Audit E-7: overlapping refreshes on a non-writer instance', () => {
  it('a stale read that finishes last does not un-block the wallet', async () => {
    const WALLET = 'eip155:84532:0xa271a3407d3302f4b4fbe469b9188487cedd7d45';
    const blockedRow = {
      id: 'b1',
      subjectKind: BlockSubjectKind.WALLET,
      subject: WALLET,
      subjectKey: 'eip155:0xa271a3407d3302f4b4fbe469b9188487cedd7d45',
      reasonCode: 'LEAKED_KEY',
      blockedAt: new Date(),
    };
    const resolvers: ((rows: unknown[]) => void)[] = [];
    const repo = {
      findActive: () => new Promise<unknown[]>((resolve) => resolvers.push(resolve)),
    };
    const redis = { publish: async () => 0, disconnect: () => undefined };
    const service = new AccountBlocklistService(
      repo as never,
      redis as never,
      redis as never,
      DEFAULT_ACCOUNT_BLOCKLIST_CONFIG,
    );

    const poll = service.refresh(); // started before the other instance committed
    const onMessage = service.refresh(); // started after the announcement
    resolvers[1]([blockedRow]); // the fresh read lands first
    await onMessage;
    expect(service.walletBlock(WALLET)).not.toBeNull();

    resolvers[0]([]); // the stale read lands last
    await poll;
    expect(service.walletBlock(WALLET)).not.toBeNull(); // the older read is discarded
  });
});
