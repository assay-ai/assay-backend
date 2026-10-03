import { Injectable } from '@nestjs/common';
import { getAddress, isAddress } from 'viem';

import {
  OnChainStake,
  OnChainStakeReaderPort,
} from '@modules/provider/ports/onchain-stake-reader.port';
import { MoneyUtil } from '@shared/utils/money.util';

import { ChainErrors } from '../errors/chains.errors';
import { getAssetMetadata } from '../ports/asset-registry';
import { AccountId, ChainId, parseAccountId, toAssetId } from '../ports/caip.types';
import { X402_CONFIG_ABI, X402_STAKE_ABI } from './abi/x402.abi';
import { EvmDeployment } from './evm.constants';
import { EvmReaderClient } from './evm-escrow-balance-reader.service';

/** The ten fields `stakeOf` returns, by name. `__gap` is on the wire and ignored. */
export interface EvmProviderStakeStruct {
  readonly bonded: bigint;
  readonly unbonding: bigint;
  readonly unbondingStartedAt: bigint;
  readonly slashedInWindow: bigint;
  readonly slashWindowStartedAt: bigint;
  readonly pendingSlash: bigint;
  readonly __gap: bigint;
  readonly totalDeposited: bigint;
  readonly totalWithdrawn: bigint;
  readonly totalSlashed: bigint;
}

/** The `ParamSet` fields this reader consumes. */
interface EvmParamSet {
  readonly unbondingPeriodSeconds: bigint;
}

export interface EvmStakeReaderConfig {
  /** Milliseconds. Injected so a test can age the parameter memo. */
  readonly now: () => number;
  /** How long a `params()` reading is reused before it is fetched again. */
  readonly paramsTtlMs: number;
}

/** `params()` moves only on an admin `updateConfig`; a minute bounds the lag. */
export const DEFAULT_EVM_PARAMS_TTL_MS = 60_000;

/**
 * `OnChainStakeReaderPort` over `X402Stake.stakeOf`.
 *
 * ## `bonded` alone is the routable figure
 *
 * `_redeem` reads `bondedOf(provider) < p.minimumStake`, and `X402Stake`'s own
 * note says why: stake the provider has already asked to take out is not
 * backing anybody's traffic, even though it stays slashable for the whole
 * unbonding period. Folding `unbonding` into `bonded` here would let a provider
 * request a full unstake and go on serving paid traffic for the entire period
 * with a gate that says they are covered. `unbonding` is reported in its own
 * field for the rotation gate, which asks the other question.
 *
 * ## Absence, on a chain that has none
 *
 * `stakeOf` is a mapping read: a provider who has never staked comes back as an
 * all-zero struct, not as nothing. The port is explicit that absent is not zero
 * — its two callers read absence as "there is nothing here to walk away from"
 * and as "no known stake" — so `totalDeposited === 0` stands in for it, exactly
 * as `totalFunded` does on the escrow side. A provider who staked and later
 * withdrew everything stays **present at zero**, which is a measurement rather
 * than a gap.
 *
 * ## Why `unbondingPeriodSeconds` is read from the chain
 *
 * It is a `ParamSet` field an admin can move with `updateConfig`, so a copy of
 * it in the domain module or an env var is a number that can silently disagree
 * with the one the withdrawal gate enforces. It is memoised per chain with a
 * short TTL and the memo is **dropped on failure**, so one unreachable RPC does
 * not poison the process for the rest of its life.
 */
@Injectable()
export class EvmStakeReader implements OnChainStakeReaderPort {
  /** `chainId` → the in-flight or settled parameter read, and when it started. */
  private readonly params = new Map<
    ChainId,
    { readonly at: number; readonly value: Promise<EvmParamSet> }
  >();

  constructor(
    private readonly clients: ReadonlyMap<ChainId, EvmReaderClient>,
    private readonly deployments: ReadonlyMap<ChainId, EvmDeployment>,
    private readonly config: EvmStakeReaderConfig,
  ) {}

  async bondedStakeOf(
    accounts: readonly AccountId[],
  ): Promise<ReadonlyMap<AccountId, OnChainStake>> {
    const found = new Map<AccountId, OnChainStake>();
    if (accounts.length === 0) {
      return found;
    }

    for (const [chainId, group] of this.byChain(accounts)) {
      const deployment = this.deployment(chainId);
      const { unbondingPeriodSeconds } = await this.paramsFor(chainId);
      const asset = toAssetId(chainId, 'erc20', getAddress(deployment.asset));
      const decimals = getAssetMetadata(asset).decimals;

      const results = await this.client(chainId).multicall({
        contracts: group.map(({ address }) => ({
          address: getAddress(deployment.stake),
          abi: X402_STAKE_ABI,
          functionName: 'stakeOf',
          args: [address],
        })),
        allowFailure: false,
      });

      // Zipped back onto the request by POSITION, so a reply that does not
      // answer for exactly what was asked cannot be read at all. Unreadable
      // must never resolve to empty: absence is what the rotation gate reads as
      // "the provider has fully exited", and a truncated reply would hand a
      // defector the rotation that lets a slash follow their new key to an
      // empty account while the collateral stays behind.
      if (results.length !== group.length) {
        throw ChainErrors.rpcReplyMalformed({
          method: 'multicall(stakeOf)',
          expected: group.length,
          actual: results.length,
        });
      }

      // One timestamp per round trip, taken after it returns: this is what
      // travels to the gate, and it has to name the moment the chain answered.
      const observedAt = new Date();

      group.forEach((entry, index) => {
        const stake = results[index] as EvmProviderStakeStruct;
        // Never staked. See the class comment — this is the mapping's absence.
        if (stake.totalDeposited === 0n) {
          return;
        }

        const startedAt = stake.unbondingStartedAt;
        found.set(entry.account, {
          account: entry.account,
          // `bonded` and `unbonding`, never summed. Two fields, two questions.
          bonded: MoneyUtil.of(stake.bonded.toString(), asset, decimals),
          unbonding: MoneyUtil.of(stake.unbonding.toString(), asset, decimals),
          // `0` is "nothing unbonding", not 1970.
          unbondingStartedAt: startedAt === 0n ? null : new Date(Number(startedAt) * 1000),
          unbondingCompletesAt:
            startedAt === 0n
              ? null
              : new Date((Number(startedAt) + Number(unbondingPeriodSeconds)) * 1000),
          observedAt,
        });
      });
    }

    return found;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async paramsFor(chainId: ChainId): Promise<EvmParamSet> {
    const cached = this.params.get(chainId);
    if (cached && this.config.now() - cached.at < this.config.paramsTtlMs) {
      return cached.value;
    }

    const value = this.fetchParams(chainId).catch((error: unknown) => {
      // A rejected promise left in the map would make one transient RPC failure
      // permanent for the rest of the TTL, and every stake read with it.
      this.params.delete(chainId);
      throw error;
    });
    this.params.set(chainId, { at: this.config.now(), value });
    return value;
  }

  private async fetchParams(chainId: ChainId): Promise<EvmParamSet> {
    const deployment = this.deployment(chainId);
    const params = (await this.client(chainId).readContract({
      address: getAddress(deployment.config),
      abi: X402_CONFIG_ABI,
      functionName: 'params',
      args: [],
    })) as EvmParamSet;
    return { unbondingPeriodSeconds: params.unbondingPeriodSeconds };
  }

  private byChain(
    accounts: readonly AccountId[],
  ): ReadonlyMap<ChainId, readonly { account: AccountId; address: `0x${string}` }[]> {
    const groups = new Map<ChainId, { account: AccountId; address: `0x${string}` }[]>();
    for (const account of accounts) {
      const { chainId, address } = this.parse(account);
      const group = groups.get(chainId) ?? [];
      group.push({ account, address });
      groups.set(chainId, group);
    }
    return groups;
  }

  /** EIP-55, strictly — the same reading door the escrow reader argues for. */
  private parse(account: AccountId): { chainId: ChainId; address: `0x${string}` } {
    const parsed = parseAccountId(account);
    if (!this.deployments.has(parsed.chainId)) {
      throw ChainErrors.unsupportedChain({ chainId: parsed.chainId });
    }
    if (!isAddress(parsed.address, { strict: true })) {
      throw ChainErrors.invalidAddress({ chainId: parsed.chainId, address: parsed.address });
    }
    return { chainId: parsed.chainId, address: getAddress(parsed.address) };
  }

  private deployment(chainId: ChainId): EvmDeployment {
    const deployment = this.deployments.get(chainId);
    if (!deployment) {
      throw ChainErrors.unsupportedChain({ chainId });
    }
    return deployment;
  }

  private client(chainId: ChainId): EvmReaderClient {
    const client = this.clients.get(chainId);
    if (!client) {
      throw ChainErrors.programNotConfigured({
        what: `a JSON-RPC client for ${chainId}`,
        variable: 'EVM_RPC_URLS',
      });
    }
    return client;
  }
}
