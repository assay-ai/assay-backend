import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { getAddress } from 'viem';

import {
  EvmSlashRecordRepository,
  StandingSlashRecord,
} from '@database/postgres/repositories/evm-slash-record.repository';
import { chainErrorName } from '@modules/slash/domain/chain-slash-outcome';
import { SlashBatchOutcome, SlashCancelResult } from '@modules/slash/ports/slash-executor.port';
import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';

import { ENABLED_CHAINS } from '../enabled-chains';
import { ChainId, ChainNamespace, namespaceOf } from '../ports/caip.types';
import { ASSAY_CONFIG_ABI } from './abi/assay.abi';
import { EVM_DEPLOYMENTS, EVM_RPC_CLIENTS, EvmDeployment } from './evm.constants';
import { EvmSlashHoldMonitor } from './evm-slash-hold.monitor';
import { EvmSlashRecordClient, readSlashRecord } from './evm-slash-record';
import { slashStatusFromEvm } from './evm-slash-status';

/** Every two minutes, at second 40 (the slash watcher runs at second 0). */
export const EVM_REVOKED_VERIFIER_REAP_CRON = '40 */2 * * * *';

/** Records read and released per batch — `cancelSlashBatch`'s bound, and a sane multicall. */
export const EVM_REVOKED_VERIFIER_REAP_BATCH = 64;

/** Batches per dead key per tick; the rest is released over later ticks. */
export const EVM_REVOKED_VERIFIER_REAP_ROUNDS = 8;

export const EVM_REVOKED_VERIFIER_ALERTS = {
  /** A key that can no longer sign still has standing records; the reaper is releasing them. */
  RELEASING: 'evm_dead_verifier_records_releasing',
  /** Some of them could not be released this pass. */
  STUCK: 'evm_dead_verifier_records_stuck',
} as const;

/** The one door the reaper needs: `EvmSlashExecutor.expireBatch`. */
export interface SlashExpirer {
  expireBatch(
    requests: readonly { chainId: ChainId; requestId: string; provider: string }[],
  ): Promise<readonly SlashBatchOutcome<SlashCancelResult>[]>;
}

export const EVM_SLASH_EXPIRER = 'EVM_SLASH_EXPIRER';
export const EVM_REAPER_CLOCK = 'EVM_REAPER_CLOCK';

/** What one pass did for one dead key. */
export interface ReapReport {
  readonly chainId: ChainId;
  readonly verifier: string;
  readonly released: number;
  readonly alreadyClosed: number;
  readonly failed: number;
}

/**
 * Releases every standing slash record whose verifier key can no longer sign
 * (review 2026-10-24 wave 2 M-2).
 *
 * Since D-26 a `Pending` or `Disputed` record reserves the provider's stake,
 * and the escrow refuses to pay a provider whose FREE stake (bonded − pending
 * penalties) is below the minimum. Whoever steals the verifier key can
 * therefore halt payments to any provider in one block, and `revokeVerifier`
 * alone releases nothing. Since D-27 `expireSlash` — permissionless — releases
 * at once any record whose verifier `canSign` no longer admits (revoked, or
 * expired). This job is the platform's half of that: it does not wait for a
 * human to send one transaction per record.
 *
 * Each pass, per enabled EVM chain:
 *
 * 1. every verifier with a standing record in `evm_slash_records` (filled by
 *    `EvmSlashProposalWatcher` from `SlashProposed`, this platform's records
 *    and anybody else's) is asked `canSign` live; a key that cannot sign is
 *    flagged `verifier_unavailable` on its records;
 * 2. each of its standing records is re-read (`slashRecordOf`): one no longer
 *    `Pending`/`Disputed` is closed, one still standing is released with
 *    `expireSlash`, batched (`EvmSlashExecutor.expireBatch`, Multicall3);
 * 3. every provider touched is re-checked for its slash hold at once.
 *
 * **Idempotent and safe to re-run**: nothing is sent for a record the chain no
 * longer holds, every send is simulated first, a record released by somebody
 * else (the arbiter's `cancelSlashBatch`, a stranger's `expireSlash`) is just
 * closed, and a failure is counted on the row and retried next pass. The
 * platform's own parts signed by the key are released too — revocation voids
 * them anyway (`executeSlash` refuses a dead key) — and the watcher mirrors
 * each `SlashCancelled` onto its case.
 */
@Injectable()
export class EvmRevokedVerifierReaper {
  private readonly logger = new Logger(EvmRevokedVerifierReaper.name);

  constructor(
    @Inject(EVM_RPC_CLIENTS) private readonly clients: ReadonlyMap<ChainId, EvmSlashRecordClient>,
    @Inject(EVM_DEPLOYMENTS) private readonly deployments: ReadonlyMap<ChainId, EvmDeployment>,
    @Inject(ENABLED_CHAINS) private readonly enabled: readonly ChainId[],
    private readonly records: EvmSlashRecordRepository,
    /** `EvmSlashExecutor` — only its relayer-sent, permissionless `expireBatch`. */
    @Inject(EVM_SLASH_EXPIRER) private readonly expirer: SlashExpirer,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    @Optional() private readonly slashHolds: EvmSlashHoldMonitor | null = null,
    @Optional() @Inject(EVM_REAPER_CLOCK) private readonly now: () => Date = () => new Date(),
  ) {}

  @Cron(EVM_REVOKED_VERIFIER_REAP_CRON)
  async handleTick(): Promise<void> {
    try {
      await this.reap();
    } catch (error) {
      this.logger.error(`revoked-verifier reap threw: ${describe(error)}`);
    }
  }

  /** One pass over every enabled eip155 chain with a deployment. */
  async reap(): Promise<ReapReport[]> {
    const reports: ReapReport[] = [];
    for (const chainId of this.enabled) {
      if (namespaceOf(chainId) !== ChainNamespace.EIP155) continue;
      const deployment = this.deployments.get(chainId);
      const client = this.clients.get(chainId);
      if (!deployment || !client) continue;
      try {
        reports.push(...(await this.reapChain(chainId, deployment, client)));
      } catch (error) {
        this.logger.error(`revoked-verifier reap on ${chainId} failed: ${describe(error)}`);
      }
    }
    return reports;
  }

  private async reapChain(
    chainId: ChainId,
    deployment: EvmDeployment,
    client: EvmSlashRecordClient,
  ): Promise<ReapReport[]> {
    const dead: string[] = [];
    for (const verifier of await this.records.standingVerifiers(chainId)) {
      let canSign: boolean;
      try {
        canSign = (await client.readContract({
          address: deployment.config,
          abi: ASSAY_CONFIG_ABI,
          functionName: 'canSign',
          args: [getAddress(verifier)],
        })) as boolean;
      } catch (error) {
        this.logger.warn(`canSign(${verifier}) on ${chainId} unreadable: ${describe(error)}`);
        continue;
      }
      if (canSign) continue;
      await this.records.markVerifierUnavailable(chainId, verifier);
      dead.push(verifier);
    }

    const reports: ReapReport[] = [];
    for (const verifier of dead) {
      reports.push(await this.reapVerifier(chainId, deployment, client, verifier));
    }
    return reports;
  }

  private async reapVerifier(
    chainId: ChainId,
    deployment: EvmDeployment,
    client: EvmSlashRecordClient,
    verifier: string,
  ): Promise<ReapReport> {
    let released = 0;
    let alreadyClosed = 0;
    let failed = 0;
    const providers = new Set<string>();

    for (let round = 0; round < EVM_REVOKED_VERIFIER_REAP_ROUNDS; round += 1) {
      const rows = await this.records.standingByVerifier(
        chainId,
        verifier,
        EVM_REVOKED_VERIFIER_REAP_BATCH,
      );
      if (rows.length === 0) break;

      const standing: StandingSlashRecord[] = [];
      const closed: string[] = [];
      let roundFailed = 0;
      for (const row of rows) {
        const verdict = await this.readStanding(chainId, deployment, client, row, verifier);
        if (verdict === 'STANDING') standing.push(row);
        else if (verdict === 'CLOSED') {
          closed.push(row.requestId);
          providers.add(row.provider);
        } else {
          roundFailed += 1;
          await this.records.recordReapFailure(chainId, row.requestId, verdict);
        }
      }
      await this.records.markClosed(chainId, closed, this.now());
      alreadyClosed += closed.length;

      let outcomes: readonly SlashBatchOutcome<SlashCancelResult>[] = [];
      if (standing.length > 0) {
        try {
          outcomes = await this.expirer.expireBatch(
            standing.map((row) => ({ chainId, requestId: row.requestId, provider: row.provider })),
          );
        } catch (error) {
          this.logger.warn(
            `expireSlash batch of ${standing.length} on ${chainId} threw: ${describe(error)}`,
          );
          outcomes = standing.map(() => ({ ok: false as const, error }));
        }
      }
      const releasedNow: string[] = [];
      for (const [index, row] of standing.entries()) {
        const outcome = outcomes[index];
        if (outcome?.ok) {
          releasedNow.push(row.requestId);
          providers.add(row.provider);
          continue;
        }
        roundFailed += 1;
        await this.records.recordReapFailure(
          chainId,
          row.requestId,
          (outcome ? chainErrorName(outcome.error) : null) ?? 'transport',
        );
      }
      await this.records.markClosed(chainId, releasedNow, this.now());
      released += releasedNow.length;
      failed += roundFailed;

      // Nothing moved this round: what is left fails for now. Next pass.
      if (roundFailed === rows.length || rows.length < EVM_REVOKED_VERIFIER_REAP_BATCH) break;
    }

    if (this.slashHolds) {
      for (const provider of providers) await this.slashHolds.recheckAuthority(chainId, provider);
    }
    await this.report(chainId, verifier, released, alreadyClosed, failed);
    return { chainId, verifier, released, alreadyClosed, failed };
  }

  /**
   * `STANDING` when the chain still holds the record `Pending` or `Disputed`
   * under this verifier; `CLOSED` when it no longer does; otherwise the reason
   * it could not be told (kept on the row, retried next pass).
   */
  private async readStanding(
    chainId: ChainId,
    deployment: EvmDeployment,
    client: EvmSlashRecordClient,
    row: StandingSlashRecord,
    verifier: string,
  ): Promise<'STANDING' | 'CLOSED' | string> {
    try {
      const record = await readSlashRecord(client, deployment.stake, `0x${row.requestId}`);
      const status = slashStatusFromEvm(record.status);
      if (status === null) return 'NoRecord';
      if (status !== 'PENDING' && status !== 'DISPUTED') return 'CLOSED';
      if (getAddress(record.verifier) !== getAddress(verifier)) return 'VerifierMismatch';
      return 'STANDING';
    } catch (error) {
      this.logger.warn(
        `slash record ${row.requestId} on ${chainId} unreadable: ${describe(error)}`,
      );
      return 'Unreadable';
    }
  }

  private async report(
    chainId: ChainId,
    verifier: string,
    released: number,
    alreadyClosed: number,
    failed: number,
  ): Promise<void> {
    const details = { chainId, verifier, released, alreadyClosed, failed };
    if (released > 0 || alreadyClosed > 0) {
      this.logger.warn(
        `verifier ${verifier} on ${chainId} can no longer sign: released ${released} of its ` +
          `standing slash record(s), ${alreadyClosed} were already closed, ${failed} failed`,
      );
      await this.alerts.emit({
        severity: AlertSeverity.WARN,
        name: EVM_REVOKED_VERIFIER_ALERTS.RELEASING,
        summary:
          `Verifier key ${verifier} on ${chainId} can no longer sign; its standing slash ` +
          `records are being released (expireSlash) so the providers' stake is free again`,
        details,
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: `${chainId}:${verifier}`,
      });
    }
    if (failed > 0) {
      await this.alerts.emit({
        severity: AlertSeverity.CRITICAL,
        name: EVM_REVOKED_VERIFIER_ALERTS.STUCK,
        summary:
          `${failed} standing slash record(s) of dead verifier key ${verifier} on ${chainId} ` +
          `could not be released this pass; payments to their providers may stay halted. ` +
          `Retried every pass; see the runbook (arbiter cancelSlashBatch)`,
        details,
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: `${chainId}:${verifier}`,
      });
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
