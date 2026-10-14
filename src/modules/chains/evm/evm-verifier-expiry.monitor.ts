import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { getAddress } from 'viem';

import { SlashProposalPartRepository } from '@database/postgres/repositories/slash-proposal-part.repository';
import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';

import { ENABLED_CHAINS } from '../enabled-chains';
import { ChainId, ChainNamespace, namespaceOf } from '../ports/caip.types';
import { X402_CONFIG_ABI } from './abi/x402.abi';
import { EVM_DEPLOYMENTS, EVM_RPC_CLIENTS, EvmDeployment } from './evm.constants';
import { EvmSlashRecordClient, readSlashRecord } from './evm-slash-record';

/** Every hour, on the hour. */
export const EVM_VERIFIER_EXPIRY_CRON = '0 0 * * * *';
/** Warn this long before a verifier key with open records expires (follow-up B5). */
export const VERIFIER_EXPIRY_WARN_MS = 45 * 24 * 60 * 60 * 1000;
/** Open records read per page; a pass pages through all of them (review S-7). */
export const VERIFIER_EXPIRY_PAGE_SIZE = 500;

export const EVM_VERIFIER_EXPIRY_ALERTS = {
  EXPIRING: 'evm_verifier_key_expiring',
} as const;

/**
 * Follow-up B5 (audit F4): a verifier key's expiry voids every record it
 * signed — `executeSlash` re-checks the key — so a key that expires while its
 * records are still `Pending` or `Disputed` silently pardons them. Each pass
 * reads the verifier of every open record from the chain, and the key's
 * `expiresAt`, and raises a WARN for each key that expires within 45 days (or
 * already has) while it still has open records. Rotation is a NEW key
 * (`yarn verifier:registry`); see the verifier-key runbook.
 *
 * Read-only on chain. Never throws.
 */
@Injectable()
export class EvmVerifierExpiryMonitor {
  private readonly logger = new Logger(EvmVerifierExpiryMonitor.name);

  constructor(
    @Inject(EVM_RPC_CLIENTS) private readonly clients: ReadonlyMap<ChainId, EvmSlashRecordClient>,
    @Inject(EVM_DEPLOYMENTS) private readonly deployments: ReadonlyMap<ChainId, EvmDeployment>,
    @Inject(ENABLED_CHAINS) private readonly enabled: readonly ChainId[],
    private readonly parts: SlashProposalPartRepository,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
  ) {}

  @Cron(EVM_VERIFIER_EXPIRY_CRON)
  async handleTick(): Promise<void> {
    try {
      await this.check();
    } catch (error) {
      this.logger.error(`verifier-key expiry check threw: ${describe(error)}`);
    }
  }

  /** The keys warned about this pass, for tests and the log. */
  async check(now: Date = new Date()): Promise<{ chainId: ChainId; verifier: string }[]> {
    const records: { requestId: string; assetId: string }[] = [];
    for (let offset = 0; ; offset += VERIFIER_EXPIRY_PAGE_SIZE) {
      const page = await this.parts.findOpenChainRecords(VERIFIER_EXPIRY_PAGE_SIZE, offset);
      records.push(...page);
      if (page.length < VERIFIER_EXPIRY_PAGE_SIZE) break;
    }
    const byChain = new Map<ChainId, string[]>();
    for (const record of records) {
      const chainId = record.assetId.split('/')[0] as ChainId;
      if (namespaceOf(chainId) !== ChainNamespace.EIP155 || !this.enabled.includes(chainId)) {
        continue;
      }
      byChain.set(chainId, [...(byChain.get(chainId) ?? []), record.requestId]);
    }

    const warned: { chainId: ChainId; verifier: string }[] = [];
    for (const [chainId, requestIds] of byChain) {
      const client = this.clients.get(chainId);
      const deployment = this.deployments.get(chainId);
      if (!client || !deployment) continue;
      const open = new Map<string, number>();
      for (const requestId of requestIds) {
        try {
          const record = await readSlashRecord(
            client,
            deployment.stake,
            `0x${requestId.replace(/^0x/, '')}`,
          );
          const verifier = getAddress(record.verifier);
          open.set(verifier, (open.get(verifier) ?? 0) + 1);
        } catch (error) {
          this.logger.warn(
            `slash record ${requestId} on ${chainId} unreadable: ${describe(error)}`,
          );
        }
      }
      for (const [verifier, count] of open) {
        try {
          const key = (await client.readContract({
            address: deployment.config,
            abi: X402_CONFIG_ABI,
            functionName: 'verifierKey',
            args: [verifier],
          })) as { expiresAt: bigint; revoked: boolean };
          const expiresAtMs = Number(key.expiresAt) * 1000;
          if (key.expiresAt === 0n || key.revoked) continue;
          if (expiresAtMs - now.getTime() > VERIFIER_EXPIRY_WARN_MS) continue;
          warned.push({ chainId, verifier });
          const expiresAt = new Date(expiresAtMs).toISOString();
          this.logger.warn(
            `verifier key ${verifier} on ${chainId} expires ${expiresAt} with ${count} open ` +
              `slash record(s); rotate it before then or they cannot execute`,
          );
          await this.alerts.emit({
            severity: AlertSeverity.WARN,
            name: EVM_VERIFIER_EXPIRY_ALERTS.EXPIRING,
            summary:
              `Verifier key ${verifier} on ${chainId} expires ${expiresAt} and still has ` +
              `${count} open slash record(s); records it signed cannot execute after it expires`,
            details: { chainId, verifier, expiresAt, openRecords: count },
            aggregation: AlertAggregation.ONCE_PER_INCIDENT,
            dedupeKey: `${chainId}:${verifier}`,
          });
        } catch (error) {
          this.logger.warn(`verifier key ${verifier} on ${chainId} unreadable: ${describe(error)}`);
        }
      }
    }
    return warned;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
