import { Inject, Injectable } from '@nestjs/common';
import { Address, address, getBase64Encoder } from '@solana/kit';
import {
  findConfigPda,
  findStakePda,
  getConfigDecoder,
  getProviderStakeDecoder,
  PROVIDER_STAKE_DISCRIMINATOR,
} from '@assay/settlement-client';

import { MoneyUtil } from '@shared/utils/money.util';

import {
  OnChainStake,
  OnChainStakeReaderPort,
} from '@modules/provider/ports/onchain-stake-reader.port';

import { ChainErrors } from '../errors/chains.errors';
import { getAssetMetadata } from '../ports/asset-registry';
import { AccountId, AssetId, chainIdOf, parseAccountId, toAssetId } from '../ports/caip.types';
import { SOLANA_RPC } from './solana.constants';
import { SETTLEMENT_PROGRAM_ID, SETTLEMENT_PROGRAM_ID_ENV } from './settlement-program.constants';

/**
 * The two RPC calls this service makes, declared structurally so a test can
 * supply exactly them — the same trade `VerifierRegistryRpcClient` makes next
 * door.
 */
export interface SettlementStakeRpcClient {
  getAccountInfo(
    account: Address,
    config: { encoding: 'base64'; commitment?: 'confirmed' | 'finalized' },
  ): { send(): Promise<{ value: { data: readonly [string, 'base64'] } | null }> };
  getMultipleAccounts(
    accounts: readonly Address[],
    config: { encoding: 'base64'; commitment?: 'confirmed' | 'finalized' },
  ): { send(): Promise<{ value: readonly ({ data: readonly [string, 'base64'] } | null)[] }> };
}

/**
 * The JSON-RPC cap on `getMultipleAccounts`.
 *
 * Not a tunable — it is the server's limit, and a request of 101 addresses is
 * refused outright rather than truncated. Exported so the test that proves the
 * chunking is reading the same number the chunking uses.
 */
export const MAX_ACCOUNTS_PER_RPC_BATCH = 100;

/**
 * Reads the `ProviderStake` account off the settlement program.
 *
 * ## `bonded` alone. Never `bonded + unbonding`
 *
 * `ProviderStake::meets_minimum` in the program is `self.bonded >=
 * minimum_stake`, and the account's own doc comment says why: stake the
 * provider has already asked to take out is not backing anybody's traffic,
 * even though it is still slashable. Slashability is the base for `at_risk()`
 * and for the slash cap — a different question from routing, answered by a
 * different field.
 *
 * Adding `unbonding` *into* `bonded` here would let a provider request a full
 * unstake and go on serving paid traffic for the whole 14-day unbonding period,
 * with a stake gate that says they are covered. That is the one bug this file
 * exists to not have, which is why it is stated in three places (here, on
 * `OnChainStake.bonded`, and in the first case of its unit test) rather than one.
 *
 * `unbonding` is nevertheless *reported*, in its own field, because the
 * stake-authority rotation gate asks a different question of the same account —
 * see `OnChainStake`. Carrying it costs nothing: it comes out of a struct this
 * method already decodes in full, so the alternative was a second RPC round
 * trip for bytes already in hand.
 *
 * ## Decoded by the generated client, never by hand
 *
 * Seeds, discriminator, field order and field widths all come from
 * `@assay/settlement-client`, which is Codama output rendered from the program's
 * IDL and held in step with it by `yarn client:check`. `SolanaVerifierRegistryService`
 * next door carries the longer version of this argument; it applies here with
 * the same force, because a `u64` read at the wrong offset is still a number
 * and the number decides who takes paid traffic.
 *
 * What the decoder does not do is decide whether the bytes are a `ProviderStake`
 * at all, so two guards stay:
 *
 * - the **discriminator**, checked rather than skipped — a PDA is only an
 *   address, and a second account type at these seeds would otherwise decode as
 *   a stake balance;
 * - the **stored provider**, compared against the pubkey whose PDA we derived.
 *
 * ## Where the asset comes from, and why it costs one extra read
 *
 * `Money` is meaningless without an asset, and the program states the asset
 * itself: `Config.stake_mint` is the mint every deposit and withdrawal is
 * denominated in. That is one `getAccountInfo` for a value that changes
 * approximately never — only an admin `update_config` moves it — so it is
 * memoised for the life of the process. Decimals then come from the **local
 * asset registry**, not from the mint account, deliberately: `asset-registry.ts`
 * records the scale we expect precisely so that a mint whose on-chain decimals
 * differ is loud rather than silently rescaling somebody's collateral by 1000×.
 *
 * The memo is dropped on failure, so one unreachable RPC at boot does not
 * poison the process for the rest of its life.
 */
@Injectable()
export class SolanaSettlementStakeReader implements OnChainStakeReaderPort {
  private config: Promise<SettlementStakeConfig> | null = null;

  constructor(
    @Inject(SOLANA_RPC) private readonly rpc: SettlementStakeRpcClient,
    @Inject(SETTLEMENT_PROGRAM_ID) private readonly programId: string | null,
  ) {}

  async bondedStakeOf(
    accounts: readonly AccountId[],
  ): Promise<ReadonlyMap<AccountId, OnChainStake>> {
    const found = new Map<AccountId, OnChainStake>();
    if (accounts.length === 0) {
      return found;
    }

    const programAddress = address(this.requireProgramId());
    const { stakeMint: mint, unbondingPeriodSeconds } = await this.settlementConfig();

    // PDA per authority, in declaration order, so the RPC's positional reply
    // can be zipped back onto the account it answers for. `findStakePda` is a
    // local derivation — no network — but it is async because the underlying
    // hash is, so these are resolved together rather than in sequence.
    const derived = await Promise.all(
      accounts.map(async (account) => {
        const { address: pubkey } = parseAccountId(account);
        const [pda] = await findStakePda({ provider: address(pubkey) }, { programAddress });
        return { account, pubkey, pda };
      }),
    );

    for (let start = 0; start < derived.length; start += MAX_ACCOUNTS_PER_RPC_BATCH) {
      const chunk = derived.slice(start, start + MAX_ACCOUNTS_PER_RPC_BATCH);
      const { value } = await this.rpc
        .getMultipleAccounts(
          chunk.map((entry) => entry.pda),
          { encoding: 'base64', commitment: 'confirmed' },
        )
        .send();

      // The reply is zipped back onto the request by POSITION, so a reply that
      // does not answer for exactly what was asked cannot be read at all: a
      // missing entry does not look like a gap, it looks like `null`, and
      // `null` here means "no stake account at those seeds". That is an
      // ordinary answer with a meaning of its own — and the rotation gate
      // reads it as "the provider has fully exited, let them re-point their
      // stake authority". A truncated or malformed reply would therefore hand a
      // defecting provider the rotation that lets a slash follow their new key
      // to an empty PDA while the collateral stays behind. Unreadable must
      // never resolve to empty, so this throws rather than degrading.
      if (value.length !== chunk.length) {
        throw ChainErrors.rpcReplyMalformed({
          method: 'getMultipleAccounts',
          expected: chunk.length,
          actual: value.length,
        });
      }

      // One timestamp per round trip, taken after it returns. This is what
      // `ProviderStake.observedAt` carries all the way to the gate, and it has
      // to name the moment the chain answered — not the moment a cache of the
      // answer was read.
      const observedAt = new Date();

      chunk.forEach((entry, index) => {
        const account = value[index];
        // No account at those seeds: this provider has never opened a stake
        // account, or has closed it. Absent from the map — the caller's port
        // is explicit that absent is not zero.
        if (!account) {
          return;
        }

        const data = new Uint8Array(getBase64Encoder().encode(account.data[0]));
        const stake = this.decodeStake(data, entry.pubkey, entry.pda);
        found.set(entry.account, {
          account: entry.account,
          bonded: this.toMoney(stake.bonded, entry.account, mint),
          unbonding: this.toMoney(stake.unbonding, entry.account, mint),
          // `0` is "nothing unbonding", not 1970 — see `OnChainStake`. The
          // completion date is derived here rather than in the caller because
          // the period length is a program parameter, and a second copy of it
          // outside this module is a number that can disagree with the one the
          // withdrawal gate enforces.
          unbondingStartedAt: toDate(stake.unbondingStartedAt),
          unbondingCompletesAt: toDate(
            stake.unbondingStartedAt === 0n
              ? 0n
              : stake.unbondingStartedAt + unbondingPeriodSeconds,
          ),
          observedAt,
        });
      });
    }

    return found;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private requireProgramId(): string {
    if (!this.programId) {
      // Not a boot failure, by the deliberate design of the token — see
      // `settlement-program.constants.ts`. A deployment with no settlement
      // program is legitimate today, so the failure belongs at the first call
      // that actually needs an address, which is this one.
      throw ChainErrors.programNotConfigured({
        what: 'the settlement program',
        variable: SETTLEMENT_PROGRAM_ID_ENV,
      });
    }
    return this.programId;
  }

  /**
   * The two `Config` fields this reader needs, read once and remembered.
   *
   * One memo rather than two, because they come out of the same account in the
   * same round trip and only an admin `update_config` moves either. See the
   * class comment for why the mint is read from the chain at all; the unbonding
   * period is here for the same reason — a copy of it elsewhere is a number
   * that can silently disagree with the one enforcing the withdrawal gate.
   */
  private async settlementConfig(): Promise<SettlementStakeConfig> {
    if (!this.config) {
      this.config = this.fetchConfig().catch((error: unknown) => {
        // A rejected promise left in the field would make one transient RPC
        // failure permanent for the life of the process.
        this.config = null;
        throw error;
      });
    }
    return this.config;
  }

  private async fetchConfig(): Promise<SettlementStakeConfig> {
    const programAddress = address(this.requireProgramId());
    const [configPda] = await findConfigPda({ programAddress });

    const account = await this.rpc
      .getAccountInfo(configPda, { encoding: 'base64', commitment: 'confirmed' })
      .send();
    if (!account.value) {
      // The program is configured but not initialised on this cluster. Loud,
      // and not the same failure as "the provider has no stake".
      throw ChainErrors.programNotConfigured({
        what: `the settlement program's Config account (${configPda})`,
        variable: SETTLEMENT_PROGRAM_ID_ENV,
      });
    }

    const data = new Uint8Array(getBase64Encoder().encode(account.value.data[0]));
    try {
      const decoded = getConfigDecoder().decode(data);
      return {
        stakeMint: decoded.stakeMint,
        unbondingPeriodSeconds: decoded.unbondingPeriodSeconds,
      };
    } catch (cause) {
      throw ChainErrors.accountLayoutUnexpected({
        account: configPda,
        expected: 'a settlement program Config account',
        actual: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  private decodeStake(
    data: Uint8Array,
    pubkey: string,
    pda: Address,
  ): {
    bonded: bigint;
    unbonding: bigint;
    unbondingStartedAt: bigint;
  } {
    if (!discriminatorMatches(data)) {
      throw ChainErrors.accountLayoutUnexpected({
        account: pda,
        expected: 'a ProviderStake account',
        actual: Buffer.from(data.subarray(0, PROVIDER_STAKE_DISCRIMINATOR.length)).toString('hex'),
      });
    }

    let decoded: ReturnType<ReturnType<typeof getProviderStakeDecoder>['decode']>;
    try {
      decoded = getProviderStakeDecoder().decode(data);
    } catch (cause) {
      throw ChainErrors.accountLayoutUnexpected({
        account: pda,
        expected: 'a ProviderStake account',
        actual: cause instanceof Error ? cause.message : String(cause),
      });
    }

    // Cannot differ without the program having changed underneath us, and the
    // consequence of being wrong is crediting one provider with another's
    // collateral.
    if (decoded.provider !== pubkey) {
      throw ChainErrors.accountLayoutUnexpected({
        account: pda,
        expected: pubkey,
        actual: decoded.provider,
      });
    }

    // Two balances, two separate questions — they are deliberately not summed
    // anywhere in this file. See the class comment and `OnChainStake`.
    return {
      bonded: decoded.bonded,
      unbonding: decoded.unbonding,
      unbondingStartedAt: decoded.unbondingStartedAt,
    };
  }

  private toMoney(atomic: bigint, account: AccountId, mint: string) {
    // The chain the authority lives on, taken from the authority's own CAIP-10
    // rather than assumed: `parseAssetId`/`getAssetMetadata` are what make a
    // devnet mint and a mainnet mint two different assets instead of one.
    const asset: AssetId = toAssetId(chainIdOf(account), 'token', mint);
    return MoneyUtil.of(atomic, asset, getAssetMetadata(asset).decimals);
  }
}

/** The `Config` fields this reader depends on. See {@link SolanaSettlementStakeReader}. */
interface SettlementStakeConfig {
  readonly stakeMint: string;
  readonly unbondingPeriodSeconds: bigint;
}

/**
 * A unix second count from the program, or `null` for its never-written `0`.
 *
 * The program writes `0` to mean "this never happened" on every timestamp it
 * keeps, and 1970 is a date a screen will happily render as an expired
 * countdown. One helper rather than a conditional at each call site, so the
 * sentinel is handled the same way every time.
 */
function toDate(seconds: bigint): Date | null {
  return seconds === 0n ? null : new Date(Number(seconds) * 1000);
}

function discriminatorMatches(data: Uint8Array): boolean {
  const expected = PROVIDER_STAKE_DISCRIMINATOR;
  if (data.length < expected.length) {
    return false;
  }
  return expected.every((byte, index) => data[index] === byte);
}
