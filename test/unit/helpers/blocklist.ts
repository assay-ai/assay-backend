import { randomUUID } from 'node:crypto';

import { BlockSubjectKind, subjectKey } from '@modules/blocklist/domain/account-block';
import {
  AccountBlocklistService,
  DEFAULT_ACCOUNT_BLOCKLIST_CONFIG,
} from '@modules/blocklist/services/account-blocklist.service';

export interface SeededBlock {
  readonly kind: BlockSubjectKind;
  readonly subject: string;
  readonly reasonCode?: string;
}

/**
 * A real `AccountBlocklistService` with no database and no Redis behind it.
 *
 * The matching under test is the real one — normalisation, the
 * chain-agnostic wallet key, the role order — and only the two boundaries are
 * stubbed. `applied` updates the in-memory maps before its first `await`, so
 * the blocks are in place when this returns.
 */
export function blocklistOf(...blocks: readonly SeededBlock[]): AccountBlocklistService {
  const redis = {
    publish: async () => 0,
    subscribe: async () => 1,
    unsubscribe: async () => 1,
    on: () => undefined,
    quit: async () => 'OK',
    disconnect: () => undefined,
  };
  const service = new AccountBlocklistService(
    { findActive: async () => [] } as never,
    redis as never,
    redis as never,
    DEFAULT_ACCOUNT_BLOCKLIST_CONFIG,
  );
  for (const block of blocks) addBlock(service, block);
  return service;
}

/** The blocklist with nothing on it — what every test that is not about blocking passes. */
export const noBlocks = (): AccountBlocklistService => blocklistOf();

/** Put one more block on a blocklist built by {@link blocklistOf}, synchronously. */
export function addBlock(service: AccountBlocklistService, block: SeededBlock): void {
  const key = subjectKey(block.kind, block.subject);
  if (key === null) throw new Error(`not a ${block.kind} subject: ${block.subject}`);
  void service.applied({
    kind: 'blocked',
    row: {
      id: randomUUID(),
      subjectKind: block.kind,
      subject: block.subject,
      subjectKey: key,
      reasonCode: block.reasonCode ?? 'TEST',
      blockedAt: new Date(),
    },
  });
}
