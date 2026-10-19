import { Injectable, Logger } from '@nestjs/common';
import { getAddress, zeroAddress } from 'viem';

import { MoneyUtil } from '@shared/utils/money.util';

import { ChainErrors } from '../errors/chains.errors';
import { getAssetMetadata } from '../ports/asset-registry';
import {
  AccountId,
  AssetId,
  ChainId,
  ChainNamespace,
  namespaceOf,
  parseAssetId,
  toAccountId,
  toAssetId,
} from '../ports/caip.types';
import { Money } from '../ports/money.types';
import { VaultPort } from '../ports/vault.port';
import { ERC20_ABI, X402_CONFIG_ABI, X402_ESCROW_ABI } from './abi/x402.abi';
import { EvmDeployment } from './evm.constants';

/** Per chain, the derived addresses of this process's redeemer and relayer keys. */
export interface EvmKeyAddresses {
  readonly redeemer: ReadonlyMap<ChainId, `0x${string}`>;
  readonly relayer: ReadonlyMap<ChainId, `0x${string}`>;
}

/**
 * `keccak256("eip1967.proxy.implementation") - 1` — where an ERC-1967 proxy
 * keeps the address it delegates to.
 *
 * The same 32 bytes `assay-evm/script/verify-deployment.sh:43` reads with `cast
 * storage`, so the check an operator runs by hand before a handover and the
 * check the reconciler runs every five minutes are asking the chain the same
 * question at the same address.
 */
export const ERC1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const;

/**
 * The three JSON-RPC reads this port makes.
 *
 * Declared structurally rather than as viem's `PublicClient`, for the reason
 * `sanctioned-evm-rpc.ts` gives about its own return type: annotating that
 * alias makes the compiler walk viem's whole action union (`TS2589`).
 */
export interface EvmVaultClient {
  getBlockNumber(args?: { cacheTime?: number }): Promise<bigint>;
  getStorageAt(args: {
    address: `0x${string}`;
    slot: `0x${string}`;
  }): Promise<`0x${string}` | undefined>;
  readContract(args: {
    address: `0x${string}`;
    abi: unknown;
    functionName: string;
    args?: readonly unknown[];
    blockNumber?: bigint;
  }): Promise<unknown>;
}

/**
 * `VaultPort` for an `eip155` chain.
 *
 * ## The vault IS the escrow contract, and there is no second account
 *
 * `X402Escrow` holds the USDG itself and is authorised by its own code. So `getVaultOwner` and
 * `getVaultAccount` return the same address, which is not a shortcut — it is
 * the shape of the thing. Neither costs a round trip: the answer is the
 * deployment record, and the record is what `assertVaultControl` checks.
 *
 * ## What "control" means here, and it is four reads
 *
 * There is no program to ask. The question that carries the same weight is
 * *"is the code behind this address the code we deployed, and are the keys that
 * can replace or re-parameterise it the keys we recorded?"* — so:
 *
 *   1. the ERC-1967 implementation slot equals `deployment.escrowImplementation`;
 *   2. `CONFIG.owner()` equals `deployment.owner` — the UUPS upgrade authority
 *      of all three contracts (assay-evm D-17);
 *   3. `CONFIG.admin()` equals `deployment.admin` — the operational key
 *      (pause, parameters, verifier registry), which the owner appoints and
 *      which can NOT upgrade;
 *   4. `ASSET()` equals the asset being reconciled.
 *
 * Any of the four failing is `CHAIN_VAULT_CONTROL_UNVERIFIED`, thrown at the
 * point of use and **naming which one**, because the four are four different
 * incidents with no overlapping remedy. `ReconciliationService.run` calls this
 * FIRST for the reason its own comment gives: a vault balance read from an
 * address whose control has not been proven is not evidence of anything, and it
 * would look authoritative in the stored row for ever.
 *
 * Then one more, about THIS process's keys rather than the contract:
 *
 *   5. `params().redeemer` is the address of this process's `EVM_REDEEMER_KEYS`
 *      key for the chain, and is NOT the address of its `EVM_RELAYER_KEYS` key.
 *      Each half is checked only when that key is configured here. Without it
 *      the key split is unenforced: keeping the old key as the relayer and
 *      adding a new redeemer key boots fine, refuses every redemption, and
 *      leaves the hot relayer key as the on-chain redeemer.
 *
 * There is deliberately no read of `CONFIG()` on the escrow. `CONFIG` is
 * storage written once in `initialize` and never again, so the only way it can
 * move is an upgrade — which check 1 already refuses. Another read would be a
 * second spelling of the first. A non-zero `pendingOwner()` only WARNS: a
 * transfer in progress has not moved the authority, and `owner()` changes (and
 * check 2 fails) the moment it completes. The warning is there so a proposal
 * nobody recorded is seen before it is accepted.
 *
 * ## Why no `balanceOf`-based solvency check appears here, and none may be added
 *
 * `X402Escrow`'s four `balanceOf` reads are all delta halves. A solvency
 * assertion over the pooled balance would refuse EVERY withdrawal rather than
 * the one actually affected the moment anything is off by a unit — USDG is an
 * upgradeable proxy with a blocklist, and a blocklisted contract's
 * `balanceOf` and its entitlements would disagree. The reconciler compares and
 * records; it never gates.
 *
 * ## `slot` is a block number, and the name stays
 *
 * The port's shape is shared and `reconciliation_runs.vault_slot` is a
 * `numeric` column. Renaming the field here would fork a schema and a wire
 * contract for a vocabulary difference between two chains, so it does not
 * happen — this paragraph is here because the next reader will otherwise
 * think it is a copy-paste from the Solana implementation.
 */
@Injectable()
export class EvmVaultService implements VaultPort {
  private readonly logger = new Logger(EvmVaultService.name);

  constructor(
    private readonly clients: ReadonlyMap<ChainId, EvmVaultClient>,
    private readonly deployments: ReadonlyMap<ChainId, EvmDeployment>,
    /** Per chain, the ADDRESSES (never the keys) of this process's signing keys. Check 5. */
    private readonly keyAddresses: EvmKeyAddresses = { redeemer: new Map(), relayer: new Map() },
  ) {}

  async getVaultOwner(asset: AssetId): Promise<AccountId> {
    return this.escrowAccount(asset);
  }

  async getVaultAccount(asset: AssetId): Promise<AccountId> {
    return this.escrowAccount(asset);
  }

  async getVaultBalance(asset: AssetId): Promise<Money> {
    return (await this.getVaultBalanceAt(asset)).balance;
  }

  /**
   * The balance **and** the block it was true at.
   *
   * `eth_call` cannot report which block answered it, so the two facts cannot
   * come out of one request the way Solana's `getTokenAccountBalance` returns
   * `context.slot` beside `value`. The order is therefore the other way round:
   * read the head, then read the balance **anchored to that exact block**.
   *
   * That is two requests describing **one** moment, which is the property the
   * port actually requires. The forbidden shape is `eth_blockNumber` followed
   * by an `eth_call` at `latest` — two requests describing two moments, printed
   * as one on a page with no login.
   *
   * `cacheTime: 0` because viem caches `eth_blockNumber` for its polling
   * interval by default, and a cached head would re-introduce exactly the gap
   * the anchoring closes.
   */
  async getVaultBalanceAt(asset: AssetId): Promise<{ balance: Money; slot: bigint }> {
    const { chainId, deployment } = this.resolve(asset);
    const client = this.client(chainId);

    const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
    const raw = (await client.readContract({
      address: getAddress(deployment.asset),
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      // The TOKEN's ledger, not `totalEscrowed()`. The contract's own counter is
      // the contract's opinion of what it holds; proof of reserves is about
      // what the token says it holds, and the whole value of the page is that
      // the two are compared by somebody else.
      args: [getAddress(deployment.escrow)],
      blockNumber,
    })) as bigint;

    return {
      balance: MoneyUtil.of(raw.toString(), asset, getAssetMetadata(asset).decimals),
      slot: blockNumber,
    };
  }

  async assertVaultControl(asset: AssetId): Promise<void> {
    const { chainId, deployment } = this.resolve(asset);
    const client = this.client(chainId);
    const escrow = getAddress(deployment.escrow);

    // 1. The code behind the proxy.
    const slot = await client.getStorageAt({
      address: escrow,
      slot: ERC1967_IMPLEMENTATION_SLOT,
    });
    const implementation = addressFromWord(slot);
    if (implementation !== getAddress(deployment.escrowImplementation).toLowerCase()) {
      throw ChainErrors.vaultControlUnverified({
        reason:
          `escrow proxy ${escrow} delegates to implementation ${implementation ?? 'nothing'}, ` +
          `not the ${deployment.escrowImplementation} the deployment record names — an upgrade ` +
          `nobody recorded, or the wrong address`,
      });
    }

    // 2. The key that can replace it: the owner, the upgrade authority.
    const owner = (await client.readContract({
      address: getAddress(deployment.config),
      abi: X402_CONFIG_ABI,
      functionName: 'owner',
    })) as `0x${string}`;
    if (getAddress(owner) !== getAddress(deployment.owner)) {
      throw ChainErrors.vaultControlUnverified({
        reason:
          `config ${deployment.config} reports owner ${owner}, not the ${deployment.owner} the ` +
          `deployment record names — the upgrade authority of all three contracts moved ` +
          `without being recorded`,
      });
    }

    // 3. The operational key the owner appointed.
    const admin = (await client.readContract({
      address: getAddress(deployment.config),
      abi: X402_CONFIG_ABI,
      functionName: 'admin',
    })) as `0x${string}`;
    if (getAddress(admin) !== getAddress(deployment.admin)) {
      throw ChainErrors.vaultControlUnverified({
        reason:
          `config ${deployment.config} reports admin ${admin}, not the ${deployment.admin} the ` +
          `deployment record names — the operational key (pause, parameters, verifier ` +
          `registry) changed without being recorded`,
      });
    }

    // A proposed owner nobody recorded is seen before it is accepted. Advisory:
    // `owner()` above is the fail-closed check, so an unreadable
    // `pendingOwner()` warns too and does not refuse.
    await this.warnOnPendingOwner(client, deployment);

    // 4. The denomination.
    const settled = (await client.readContract({
      address: escrow,
      abi: X402_ESCROW_ABI,
      functionName: 'ASSET',
    })) as `0x${string}`;
    if (getAddress(settled) !== getAddress(deployment.asset)) {
      throw ChainErrors.vaultControlUnverified({
        reason:
          `escrow ${escrow} settles in ASSET ${settled}, not the ${deployment.asset} being ` +
          `reconciled`,
      });
    }

    // 5. The redeemer pin against this process's own keys.
    await this.assertRedeemerKeys(client, chainId, deployment);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async warnOnPendingOwner(
    client: EvmVaultClient,
    deployment: EvmDeployment,
  ): Promise<void> {
    let pendingOwner: `0x${string}`;
    try {
      pendingOwner = (await client.readContract({
        address: getAddress(deployment.config),
        abi: X402_CONFIG_ABI,
        functionName: 'pendingOwner',
      })) as `0x${string}`;
    } catch (error) {
      this.logger.warn(
        `could not read pendingOwner() on config ${deployment.config}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (getAddress(pendingOwner) !== zeroAddress) {
      this.logger.warn(
        `config ${deployment.config} has a pending owner ${pendingOwner}: an ownership transfer ` +
          `was proposed and is not accepted yet. If nobody planned it, the owner should ` +
          `transferOwnership to itself (or the right key) before it is accepted`,
      );
    }
  }

  /**
   * Check 5: `params().redeemer` equals this process's redeemer key address
   * and differs from its relayer key address. The message names addresses,
   * which are public, and the variables, never a key.
   */
  private async assertRedeemerKeys(
    client: EvmVaultClient,
    chainId: ChainId,
    deployment: EvmDeployment,
  ): Promise<void> {
    const redeemerKey = this.keyAddresses.redeemer.get(chainId);
    const relayerKey = this.keyAddresses.relayer.get(chainId);
    if (redeemerKey === undefined && relayerKey === undefined) return;

    const params = (await client.readContract({
      address: getAddress(deployment.config),
      abi: X402_CONFIG_ABI,
      functionName: 'params',
    })) as { redeemer: `0x${string}` };
    const live = getAddress(params.redeemer);

    if (redeemerKey !== undefined && getAddress(redeemerKey) !== live) {
      throw ChainErrors.vaultControlUnverified({
        reason:
          `config ${deployment.config} pins redeemer ${live}, but the EVM_REDEEMER_KEYS key ` +
          `for ${chainId} is ${getAddress(redeemerKey)} — every redemption would be refused. ` +
          `Rotate params().redeemer with updateConfig, or put the key for ${live} in ` +
          `EVM_REDEEMER_KEYS`,
      });
    }
    if (relayerKey !== undefined && getAddress(relayerKey) === live) {
      throw ChainErrors.vaultControlUnverified({
        reason:
          `config ${deployment.config} pins redeemer ${live}, which is the EVM_RELAYER_KEYS key ` +
          `for ${chainId} — the hot relayer key can redeem, so the key split protects nothing. ` +
          `Move that key to EVM_REDEEMER_KEYS and give the relayer a new key, or rotate ` +
          `params().redeemer with updateConfig`,
      });
    }
  }

  private escrowAccount(asset: AssetId): AccountId {
    const { chainId, deployment } = this.resolve(asset);
    return toAccountId(chainId, getAddress(deployment.escrow));
  }

  /**
   * The one door, and it refuses in two different ways on purpose.
   *
   * A Solana asset arriving here is `CHAIN_UNSUPPORTED` — this object serves no
   * such chain and the multiplexer should never have routed it. An eip155 asset
   * that is not the one this deployment settles in is `CHAIN_ASSET_NOT_ON_CHAIN`
   * — the chain is served, the asset is not. Collapsing the two would send an
   * operator to the wrong file.
   */
  private resolve(asset: AssetId): { chainId: ChainId; deployment: EvmDeployment } {
    const { chainId } = parseAssetId(asset);
    const deployment = this.deployments.get(chainId);
    if (namespaceOf(chainId) !== ChainNamespace.EIP155 || !deployment) {
      throw ChainErrors.unsupportedChain({ chainId });
    }

    const expected = toAssetId(chainId, 'erc20', getAddress(deployment.asset));
    if (asset !== expected) {
      throw ChainErrors.assetNotOnChain({ asset, chainId });
    }
    return { chainId, deployment };
  }

  private client(chainId: ChainId): EvmVaultClient {
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

/**
 * The last 20 bytes of a storage word, lower-cased.
 *
 * `null` when the node answered with something that is not a 32-byte word —
 * including `0x`, which is what a node returns for a slot of an address with no
 * code. That is not "the implementation is the zero address"; it is "there is
 * nothing here", and the caller refuses either way.
 */
function addressFromWord(word: `0x${string}` | undefined): string | null {
  if (typeof word !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(word)) {
    return null;
  }
  return `0x${word.slice(-40)}`.toLowerCase();
}
