import { Inject, Injectable } from '@nestjs/common';
import {
  findAssociatedTokenPda,
  getTokenDecoder,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {
  Address,
  address,
  getAddressEncoder,
  getBase64Encoder,
  getProgramDerivedAddress,
  getU8Encoder,
  getUtf8Encoder,
} from '@solana/kit';

import { MoneyUtil } from '@shared/utils/money.util';

import { ChainErrors } from '../errors/chains.errors';
import { getAssetMetadata } from '../ports/asset-registry';
import { AccountId, AssetId, parseAccountId, parseAssetId, toAccountId } from '../ports/caip.types';
import { Money } from '../ports/money.types';
import { VaultPort } from '../ports/vault.port';
import { SOLANA_RPC } from './solana.constants';
import {
  SOLANA_VAULT_INDEX,
  SOLANA_VAULT_MULTISIG_CREATE_KEY,
  SQUADS_SEED_MULTISIG,
  SQUADS_SEED_PREFIX,
  SQUADS_SEED_VAULT,
  SQUADS_V4_PROGRAM_ADDRESS,
} from './squads-vault.constants';

/**
 * The slice of the Solana JSON-RPC this service uses.
 *
 * `getAccountInfo` is what `SolanaChainAdapter`'s narrower `SolanaRpcClient`
 * does not need — proving control of the vault means reading raw account
 * bytes, not just a token balance. Declared structurally, like the adapter's,
 * so a test supplies exactly these two calls instead of a whole RPC surface.
 */
export interface SquadsVaultRpcClient {
  getAccountInfo(
    accountAddress: Address,
    config: { encoding: 'base64' },
  ): { send(): Promise<{ value: { owner: Address; data: readonly [string, string] } | null }> };
  getTokenAccountBalance(account: Address): {
    /**
     * `context.slot` is part of every Solana RPC envelope and was previously
     * dropped on the floor here. It is declared because the proof-of-reserves
     * page publishes it:
     * a balance without the slot it was read at is a claim nobody can check.
     */
    send(): Promise<{
      context: { slot: bigint | number };
      value: { amount: string; decimals: number };
    }>;
  };
}

const utf8Encoder = getUtf8Encoder();
const addressEncoder = getAddressEncoder();
const u8Encoder = getU8Encoder();
const base64Encoder = getBase64Encoder();
const tokenDecoder = getTokenDecoder();

/**
 * The treasury vault, Squads v4-controlled.
 *
 * Everything here is either a pure PDA derivation (no network call, and
 * therefore cheap to get wrong quietly) or a read that **proves** the
 * derivation matches on-chain reality. The two are kept apart deliberately:
 * `getVaultAccount` and friends compute where the vault *should* be;
 * `assertVaultControl` is the only method that checks it actually is —
 * calling the former is not a substitute for calling the latter, and nothing
 * here calls `assertVaultControl` implicitly. A caller that skips it is
 * trusting an unverified PDA, which is fine for read-only balance display and
 * not fine for anything that moves money.
 */
@Injectable()
export class SquadsVaultService implements VaultPort {
  private multisigPda: Promise<Address> | null = null;
  private readonly vaultPdaByChain = new Map<string, Promise<Address>>();

  constructor(
    @Inject(SOLANA_RPC) private readonly rpc: SquadsVaultRpcClient,
    @Inject(SOLANA_VAULT_MULTISIG_CREATE_KEY) private readonly createKey: string | null,
    @Inject(SOLANA_VAULT_INDEX) private readonly vaultIndex: number,
  ) {
    if (!Number.isInteger(vaultIndex) || vaultIndex < 0 || vaultIndex > 255) {
      throw ChainErrors.vaultNotConfigured({
        reason: `SOLANA_VAULT_INDEX must be an integer in [0, 255], got ${String(vaultIndex)}`,
      });
    }
  }

  async getVaultOwner(asset: AssetId): Promise<AccountId> {
    const { chainId } = parseAssetId(asset);
    const vaultPda = await this.deriveVaultPda();
    return toAccountId(chainId, vaultPda);
  }

  async getVaultAccount(asset: AssetId): Promise<AccountId> {
    const { chainId, assetReference } = parseAssetId(asset);
    const vaultPda = await this.deriveVaultPda();
    const [ata] = await findAssociatedTokenPda({
      owner: vaultPda,
      mint: address(assetReference),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    return toAccountId(chainId, ata);
  }

  async getVaultBalance(asset: AssetId): Promise<Money> {
    return (await this.getVaultBalanceAt(asset)).balance;
  }

  /**
   * The balance **and** the slot the RPC reported it at.
   *
   * This is the single read; `getVaultBalance` is a projection of it. The
   * `context.slot` that used to be destructured away here is the whole reason
   * the method exists — the proof-of-reserves page prints it beside the figure so a reader can
   * check the vault themselves at the same slot, which is the difference
   * between publishing a number and publishing a proof.
   */
  async getVaultBalanceAt(asset: AssetId): Promise<{ balance: Money; slot: bigint }> {
    const metadata = getAssetMetadata(asset);
    const vaultAccount = await this.getVaultAccount(asset);
    const { context, value } = await this.rpc
      .getTokenAccountBalance(address(parseAccountId(vaultAccount).address))
      .send();

    if (value.decimals !== metadata.decimals) {
      throw ChainErrors.assetDecimalsMismatch({
        asset,
        expected: metadata.decimals,
        actual: value.decimals,
      });
    }

    return {
      balance: MoneyUtil.of(value.amount, asset, metadata.decimals),
      slot: BigInt(context.slot),
    };
  }

  /**
   * Proves the arrangement rather than assuming it.
   *
   * Two independent facts, both required: the multisig PDA is an account the
   * Squads program actually owns (not an address that merely *looks* right
   * because the math checks out — an uninitialised PDA is a valid PDA), and
   * the vault's token account is authorised to the vault PDA and not, say,
   * left owned by whichever key created it.
   */
  async assertVaultControl(asset: AssetId): Promise<void> {
    const { assetReference } = parseAssetId(asset);
    const multisigPda = await this.deriveMultisigPda();
    const vaultPda = await this.deriveVaultPda();
    const vaultAccount = await this.getVaultAccount(asset);

    const multisigInfo = await this.rpc.getAccountInfo(multisigPda, { encoding: 'base64' }).send();
    if (!multisigInfo.value || multisigInfo.value.owner !== SQUADS_V4_PROGRAM_ADDRESS) {
      throw ChainErrors.vaultControlUnverified({
        reason: multisigInfo.value
          ? `multisig PDA ${multisigPda} is owned by ${multisigInfo.value.owner}, not the Squads program`
          : `multisig PDA ${multisigPda} does not exist on chain`,
      });
    }

    const vaultAtaAddress = address(parseAccountId(vaultAccount).address);
    const vaultAtaInfo = await this.rpc
      .getAccountInfo(vaultAtaAddress, { encoding: 'base64' })
      .send();
    if (!vaultAtaInfo.value) {
      throw ChainErrors.vaultControlUnverified({
        reason: `vault token account ${vaultAtaAddress} does not exist on chain`,
      });
    }

    const tokenAccount = tokenDecoder.decode(base64Encoder.encode(vaultAtaInfo.value.data[0]));
    if (tokenAccount.owner !== vaultPda) {
      throw ChainErrors.vaultControlUnverified({
        reason:
          `vault token account ${vaultAtaAddress} authority is ${tokenAccount.owner}, ` +
          `not the derived vault PDA ${vaultPda}`,
      });
    }
    if (tokenAccount.mint !== assetReference) {
      throw ChainErrors.vaultControlUnverified({
        reason: `vault token account ${vaultAtaAddress} mint is ${tokenAccount.mint}, not ${assetReference}`,
      });
    }
  }

  // ── PDA derivation — pure, no network call ──────────────────────────────

  private deriveMultisigPda(): Promise<Address> {
    if (!this.createKey) {
      throw ChainErrors.vaultNotConfigured({
        reason:
          'SOLANA_VAULT_MULTISIG_CREATE_KEY is not set; there is no multisig to derive a vault from',
      });
    }
    if (!this.multisigPda) {
      const createKey = this.createKey;
      this.multisigPda = getProgramDerivedAddress({
        programAddress: address(SQUADS_V4_PROGRAM_ADDRESS),
        seeds: [
          utf8Encoder.encode(SQUADS_SEED_PREFIX),
          utf8Encoder.encode(SQUADS_SEED_MULTISIG),
          addressEncoder.encode(address(createKey)),
        ],
      }).then(([pda]) => pda);
    }
    return this.multisigPda;
  }

  private deriveVaultPda(): Promise<Address> {
    const cacheKey = `${this.createKey ?? ''}:${this.vaultIndex}`;
    const cached = this.vaultPdaByChain.get(cacheKey);
    if (cached) {
      return cached;
    }

    const promise = this.deriveMultisigPda().then((multisigPda) =>
      getProgramDerivedAddress({
        programAddress: address(SQUADS_V4_PROGRAM_ADDRESS),
        seeds: [
          utf8Encoder.encode(SQUADS_SEED_PREFIX),
          addressEncoder.encode(multisigPda),
          utf8Encoder.encode(SQUADS_SEED_VAULT),
          u8Encoder.encode(this.vaultIndex),
        ],
      }).then(([pda]) => pda),
    );
    this.vaultPdaByChain.set(cacheKey, promise);
    return promise;
  }
}
