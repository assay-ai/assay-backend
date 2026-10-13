import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';

import {
  AccountBlockRepository,
  ActiveBlockRow,
} from '@database/postgres/repositories/account-block.repository';
import { AccountErrors } from '@modules/account/errors/account.errors';

import { BlockedRole, BlockHit, BlockSubjectKind, subjectKey } from '../domain/account-block';

export const ACCOUNT_BLOCKLIST_REDIS = 'ACCOUNT_BLOCKLIST_REDIS';
export const ACCOUNT_BLOCKLIST_SUBSCRIBER = 'ACCOUNT_BLOCKLIST_SUBSCRIBER';
export const ACCOUNT_BLOCKLIST_CONFIG = 'ACCOUNT_BLOCKLIST_CONFIG';

/** How long boot waits for the change subscription before serving on the poll alone. */
const SUBSCRIBE_WAIT_MS = 2_000;

export interface AccountBlocklistConfig {
  /** The pub/sub channel a write is announced on. */
  readonly channel: string;
  /** How often every process re-reads the table regardless of messages. */
  readonly pollIntervalMs: number;
}

export const DEFAULT_ACCOUNT_BLOCKLIST_CONFIG: AccountBlocklistConfig = Object.freeze({
  channel: 'account-blocklist:changed',
  pollIntervalMs: 5_000,
});

/** One party to a request, as an enforcement point names it. */
export interface BlockParty {
  readonly role: BlockedRole;
  readonly kind: BlockSubjectKind;
  /** An organization id or a CAIP-10 account. Null/undefined is skipped. */
  readonly subject: string | null | undefined;
}

export interface BlockedParty {
  readonly role: BlockedRole;
  readonly hit: BlockHit;
}

/** What a write tells this process, so it is current before the commit is announced. */
export type BlocklistChange =
  | { readonly kind: 'blocked'; readonly row: ActiveBlockRow }
  | { readonly kind: 'unblocked'; readonly subjectKind: string; readonly subjectKey: string };

/**
 * The blocklist, in memory, in every process.
 *
 * ## Why in memory
 *
 * The check runs on every authenticated request, every tool call, every
 * routing decision and every voucher redemption. A database read on each of
 * those would make the blocklist the hottest query in the system for a table
 * that holds a handful of rows and changes a few times a month. So every
 * process holds the active rows as two maps and answers synchronously.
 *
 * ## How a change reaches every instance
 *
 * Postgres (`account_blocks`) is the source of truth; this is a copy of it.
 * The copy is refreshed three ways, the same shape as the policy kill switch
 * (`RedisPolicyKillSwitchService`):
 *
 * 1. **The writer, at once.** `applied` is called by the operator service after
 *    its transaction commits: the change is applied to this process's maps
 *    synchronously, so the next request on the instance that wrote the block is
 *    refused — no window at all.
 * 2. **Every other instance, within milliseconds.** The writer publishes on
 *    `account-blocklist:changed`; each process re-reads the table on the
 *    message.
 * 3. **The guaranteed bound.** Every process re-reads the table every
 *    `ACCOUNT_BLOCKLIST_POLL_MS` (default 5s) whatever Redis does, so a lost
 *    message, a restarted subscriber or a Redis outage delays a block by at
 *    most one poll.
 *
 * The refresh is a full re-read, not a diff. The table is small, the read is a
 * covered partial index, and a full read cannot drift.
 *
 * ## When the database cannot be read
 *
 * The last copy that was read is kept and the failure is logged. That is
 * neither fail-open nor fail-closed on purpose: emptying the list on a database
 * blip would unblock every leaked key at once, and refusing everyone would turn
 * a database blip into a platform outage. A process that has never read the
 * table (it booted during the outage) starts empty and logs an error on every
 * failed poll until it succeeds.
 */
@Injectable()
export class AccountBlocklistService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AccountBlocklistService.name);

  private organizations: ReadonlyMap<string, BlockHit> = new Map();
  private wallets: ReadonlyMap<string, BlockHit> = new Map();
  private refreshedAt = 0;
  /** Bumped by every local write, so a refresh that started before it is not applied after it. */
  private localWrites = 0;
  private timer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(
    private readonly blocks: AccountBlockRepository,
    @Inject(ACCOUNT_BLOCKLIST_REDIS) private readonly redis: Redis,
    @Inject(ACCOUNT_BLOCKLIST_SUBSCRIBER) private readonly subscriber: Redis,
    @Inject(ACCOUNT_BLOCKLIST_CONFIG) private readonly config: AccountBlocklistConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Awaited: a process that serves before it has read the list would let a
    // blocked account through for its first few seconds.
    await this.refresh().catch((error: unknown) => {
      this.logger.error(`Blocklist could not be loaded at boot: ${describe(error)}`);
    });

    // Awaited for a bounded time: a process that is subscribed before it
    // serves hears the next block at once, but a Redis outage at boot must not
    // hold the process up — `subscribe` waits for a connection, and the poll
    // below is the guarantee either way.
    this.subscriber.on('message', (channel: string) => {
      if (channel !== this.config.channel) return;
      void this.refresh().catch((error: unknown) => {
        this.logger.warn(`Blocklist refresh on broadcast failed: ${describe(error)}`);
      });
    });
    const subscribed = this.subscriber.subscribe(this.config.channel).catch((error: unknown) => {
      this.logger.warn(`Blocklist could not subscribe to changes: ${describe(error)}`);
    });
    let bound: NodeJS.Timeout | undefined;
    await Promise.race([
      subscribed,
      new Promise<void>((resolve) => {
        bound = setTimeout(resolve, SUBSCRIBE_WAIT_MS);
        bound.unref?.();
      }),
    ]);
    clearTimeout(bound);

    this.timer = setInterval(() => {
      void this.refresh().catch((error: unknown) => {
        this.logger.error(`Blocklist poll failed: ${describe(error)}`);
      });
    }, this.config.pollIntervalMs);
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.subscriber.unsubscribe(this.config.channel).catch(() => undefined);
    // `disconnect`, not `quit`: nothing is waiting on a reply, and `quit` on a
    // client still trying to connect waits for a connection that may never come.
    this.subscriber.disconnect();
    this.redis.disconnect();
  }

  // ── Reads: synchronous, from memory ─────────────────────────────────────

  organizationBlock(organizationId: string | null | undefined): BlockHit | null {
    if (!organizationId) return null;
    const key = subjectKey(BlockSubjectKind.ORGANIZATION, organizationId);
    return key ? (this.organizations.get(key) ?? null) : null;
  }

  walletBlock(account: string | null | undefined): BlockHit | null {
    if (!account) return null;
    const key = subjectKey(BlockSubjectKind.WALLET, account);
    return key ? (this.wallets.get(key) ?? null) : null;
  }

  /** The first party that is blocked, in the order given, or null. */
  firstBlocked(parties: readonly BlockParty[]): BlockedParty | null {
    for (const party of parties) {
      const hit =
        party.kind === BlockSubjectKind.ORGANIZATION
          ? this.organizationBlock(party.subject)
          : this.walletBlock(party.subject);
      if (hit) return { role: party.role, hit };
    }
    return null;
  }

  /** Throws `ACCOUNT_BLOCKED` naming the role of the first blocked party. */
  assertNotBlocked(parties: readonly BlockParty[]): void {
    const blocked = this.firstBlocked(parties);
    if (blocked) {
      throw AccountErrors.accountBlocked({
        role: blocked.role,
        subjectKind: blocked.hit.subjectKind,
      });
    }
  }

  /** Every block standing, as this process last read it. */
  list(): readonly BlockHit[] {
    return [...this.organizations.values(), ...this.wallets.values()];
  }

  snapshotAgeMs(): number {
    return this.refreshedAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - this.refreshedAt;
  }

  // ── Writes: called by the operator service after its commit ─────────────

  /**
   * Make a committed change visible here at once, then tell every other
   * process. A publish failure is logged and not thrown: the change is already
   * durable, and the poll carries it everywhere within one interval.
   */
  async applied(change: BlocklistChange): Promise<void> {
    this.localWrites += 1;
    if (change.kind === 'blocked') {
      const hit = toHit(change.row);
      if (change.row.subjectKind === BlockSubjectKind.ORGANIZATION) {
        this.organizations = withEntry(this.organizations, change.row.subjectKey, hit);
      } else {
        this.wallets = withEntry(this.wallets, change.row.subjectKey, hit);
      }
    } else if (change.subjectKind === BlockSubjectKind.ORGANIZATION) {
      this.organizations = withoutEntry(this.organizations, change.subjectKey);
    } else {
      this.wallets = withoutEntry(this.wallets, change.subjectKey);
    }

    await this.redis.publish(this.config.channel, change.kind).catch((error: unknown) => {
      this.logger.warn(
        `Blocklist change could not be announced; other instances will see it on their next ` +
          `poll: ${describe(error)}`,
      );
    });
  }

  /**
   * Re-read the table and replace the copy.
   *
   * A local write that lands while the read is in flight would be overwritten
   * by a result that predates it, so the read is repeated until no write
   * overtook it.
   */
  async refresh(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const seen = this.localWrites;
      const rows = await this.blocks.findActive();
      if (this.localWrites !== seen) continue;

      const organizations = new Map<string, BlockHit>();
      const wallets = new Map<string, BlockHit>();
      for (const row of rows) {
        const target = row.subjectKind === BlockSubjectKind.ORGANIZATION ? organizations : wallets;
        target.set(row.subjectKey, toHit(row));
      }
      this.organizations = organizations;
      this.wallets = wallets;
      this.refreshedAt = Date.now();
      return;
    }
    // Three writes in a row overtook the read; the next poll or message will
    // settle it, and the local writes are already applied.
  }
}

function toHit(row: ActiveBlockRow): BlockHit {
  return {
    blockId: row.id,
    subjectKind: row.subjectKind as BlockSubjectKind,
    subject: row.subject,
    reasonCode: row.reasonCode,
    blockedAt: row.blockedAt,
  };
}

function withEntry(
  map: ReadonlyMap<string, BlockHit>,
  key: string,
  hit: BlockHit,
): ReadonlyMap<string, BlockHit> {
  const next = new Map(map);
  next.set(key, hit);
  return next;
}

function withoutEntry(
  map: ReadonlyMap<string, BlockHit>,
  key: string,
): ReadonlyMap<string, BlockHit> {
  const next = new Map(map);
  next.delete(key);
  return next;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
