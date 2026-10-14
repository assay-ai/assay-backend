import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { getAddress, isAddress } from 'viem';

import { EvmChainStateRepository } from '@database/postgres/repositories/evm-chain-state.repository';
import { AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';

import { ChainErrors } from '../../errors/chains.errors';
import { ChainDoor, ChainParty, ChainStateGatePort } from '../../ports/chain-state-gate.port';
import { ChainId, ChainNamespace, namespaceOf, parseAccountId } from '../../ports/caip.types';
import { X402_CONFIG_ABI } from '../abi/x402.abi';
import { readDomainMismatches } from '../eip712/domain-guard';
import { checkConfigUpgraded } from '../evm-config-terms';
import { EvmDeployment } from '../evm.constants';

/** Default `EVM_CHAIN_STATE_POLL_MS`: how often every process re-reads the cache tables. */
export const DEFAULT_EVM_CHAIN_STATE_POLL_MS = 15_000;

/**
 * How often the EIP-712 domain guard re-reads the proxies' `DOMAIN_SEPARATOR()`
 * on the poll while they match; while they do not, every poll re-reads them.
 */
export const EVM_DOMAIN_CHECK_MS = 5 * 60_000;

export const EVM_DOMAIN_MISMATCH_ALERT = 'evm_eip712_domain_mismatch';

interface ChainSnapshot {
  readonly paused: boolean;
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
 * Which doors close (assay-evm D-19): the pause closes every door here and
 * the blocklist closes them for a blocked party. The backend assumes the
 * upgraded contracts; at boot it logs one error per chain whose Config does
 * not answer `arbiter()` ({@link checkConfigUpgraded}).
 *
 * The EIP-712 domain guard (reviews evm-escrow R1, evm-stake-slash R-3): at
 * boot and on the poll, the live `DOMAIN_SEPARATOR()` of the Escrow and Stake
 * proxies is compared with the domain this backend signs under
 * ({@link readDomainMismatches}). On a mismatch it logs an error, raises a
 * CRITICAL alert, refuses the `REDEEM` door (voucher acceptance and seq
 * issuance) and answers {@link domainRefusal} for the slash executor, until the
 * domains match again. An unreadable separator keeps the last answer.
 */
export class EvmChainStateService implements ChainStateGatePort, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EvmChainStateService.name);
  private chains: ReadonlyMap<string, ChainSnapshot> = new Map();
  private timer: NodeJS.Timeout | null = null;
  /** Chains whose proxies sign under another EIP-712 domain: the contracts named. */
  private readonly domainMismatches = new Map<ChainId, string>();
  private domainCheckedAt = 0;

  constructor(
    private readonly repository: EvmChainStateRepository,
    private readonly clients: ReadonlyMap<ChainId, EvmChainStateClient>,
    private readonly deployments: ReadonlyMap<ChainId, EvmDeployment>,
    private readonly config: { readonly pollMs: number; readonly now?: () => number },
    private readonly alerts: AlertPort | null = null,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.deployments.size === 0) return;
    // Not awaited: a slow node must not hold boot up for a log line.
    for (const [chainId, deployment] of this.deployments) {
      const client = this.clients.get(chainId);
      if (client) void checkConfigUpgraded(client, deployment.config, chainId, this.logger);
    }
    await this.refresh().catch((error: unknown) =>
      this.logger.error(`EVM chain state could not be loaded at boot: ${describe(error)}`),
    );
    await this.checkDomains();
    this.timer = setInterval(() => {
      void this.refresh().catch((error: unknown) =>
        this.logger.warn(`EVM chain state poll failed: ${describe(error)}`),
      );
      if (
        this.domainMismatches.size > 0 ||
        this.now() - this.domainCheckedAt >= EVM_DOMAIN_CHECK_MS
      ) {
        void this.checkDomains();
      }
    }, this.config.pollMs);
    this.timer.unref?.();
  }

  private now(): number {
    return (this.config.now ?? Date.now)();
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
        blocked: new Set(
          blocked.filter((row) => row.chainId === state.chainId).map((row) => row.address),
        ),
      });
    }
    this.chains = next;
  }

  /**
   * Re-read every chain's proxies' `DOMAIN_SEPARATOR()` and update the guard.
   * Never throws: a chain that cannot be read keeps its last answer.
   */
  async checkDomains(): Promise<void> {
    this.domainCheckedAt = this.now();
    for (const [chainId, deployment] of this.deployments) {
      const client = this.clients.get(chainId);
      if (!client) continue;
      try {
        const mismatches = await readDomainMismatches(client, chainId, deployment);
        if (mismatches.length === 0) {
          if (this.domainMismatches.delete(chainId)) {
            this.logger.log(
              `the EIP-712 domains on ${chainId} match again; vouchers and slash proposals resume`,
            );
          }
          continue;
        }
        const contracts = mismatches.map((row) => row.contract).join(', ');
        const known = this.domainMismatches.get(chainId) === contracts;
        this.domainMismatches.set(chainId, contracts);
        if (known) continue;
        this.logger.error(
          `EIP-712 domain mismatch on ${chainId}: ${mismatches
            .map(
              (row) =>
                `${row.contract} ${row.address} reports ${row.live}, expected ${row.expected}`,
            )
            .join('; ')}. Vouchers and slash proposals are refused on ${chainId} until they match`,
        );
        await this.alerts
          ?.emit({
            severity: AlertSeverity.CRITICAL,
            name: EVM_DOMAIN_MISMATCH_ALERT,
            summary:
              `The settlement proxies on ${chainId} (${contracts}) sign under a different ` +
              `EIP-712 domain than this backend. Vouchers and slash proposals are refused there ` +
              `until the backend and the contracts agree`,
            details: {
              chainId,
              ...Object.fromEntries(
                mismatches.flatMap((row) => [
                  [`${row.contract}.live`, row.live],
                  [`${row.contract}.expected`, row.expected],
                ]),
              ),
            },
            aggregation: AlertAggregation.ONCE_PER_INCIDENT,
            dedupeKey: chainId,
          })
          .catch(() => undefined);
      } catch (error) {
        this.logger.warn(
          `the EIP-712 domains on ${chainId} could not be read; keeping the last answer ` +
            `(${this.domainMismatches.has(chainId) ? 'mismatch' : 'match'}): ${describe(error)}`,
        );
      }
    }
  }

  /** The refusal while `chainId`'s proxies sign under another EIP-712 domain, or `null`. */
  domainRefusal(chainId: string): Error | null {
    const contracts = this.domainMismatches.get(chainId as ChainId);
    return contracts ? ChainErrors.domainMismatch({ chainId, contracts }) : null;
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

  async blockedAccounts(chainId: string): Promise<readonly string[]> {
    const snapshot = this.chains.get(chainId);
    if (!snapshot || snapshot.blocked.size === 0) return [];
    const confirmed: string[] = [];
    for (const address of snapshot.blocked) {
      if (!isAddress(address, { strict: false })) continue;
      // `hold` mode: an unreadable confirmation does not keep the address out.
      if (await this.confirm(chainId as ChainId, 'blocked', [getAddress(address)], 'hold')) {
        confirmed.push(`${chainId}:${address.toLowerCase()}`);
      }
    }
    return confirmed;
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
      // A voucher accepted under another domain reverts at redemption: refused
      // here, never held (a hold can cost a voucher already accepted).
      const mismatch =
        door === ChainDoor.REDEEM && mode === 'refuse' && this.domainRefusal(chainId);
      if (mismatch) {
        return { error: mismatch, reason: mismatch.message };
      }
      const snapshot = this.chains.get(chainId);
      if (!snapshot) continue;
      if (snapshot.paused) {
        const live = await this.confirm(chainId, 'paused', [], mode);
        if (live) {
          return {
            error: ChainErrors.programPaused({ chainId, door }),
            reason: `the settlement contracts on ${chainId} are paused`,
          };
        }
      }
      for (const member of members) {
        if (!snapshot.blocked.has(member.address.toLowerCase())) continue;
        const live = await this.confirm(chainId, 'blocked', [member.address], mode);
        if (live) {
          return {
            error: ChainErrors.addressBlocked({
              chainId,
              role: member.role,
              account: member.address,
            }),
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

function evmParty(
  party: ChainParty,
): { chainId: ChainId; role: string; address: `0x${string}` } | null {
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
