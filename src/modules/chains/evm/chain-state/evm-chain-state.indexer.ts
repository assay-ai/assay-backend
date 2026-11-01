import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { getAddress } from 'viem';

import {
  BlockedSetRow,
  EvmChainStateRepository,
} from '@database/postgres/repositories/evm-chain-state.repository';
import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';

import { ENABLED_CHAINS } from '../../enabled-chains';
import { ChainId, ChainNamespace, namespaceOf } from '../../ports/caip.types';
import {
  ASSAY_CONFIG_ABI,
  ASSAY_CONFIG_EVENTS_ABI,
  ASSAY_PROXY_EVENTS_ABI,
} from '../abi/assay.abi';
import { readConfigTerms } from '../evm-config-terms';
import { EVM_DEPLOYMENTS, EVM_RPC_CLIENTS, EvmDeployment } from '../evm.constants';
import { EvmChainStateService } from './evm-chain-state.service';

/** Every minute: a pause or a block reaches the cache within about one tick. */
export const EVM_CHAIN_STATE_CRON = '0 * * * * *';
/** Most blocks one tick reads per chain; a backlog is caught up over later ticks. */
export const EVM_CHAIN_STATE_MAX_BLOCKS = 10_000n;
/** Blocks per `eth_getLogs` call. */
export const EVM_CHAIN_STATE_CHUNK = 2_000n;
/**
 * An event whose block is older than this, by the chain head's own clock,
 * when a FRESH index (one that never caught up) first reads it is history,
 * not a key being used now: its alert is recorded at INFO instead of paging
 * (BUG-R2-OPS-02). One summary WARN still names every such event (see
 * {@link EVM_CHAIN_STATE_ALERTS.HISTORY_REPLAYED}).
 */
export const EVM_CHAIN_STATE_HISTORY_AGE_MS = 60 * 60 * 1000;
/**
 * While a fresh index is still catching up, the history summary WARN is sent
 * every this many passes (ticks) that downgraded an event, not only at the
 * end, so a catch-up that never finishes still pages.
 */
export const EVM_CHAIN_STATE_HISTORY_SUMMARY_PASSES = 10;
/** Default `EVM_CHAIN_STATE_CONFIRMATIONS`: blocks behind the head the index stops at. */
export const DEFAULT_EVM_CHAIN_STATE_CONFIRMATIONS = 12;

export const EVM_CHAIN_STATE_ALERTS = {
  LAGGING: 'evm_chain_state_lagging',
  CONFIG_LEVER: 'evm_config_lever_pulled',
  PROXY_UPGRADED: 'evm_proxy_upgraded',
  PAUSE_TOGGLED: 'evm_config_pause_toggled',
  ADMIN_UNBLOCK: 'evm_admin_unblocked_address',
  ARBITER_BLOCK: 'evm_arbiter_blocked_address',
  UNKNOWN_START: 'evm_chain_state_unknown_start',
  DRIFT: 'evm_chain_state_drift',
  /** One WARN naming the events a fresh index recorded as history (INFO). */
  HISTORY_REPLAYED: 'evm_chain_state_history_replayed',
} as const;

export interface EvmChainStateIndexerConfig {
  /** `EVM_CHAIN_STATE_RECONCILE_MS` (default 5 min): the full `paused()` / `blocked()` re-read. */
  readonly reconcileMs: number;
  /** `EVM_CHAIN_STATE_MAX_LAG_MS` (default 5 min): behind by more, and the log and health warn. */
  readonly maxLagMs: number;
  /**
   * `EVM_CHAIN_STATE_FROM_BLOCK`, per chain: where a chain with no cursor
   * starts. Absent: the deployment's recorded `disputeUpgradeBlock` (no
   * `BlockedSet` can predate it). Neither: the indexer reads `blocked()` live
   * for every address the platform knows on that chain, starts at the safe
   * head and warns (audit E-11: a fixed lookback lost older events for good).
   */
  readonly fromBlock: ReadonlyMap<ChainId, bigint>;
  /**
   * `EVM_CHAIN_STATE_CONFIRMATIONS` (default 12): the index stops this many
   * blocks behind the head, so an event in a block that is reorged out is
   * never written, and one reorged in below the cursor is not skipped.
   */
  readonly confirmations?: number;
  readonly now: () => number;
}

export const EVM_CHAIN_STATE_INDEXER_CONFIG = 'EVM_CHAIN_STATE_INDEXER_CONFIG';

export interface EvmConfigEventLog {
  readonly eventName?: string;
  /** The emitting contract (a proxy, for `Upgraded`). */
  readonly address?: `0x${string}`;
  readonly args: Record<string, unknown>;
  readonly blockNumber: bigint | null;
  readonly logIndex: number | null;
  readonly transactionHash: `0x${string}` | null;
}

export interface EvmChainStateIndexerClient {
  getBlockNumber(args?: { cacheTime?: number }): Promise<bigint>;
  getContractEvents(args: {
    address: `0x${string}` | readonly `0x${string}`[];
    abi: typeof ASSAY_CONFIG_EVENTS_ABI | typeof ASSAY_PROXY_EVENTS_ABI;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<readonly EvmConfigEventLog[]>;
  readContract(args: {
    address: `0x${string}`;
    abi: unknown;
    functionName: string;
    args: readonly unknown[];
  }): Promise<unknown>;
  /** The block's timestamp (seconds), to tell a fresh index's history from a new event. */
  getBlock?(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
}

/** Whether an event's alert is history (INFO) rather than news (its usual severity). */
type HistoryCheck = (log: EvmConfigEventLog) => Promise<boolean>;

/** Per event name: the events a fresh index recorded as history. */
interface HistoryEntry {
  count: number;
  newestBlock: bigint;
  newestTimeMs: number;
}

/** What a fresh index has downgraded and not yet summarised, per chain. */
interface HistoryTally {
  passes: number;
  fromBlock: bigint | null;
  toBlock: bigint | null;
  events: Map<string, HistoryEntry>;
}

/**
 * Indexes `AssayConfig`'s pause and blocklist into Postgres, with a cursor per
 * chain kept in the same transaction as the events it covers (the H-1
 * watcher's shape, with the cursor durable rather than in Redis — a lost
 * blocklist event is not recoverable by re-reading a recent window).
 *
 * - **Every tick:** `PauseToggled` and `BlockedSet` since the cursor, into
 *   `evm_chain_states` / `evm_blocked_addresses`.
 * - **Every `reconcileMs`:** `paused()`, the dispute terms and `blocked()` of
 *   every address ever named, read live; a disagreement is corrected and
 *   logged — the events are the fast path, this is the bound.
 * - **The levers a stolen key pulls** (contract security review, audit E-6):
 *   `AdminSet`, `ConfigUpdated` (treasury, bps, caps), `VerifierRevokedEvent`,
 *   `ArbiterSet`, `SlashDelaySet`, `CollectHoldSet`, `VerifierRegistered` and an ERC-1967
 *   `Upgraded` on any of the three proxies are CRITICAL alerts;
 *   `PauseToggled`, an unblock (`BlockedSet` false — the admin's door) and a
 *   block sent by the arbiter are WARNs.
 * - **Params:** `ConfigUpdated`, `SlashDelaySet`, `CollectHoldSet` and
 *   `ArbiterSet` stamp `params_changed_at`, so every process re-reads the
 *   on-chain params within one poll (`EvmChainStateService`).
 * - **Confirmations:** events are read only up to `head − confirmations`.
 * - **Lag:** `now − caught_up_at`. Past `maxLagMs` it is a WARN in the log and
 *   an alert, and `GET /operator/health` reports it (`chainState`).
 *
 * Read-only on chain. A cache: the contracts stay the enforcer.
 */
@Injectable()
export class EvmChainStateIndexer {
  private readonly logger = new Logger(EvmChainStateIndexer.name);
  /**
   * In memory: a restart mid catch-up loses the not-yet-summarised part
   * (at most {@link EVM_CHAIN_STATE_HISTORY_SUMMARY_PASSES} passes). Those
   * events are still in the log and the alert sinks at INFO.
   */
  private readonly history = new Map<ChainId, HistoryTally>();

  constructor(
    @Inject(EVM_RPC_CLIENTS)
    private readonly clients: ReadonlyMap<ChainId, EvmChainStateIndexerClient>,
    @Inject(EVM_DEPLOYMENTS) private readonly deployments: ReadonlyMap<ChainId, EvmDeployment>,
    @Inject(ENABLED_CHAINS) private readonly enabled: readonly ChainId[],
    private readonly repository: EvmChainStateRepository,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    @Inject(EVM_CHAIN_STATE_INDEXER_CONFIG) private readonly config: EvmChainStateIndexerConfig,
    // The scheduler's own copy of the cache, refreshed at once after a write.
    @Optional() private readonly cache: EvmChainStateService | null = null,
  ) {}

  @Cron(EVM_CHAIN_STATE_CRON)
  async handleTick(): Promise<void> {
    try {
      await this.tick();
    } catch (error) {
      this.logger.error(`EVM chain-state index threw: ${describe(error)}`);
    }
  }

  async tick(): Promise<void> {
    for (const chainId of this.enabled) {
      if (namespaceOf(chainId) !== ChainNamespace.EIP155) continue;
      const deployment = this.deployments.get(chainId);
      const client = this.clients.get(chainId);
      if (!deployment || !client) continue;
      try {
        await this.indexChain(chainId, deployment, client);
      } catch (error) {
        // The node's message stays in this log line, never in an alert or a
        // row: an RPC URL can carry an API key.
        this.logger.error(`EVM chain-state index on ${chainId} failed: ${describe(error)}`);
        await this.repository
          .recordError(chainId, 'the chain could not be read')
          .catch(() => undefined);
      }
      try {
        await this.reconcileIfDue(chainId, deployment, client);
      } catch (error) {
        this.logger.error(`EVM chain-state reconcile on ${chainId} failed: ${describe(error)}`);
      }
      await this.reportLag(chainId);
    }
    await this.cache?.refresh().catch(() => undefined);
  }

  private async indexChain(
    chainId: ChainId,
    deployment: EvmDeployment,
    client: EvmChainStateIndexerClient,
  ): Promise<void> {
    const head = await client.getBlockNumber({ cacheTime: 0 });
    const confirmations = BigInt(
      this.config.confirmations ?? DEFAULT_EVM_CHAIN_STATE_CONFIRMATIONS,
    );
    const safeHead = head > confirmations ? head - confirmations : 0n;
    const state = await this.repository.findState(chainId);
    const now = new Date(this.config.now());
    const fresh = !state?.caughtUpAt;
    // Pass-local: merged into the tally only once the range is written, so a
    // pass that fails and is read again is not counted twice.
    const pass = new Map<string, HistoryEntry>();
    const historical = await this.historyCheck(client, fresh, head, pass);
    let start: bigint;
    if (state?.cursorBlock !== null && state?.cursorBlock !== undefined) {
      start = BigInt(state.cursorBlock) + 1n;
    } else {
      const known = this.config.fromBlock.get(chainId) ?? deployment.disputeUpgradeBlock;
      start = known ?? (await this.seedFromKnownAccounts(chainId, deployment, client, safeHead));
    }
    if (start > safeHead) {
      await this.repository.applyIndexedRange({
        chainId,
        cursorBlock: start - 1n,
        headBlock: head,
        caughtUp: true,
        now,
        blocked: [],
      });
      if (fresh) await this.tallyHistory(chainId, pass, null, null, true);
      return;
    }
    const end =
      safeHead - start + 1n > EVM_CHAIN_STATE_MAX_BLOCKS
        ? start + EVM_CHAIN_STATE_MAX_BLOCKS - 1n
        : safeHead;

    const logs: EvmConfigEventLog[] = [];
    for (let from = start; from <= end; from += EVM_CHAIN_STATE_CHUNK) {
      const to = from + EVM_CHAIN_STATE_CHUNK - 1n < end ? from + EVM_CHAIN_STATE_CHUNK - 1n : end;
      logs.push(
        ...(await client.getContractEvents({
          address: deployment.config,
          abi: ASSAY_CONFIG_EVENTS_ABI,
          fromBlock: from,
          toBlock: to,
        })),
      );
      for (const log of await client.getContractEvents({
        address: [deployment.config, deployment.stake, deployment.escrow],
        abi: ASSAY_PROXY_EVENTS_ABI,
        fromBlock: from,
        toBlock: to,
      })) {
        await this.alertUpgraded(chainId, log, await historical(log));
      }
    }
    logs.sort(
      (left, right) =>
        Number((left.blockNumber ?? 0n) - (right.blockNumber ?? 0n)) ||
        (left.logIndex ?? 0) - (right.logIndex ?? 0),
    );

    let paused: boolean | undefined;
    let arbiter: string | null | undefined;
    let slashDelaySeconds: number | undefined;
    let paramsChanged = false;
    let knownArbiter = state?.arbiter ?? null;
    if (knownArbiter === null && logs.some((log) => log.eventName === 'BlockedSet')) {
      // Before the first reconcile the arbiter is not cached yet: read it, so
      // an arbiter block is not silent (audit E-6).
      knownArbiter = await (
        client.readContract({
          address: deployment.config,
          abi: ASSAY_CONFIG_ABI,
          functionName: 'arbiter',
          args: [],
        }) as Promise<string>
      )
        .then((value) => lower(value))
        .catch(() => null);
    }
    const blocked: BlockedSetRow[] = [];
    for (const log of logs) {
      switch (log.eventName) {
        case 'PauseToggled':
          paused = Boolean(log.args.paused);
          await this.alertWarn(
            chainId,
            log,
            await historical(log),
            EVM_CHAIN_STATE_ALERTS.PAUSE_TOGGLED,
            `AssayConfig on ${chainId} was ${paused ? 'PAUSED' : 'unpaused'} by ` +
              `${String(log.args.admin)}: confirm it was intended`,
          );
          break;
        case 'BlockedSet': {
          const by = lower(log.args.by);
          blocked.push({
            address: lower(log.args.account) ?? '',
            blocked: Boolean(log.args.blocked),
            setBy: by,
            blockNumber: log.blockNumber,
            logIndex: log.logIndex,
            transactionHash: log.transactionHash,
          });
          if (!log.args.blocked) {
            // Only the admin can unblock: the dangerous direction.
            await this.alertWarn(
              chainId,
              log,
              await historical(log),
              EVM_CHAIN_STATE_ALERTS.ADMIN_UNBLOCK,
              `${String(log.args.account)} was UNBLOCKED on chain on ${chainId} by ` +
                `${String(log.args.by)}: confirm the unblock was intended`,
            );
          } else if (by && knownArbiter && by === knownArbiter) {
            await this.alertArbiterBlock(chainId, log, await historical(log));
          }
          break;
        }
        case 'ArbiterSet':
          arbiter = lower(log.args.newArbiter);
          if (arbiter && BigInt(arbiter) === 0n) arbiter = null;
          knownArbiter = arbiter;
          paramsChanged = true;
          await this.alertLever(chainId, log, await historical(log));
          break;
        case 'SlashDelaySet':
          slashDelaySeconds = Number(log.args.newDelay);
          paramsChanged = true;
          await this.alertLever(chainId, log, await historical(log));
          break;
        case 'ConfigUpdated':
        case 'CollectHoldSet':
          // Every process re-reads the on-chain params when it sees the stamp.
          paramsChanged = true;
          await this.alertLever(chainId, log, await historical(log));
          break;
        case 'VerifierRegistered':
        case 'AdminSet':
        case 'VerifierRevokedEvent':
          await this.alertLever(chainId, log, await historical(log));
          break;
        default:
          break;
      }
    }

    await this.repository.applyIndexedRange({
      chainId,
      cursorBlock: end,
      headBlock: head,
      // The index stops `confirmations` behind the head, so reaching the safe
      // head is caught up; `end === head` never held with confirmations on.
      caughtUp: end === safeHead,
      now,
      ...(paused !== undefined ? { paused } : {}),
      ...(arbiter !== undefined ? { arbiter } : {}),
      ...(slashDelaySeconds !== undefined && Number.isFinite(slashDelaySeconds)
        ? { slashDelaySeconds }
        : {}),
      ...(paramsChanged ? { paramsChanged } : {}),
      blocked: blocked.filter((row) => row.address !== ''),
    });
    if (fresh) await this.tallyHistory(chainId, pass, start, end, end === safeHead);
  }

  /**
   * Adds one written pass of a fresh index to the chain's history tally, and
   * sends the summary WARN when the first catch-up completes, or every
   * {@link EVM_CHAIN_STATE_HISTORY_SUMMARY_PASSES} passes while it is still
   * catching up. Telegram pages WARN+, so a lever pulled between the deploy
   * and the first index is seen by a human even though each event was INFO.
   */
  private async tallyHistory(
    chainId: ChainId,
    pass: ReadonlyMap<string, HistoryEntry>,
    from: bigint | null,
    to: bigint | null,
    caughtUp: boolean,
  ): Promise<void> {
    let tally = this.history.get(chainId);
    if (!tally) {
      tally = { passes: 0, fromBlock: null, toBlock: null, events: new Map() };
      this.history.set(chainId, tally);
    }
    tally.passes += 1;
    if (from !== null && (tally.fromBlock === null || from < tally.fromBlock)) {
      tally.fromBlock = from;
    }
    if (to !== null && (tally.toBlock === null || to > tally.toBlock)) tally.toBlock = to;
    for (const [name, entry] of pass) mergeHistory(tally.events, name, entry);
    const due = caughtUp || tally.passes % EVM_CHAIN_STATE_HISTORY_SUMMARY_PASSES === 0;
    if (!due) return;
    if (tally.events.size > 0) {
      await this.alertHistory(chainId, tally, caughtUp);
      tally.events = new Map();
      tally.fromBlock = null;
      tally.toBlock = null;
    }
    if (caughtUp) this.history.delete(chainId);
  }

  private async alertHistory(
    chainId: ChainId,
    tally: HistoryTally,
    caughtUp: boolean,
  ): Promise<void> {
    const entries = [...tally.events].sort(([left], [right]) => left.localeCompare(right));
    const total = entries.reduce((sum, [, entry]) => sum + entry.count, 0);
    const list = entries
      .map(
        ([name, entry]) =>
          `${name} x${entry.count} (newest block ${entry.newestBlock}, ` +
          `${new Date(entry.newestTimeMs).toISOString()})`,
      )
      .join('; ');
    const range =
      tally.fromBlock !== null && tally.toBlock !== null
        ? ` in blocks ${tally.fromBlock}..${tally.toBlock}`
        : '';
    const stage = caughtUp
      ? 'finished its first catch-up and'
      : `is still catching up after ${tally.passes} passes and so far`;
    this.logger.warn(
      `EVM chain-state index on ${chainId} ${stage} recorded ${total} event(s) as history: ${list}`,
    );
    const details: Record<string, string | number> = {
      chainId,
      events: total,
      passes: tally.passes,
      caughtUp: String(caughtUp),
      fromBlock: tally.fromBlock?.toString() ?? '(unknown)',
      toBlock: tally.toBlock?.toString() ?? '(unknown)',
    };
    for (const [name, entry] of entries) {
      details[`${name}.count`] = entry.count;
      details[`${name}.newestBlock`] = entry.newestBlock.toString();
      details[`${name}.newestTime`] = new Date(entry.newestTimeMs).toISOString();
    }
    await this.alerts.emit({
      severity: AlertSeverity.WARN,
      name: EVM_CHAIN_STATE_ALERTS.HISTORY_REPLAYED,
      summary:
        `A fresh EVM chain-state index on ${chainId} ${stage} recorded ${total} governance ` +
        `event(s)${range} as history (INFO, older than 1 hour by chain time): ${list}. Confirm ` +
        `each one was intended (runbook)`,
      details,
      aggregation: AlertAggregation.ONCE_PER_INCIDENT,
      dedupeKey: `${chainId}:history:${details.fromBlock}-${details.toBlock}:${tally.passes}`,
    });
  }

  /**
   * A chain with no cursor and no known start block (audit E-11): no lookback
   * is long enough to be sure of every `BlockedSet`, so `blocked()` is read
   * live for every address the platform knows on this chain, the blocked ones
   * are written as corrections, and the index starts at the safe head. Warns:
   * an address the platform has never seen is only learned from a later event.
   * Returns the start block.
   */
  private async seedFromKnownAccounts(
    chainId: ChainId,
    deployment: EvmDeployment,
    client: EvmChainStateIndexerClient,
    safeHead: bigint,
  ): Promise<bigint> {
    const addresses = await this.repository.findKnownChainAccounts(chainId);
    const blocked: BlockedSetRow[] = [];
    for (const address of addresses) {
      const live = Boolean(
        await client.readContract({
          address: deployment.config,
          abi: ASSAY_CONFIG_ABI,
          functionName: 'blocked',
          args: [getAddress(address)],
        }),
      );
      if (live) {
        blocked.push({
          address,
          blocked: true,
          setBy: null,
          blockNumber: null,
          logIndex: null,
          transactionHash: null,
        });
      }
    }
    await this.repository.applyCorrections(chainId, blocked);
    this.logger.warn(
      `EVM chain-state index on ${chainId} has no cursor, no EVM_CHAIN_STATE_FROM_BLOCK and no ` +
        `recorded upgrade block: read blocked() for ${addresses.length} known address(es) ` +
        `(${blocked.length} blocked) and starting at block ${safeHead + 1n}. Set ` +
        `EVM_CHAIN_STATE_FROM_BLOCK to the dispute upgrade's block to index every BlockedSet.`,
    );
    await this.alerts.emit({
      severity: AlertSeverity.WARN,
      name: EVM_CHAIN_STATE_ALERTS.UNKNOWN_START,
      summary:
        `The EVM chain-state index on ${chainId} started without a known start block; the ` +
        `blocklist was seeded from a live read of ${addresses.length} known address(es)`,
      details: { chainId, known: addresses.length, blocked: blocked.length },
      aggregation: AlertAggregation.ONCE_PER_INCIDENT,
      dedupeKey: chainId,
    });
    return safeHead + 1n;
  }

  /** The bound behind the events: a full live read every `reconcileMs`. */
  private async reconcileIfDue(
    chainId: ChainId,
    deployment: EvmDeployment,
    client: EvmChainStateIndexerClient,
  ): Promise<void> {
    const state = await this.repository.findState(chainId);
    const nowMs = this.config.now();
    if (state?.reconciledAt && nowMs - state.reconciledAt.getTime() < this.config.reconcileMs) {
      return;
    }
    const terms = await readConfigTerms(client, deployment.config);
    const corrections: BlockedSetRow[] = [];
    for (const row of await this.repository.findKnownAddresses(chainId)) {
      const live = Boolean(
        await client.readContract({
          address: deployment.config,
          abi: ASSAY_CONFIG_ABI,
          functionName: 'blocked',
          args: [getAddress(row.address)],
        }),
      );
      if (live !== row.blocked) {
        corrections.push({
          address: row.address,
          blocked: live,
          setBy: null,
          blockNumber: null,
          logIndex: null,
          transactionHash: null,
        });
      }
    }
    if ((state && state.paused !== terms.paused) || corrections.length > 0) {
      this.logger.warn(
        `EVM chain state on ${chainId} drifted from the chain and was corrected: ` +
          `paused ${state?.paused}→${terms.paused}, ${corrections.length} blocklist correction(s)`,
      );
      await this.alerts.emit({
        severity: AlertSeverity.WARN,
        name: EVM_CHAIN_STATE_ALERTS.DRIFT,
        summary: `The indexed pause/blocklist on ${chainId} disagreed with the chain and was corrected`,
        details: { chainId, paused: String(terms.paused), corrections: corrections.length },
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: chainId,
      });
    }
    await this.repository.applyReconcile(
      chainId,
      {
        paused: terms.paused,
        arbiter: terms.arbiter?.toLowerCase() ?? null,
        slashDelaySeconds: terms.slashDelaySeconds,
      },
      corrections,
      new Date(nowMs),
    );
  }

  private async reportLag(chainId: ChainId): Promise<void> {
    const state = await this.repository.findState(chainId).catch(() => null);
    const lagMs = chainStateLagMs(state?.caughtUpAt ?? null, this.config.now());
    if (lagMs !== null && lagMs <= this.config.maxLagMs) return;
    const behind =
      lagMs === null ? 'has never caught up' : `is ${Math.round(lagMs / 1000)}s behind`;
    this.logger.warn(
      `EVM chain-state index on ${chainId} ${behind}; pause and blocklist refusals may be stale ` +
        `(the contracts still enforce)`,
    );
    await this.alerts.emit({
      severity: AlertSeverity.WARN,
      name: EVM_CHAIN_STATE_ALERTS.LAGGING,
      summary: `The EVM chain-state index on ${chainId} ${behind}`,
      details: { chainId, lagSeconds: lagMs === null ? -1 : Math.round(lagMs / 1000) },
      aggregation: AlertAggregation.ONCE_PER_INCIDENT,
      dedupeKey: chainId,
    });
  }

  /**
   * The history rule (BUG-R2-OPS-02): only while the index has NEVER caught up
   * (the first catch-up of a fresh index, e.g. from the deploy block), an
   * event whose block is older than {@link EVM_CHAIN_STATE_HISTORY_AGE_MS}
   * than the chain head read in the same pass is history. Chain time, not the
   * server clock, so a server clock that runs fast cannot quieten a new event.
   * A warm index, an event with no block, or a head or block whose time cannot
   * be read keeps the usual severity: a real lever never goes quiet because
   * the indexer was behind or the RPC failed. Every downgraded event is put in
   * `pass`, for the summary WARN. One block read per block, per tick.
   */
  private async historyCheck(
    client: EvmChainStateIndexerClient,
    fresh: boolean,
    head: bigint,
    pass: Map<string, HistoryEntry>,
  ): Promise<HistoryCheck> {
    if (!fresh || typeof client.getBlock !== 'function') return async () => false;
    const times = new Map<bigint, Promise<number | null>>();
    const timeOf = (blockNumber: bigint): Promise<number | null> => {
      let time = times.get(blockNumber);
      if (!time) {
        time = Promise.resolve()
          .then(() => client.getBlock!({ blockNumber }))
          .then((block) => Number(block.timestamp) * 1000)
          .then((ms) => (Number.isFinite(ms) ? ms : null))
          .catch(() => null);
        times.set(blockNumber, time);
      }
      return time;
    };
    const headMs = await timeOf(head);
    if (headMs === null) return async () => false;
    return async (log) => {
      if (log.blockNumber === null || log.blockNumber === undefined) return false;
      const atMs = await timeOf(log.blockNumber);
      if (atMs === null || headMs - atMs <= EVM_CHAIN_STATE_HISTORY_AGE_MS) return false;
      mergeHistory(pass, log.eventName ?? 'unknown', {
        count: 1,
        newestBlock: log.blockNumber,
        newestTimeMs: atMs,
      });
      return true;
    };
  }

  /** INFO, and a history note in the summary, for an event a fresh index replays. */
  private severityOf(usual: AlertSeverity, historical: boolean): AlertSeverity {
    return historical ? AlertSeverity.INFO : usual;
  }

  private historyNote(historical: boolean): string {
    return historical
      ? ' (history: first read by a fresh chain-state index, more than 1 hour after its block ' +
          'by chain time; a summary WARN follows)'
      : '';
  }

  private async alertLever(
    chainId: ChainId,
    log: EvmConfigEventLog,
    historical = false,
  ): Promise<void> {
    await this.alerts.emit({
      severity: this.severityOf(AlertSeverity.CRITICAL, historical),
      name: EVM_CHAIN_STATE_ALERTS.CONFIG_LEVER,
      summary:
        `AssayConfig on ${chainId} emitted ${log.eventName}. This is a lever a stolen admin key ` +
        `pulls (admin, treasury, bps, caps, arbiter, slash delay, collect hold, verifier ` +
        `registry): confirm it was intended${this.historyNote(historical)}`,
      details: { chainId, event: log.eventName, ...historyDetail(historical), ...stringArgs(log) },
      aggregation: AlertAggregation.ONCE_PER_INCIDENT,
      dedupeKey: `${chainId}:${log.transactionHash}:${log.logIndex}`,
    });
  }

  private async alertUpgraded(
    chainId: ChainId,
    log: EvmConfigEventLog,
    historical = false,
  ): Promise<void> {
    await this.alerts.emit({
      severity: this.severityOf(AlertSeverity.CRITICAL, historical),
      name: EVM_CHAIN_STATE_ALERTS.PROXY_UPGRADED,
      summary:
        `A settlement proxy on ${chainId} (${String(log.address ?? 'unknown')}) was upgraded to ` +
        `${String(log.args.implementation)}. Only the owner key can do this: confirm it was ` +
        `intended, and record the implementation${this.historyNote(historical)}`,
      details: {
        chainId,
        proxy: String(log.address ?? 'unknown'),
        ...historyDetail(historical),
        ...stringArgs(log),
      },
      aggregation: AlertAggregation.ONCE_PER_INCIDENT,
      dedupeKey: `${chainId}:${log.transactionHash}:${log.logIndex}`,
    });
  }

  private async alertWarn(
    chainId: ChainId,
    log: EvmConfigEventLog,
    historical: boolean,
    name: string,
    summary: string,
  ): Promise<void> {
    await this.alerts.emit({
      severity: this.severityOf(AlertSeverity.WARN, historical),
      name,
      summary: `${summary}${this.historyNote(historical)}`,
      details: {
        chainId,
        event: log.eventName ?? 'unknown',
        ...historyDetail(historical),
        ...stringArgs(log),
      },
      aggregation: AlertAggregation.ONCE_PER_INCIDENT,
      dedupeKey: `${chainId}:${log.transactionHash}:${log.logIndex}`,
    });
  }

  private async alertArbiterBlock(
    chainId: ChainId,
    log: EvmConfigEventLog,
    historical = false,
  ): Promise<void> {
    await this.alerts.emit({
      severity: this.severityOf(AlertSeverity.WARN, historical),
      name: EVM_CHAIN_STATE_ALERTS.ARBITER_BLOCK,
      summary:
        `The arbiter set the on-chain block of ${String(log.args.account)} on ${chainId}` +
        this.historyNote(historical),
      details: { chainId, ...historyDetail(historical), ...stringArgs(log) },
      aggregation: AlertAggregation.ONCE_PER_INCIDENT,
      dedupeKey: `${chainId}:${log.transactionHash}:${log.logIndex}`,
    });
  }
}

function mergeHistory(into: Map<string, HistoryEntry>, name: string, entry: HistoryEntry): void {
  const known = into.get(name);
  if (!known) {
    into.set(name, { ...entry });
    return;
  }
  known.count += entry.count;
  if (entry.newestBlock > known.newestBlock) {
    known.newestBlock = entry.newestBlock;
    known.newestTimeMs = entry.newestTimeMs;
  }
}

function historyDetail(historical: boolean): Record<string, string> {
  return historical ? { history: 'fresh-index catch-up' } : {};
}

/** `now − caught_up_at` in ms, or `null` when the index never caught up. */
export function chainStateLagMs(caughtUpAt: Date | null, nowMs: number): number | null {
  return caughtUpAt ? Math.max(0, nowMs - caughtUpAt.getTime()) : null;
}

function lower(value: unknown): string | null {
  return typeof value === 'string' ? value.toLowerCase() : null;
}

function stringArgs(log: EvmConfigEventLog): Record<string, string> {
  const text = (value: unknown): string =>
    typeof value === 'object' && value !== null
      ? JSON.stringify(value, (_key, inner: unknown) =>
          typeof inner === 'bigint' ? inner.toString() : inner,
        )
      : String(value);
  return {
    ...Object.fromEntries(Object.entries(log.args).map(([key, value]) => [key, text(value)])),
    transactionHash: log.transactionHash ?? '(unknown)',
    blockNumber: (log.blockNumber ?? 0n).toString(),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
