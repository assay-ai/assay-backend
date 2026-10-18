import { Inject, Injectable } from '@nestjs/common';
import { encodeFunctionData, getAddress } from 'viem';

import {
  HeldKey,
  HeldPaymentsPort,
  HeldRecord,
  HeldStatus,
  HeldTxResult,
  MAX_HELD_BATCH,
} from '@modules/payment/ports/held-payments.port';

import { ChainErrors } from '../errors/chains.errors';
import { AssetId, ChainId, chainIdOf, parseAccountId, toAccountId } from '../ports/caip.types';
import {
  HELD_STATUS_BY_INDEX,
  X402_CONFIG_HOLD_ABI,
  X402_ESCROW_HOLD_ABI,
} from './abi/x402-hold.abi';
import { EvmDeployment } from './evm.constants';
import { EvmReaderClient } from './evm-escrow-balance-reader.service';
import { isRevert } from './evm-voucher-authority';
import { EVM_REDEEMER, EvmRelayerPort } from './ports/evm-relayer.port';

/** Gas for one held move, and for each further one in a batch. */
const HELD_BASE_GAS = 120_000n;
const HELD_PER_ITEM_GAS = 60_000n;

/**
 * The escrow's held payments on eip155 (G3.B1, `x402-hold.abi.ts`). Sends with
 * the REDEEMER key — the only sender `collectHeld` (before the timeout) and
 * `refundHeld` accept. A read that reverts means the escrow has no hold (not
 * yet upgraded): `null`, and the caller keeps the old pay-at-redemption path.
 */
@Injectable()
export class EvmHeldPayments implements HeldPaymentsPort {
  constructor(
    private readonly clients: ReadonlyMap<ChainId, EvmReaderClient>,
    private readonly deployments: ReadonlyMap<ChainId, EvmDeployment>,
    @Inject(EVM_REDEEMER) private readonly redeemer: EvmRelayerPort,
  ) {}

  async readHeld(asset: AssetId, key: HeldKey): Promise<HeldRecord | null> {
    const chainId = chainIdOf(asset);
    try {
      const raw = (await this.client(chainId).readContract({
        address: this.deployment(chainId).escrow,
        abi: X402_ESCROW_HOLD_ABI,
        functionName: 'held',
        args: [getAddress(parseAccountId(key.payer).address), BigInt(key.seq)],
      })) as {
        provider: string;
        amount: bigint;
        takeRateBps: number;
        status: number;
        collectableAt: bigint;
      };
      return {
        status: (HELD_STATUS_BY_INDEX[raw.status] ?? 'NONE') as HeldStatus,
        provider: raw.provider,
        amount: BigInt(raw.amount),
        takeRateBps: Number(raw.takeRateBps),
        collectableAt: new Date(Number(raw.collectableAt) * 1000),
      };
    } catch (error) {
      if (isRevert(error)) return null;
      throw error;
    }
  }

  collect(asset: AssetId, keys: readonly HeldKey[]): Promise<HeldTxResult> {
    return this.send(asset, keys, 'collectHeld', 'collectHeldBatch');
  }

  refund(asset: AssetId, keys: readonly HeldKey[]): Promise<HeldTxResult> {
    return this.send(asset, keys, 'refundHeld', 'refundHeldBatch');
  }

  async totalHeld(asset: AssetId): Promise<bigint | null> {
    const chainId = chainIdOf(asset);
    try {
      return BigInt(
        (await this.client(chainId).readContract({
          address: this.deployment(chainId).escrow,
          abi: X402_ESCROW_HOLD_ABI,
          functionName: 'totalHeld',
          args: [],
        })) as bigint,
      );
    } catch (error) {
      if (isRevert(error)) return null;
      throw error;
    }
  }

  async collectHoldSeconds(asset: AssetId): Promise<number | null> {
    const chainId = chainIdOf(asset);
    try {
      return Number(
        (await this.client(chainId).readContract({
          address: this.deployment(chainId).config,
          abi: X402_CONFIG_HOLD_ABI,
          functionName: 'collectHoldSeconds',
          args: [],
        })) as bigint,
      );
    } catch (error) {
      if (isRevert(error)) return null;
      throw error;
    }
  }

  private async send(
    asset: AssetId,
    keys: readonly HeldKey[],
    single: 'collectHeld' | 'refundHeld',
    batch: 'collectHeldBatch' | 'refundHeldBatch',
  ): Promise<HeldTxResult> {
    if (keys.length === 0 || keys.length > MAX_HELD_BATCH) {
      throw ChainErrors.payloadMalformed({
        reason: `a held batch of ${keys.length} is outside 1..${MAX_HELD_BATCH}`,
      });
    }
    const chainId = chainIdOf(asset);
    const payers = keys.map((key) => getAddress(parseAccountId(key.payer).address));
    const seqs = keys.map((key) => BigInt(key.seq));
    const data =
      keys.length === 1
        ? encodeFunctionData({
            abi: X402_ESCROW_HOLD_ABI,
            functionName: single,
            args: [payers[0], seqs[0]],
          })
        : encodeFunctionData({
            abi: X402_ESCROW_HOLD_ABI,
            functionName: batch,
            args: [payers, seqs],
          });
    const result = await this.redeemer.sendCall({
      chainId,
      to: toAccountId(chainId, getAddress(this.deployment(chainId).escrow)),
      data,
      gasLimit: HELD_BASE_GAS + HELD_PER_ITEM_GAS * BigInt(keys.length - 1),
      purpose: `${keys.length === 1 ? single : batch} n=${keys.length}`,
    });
    if (result.status !== 'SUCCESS') {
      throw ChainErrors.payloadMalformed({
        reason: `${single} reverted: ${result.revertReason ?? 'unknown'} (${result.hash})`,
      });
    }
    return { txRef: result.hash };
  }

  private client(chainId: ChainId): EvmReaderClient {
    const client = this.clients.get(chainId);
    if (!client) throw ChainErrors.unsupportedChain({ chainId });
    return client;
  }

  private deployment(chainId: ChainId): EvmDeployment {
    const deployment = this.deployments.get(chainId);
    if (!deployment) throw ChainErrors.unsupportedChain({ chainId });
    return deployment;
  }
}
