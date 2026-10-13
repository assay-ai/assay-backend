import { Injectable } from '@nestjs/common';
import { encodeFunctionData, getAddress, isAddress, parseEventLogs } from 'viem';

import {
  GAS_NOT_SPONSORED_REASON,
  StakeAsset,
  StakeIntentBuilderPort,
  StakeIntentKind,
  StakeIntentPreflight,
  StakeIntentRequest,
  ConfirmedDepositExpectation,
} from '@modules/provider/ports/stake-intent-builder.port';
import { MoneyUtil } from '@shared/utils/money.util';

import { ChainErrors } from '../errors/chains.errors';
import { getAssetMetadata } from '../ports/asset-registry';
import { AccountId, AssetId, ChainId, parseAccountId, toAssetId } from '../ports/caip.types';
import { Money } from '../ports/money.types';
import { UnsignedChainTransaction } from '../ports/unsigned-chain-transaction';
import { ERC20_ABI, X402_STAKE_ABI } from './abi/x402.abi';
import { EvmDeployment } from './evm.constants';

/**
 * The slice of a viem `PublicClient` this builder needs. There is no
 * `sendRawTransaction` and no wallet client: see the class comment.
 */
export interface EvmStakeIntentClient {
  readContract(args: {
    address: `0x${string}`;
    abi: unknown;
    functionName: string;
    args: readonly unknown[];
  }): Promise<unknown>;
  getBalance(args: { address: `0x${string}` }): Promise<bigint>;
  getTransactionCount(args: { address: `0x${string}`; blockTag: 'pending' }): Promise<number>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  getTransactionReceipt(args: { hash: `0x${string}` }): Promise<{
    readonly status: 'success' | 'reverted';
    readonly blockNumber: bigint;
    readonly logs: readonly {
      readonly address: string;
      readonly topics: readonly string[];
      readonly data: string;
    }[];
  }>;
  /** For the mined block's timestamp (seconds). */
  getBlock(args: { blockNumber: bigint }): Promise<{ readonly timestamp: bigint }>;
}

/**
 * Gas **ceilings** per door, in gas units — quoted to the provider before they
 * sign and written as the transaction's `gasLimit`.
 *
 * A ceiling rather than an `eth_estimateGas`, for the reason
 * `STAKE_INTENT_GAS_LAMPORTS` gives on Solana and one this chain adds: a
 * `depositStake` cannot be estimated at all until the `approve` before it is
 * mined — estimation runs `transferFrom` against a zero allowance and reverts.
 * The wallet re-estimates after approving (`frontend/src/features/provider-stake`),
 * so these numbers bound the preflight, not the fee actually paid.
 *
 * Measured on an anvil fork of `eip155:46630`, 2026-09-23: `approve` 57,535,
 * `depositStake` 166,443 (157,281 used), `requestUnstake` 61,251. Each ceiling
 * is roughly twice the measurement, because the chain's own estimate includes
 * an L1 data component the fork does not.
 */
export const EVM_STAKE_GAS_CEILING = {
  APPROVE: 120_000n,
  DEPOSIT: 350_000n,
  UNSTAKE: 150_000n,
  WITHDRAW: 150_000n,
} as const;

/** Wei per ether, as a scale. */
const WEI_DECIMALS = 18;

/** CAIP-19 for the native asset of an eip155 chain. `slip44:60` is ETH. */
function nativeAssetIdOf(chain: ChainId): AssetId {
  return toAssetId(chain, 'slip44', '60');
}

/**
 * The provider's stake doors on `eip155`, build-only.
 *
 * ## There is nothing to open
 *
 * `X402Stake` keys `mapping(address => ProviderStake)` on the provider, and the
 * first `depositStakeFor` writes the row. So {@link needsOpenStake} is `false`
 * and an `OPEN_STAKE` request is refused by name — the same fact
 * `EvmEscrowOpener` states for a buyer's escrow, answered in the port's type
 * rather than discovered at a call site.
 *
 * ## A deposit is two transactions, and this builds the second
 *
 * `depositStakeFor` pulls with `safeTransferFrom`, so the wallet must first
 * `approve(stake, amount)` on the asset. That approval is the frontend's to
 * sequence — the buyer's deposit path already does exactly this — because its
 * nonce and the deposit's nonce are consecutive and only the wallet knows when
 * the first one has landed. The preflight's `requiredGas` covers both.
 *
 * ## No `sendRawTransaction`, no key
 *
 * Same rule as `SolanaStakeIntentBuilder`: a provider's stake is theirs, and
 * `withdrawStake` is `msg.sender`-only on chain. The client interface above has
 * no send method, so there is nothing here for a later call site to reach for.
 */
@Injectable()
export class EvmStakeIntentBuilder implements StakeIntentBuilderPort {
  constructor(
    private readonly clients: ReadonlyMap<ChainId, EvmStakeIntentClient>,
    private readonly deployments: ReadonlyMap<ChainId, EvmDeployment>,
  ) {}

  /**
   * The deployment's `asset` — the same address `EvmStakeReader` quotes stake
   * in, so a deposit and the balance it moves cannot name different tokens.
   */
  async stakeAsset(chain: ChainId): Promise<StakeAsset> {
    const asset = toAssetId(chain, 'erc20', getAddress(this.deployment(chain).asset));
    return { asset, decimals: getAssetMetadata(asset).decimals };
  }

  needsOpenStake(_chain: ChainId): boolean {
    return false;
  }

  async preflight(request: StakeIntentRequest): Promise<StakeIntentPreflight> {
    return (await this.resolve(request)).preflight;
  }

  async buildIntent(
    request: StakeIntentRequest,
  ): Promise<{ transaction: UnsignedChainTransaction; preflight: StakeIntentPreflight }> {
    const context = await this.resolve(request);
    const { chainId, deployment } = context;

    const nonce = await this.client(chainId).getTransactionCount({
      address: context.sender,
      blockTag: 'pending',
    });

    return {
      transaction: {
        namespace: 'eip155',
        chainId,
        kind: 'transaction',
        from: context.sender,
        to: getAddress(deployment.stake),
        data: this.calldataFor(request, context),
        value: '0',
        nonce: nonce.toString(),
        gasLimit: EVM_STAKE_GAS_CEILING[context.kind].toString(),
        maxFeePerGas: context.fees.maxFeePerGas.toString(),
        maxPriorityFeePerGas: context.fees.maxPriorityFeePerGas.toString(),
      },
      preflight: context.preflight,
    };
  }

  /**
   * What one mined transaction deposited into this provider's stake, read off
   * the `StakeDeposited` events the stake proxy emitted — the amount is the
   * event's, never the caller's. `null` for a reverted transaction, an unknown
   * hash, or a transaction with no deposit for this provider; see the port for
   * why the three are one answer.
   */
  async confirmedDeposit(
    signature: string,
    account: AccountId,
    expected: ConfirmedDepositExpectation,
  ): Promise<Money | null> {
    const { chainId, address: provider } = this.parse(account);
    const { address: funder } = this.parse(expected.funder);
    const deployment = this.deployment(chainId);
    const { asset, decimals } = await this.stakeAsset(chainId);

    let receipt: Awaited<ReturnType<EvmStakeIntentClient['getTransactionReceipt']>>;
    try {
      receipt = await this.client(chainId).getTransactionReceipt({
        hash: signature as `0x${string}`,
      });
    } catch {
      // viem throws `TransactionReceiptNotFoundError` for an unknown or
      // not-yet-mined hash. Absence is an answer here, not a failure.
      return null;
    }
    if (receipt.status !== 'success') {
      return null;
    }

    const stake = getAddress(deployment.stake);
    const events = parseEventLogs({
      abi: X402_STAKE_ABI,
      eventName: 'StakeDeposited',
      logs: receipt.logs.filter((log) => getAddress(log.address) === stake) as never,
    });

    // Only what the treasury funded counts (review M-3): a provider's own
    // deposit, or anybody else's, is not a compensation.
    let total = 0n;
    for (const event of events) {
      if (getAddress(event.args.provider) !== provider) continue;
      if (getAddress(event.args.funder) !== funder) continue;
      total += event.args.amount;
    }
    if (total === 0n) return null;

    // And only a deposit made after the slash executed: one earlier deposit
    // must not be presented as the repayment of a later penalty.
    let minedAtMs: number;
    try {
      const block = await this.client(chainId).getBlock({ blockNumber: receipt.blockNumber });
      minedAtMs = Number(block.timestamp) * 1000;
    } catch {
      return null;
    }
    if (!(minedAtMs > expected.after.getTime())) return null;

    return MoneyUtil.of(total, asset, decimals);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async resolve(request: StakeIntentRequest): Promise<StakeIntentContext> {
    if (request.kind === StakeIntentKind.OPEN_STAKE) {
      throw ChainErrors.payloadMalformed({
        reason:
          'there is no stake account to open on eip155: X402Stake keys a mapping on the ' +
          'provider, and the first depositStake writes it',
      });
    }

    const { chainId, address: provider } = this.parse(request.account);
    const deployment = this.deployment(chainId);
    const { asset, decimals } = await this.stakeAsset(chainId);
    // Normally the provider. A treasury-funded compensation deposit is the one
    // case where they differ — see `StakeIntentRequest.funder`.
    const sender = request.funder ? this.parse(request.funder).address : provider;

    const amount = this.requireAmount(request, asset);
    const requiredStakeAsset =
      request.kind === StakeIntentKind.DEPOSIT ? amount : MoneyUtil.zero(asset, decimals);

    const client = this.client(chainId);
    const [tokenAtomic, wei, fees] = await Promise.all([
      client.readContract({
        address: getAddress(deployment.asset),
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [sender],
      }) as Promise<bigint>,
      client.getBalance({ address: sender }),
      client.estimateFeesPerGas(),
    ]);

    const gasUnits =
      request.kind === StakeIntentKind.DEPOSIT
        ? EVM_STAKE_GAS_CEILING.APPROVE + EVM_STAKE_GAS_CEILING.DEPOSIT
        : EVM_STAKE_GAS_CEILING[request.kind];
    const native = nativeAssetIdOf(chainId);
    const requiredGas = MoneyUtil.of(gasUnits * fees.maxFeePerGas, native, WEI_DECIMALS);
    const gasBalance = MoneyUtil.of(wei, native, WEI_DECIMALS);
    // An ERC-20 balance always exists — a mapping read of an untouched address
    // is a real zero, not the "no token account" Solana's `null` means.
    const stakeAssetBalance = MoneyUtil.of(tokenAtomic, asset, decimals);

    return {
      kind: request.kind,
      chainId,
      deployment,
      provider,
      sender,
      amount,
      fees,
      preflight: {
        requiredStakeAsset,
        stakeAssetBalance,
        requiredGas,
        gasBalance,
        hasEnoughStakeAsset: MoneyUtil.greaterThanOrEqual(stakeAssetBalance, requiredStakeAsset),
        hasEnoughGas: MoneyUtil.greaterThanOrEqual(gasBalance, requiredGas),
        gasSponsored: false,
        gasNotSponsoredReason: GAS_NOT_SPONSORED_REASON,
      },
    };
  }

  private calldataFor(request: StakeIntentRequest, context: StakeIntentContext): `0x${string}` {
    const amount = MoneyUtil.toAtomic(context.amount);

    switch (context.kind) {
      case StakeIntentKind.DEPOSIT:
        return request.funder
          ? encodeFunctionData({
              abi: X402_STAKE_ABI,
              functionName: 'depositStakeFor',
              args: [context.provider, amount],
            })
          : encodeFunctionData({
              abi: X402_STAKE_ABI,
              functionName: 'depositStake',
              args: [amount],
            });
      case StakeIntentKind.UNSTAKE:
        return encodeFunctionData({
          abi: X402_STAKE_ABI,
          functionName: 'requestUnstake',
          args: [amount],
        });
      case StakeIntentKind.WITHDRAW:
        return encodeFunctionData({
          abi: X402_STAKE_ABI,
          functionName: 'withdrawStake',
          args: [amount],
        });
    }
  }

  /** Refused rather than defaulted — see `SolanaStakeIntentBuilder.requireAmount`. */
  private requireAmount(request: StakeIntentRequest, asset: AssetId): Money {
    if (!request.amount) {
      throw ChainErrors.programNotConfigured({
        what: `an amount for a ${request.kind} stake intent`,
        variable: 'amount',
      });
    }
    if (request.amount.asset !== asset) {
      throw ChainErrors.assetUnknown({ asset: request.amount.asset });
    }
    return request.amount;
  }

  private parse(account: AccountId): { chainId: ChainId; address: `0x${string}` } {
    const parsed = parseAccountId(account);
    this.deployment(parsed.chainId);
    if (!isAddress(parsed.address, { strict: false })) {
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

  private client(chainId: ChainId): EvmStakeIntentClient {
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

/** One request's resolved addresses, fees and preflight. */
interface StakeIntentContext {
  readonly kind: Exclude<StakeIntentKind, StakeIntentKind.OPEN_STAKE>;
  readonly chainId: ChainId;
  readonly deployment: EvmDeployment;
  readonly provider: `0x${string}`;
  /** Who signs and pays: the provider, unless a `funder` was named. */
  readonly sender: `0x${string}`;
  readonly amount: Money;
  readonly fees: { readonly maxFeePerGas: bigint; readonly maxPriorityFeePerGas: bigint };
  readonly preflight: StakeIntentPreflight;
}
