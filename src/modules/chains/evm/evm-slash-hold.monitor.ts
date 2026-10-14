import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { getAddress } from 'viem';

import { ProviderChainEnrolmentRepository } from '@database/postgres/repositories/provider-chain-enrolment.repository';
import { ProviderSlashHoldRepository } from '@database/postgres/repositories/provider-slash-hold.repository';
import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';
import {
  nextSlashHoldState,
  NOT_HELD,
  SlashHoldReason,
  slashHoldReasons,
  SlashHoldState,
  SlashHoldStakeReading,
} from '@modules/provider/domain/slash-hold';

import { ENABLED_CHAINS } from '../enabled-chains';
import { ChainId, ChainNamespace, namespaceOf, parseAccountId } from '../ports/caip.types';
import { X402_CONFIG_ABI, X402_STAKE_ABI } from './abi/x402.abi';
import { EVM_DEPLOYMENTS, EVM_RPC_CLIENTS, EvmDeployment } from './evm.constants';

/** Every minute, at second 30 (off the other sweeps' second 0). */
export const EVM_SLASH_HOLD_CRON = '30 * * * * *';

export interface EvmSlashHoldClient {
  readContract(args: {
    address: `0x${string}`;
    abi: unknown;
    functionName: string;
    args: readonly unknown[];
  }): Promise<unknown>;
}

/**
 * The provider "slash hold" (owner feature): stop routing paid calls to a
 * provider, on one chain, whose penalties there can no longer be collected
 * promptly, so penalties do not keep piling up. A provider is held while any
 * of `SlashHoldReason` holds (see `slashHoldReasons`), read from the chain —
 * `stakeOf` and `params()` — and the platform's own upheld cases (and, left
 * out of the reservation, its records frozen by an on-chain dispute), and is
 * released after two consecutive clear checks (`nextSlashHoldState`).
 *
 * Re-checked every minute and, for one provider, on its slash events
 * (`EvmSlashProposalWatcher`). The decision is cached in
 * `provider_slash_holds`, which routing (`DbProviderRegistry`) and payment
 * intents read; no on-chain state is written. A failed read keeps the last
 * decision. WARN on a hold, INFO on a release.
 */
@Injectable()
export class EvmSlashHoldMonitor {
  private readonly logger = new Logger(EvmSlashHoldMonitor.name);

  constructor(
    @Inject(EVM_RPC_CLIENTS) private readonly clients: ReadonlyMap<ChainId, EvmSlashHoldClient>,
    @Inject(EVM_DEPLOYMENTS) private readonly deployments: ReadonlyMap<ChainId, EvmDeployment>,
    @Inject(ENABLED_CHAINS) private readonly enabled: readonly ChainId[],
    private readonly enrolments: ProviderChainEnrolmentRepository,
    private readonly proposals: SlashProposalRepository,
    private readonly holds: ProviderSlashHoldRepository,
    @Optional() private readonly now: () => number = () => Date.now(),
  ) {}

  @Cron(EVM_SLASH_HOLD_CRON)
  async handleTick(): Promise<void> {
    try {
      await this.tick();
    } catch (error) {
      this.logger.error(`slash-hold check threw: ${describe(error)}`);
    }
  }

  async tick(): Promise<void> {
    for (const chainId of this.enabled) {
      if (namespaceOf(chainId) !== ChainNamespace.EIP155) continue;
      try {
        const providers = await this.enrolments.findStakeAuthoritiesOn(chainId);
        await this.checkChain(chainId, providers);
      } catch (error) {
        this.logger.error(`slash-hold check on ${chainId} failed: ${describe(error)}`);
      }
    }
  }

  /** One provider, now — on a slash event of its stake authority. Never throws. */
  async recheckAuthority(chainId: ChainId, stakeAuthority: string): Promise<void> {
    try {
      const wanted = getAddress(stakeAuthority);
      const providers = (await this.enrolments.findStakeAuthoritiesOn(chainId)).filter(
        (row) => addressOf(row.stakeAuthority) === wanted,
      );
      if (providers.length > 0) await this.checkChain(chainId, providers);
    } catch (error) {
      this.logger.warn(`slash-hold recheck on ${chainId} failed: ${describe(error)}`);
    }
  }

  private async checkChain(
    chainId: ChainId,
    providers: readonly { providerId: string; stakeAuthority: string }[],
  ): Promise<void> {
    const client = this.clients.get(chainId);
    const deployment = this.deployments.get(chainId);
    if (!client || !deployment || providers.length === 0) return;
    const now = new Date(this.now());
    const [params, waiting, disputed] = await Promise.all([
      client.readContract({
        address: deployment.config,
        abi: X402_CONFIG_ABI,
        functionName: 'params',
        args: [],
      }) as Promise<{ penaltyAmount: bigint; minimumStake: bigint }>,
      this.proposals.findWaitingExecution(chainId, now),
      this.proposals.findDisputedReservations(chainId),
    ]);

    for (const { providerId, stakeAuthority } of providers) {
      try {
        const stake = (await client.readContract({
          address: deployment.stake,
          abi: X402_STAKE_ABI,
          functionName: 'stakeOf',
          args: [addressOf(stakeAuthority)],
        })) as { bonded: bigint; unbonding: bigint; pendingSlash: bigint };
        const reading: SlashHoldStakeReading = {
          bonded: BigInt(stake.bonded),
          unbonding: BigInt(stake.unbonding),
          pendingSlash: BigInt(stake.pendingSlash),
          penaltyAmount: BigInt(params.penaltyAmount),
          minimumStake: BigInt(params.minimumStake),
          disputedReserved: disputed.get(providerId) ?? 0n,
        };
        const wait = waiting.get(providerId);
        const reasons = slashHoldReasons(reading, {
          recordWaiting: wait !== undefined,
          windowRefused: wait?.windowRefused ?? false,
        });
        await this.apply(providerId, chainId, reasons, now);
      } catch (error) {
        // Keep the last decision: a node outage neither holds nor releases.
        this.logger.warn(
          `slash-hold check of provider ${providerId} on ${chainId} unreadable; keeping the last ` +
            `decision: ${describe(error)}`,
        );
      }
    }
  }

  private async apply(
    providerId: string,
    chainId: ChainId,
    reasons: readonly SlashHoldReason[],
    now: Date,
  ): Promise<void> {
    const stored = await this.holds.findState(providerId, chainId);
    const previous: SlashHoldState = stored
      ? {
          held: stored.held,
          reasons: (stored.reasons ?? []) as SlashHoldReason[],
          clearChecks: stored.clearChecks,
          heldSince: stored.heldSince,
        }
      : NOT_HELD;
    const next = nextSlashHoldState(previous, reasons, now);
    const released = previous.held && !next.held;
    await this.holds.saveState(providerId, chainId, {
      ...next,
      checkedAt: now,
      ...(released ? { releasedAt: now } : {}),
    });
    if (next.held && !previous.held) {
      this.logger.warn(
        `provider ${providerId} is on a slash hold on ${chainId} (${next.reasons.join(', ')}): ` +
          `its paid bindings are not routed there until the penalties can be collected`,
      );
    } else if (released) {
      this.logger.log(`provider ${providerId}'s slash hold on ${chainId} is released`);
    }
  }
}

function addressOf(account: string): `0x${string}` {
  return getAddress(account.includes(':') ? parseAccountId(account as never).address : account);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
