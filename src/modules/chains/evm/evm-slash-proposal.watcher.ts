import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Redis } from 'ioredis';

import { SlashProposalPartRepository } from '@database/postgres/repositories/slash-proposal-part.repository';
import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';
import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';

import { ENABLED_CHAINS } from '../enabled-chains';
import { ChainId, ChainNamespace, namespaceOf } from '../ports/caip.types';
import { X402_SLASH_PROPOSED_EVENT_ABI } from './abi/x402.abi';
import { EVM_DEPLOYMENTS, EVM_RPC_CLIENTS, EvmDeployment } from './evm.constants';

/** Every two minutes. A rogue record cannot move money for 72 hours. */
export const EVM_SLASH_WATCH_CRON = '0 */2 * * * *';

/** Most blocks one tick reads per chain; a backlog is caught up over later ticks. */
export const EVM_SLASH_WATCH_MAX_BLOCKS = 10_000n;

/** Blocks per `eth_getLogs` call; most providers refuse wider ranges. */
export const EVM_SLASH_WATCH_CHUNK = 2_000n;

/** Where a chain with no cursor yet starts: this many blocks behind the head. */
export const EVM_SLASH_WATCH_INITIAL_LOOKBACK = 10_000n;

export const EVM_SLASH_WATCH_ALERTS = {
  UNKNOWN: 'slash_proposal_unknown',
  MISMATCH: 'slash_proposal_mismatch',
  UNREADABLE: 'slash_watch_unreadable',
} as const;

const CURSOR_PREFIX = 'evm:slash-watch:cursor:';

/** The two reads this class needs from a viem public client. */
export interface EvmSlashWatchClient {
  getBlockNumber(args?: { cacheTime?: number }): Promise<bigint>;
  getContractEvents(args: {
    address: `0x${string}`;
    abi: typeof X402_SLASH_PROPOSED_EVENT_ABI;
    eventName: 'SlashProposed';
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<readonly SlashProposedLog[]>;
}

export interface SlashProposedLog {
  readonly args: {
    readonly requestId?: `0x${string}`;
    readonly provider?: `0x${string}`;
    readonly verifier?: `0x${string}`;
    readonly beneficiary?: `0x${string}`;
    readonly penalty?: bigint;
    readonly executableAt?: bigint;
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
 * Read-only on chain: `eth_blockNumber` and `eth_getLogs`, nothing signed or
 * sent. The response is in `docs/runbooks/chains.md` ("Unknown slash record").
 *
 * The cursor (last block read, per chain) is kept in Redis. A lost cursor
 * re-reads the last {@link EVM_SLASH_WATCH_INITIAL_LOOKBACK} blocks; known
 * records stay silent, so a re-read costs RPC calls, not false alerts.
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
    @Inject(REDIS_CACHE_CLIENT) private readonly redis: Redis,
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
    const cursor = await this.readCursor(chainId);
    const start =
      cursor === null
        ? head > EVM_SLASH_WATCH_INITIAL_LOOKBACK
          ? head - EVM_SLASH_WATCH_INITIAL_LOOKBACK
          : 0n
        : cursor + 1n;
    if (start > head) return [];
    const end =
      head - start + 1n > EVM_SLASH_WATCH_MAX_BLOCKS
        ? start + EVM_SLASH_WATCH_MAX_BLOCKS - 1n
        : head;

    const logs: SlashProposedLog[] = [];
    for (let from = start; from <= end; from += EVM_SLASH_WATCH_CHUNK) {
      const to = from + EVM_SLASH_WATCH_CHUNK - 1n < end ? from + EVM_SLASH_WATCH_CHUNK - 1n : end;
      logs.push(
        ...(await client.getContractEvents({
          address: deployment.stake,
          abi: X402_SLASH_PROPOSED_EVENT_ABI,
          eventName: 'SlashProposed',
          fromBlock: from,
          toBlock: to,
        })),
      );
    }

    const findings = await this.compare(chainId, logs);
    // Only after the comparison and its alerts: a failure above re-reads the
    // same range next tick rather than skipping it.
    await this.writeCursor(chainId, end);
    return findings;
  }

  private async compare(
    chainId: ChainId,
    logs: readonly SlashProposedLog[],
  ): Promise<SlashWatchFinding[]> {
    const ids = logs
      .map((log) => log.args.requestId?.toLowerCase().replace(/^0x/, ''))
      .filter((id): id is string => typeof id === 'string');
    const stored = new Map(
      (await this.parts.findByChainRequestIds(ids)).map((part) => [part.chainRequestId, part]),
    );

    const findings: SlashWatchFinding[] = [];
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
      }
    }
    return findings;
  }

  private async readCursor(chainId: ChainId): Promise<bigint | null> {
    try {
      const value = await this.redis.get(CURSOR_PREFIX + chainId);
      return value === null ? null : BigInt(value);
    } catch (error) {
      this.logger.warn(
        `slash watch cursor for ${chainId} unreadable, re-reading: ${describe(error)}`,
      );
      return null;
    }
  }

  private async writeCursor(chainId: ChainId, block: bigint): Promise<void> {
    try {
      await this.redis.set(CURSOR_PREFIX + chainId, block.toString());
    } catch (error) {
      this.logger.warn(`slash watch cursor for ${chainId} not saved: ${describe(error)}`);
    }
  }
}

/** The address of a CAIP-10 account, lower-case. */
function addressOf(account: string): string {
  return (account.split(':').pop() ?? '').toLowerCase();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
