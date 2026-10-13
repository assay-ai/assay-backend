import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { getAddress, isAddress } from 'viem';

import { EvmChainStateRepository } from '@database/postgres/repositories/evm-chain-state.repository';

import { ChainErrors } from '../../errors/chains.errors';
import { ChainDoor, ChainParty, ChainStateGatePort } from '../../ports/chain-state-gate.port';
import { ChainId, ChainNamespace, namespaceOf, parseAccountId } from '../../ports/caip.types';
import { X402_CONFIG_ABI } from '../abi/x402.abi';
import { EvmDeployment } from '../evm.constants';

/** Default `EVM_CHAIN_STATE_POLL_MS`: how often every process re-reads the cache tables. */
export const DEFAULT_EVM_CHAIN_STATE_POLL_MS = 15_000;

/** The doors a Config that predates the dispute upgrade already pauses. */
const PAUSED_BEFORE_UPGRADE: ReadonlySet<ChainDoor> = new Set([ChainDoor.DEPOSIT, ChainDoor.REDEEM]);

interface ChainSnapshot {
  readonly paused: boolean;
  /** `null` until the indexer's first reconcile. */
  readonly upgraded: boolean | null;
  readonly blocked: ReadonlySet<string>;
}

export interface EvmChainStateClient {
  readContract(args: {
    address: `0x${string}`;
    abi: unknown;
    functionName: string;
    args: readonly unknown[];
  }): Promise<unknown>;
}

/**
 * The chain-state cache on the hot path, in every process.
 *
 * Postgres (`evm_chain_states`, `evm_blocked_addresses`) is written by
 * `EvmChainStateIndexer` in the scheduler; this holds a copy in memory and
 * re-reads it every `EVM_CHAIN_STATE_POLL_MS`, the same shape as the
 * platform's own `AccountBlocklistService`. A failed re-read keeps the last
 * copy. See `ChainStateGatePort` for why a cache answer that refuses is
 * confirmed against the chain first.
 *
 * Which doors close (assay-evm D-19): on an upgraded Config the pause closes
 * every door here and the blocklist closes them for a blocked party; on a
 * Config that predates the upgrade only deposits and redemption are paused
 * and there is no blocklist.
 */
export class EvmChainStateService implements ChainStateGatePort, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EvmChainStateService.name);
  private chains: ReadonlyMap<string, ChainSnapshot> = new Map();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repository: EvmChainStateRepository,
    private readonly clients: ReadonlyMap<ChainId, EvmChainStateClient>,
    private readonly deployments: ReadonlyMap<ChainId, EvmDeployment>,
    private readonly config: { readonly pollMs: number },
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.deployments.size === 0) return;
    await this.refresh().catch((error: unknown) =>
      this.logger.error(`EVM chain state could not be loaded at boot: ${describe(error)}`),
    );
    this.timer = setInterval(() => {
      void this.refresh().catch((error: unknown) =>
        this.logger.warn(`EVM chain state poll failed: ${describe(error)}`),
      );
    }, this.config.pollMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Re-read both tables and replace the copy. */
  async refresh(): Promise<void> {
    const [states, blocked] = await Promise.all([
      this.repository.findAllStates(),
      this.repository.findBlocked(),
    ]);
    const next = new Map<string, ChainSnapshot>();
    for (const state of states) {
      next.set(state.chainId, {
        paused: state.paused,
        upgraded: state.upgraded,
        blocked: new Set(
          blocked.filter((row) => row.chainId === state.chainId).map((row) => row.address),
        ),
      });
    }
    this.chains = next;
  }

  async assertActive(door: ChainDoor, parties: readonly ChainParty[]): Promise<void> {
    const refusal = await this.refusal(door, parties, 'refuse');
    if (refusal) throw refusal.error;
  }

  async holdReason(door: ChainDoor, parties: readonly ChainParty[]): Promise<string | null> {
    try {
      const refusal = await this.refusal(door, parties, 'hold');
      return refusal ? refusal.reason : null;
    } catch {
      return null;
    }
  }

  /**
   * The cache's verdict, confirmed live. `mode: 'hold'` answers "not
   * inactive" when the confirmation cannot be read; `'refuse'` refuses on
   * the cache alone then.
   */
  private async refusal(
    door: ChainDoor,
    parties: readonly ChainParty[],
    mode: 'refuse' | 'hold',
  ): Promise<{ error: Error; reason: string } | null> {
    const byChain = new Map<ChainId, { role: string; address: `0x${string}` }[]>();
    for (const party of parties) {
      const parsed = evmParty(party);
      if (!parsed) continue;
      byChain.set(parsed.chainId, [...(byChain.get(parsed.chainId) ?? []), parsed]);
    }

    for (const [chainId, members] of byChain) {
      const snapshot = this.chains.get(chainId);
      if (!snapshot) continue;
      const pauseCloses = snapshot.upgraded === true || PAUSED_BEFORE_UPGRADE.has(door);
      if (pauseCloses && snapshot.paused) {
        const live = await this.confirm(chainId, 'paused', [], mode);
        if (live) {
          return {
            error: ChainErrors.programPaused({ chainId, door }),
            reason: `the settlement contracts on ${chainId} are paused`,
          };
        }
      }
      if (snapshot.upgraded !== true) continue;
      for (const member of members) {
        if (!snapshot.blocked.has(member.address.toLowerCase())) continue;
        const live = await this.confirm(chainId, 'blocked', [member.address], mode);
        if (live) {
          return {
            error: ChainErrors.addressBlocked({ chainId, role: member.role, account: member.address }),
            reason: `the ${member.role.toLowerCase()} ${member.address} is blocked on ${chainId}`,
          };
        }
      }
    }
    return null;
  }

  /** The chain's own answer; on a failed read, `true` to refuse and `false` to hold. */
  private async confirm(
    chainId: ChainId,
    functionName: 'paused' | 'blocked',
    args: readonly unknown[],
    mode: 'refuse' | 'hold',
  ): Promise<boolean> {
    const client = this.clients.get(chainId);
    const deployment = this.deployments.get(chainId);
    if (!client || !deployment) return mode === 'refuse';
    try {
      return Boolean(
        await client.readContract({
          address: deployment.config,
          abi: X402_CONFIG_ABI,
          functionName,
          args,
        }),
      );
    } catch (error) {
      this.logger.warn(
        `could not confirm ${functionName} on ${chainId} live; ` +
          `${mode === 'refuse' ? 'refusing on the cache' : 'not holding'}: ${describe(error)}`,
      );
      return mode === 'refuse';
    }
  }
}

function evmParty(party: ChainParty): { chainId: ChainId; role: string; address: `0x${string}` } | null {
  if (!party.account) return null;
  try {
    const parsed = parseAccountId(party.account as never);
    if (namespaceOf(parsed.chainId) !== ChainNamespace.EIP155) return null;
    if (!isAddress(parsed.address, { strict: false })) return null;
    return { chainId: parsed.chainId, role: party.role, address: getAddress(parsed.address) };
  } catch {
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
