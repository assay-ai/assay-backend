import { Injectable } from '@nestjs/common';
import { getAddress, isAddress } from 'viem';

import {
  EscrowBalanceReaderPort,
  EscrowChainBalance,
} from '@modules/ledger/ports/escrow-balance-reader.port';
import { MoneyUtil } from '@shared/utils/money.util';

import { ChainErrors } from '../errors/chains.errors';
import { getAssetMetadata } from '../ports/asset-registry';
import {
  AccountId,
  AssetId,
  ChainId,
  parseAccountId,
  toAccountId,
  toAssetId,
} from '../ports/caip.types';
import { ASSAY_ESCROW_ABI } from './abi/assay.abi';
import { EvmDeployment } from './evm.constants';

/**
 * One contract read, and one batched contract read.
 *
 * Declared structurally rather than as viem's `PublicClient`, for the reason
 * `sanctioned-evm-rpc.ts` gives about its own return type: annotating that
 * alias makes the compiler walk viem's whole action union (`TS2589`). It also
 * lets a test supply exactly these two instead of a whole RPC surface.
 *
 * **`allowFailure: false`.** A `stakeOf` or `escrowOf` is a mapping read that
 * cannot revert, so a failure means the call did not happen — a wrong address,
 * an unreachable node, a chain with no contract there. Letting one come back as
 * a per-item `{ status: 'failure' }` would put "we could not read" and "there is
 * nothing here" in the same shape, and the second is a first-class answer with
 * money consequences on both of these ports.
 */
export interface EvmReaderClient {
  readContract(args: {
    address: `0x${string}`;
    abi: unknown;
    functionName: string;
    args: readonly unknown[];
  }): Promise<unknown>;
  multicall(args: {
    contracts: readonly {
      address: `0x${string}`;
      abi: unknown;
      functionName: string;
      args: readonly unknown[];
    }[];
    /** `true` answers `{ status, result, error }` per call instead of throwing (viem). */
    allowFailure: boolean;
  }): Promise<readonly unknown[]>;
}

/** The twelve fields `escrowOf` returns, by name. */
export interface EvmEscrowStruct {
  readonly balance: bigint;
  readonly seqHigh: bigint;
  readonly authNonce: bigint;
  readonly maxVoucherAmount: bigint;
  readonly maxPerWindow: bigint;
  readonly spentInWindow: bigint;
  readonly windowStartedAt: bigint;
  readonly withdrawRequested: bigint;
  readonly withdrawAvailableAt: bigint;
  readonly totalRedeemed: bigint;
  readonly totalWithdrawn: bigint;
  readonly totalFunded: bigint;
}

/**
 * `EscrowBalanceReaderPort` over `AssayEscrow.escrowOf`.
 *
 * ## One read, no derivation
 *
 * `escrowOf` returns the whole twelve-field struct, so every field the port
 * declares comes out of one call. There is no second read, no ATA to fetch
 * beside the account, and nothing computed from anything else — the Solana
 * implementation next door needs two accounts because the balance lives in a
 * token account the escrow owns; here the contract holds every buyer's USDG in
 * one pool and `balance` is the buyer's slice of it, on the struct.
 *
 * ## `totalFunded === 0` is the only honest absence
 *
 * A Solidity mapping has no absence: a buyer nobody has ever touched reads back
 * as an all-zero struct, which is a real answer to a question nobody asked.
 * `null` is reserved for exactly that case. It is **not** keyed on `balance`,
 * because a buyer who deposited and withdrew everything has a zero balance and a
 * non-zero `totalFunded`, and reporting `null` for them would make their deposit
 * history disappear off the balance surface the moment they emptied it.
 *
 * ## No cache, deliberately
 *
 * The Solana reader carries a fresh/stale two-tier cache because its RPC is on
 * the path of every spend decision and it argues for serving a recent
 * reading over an outage. That argument is about a *policy*, and it belongs to
 * whoever owns the staleness budget — not to a second copy of it here that
 * could disagree. This reader fails closed by throwing, which is the strict end
 * of the port's own contract, and the namespace multiplexer can put a cache
 * in front of both implementations if one is ever wanted for both.
 */
@Injectable()
export class EvmEscrowBalanceReader implements EscrowBalanceReaderPort {
  constructor(
    private readonly clients: ReadonlyMap<ChainId, EvmReaderClient>,
    private readonly deployments: ReadonlyMap<ChainId, EvmDeployment>,
  ) {}

  async read(account: AccountId, asset: AssetId): Promise<EscrowChainBalance | null> {
    const { chainId, address } = this.parse(account);
    const deployment = this.assertAsset(chainId, asset);

    const escrow = (await this.client(chainId).readContract({
      address: getAddress(deployment.escrow),
      abi: ASSAY_ESCROW_ABI,
      functionName: 'escrowOf',
      args: [address],
    })) as EvmEscrowStruct;

    return this.toBalance(escrow, asset);
  }

  async readMany(
    accounts: readonly AccountId[],
    asset: AssetId,
  ): Promise<ReadonlyMap<AccountId, EscrowChainBalance | null>> {
    const found = new Map<AccountId, EscrowChainBalance | null>();
    if (accounts.length === 0) {
      return found;
    }

    // Grouped by chain because a multicall is one contract call on one chain,
    // and `readMany` is handed CAIP-10s that carry their own.
    for (const [chainId, group] of this.byChain(accounts)) {
      const deployment = this.assertAsset(chainId, asset);
      const escrow = getAddress(deployment.escrow);

      const results = await this.client(chainId).multicall({
        // One target for every entry — the escrow contract — and the buyer is
        // the ARGUMENT. There is no per-buyer address to call.
        contracts: group.map(({ address }) => ({
          address: escrow,
          abi: ASSAY_ESCROW_ABI,
          functionName: 'escrowOf',
          args: [address],
        })),
        allowFailure: false,
      });

      // Zipped back by POSITION, so a reply that does not answer for exactly
      // what was asked cannot be read at all — see the stake reader for the
      // longer form of this argument. Absence here is a first-class answer.
      if (results.length !== group.length) {
        throw ChainErrors.rpcReplyMalformed({
          method: 'multicall(escrowOf)',
          expected: group.length,
          actual: results.length,
        });
      }

      // A never-funded buyer maps to `null`: read, and nothing there. A failed
      // read throws above, so absence from the map never means "no escrow".
      group.forEach((entry, index) => {
        found.set(entry.account, this.toBalance(results[index] as EvmEscrowStruct, asset));
      });
    }

    return found;
  }

  /**
   * On EVM the contract is both.
   *
   * `escrowPda` and `escrowTokenAccount` are `EscrowBalanceReaderPort`'s Solana
   * vocabulary — there is no PDA here and no separate token account, because one
   * `AssayEscrow` holds every buyer's USDG and splits it in a mapping. Inventing
   * a second port to rename two strings would fork an interface every caller
   * reads, so the names stay and this comment carries the difference.
   */
  async escrowAddresses(
    account: AccountId,
    asset: AssetId,
  ): Promise<{ escrowPda: AccountId; escrowTokenAccount: AccountId }> {
    const { chainId } = this.parse(account);
    const deployment = this.assertAsset(chainId, asset);
    const escrow = toAccountId(chainId, getAddress(deployment.escrow));
    return { escrowPda: escrow, escrowTokenAccount: escrow };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private toBalance(escrow: EvmEscrowStruct, asset: AssetId): EscrowChainBalance | null {
    if (escrow.totalFunded === 0n) {
      return null;
    }

    return {
      balance: MoneyUtil.of(escrow.balance.toString(), asset, getAssetMetadata(asset).decimals),
      seqHigh: escrow.seqHigh,
      withdrawRequested: escrow.withdrawRequested,
      withdrawAvailableAt: Number(escrow.withdrawAvailableAt),
      maxVoucherAmount: escrow.maxVoucherAmount,
      maxPerWindow: escrow.maxPerWindow,
      spentInWindow: escrow.spentInWindow,
      windowStartedAt: Number(escrow.windowStartedAt),
      observedAt: new Date(),
      lifetime: {
        funded: escrow.totalFunded,
        redeemed: escrow.totalRedeemed,
        withdrawn: escrow.totalWithdrawn,
      },
    };
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

  /**
   * The reading door, applying EIP-55 **strictly** — see
   * `EvmChainAdapter.parseAccountId` for why the reading door is the one that
   * matters. CAIP-10's grammar accepts a broken checksum and viem's non-strict
   * `getAddress` then repairs it, so a reader without this check answers a
   * balance question about an address nobody verified.
   */
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

  /**
   * The asset has to be the one this deployment settles in.
   *
   * A reading denominated in an asset the escrow does not hold is a `Money`
   * that `MoneyUtil.add` will happily combine with a real one — the asset tag is
   * the only thing that would have stopped it, and it came from the caller.
   */
  private assertAsset(chainId: ChainId, asset: AssetId): EvmDeployment {
    const deployment = this.deployments.get(chainId);
    if (!deployment) {
      throw ChainErrors.unsupportedChain({ chainId });
    }
    const expected = toAssetId(chainId, 'erc20', getAddress(deployment.asset));
    if (asset !== expected) {
      throw ChainErrors.assetNotOnChain({ asset, chainId });
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
