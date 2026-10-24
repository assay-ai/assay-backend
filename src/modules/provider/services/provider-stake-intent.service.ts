import { Inject, Injectable, Logger } from '@nestjs/common';

import { ProviderChainEnrolmentRepository } from '@database/postgres/repositories/provider-chain-enrolment.repository';
import { BlockedRole, BlockSubjectKind } from '@modules/blocklist/domain/account-block';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';
import { toUnsignedChainTransactionDto } from '@modules/chains/dto/unsigned-chain-transaction.dto';
import { AccountId, chainIdOf } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';
import { BaseError } from '@shared/errors/base.error';
import { MoneyUtil } from '@shared/utils/money.util';

import { stakeWithdrawalLimit } from '../domain/stake-withdrawal';
import {
  CreateStakeIntentResponseDto,
  StakeIntentPreflightDto,
} from '../dto/create-stake-intent.dto';
import { ProviderErrors } from '../errors/provider.errors';
import {
  ONCHAIN_STAKE_READER,
  OnChainStake,
  OnChainStakeReaderPort,
} from '../ports/onchain-stake-reader.port';
import {
  STAKE_INTENT_BUILDER,
  StakeIntentBuilderPort,
  StakeIntentKind,
  StakeIntentPreflight,
} from '../ports/stake-intent-builder.port';

/**
 * The four stake intents — `open-stake`, `deposit`,
 * `unstake`, `withdraw`.
 *
 * Until this service existed a provider's stake lifecycle was read-only from
 * the platform's side: the Capital screen rendered it, and there was no way to
 * put stake **in** or take it **out** through the product at all. The only path
 * that had ever opened a `ProviderStake` account was
 * `scripts/settlement/exercise-all.ts`, a smoke script.
 *
 * ## `open-stake` is first, and everything depends on it
 *
 * `open_stake` is a separate instruction and deliberately **not**
 * `init_if_needed` — the program's comment is *"an initializer that can run on
 * an existing account is the shape reinitialisation attacks are made of"* — and
 * `deposit_stake` requires an already-existing `Account<'info, ProviderStake>`.
 * So without an open-stake path no provider can ever acquire a stake account,
 * `OnChainProviderStakeSource` finds no PDA for anybody, and every provider
 * sits at `STAKE_UNKNOWN` forever. That is not a missing screen; it is the
 * whole stake gate quietly excluding the entire registry.
 *
 * ## The backend never signs these
 *
 * It builds; the provider's own wallet signs. The rule is made structural one
 * layer down — `StakeIntentBuilderPort` has no send, no submit and no signer
 * parameter anywhere on its surface, and `SolanaStakeIntentBuilder` declares an
 * RPC client with no `sendTransaction` in it. This service therefore *cannot*
 * sign or submit even by mistake; it does not have to be careful.
 *
 * Nothing here signs. A provider's stake authority is theirs, and
 * `withdraw_stake`'s own comment says *"Only the provider may take their own
 * stake out. The admin key cannot."*
 *
 * ## The account is never taken from the request
 *
 * It comes off `provider_chain_enrolments.stake_authority_account_id`, which
 * only the challenge/prove flow writes. A request body that could name the account would undo that proof
 * entirely: provider A could build a withdrawal against
 * provider B's PDA — which B's wallet would refuse to sign, so no money moves —
 * but more usefully could probe B's balances through the preflight. Neither is
 * worth a field.
 *
 * ## One chain, or a refusal
 *
 * The route carries no `chainId`, and the stake authority is now per chain. A
 * provider with exactly one proved authority is unambiguous and is served; one
 * with two is refused with `PROVIDER_STAKE_AUTHORITY_AMBIGUOUS` rather than
 * served the first row. The transaction returned here is about to be signed by
 * a wallet, against one chain's `ProviderStake` account — picking for the
 * provider would hand them a transfer on a chain they were not looking at, and
 * a wallet's confirmation screen shows an amount, not a chain choice. The
 * fix is a `chainId` on the request, which is a route change not made yet,
 * rather than guessed at here.
 *
 * ## Everything fails closed
 *
 * Two reads have to succeed before anything is built: the provider row and the
 * `ProviderStake` account.
 * An RPC failure in either is a `503`, never a degraded answer. This is the
 * opposite of `ProviderStakeService`'s rule one screen over, and deliberately
 * so: that endpoint is a **report** and refusing to render it protects nobody,
 * while this one puts bytes in front of a wallet. A preflight that guessed
 * would send a provider to a faucet they do not need; a transaction built
 * without reading `Config.stake_mint` would be a transfer of a token they never
 * chose.
 */
@Injectable()
export class ProviderStakeIntentService {
  private readonly logger = new Logger(ProviderStakeIntentService.name);

  constructor(
    private readonly enrolments: ProviderChainEnrolmentRepository,
    @Inject(ONCHAIN_STAKE_READER) private readonly onChain: OnChainStakeReaderPort,
    @Inject(STAKE_INTENT_BUILDER) private readonly builder: StakeIntentBuilderPort,
    private readonly blocklist: AccountBlocklistService,
  ) {}

  /**
   * One entry point for all four kinds, because the preamble is the same for
   * all four and it is the preamble that carries the safety properties: resolve
   * the proved authority, read the account, and decide whether this act is even
   * possible before a single byte is compiled.
   *
   * `amount` arrives as an atomic-unit string rather than a `Money` because the
   * asset is not the caller's to choose — see {@link resolveAmount}.
   */
  async createIntent(
    providerId: string,
    kind: StakeIntentKind,
    amount: string | null,
  ): Promise<CreateStakeIntentResponseDto> {
    const account = await this.requireStakeAuthority(providerId);
    // Every kind, withdrawals included: a blocked stake authority is most
    // often a leaked key, and a withdrawal is what a thief would build first.
    this.blocklist.assertNotBlocked([
      { role: BlockedRole.STAKE_AUTHORITY, kind: BlockSubjectKind.WALLET, subject: account },
    ]);
    const stake = await this.readStake(account);

    this.assertAccountState(kind, account, stake);

    const money = await this.resolveAmount(kind, account, amount);

    // `request_unstake` reverts on more than `bonded`: refused before the fee.
    if (
      kind === StakeIntentKind.UNSTAKE &&
      stake &&
      money &&
      MoneyUtil.toAtomic(money) > MoneyUtil.toAtomic(stake.bonded)
    ) {
      throw ProviderErrors.stakeInsufficientBonded({ bonded: stake.bonded.amount });
    }

    if (kind === StakeIntentKind.WITHDRAW) {
      // `stake` is non-null here: `assertAccountState` has already refused a
      // withdrawal against an account that was never opened.
      return this.withdrawIntent(account, stake as OnChainStake, money as Money);
    }

    const built = await this.build(account, kind, money);
    return {
      kind,
      account,
      amount: money ? toMoneyDto(money) : null,
      transaction: toUnsignedChainTransactionDto(built.transaction),
      preflight: toPreflightDto(built.preflight),
      withdrawable: null,
      blockedBy: null,
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * A withdrawal, or the reason it is smaller than asked for.
   *
   * The limit is computed **before** the transaction, and a blocked withdrawal
   * returns no transaction at all. `withdraw_stake` enforces
   * `amount <= withdrawable`, so building one anyway would charge the provider
   * a network fee to be told something this response already knows — and would
   * do it at the moment they are least inclined to be charitable about it.
   */
  private async withdrawIntent(
    account: AccountId,
    stake: OnChainStake,
    requested: Money,
  ): Promise<CreateStakeIntentResponseDto> {
    const limit = stakeWithdrawalLimit(stake, requested, new Date());

    // Nothing unstaked, or not matured yet: there is no withdrawal to describe.
    // A partly covered one still answers with `withdrawable` and `blockedBy`.
    if (MoneyUtil.isZero(limit.withdrawable)) {
      throw ProviderErrors.stakeNothingWithdrawable();
    }

    if (limit.blockedBy !== null) {
      const preflight = await this.guard(account, () =>
        this.builder.preflight({ kind: StakeIntentKind.WITHDRAW, account, amount: requested }),
      );
      this.logger.log(
        `withdraw intent for ${account} blocked by ${limit.blockedBy}: ` +
          `${MoneyUtil.format(requested)} asked, ${MoneyUtil.format(limit.withdrawable)} withdrawable`,
      );
      return {
        kind: StakeIntentKind.WITHDRAW,
        account,
        amount: toMoneyDto(requested),
        transaction: null,
        preflight: toPreflightDto(preflight),
        withdrawable: toMoneyDto(limit.withdrawable),
        blockedBy: limit.blockedBy,
      };
    }

    const built = await this.build(account, StakeIntentKind.WITHDRAW, requested);
    return {
      kind: StakeIntentKind.WITHDRAW,
      account,
      amount: toMoneyDto(requested),
      transaction: toUnsignedChainTransactionDto(built.transaction),
      preflight: toPreflightDto(built.preflight),
      withdrawable: toMoneyDto(limit.withdrawable),
      blockedBy: null,
    };
  }

  /**
   * The provider's one proved stake authority, or a refusal naming the flow
   * that writes it.
   *
   * Deliberately not `PROVIDER_STAKE_NOT_FOUND`: that code is about a balance
   * nobody could read, and a provider who is told "stake not found" goes
   * looking for money rather than for a signature.
   *
   * More than one is `PROVIDER_STAKE_AUTHORITY_AMBIGUOUS` — see the class
   * comment for why this refuses instead of picking.
   */
  private async requireStakeAuthority(providerId: string): Promise<AccountId> {
    const proved = await this.enrolments.findProvedStakeAuthorities(providerId);

    if (proved.length === 0) {
      throw ProviderErrors.stakeAuthorityUnproven({ providerId });
    }
    if (proved.length > 1) {
      throw ProviderErrors.stakeAuthorityAmbiguous({
        providerId,
        chains: proved.map((row) => row.chainId).join(', '),
      });
    }

    return proved[0].stakeAuthorityAccountId as AccountId;
  }

  /** The `ProviderStake` account, or `undefined` when the chain says there is none. */
  private async readStake(account: AccountId): Promise<OnChainStake | undefined> {
    const found = await this.guard(account, () => this.onChain.bondedStakeOf([account]));
    return found.get(account);
  }

  /**
   * Whether the account is in the state this act needs, refused here rather
   * than on chain.
   *
   * Both directions cost the provider a network fee to discover otherwise, and
   * the ordering — open first, then deposit — is the one thing about this flow
   * that surprises people. The program refuses both as well; this is not a
   * substitute for it, it is the same answer arriving before the fee.
   */
  private assertAccountState(
    kind: StakeIntentKind,
    account: AccountId,
    stake: OnChainStake | undefined,
  ): void {
    // Solana's stake is a PDA `open_stake` creates; eip155's is a mapping row
    // the first deposit writes. The builder says which, per chain.
    const needsOpen = this.builder.needsOpenStake(chainIdOf(account));

    if (kind === StakeIntentKind.OPEN_STAKE) {
      if (!needsOpen) {
        throw ProviderErrors.stakeAccountNotNeeded({ account });
      }
      if (stake) {
        throw ProviderErrors.stakeAccountAlreadyOpen({ account });
      }
      return;
    }
    if (!stake && !(kind === StakeIntentKind.DEPOSIT && !needsOpen)) {
      throw ProviderErrors.stakeAccountNotOpen({ account, kind });
    }
  }

  /**
   * The requested amount as `Money`, in the asset the **chain** names.
   *
   * The asset comes from `Config.stake_mint` through the builder, not from
   * `PLATFORM_STAKE_ASSET_ID` and not from the request. A local copy is a value
   * that can silently disagree with the mint the program will accept, and a
   * caller-supplied one could only ever be right or rejected — so accepting the
   * field would invite a console to send whatever it happens to hold.
   *
   * `null` for `OPEN_STAKE`, which carries no amount: `open_stake` takes no
   * arguments and moves no tokens.
   */
  private async resolveAmount(
    kind: StakeIntentKind,
    account: AccountId,
    amount: string | null,
  ): Promise<Money | null> {
    if (kind === StakeIntentKind.OPEN_STAKE) {
      return null;
    }
    const { asset, decimals } = await this.guard(account, () =>
      this.builder.stakeAsset(chainIdOf(account)),
    );
    return MoneyUtil.of(amount ?? '0', asset, decimals);
  }

  private async build(account: AccountId, kind: StakeIntentKind, amount: Money | null) {
    return this.guard(account, () => this.builder.buildIntent({ kind, account, amount }));
  }

  /**
   * Turns any chain-side failure into one `503` a provider can act on.
   *
   * Without this the same event surfaced as a bare `500 Internal server error`
   * — an RPC failure inside the reader or the builder is not an `AppError`, so
   * that is all the filter had to say — which is a refusal with no remedy
   * attached. An `AppError` raised by this service's own checks passes through
   * untouched, because those already carry the right status and the right
   * remedy.
   */
  private async guard<T>(account: AccountId, read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (error instanceof BaseError) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`stake intent for ${account} refused — chain unreadable: ${reason}`);
      throw ProviderErrors.stakeChainUnavailable({ account, reason });
    }
  }
}

function toMoneyDto(money: Money): MoneyDto {
  return { amount: money.amount, asset: money.asset, decimals: money.decimals };
}

function toPreflightDto(preflight: StakeIntentPreflight): StakeIntentPreflightDto {
  return {
    requiredStakeAsset: toMoneyDto(preflight.requiredStakeAsset),
    stakeAssetBalance: preflight.stakeAssetBalance ? toMoneyDto(preflight.stakeAssetBalance) : null,
    requiredGas: toMoneyDto(preflight.requiredGas),
    gasBalance: toMoneyDto(preflight.gasBalance),
    hasEnoughStakeAsset: preflight.hasEnoughStakeAsset,
    hasEnoughGas: preflight.hasEnoughGas,
    gasSponsored: preflight.gasSponsored,
    gasNotSponsoredReason: preflight.gasNotSponsoredReason,
  };
}
