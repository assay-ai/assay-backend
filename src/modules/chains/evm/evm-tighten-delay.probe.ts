import { Logger } from '@nestjs/common';
import { getAddress, zeroAddress } from 'viem';

import { TightenDelayPort } from '@modules/settlement/ports/tighten-delay.port';

import { AccountId, ChainId, parseAccountId } from '../ports/caip.types';
import { X402_ESCROW_ABI } from './abi/x402.abi';
import { EvmDeployment } from './evm.constants';
import { EvmReaderClient } from './evm-escrow-balance-reader.service';
import { isRevert } from './evm-voucher-authority';

/** How long an escrow found WITHOUT the tighten delay is believed before it is asked again. */
export const EVM_TIGHTEN_DELAY_REPROBE_MS = 60_000;

export interface EvmTightenDelayProbeConfig {
  readonly now: () => number;
  readonly reprobeMs?: number;
}

/**
 * Whether each chain's `X402Escrow` is the D-21 upgrade (assay-evm f814629),
 * found by asking it rather than by a flag somebody must flip.
 *
 * ## The probe
 *
 * `effectiveCapsOf(0, 0)` — a view the upgrade adds and nothing before it has.
 * The proxy's implementation has no fallback, so the old one REVERTS on the
 * unknown selector (measured on 46630: `ContractFunctionRevertedError`), and
 * the new one answers four zeros. A revert is "not upgraded"; any other
 * failure (an RPC down, a timeout) is "unknown" and is thrown, never cached.
 *
 * ## Why not the implementation address, or a boot-time check
 *
 * The ERC-1967 slot says WHICH implementation runs, not what it can do: it
 * would need the new address pinned here before the upgrade happens. The
 * function itself is the capability the backend is about to rely on, so it is
 * what is asked. A boot-time check alone would leave a running backend on the
 * old rule after the upgrade until somebody restarted it.
 *
 * ## Caching
 *
 * An upgrade cannot be undone without another upgrade, so a positive answer is
 * kept for the life of the process. A negative one is re-asked after
 * {@link EVM_TIGHTEN_DELAY_REPROBE_MS}, so the backend follows the upgrade
 * within a minute of it landing, with one cheap `eth_call` a minute until then.
 * Until it does, every caller keeps the strict pre-upgrade behaviour, which is
 * correct on both contracts — only more conservative on the new one.
 */
export class EvmTightenDelayProbe implements TightenDelayPort {
  private readonly logger = new Logger(EvmTightenDelayProbe.name);
  private readonly live = new Set<ChainId>();
  private readonly absentUntil = new Map<ChainId, number>();

  constructor(
    private readonly clients: ReadonlyMap<ChainId, EvmReaderClient>,
    private readonly deployments: ReadonlyMap<ChainId, EvmDeployment>,
    private readonly config: EvmTightenDelayProbeConfig,
  ) {}

  /**
   * True once the chain's escrow is known to have the tighten delay. Throws
   * when it could not be asked; a chain this backend has no escrow on is false.
   */
  async isLive(chainId: ChainId): Promise<boolean> {
    if (this.live.has(chainId)) return true;
    const deployment = this.deployments.get(chainId);
    const client = this.clients.get(chainId);
    if (!deployment || !client) return false;
    const until = this.absentUntil.get(chainId);
    if (until !== undefined && this.config.now() < until) return false;

    try {
      await client.readContract({
        address: getAddress(deployment.escrow),
        abi: X402_ESCROW_ABI,
        functionName: 'effectiveCapsOf',
        args: [zeroAddress, zeroAddress],
      });
    } catch (error) {
      if (!isRevert(error)) throw error;
      this.absentUntil.set(
        chainId,
        this.config.now() + (this.config.reprobeMs ?? EVM_TIGHTEN_DELAY_REPROBE_MS),
      );
      return false;
    }
    this.live.add(chainId);
    this.absentUntil.delete(chainId);
    this.logger.log(
      `X402Escrow on ${chainId} has the tighten delay (effectiveCapsOf answered): redemption ` +
        'reads the effective caps and the strand guard stands down',
    );
    return true;
  }

  /** {@link TightenDelayPort}: never throws — an unknown answer is `false`, the strict side. */
  async holdsTightening(payer: AccountId): Promise<boolean> {
    try {
      return await this.isLive(parseAccountId(payer).chainId);
    } catch (error) {
      this.logger.warn(
        `could not tell whether the escrow of ${payer} has the tighten delay; keeping the ` +
          `strand guard: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}
