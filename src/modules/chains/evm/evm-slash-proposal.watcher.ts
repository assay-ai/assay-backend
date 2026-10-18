import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Cron } from '@nestjs/schedule';

import { EvmChainStateRepository } from '@database/postgres/repositories/evm-chain-state.repository';
import { SlashProposalPartRepository } from '@database/postgres/repositories/slash-proposal-part.repository';
import {
  SLASH_CHAIN_RULINGS,
  SlashChainRulingsPort,
} from '@modules/slash/ports/slash-chain-rulings.port';
import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';

import { ENABLED_CHAINS } from '../enabled-chains';
import { ChainId, ChainNamespace, namespaceOf } from '../ports/caip.types';
import { X402_SLASH_WATCH_EVENTS_ABI } from './abi/x402.abi';
import {
  DEFAULT_EVM_CHAIN_STATE_CONFIRMATIONS,
  EVM_CHAIN_STATE_INDEXER_CONFIG,
  EvmChainStateIndexerConfig,
} from './chain-state/evm-chain-state.indexer';
import { EVM_DEPLOYMENTS, EVM_RPC_CLIENTS, EvmDeployment } from './evm.constants';
import { EvmSlashHoldMonitor } from './evm-slash-hold.monitor';
import { cancelReasonFromEvm } from './evm-slash-status';

/**
 * Every two minutes. A rogue record cannot move money before its
 * `executableAt` — the chain's slash delay, which since the dispute upgrade
 * the admin may set as low as ten minutes. The alert carries `executableAt`.
 */
export const EVM_SLASH_WATCH_CRON = '0 */2 * * * *';

/** Most blocks one tick reads per chain; a backlog is caught up over later ticks. */
export const EVM_SLASH_WATCH_MAX_BLOCKS = 10_000n;

/** Blocks per `eth_getLogs` call; most providers refuse wider ranges. */
export const EVM_SLASH_WATCH_CHUNK = 2_000n;

/**
 * Where a chain with no cursor, no `EVM_CHAIN_STATE_FROM_BLOCK` and no recorded
 * `disputeUpgradeBlock` starts: this many blocks behind the safe head.
 */
export const EVM_SLASH_WATCH_INITIAL_LOOKBACK = 10_000n;

export const EVM_SLASH_WATCH_ALERTS = {
  UNKNOWN: 'slash_proposal_unknown',
  MISMATCH: 'slash_proposal_mismatch',
  UNREADABLE: 'slash_watch_unreadable',
  UNKNOWN_RULING: 'slash_ruling_unknown',
} as const;

/** The two reads this class needs from a viem public client. */
export interface EvmSlashWatchClient {
  getBlockNumber(args?: { cacheTime?: number }): Promise<bigint>;
  getContractEvents(args: {
    address: `0x${string}`;
    abi: typeof X402_SLASH_WATCH_EVENTS_ABI;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<readonly SlashProposedLog[]>;
}

/** One decoded log of {@link X402_SLASH_WATCH_EVENTS_ABI}. */
export interface SlashProposedLog {
  readonly eventName:
    | 'SlashProposed'
    | 'SlashDisputed'
    | 'SlashUpheld'
    | 'SlashCancelled'
    | 'SlashExecuted';
  readonly args: {
    readonly requestId?: `0x${string}`;
    readonly provider?: `0x${string}`;
    readonly verifier?: `0x${string}`;
    readonly beneficiary?: `0x${string}`;
    readonly penalty?: bigint;
    readonly executableAt?: bigint;
    readonly disputedAt?: bigint;
    readonly arbiter?: `0x${string}`;
    readonly reason?: number;
    readonly cancelledAt?: bigint;
    readonly applied?: bigint;
    readonly agentAmount?: bigint;
    readonly platformAmount?: bigint;
    readonly executedAt?: bigint;
  };
  readonly transactionHash: `0x${string}` | null;
  readonly blockNumber: bigint | null;
}

export interface SlashWatchFinding {
  readonly chainId: ChainId;
  readonly kind: 'UNKNOWN' | 'MISMATCH';
  readonly requestId: string;
}

/**
 * Detection for review H-1: alerts on any `SlashProposed` record on an enabled
 * EVM chain that this platform did not plan.
 *
 * Whoever holds the verifier key can propose a slash naming any beneficiary;
 * nothing else in the backend looks at records it did not create. Every record
 * the backend proposes has a `slash_proposal_parts` row (written before the
 * attestation is signed) carrying its `chain_request_id`, beneficiary and
 * amount. So an event whose request id has no row, or whose beneficiary or
 * penalty differs from the row, was not proposed by this backend's planner:
 * a CRITICAL alert, one per record.
 *
 * ## The dispute upgrade's events (D-19)
 *
 * The same `eth_getLogs` also returns `SlashDisputed` (the provider froze a
 * record), `SlashUpheld` (the arbiter ruled against the provider) and
 * `SlashCancelled` (the arbiter ruled for the provider, or an expiry). They
 * are handed to the slash domain (`SLASH_CHAIN_RULINGS`), which mirrors them
 * onto the case: the part `DISPUTED`, the case into review; on an uphold the
 * part back to `PENDING` at the `executableAt` the EVENT carries; on a cancel
 * the part `CANCELLED`, and the case closed at once when nothing of it stands
 * (audit E-6). A dispute or ruling on a record nobody planned is a WARN — the
 * proposal itself was already the CRITICAL.
 *
 * Read-only on chain: `eth_blockNumber` and `eth_getLogs`, nothing signed or
 * sent. The response is in `docs/runbooks/chains.md` ("Unknown slash record").
 *
 * ## Cursor and confirmations (review S-4)
 *
 * Events are read only up to `head − EVM_CHAIN_STATE_CONFIRMATIONS`, the
 * chain-state indexer's depth: a node behind the one that answered
 * `eth_blockNumber`, or a reorg, cannot make the cursor pass a block whose logs
 * were not seen. The cursor (last block read, per chain) is durable, in
 * `evm_chain_states.slash_watch_cursor_block`. A chain with none starts at the
 * old Redis cursor if one is left, else `EVM_CHAIN_STATE_FROM_BLOCK`, else the
 * deployment's `disputeUpgradeBlock`, and only with neither
 * {@link EVM_SLASH_WATCH_INITIAL_LOOKBACK} blocks back. Known records stay
 * silent, so a re-read costs RPC calls, not false alerts.
 */
@Injectable()
export class EvmSlashProposalWatcher {
  private readonly logger = new Logger(EvmSlashProposalWatcher.name);

  constructor(
    @Inject(EVM_RPC_CLIENTS) private readonly clients: ReadonlyMap<ChainId, EvmSlashWatchClient>,
    @Inject(EVM_DEPLOYMENTS) private readonly deployments: ReadonlyMap<ChainId, EvmDeployment>,
    @Inject(ENABLED_CHAINS) private readonly enabled: readonly ChainId[],
    private readonly parts: SlashProposalPartRepository,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    private readonly cursors: EvmChainStateRepository,
    // Resolved at call time: the slash domain is composed beside this module
    // in the scheduler, and a composition without it still alerts.
    @Optional() private readonly moduleRef: ModuleRef | null = null,
    // A slash event can put a provider on (or take it off) a slash hold:
    // re-check that provider at once rather than at the next minute.
    @Optional() private readonly slashHolds: EvmSlashHoldMonitor | null = null,
    // The chain-state indexer's start blocks and confirmation depth.
    @Optional()
    @Inject(EVM_CHAIN_STATE_INDEXER_CONFIG)
    private readonly indexer: Pick<
      EvmChainStateIndexerConfig,
      'fromBlock' | 'confirmations'
    > | null = null,
  ) {}

  @Cron(EVM_SLASH_WATCH_CRON)
  async handleWatch(): Promise<void> {
    try {
      await this.check();
    } catch (error) {
      this.logger.error(`slash proposal watch threw: ${describe(error)}`);
    }
  }

  /** One pass over every enabled eip155 chain with a deployment. */
  async check(): Promise<readonly SlashWatchFinding[]> {
    const findings: SlashWatchFinding[] = [];
    for (const chainId of this.enabled) {
      if (namespaceOf(chainId) !== ChainNamespace.EIP155) continue;
      const deployment = this.deployments.get(chainId);
      const client = this.clients.get(chainId);
      if (!deployment || !client) continue;
      try {
        findings.push(...(await this.checkChain(chainId, deployment, client)));
      } catch (error) {
        // The RPC error message is not put in the alert: an RPC URL can carry
        // an API key. It is in this log line.
        this.logger.error(`slash proposal watch on ${chainId} failed: ${describe(error)}`);
        await this.alerts.emit({
          severity: AlertSeverity.WARN,
          name: EVM_SLASH_WATCH_ALERTS.UNREADABLE,
          summary: `SlashProposed events on ${chainId} could not be read; unknown slash records would go unnoticed`,
          details: { chainId },
          aggregation: AlertAggregation.ONCE_PER_INCIDENT,
          dedupeKey: chainId,
        });
      }
    }
    return findings;
  }

  private async checkChain(
    chainId: ChainId,
    deployment: EvmDeployment,
    client: EvmSlashWatchClient,
  ): Promise<SlashWatchFinding[]> {
    const head = await client.getBlockNumber({ cacheTime: 0 });
    const confirmations = BigInt(
      this.indexer?.confirmations ?? DEFAULT_EVM_CHAIN_STATE_CONFIRMATIONS,
    );
    const safeHead = head > confirmations ? head - confirmations : 0n;
    const cursor = await this.readCursor(chainId);
    const known = this.indexer?.fromBlock.get(chainId) ?? deployment.disputeUpgradeBlock;
    const start =
      cursor !== null
        ? cursor + 1n
        : (known ??
          (safeHead > EVM_SLASH_WATCH_INITIAL_LOOKBACK
            ? safeHead - EVM_SLASH_WATCH_INITIAL_LOOKBACK
            : 0n));
    if (start > safeHead) return [];
    const end =
      safeHead - start + 1n > EVM_SLASH_WATCH_MAX_BLOCKS
        ? start + EVM_SLASH_WATCH_MAX_BLOCKS - 1n
        : safeHead;

    const logs: SlashProposedLog[] = [];
    for (let from = start; from <= end; from += EVM_SLASH_WATCH_CHUNK) {
      const to = from + EVM_SLASH_WATCH_CHUNK - 1n < end ? from + EVM_SLASH_WATCH_CHUNK - 1n : end;
      logs.push(
        ...(await client.getContractEvents({
          address: deployment.stake,
          abi: X402_SLASH_WATCH_EVENTS_ABI,
          fromBlock: from,
          toBlock: to,
        })),
      );
    }

    const proposed = logs.filter((log) => log.eventName === 'SlashProposed');
    const { findings, late } = await this.compare(chainId, proposed);
    await this.readoptLate(chainId, late);
    // A failure here throws before the cursor moves, so the range is re-read
    // and the (idempotent) mirror is retried next tick.
    await this.mirrorRulings(
      chainId,
      logs.filter(
        (log) =>
          log.eventName === 'SlashDisputed' ||
          log.eventName === 'SlashUpheld' ||
          log.eventName === 'SlashCancelled' ||
          log.eventName === 'SlashExecuted',
      ),
    );
    // Only after the comparison and its alerts: a failure above re-reads the
    // same range next tick rather than skipping it.
    await this.writeCursor(chainId, end);
    if (this.slashHolds) {
      const authorities = new Set(
        logs
          .map((log) => log.args.provider)
          .filter((provider): provider is `0x${string}` => typeof provider === 'string'),
      );
      for (const provider of authorities) await this.slashHolds.recheckAuthority(chainId, provider);
    }
    return findings;
  }

  private async compare(
    chainId: ChainId,
    logs: readonly SlashProposedLog[],
  ): Promise<{ findings: SlashWatchFinding[]; late: SlashProposedLog[] }> {
    const ids = logs
      .map((log) => log.args.requestId?.toLowerCase().replace(/^0x/, ''))
      .filter((id): id is string => typeof id === 'string');
    const stored = new Map(
      (await this.parts.findByChainRequestIds(ids)).map((part) => [part.chainRequestId, part]),
    );

    const findings: SlashWatchFinding[] = [];
    const late: SlashProposedLog[] = [];
    for (const log of logs) {
      const requestId = log.args.requestId?.toLowerCase().replace(/^0x/, '');
      if (!requestId) continue;
      const onChain = {
        chainId,
        requestId: `0x${requestId}`,
        provider: log.args.provider ?? '(none)',
        verifier: log.args.verifier ?? '(none)',
        beneficiary: log.args.beneficiary ?? '(none)',
        penalty: (log.args.penalty ?? 0n).toString(),
        executableAt: (log.args.executableAt ?? 0n).toString(),
        transactionHash: log.transactionHash ?? '(unknown)',
        blockNumber: (log.blockNumber ?? 0n).toString(),
      };

      const part = stored.get(requestId);
      if (!part) {
        findings.push({ chainId, kind: 'UNKNOWN', requestId });
        await this.alerts.emit({
          severity: AlertSeverity.CRITICAL,
          name: EVM_SLASH_WATCH_ALERTS.UNKNOWN,
          summary:
            `A slash record on ${chainId} was proposed that this platform never planned. ` +
            `Treat the verifier key as compromised: see the runbook (revokeVerifier / pause / cancelSlash) ` +
            `before executableAt`,
          details: onChain,
          aggregation: AlertAggregation.ONCE_PER_INCIDENT,
          dedupeKey: `${chainId}:${requestId}`,
        });
        continue;
      }

      const storedBeneficiary = addressOf(part.beneficiaryAccount);
      const beneficiaryDiffers = storedBeneficiary !== onChain.beneficiary.toLowerCase();
      const penaltyDiffers = BigInt(part.penaltyAmount) !== (log.args.penalty ?? 0n);
      if (beneficiaryDiffers || penaltyDiffers) {
        findings.push({ chainId, kind: 'MISMATCH', requestId });
        await this.alerts.emit({
          severity: AlertSeverity.CRITICAL,
          name: EVM_SLASH_WATCH_ALERTS.MISMATCH,
          summary:
            `A slash record on ${chainId} names a different ` +
            `${[beneficiaryDiffers && 'beneficiary', penaltyDiffers && 'penalty'].filter(Boolean).join(' and ')} ` +
            `than the stored part. See the runbook before executableAt`,
          details: {
            ...onChain,
            storedBeneficiary: part.beneficiaryAccount,
            storedPenalty: part.penaltyAmount,
            proposalId: part.proposalId,
            organizationId: part.organizationId,
          },
          aggregation: AlertAggregation.ONCE_PER_INCIDENT,
          dedupeKey: `${chainId}:${requestId}`,
        });
      } else if (part.chainStatus === 'REFUSED') {
        // Review S-5: a straggler given up on whose transaction landed late.
        late.push(log);
      }
    }
    return { findings, late };
  }

  /**
   * Hands the slash domain each matching `SlashProposed` of a part it had
   * given up on (review S-5), so the part is re-adopted rather than left
   * reserving the provider's stake unseen. Throws before the cursor moves.
   */
  private async readoptLate(chainId: ChainId, logs: readonly SlashProposedLog[]): Promise<void> {
    if (logs.length === 0) return;
    const rulings = this.rulings();
    for (const log of logs) {
      const requestId = log.args.requestId?.toLowerCase().replace(/^0x/, '') ?? '';
      if (!rulings) {
        this.logger.warn(
          `a late SlashProposed for given-up part ${requestId} on ${chainId} seen, but no slash ` +
            `domain is composed in this process to re-adopt it`,
        );
        continue;
      }
      await rulings.recordLateProposal({
        chainId,
        requestId,
        executableAt: new Date(Number(log.args.executableAt ?? 0n) * 1000),
        transactionHash: log.transactionHash ?? null,
      });
    }
  }

  private async mirrorRulings(chainId: ChainId, logs: readonly SlashProposedLog[]): Promise<void> {
    if (logs.length === 0) return;
    const rulings = this.rulings();
    for (const log of logs) {
      const requestId = log.args.requestId?.toLowerCase().replace(/^0x/, '');
      if (!requestId) continue;
      const executableAt = new Date(Number(log.args.executableAt ?? 0n) * 1000);
      const transactionHash = log.transactionHash ?? null;
      if (!rulings) {
        this.logger.warn(
          `${log.eventName} for ${requestId} on ${chainId} seen, but no slash domain is composed ` +
            `in this process to mirror it`,
        );
        continue;
      }
      let known: boolean;
      if (log.eventName === 'SlashDisputed') {
        known = await rulings.recordDisputed({
          chainId,
          requestId,
          provider: log.args.provider ?? '',
          disputedAt: new Date(Number(log.args.disputedAt ?? 0n) * 1000),
          executableAt,
          transactionHash,
        });
      } else if (log.eventName === 'SlashUpheld') {
        known = await rulings.recordUpheld({
          chainId,
          requestId,
          arbiter: log.args.arbiter ?? '',
          executableAt,
          transactionHash,
        });
      } else if (log.eventName === 'SlashExecuted') {
        // Whoever sent it: `executeSlash` is permissionless (BUG-R13-D-03).
        known = await rulings.recordExecuted({
          chainId,
          requestId,
          appliedMinor: (log.args.applied ?? 0n).toString(),
          agentAmountMinor: (log.args.agentAmount ?? 0n).toString(),
          platformAmountMinor: (log.args.platformAmount ?? 0n).toString(),
          executedAt: new Date(Number(log.args.executedAt ?? 0n) * 1000),
          transactionHash,
        });
        // An execution of a record nobody planned was already the proposal's CRITICAL.
        if (!known) continue;
      } else {
        known = await rulings.recordCancelled({
          chainId,
          requestId,
          reason: cancelReasonFromEvm(Number(log.args.reason ?? 0)),
          cancelledAt: new Date(Number(log.args.cancelledAt ?? 0n) * 1000),
          transactionHash,
        });
        // A cancel of a record nobody planned is not worth a WARN on its own:
        // the proposal itself was already the CRITICAL.
        if (!known) continue;
      }
      if (!known) {
        await this.alerts.emit({
          severity: AlertSeverity.WARN,
          name: EVM_SLASH_WATCH_ALERTS.UNKNOWN_RULING,
          summary: `${log.eventName} on ${chainId} for a slash record this platform never planned`,
          details: {
            chainId,
            requestId: `0x${requestId}`,
            event: log.eventName,
            transactionHash: transactionHash ?? '(unknown)',
          },
          aggregation: AlertAggregation.ONCE_PER_INCIDENT,
          dedupeKey: `${chainId}:${requestId}:${log.eventName}`,
        });
      }
    }
  }

  private rulings(): SlashChainRulingsPort | null {
    if (!this.moduleRef) return null;
    try {
      return this.moduleRef.get<SlashChainRulingsPort>(SLASH_CHAIN_RULINGS, { strict: false });
    } catch {
      return null;
    }
  }

  /** The durable cursor in Postgres. A failed read throws: guessing a start could skip blocks. */
  private async readCursor(chainId: ChainId): Promise<bigint | null> {
    return this.cursors.findSlashWatchCursor(chainId);
  }

  private async writeCursor(chainId: ChainId, block: bigint): Promise<void> {
    await this.cursors.saveSlashWatchCursor(chainId, block);
  }
}

/** The address of a CAIP-10 account, lower-case. */
function addressOf(account: string): string {
  return (account.split(':').pop() ?? '').toLowerCase();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
