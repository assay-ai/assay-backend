import { Money } from '@modules/chains/ports/money.types';
import { MoneyUtil } from '@shared/utils/money.util';

import { OnChainStake } from '../ports/onchain-stake-reader.port';

/**
 * Why a withdrawal is smaller than the provider asked for.
 *
 * One blocker, since the simplified contract removed the exposure authority: what gates
 * `withdraw_stake` off-chain is time, and only time. A provider told nothing but
 * a number cannot tell what they are waiting for, and the wrong guess costs them
 * a support ticket about a countdown that had already finished.
 */
export enum StakeWithdrawalBlocker {
  /**
   * The unbonding side is what binds: either nothing has been unstaked, or the
   * unbonding period has not elapsed, or less was unstaked than is being asked
   * for.
   *
   * All three are the same remedy — `request_unstake` and/or wait — and all
   * three are the same term of the program's `min`. Splitting them would be
   * three codes for one action.
   */
  UNBONDING_NOT_MATURED = 'UNBONDING_NOT_MATURED',
}

export interface StakeWithdrawalLimit {
  /** What `withdraw_stake` would accept right now, computed as the program computes it. */
  readonly withdrawable: Money;
  /** `null` when the requested amount is within {@link withdrawable}. */
  readonly blockedBy: StakeWithdrawalBlocker | null;
}

/**
 * `ProviderStake::withdrawable`, mirrored off chain so the console can say why.
 *
 * ```text
 * withdrawable = min(matured unbonding, bonded + unbonding − pending_slash)
 * ```
 *
 * ## What the simplified contract took out of this function
 *
 * The exposure authority. There used to be a third balance here — `exposed`,
 * asserted on chain by a platform key — and a staleness rule around it, and the
 * arithmetic above had a `saturating_sub` of it in the second term. The program
 * now bounds a withdrawal by time alone plus whatever a live slash proposal has
 * reserved: `WITHDRAW_DELAY_SECONDS` exceeds the maximum life of a redeemable
 * voucher, and `MIN_UNBONDING_PERIOD_SECONDS` is eleven days, so stake behind
 * work already served cannot leave before the work settles.
 *
 * ## This is a mirror, and it is allowed to be
 *
 * Everything it reads is a field the chain published. It decides nothing: the
 * program still enforces the rule, and a disagreement between the two costs a
 * rejected transaction rather than money moving that should not have. What it
 * buys is the difference between "your withdrawal failed" and "10.000000 of
 * your 40.000000 is withdrawable, and the rest is still unbonding".
 *
 * ## The one term this mirror does not carry
 *
 * `pending_slash` — stake a live `propose_slash` has reserved. It is on the
 * account and the program subtracts it, but `OnChainStakeReaderPort` does not
 * publish it, so this figure is an **upper bound** for the rare provider with a
 * judgement pending against them. The consequence is a refused transaction with
 * a named on-chain error (`InsufficientUnbondingStake`), never money moving
 * that should not have; adding the term is a field on the read port and a
 * second blocker on the enum, and both would have to reach the console at the
 * same time to be worth anything.
 *
 * ## `null` timestamps are the program's `0`, not 1970
 *
 * `OnChainStake` normalises the never-written sentinel to `null`, so a provider
 * who has never unstaked reads as "nothing unbonding" rather than as an
 * unbonding that started in 1970 and matured long ago.
 */
export function stakeWithdrawalLimit(
  stake: OnChainStake,
  requested: Money,
  now: Date,
): StakeWithdrawalLimit {
  const unbonding = MoneyUtil.toAtomic(stake.unbonding);

  const matured =
    unbonding > 0n &&
    stake.unbondingCompletesAt !== null &&
    now.getTime() >= stake.unbondingCompletesAt.getTime();

  const withdrawableAtomic = matured ? unbonding : 0n;
  const withdrawable = MoneyUtil.of(withdrawableAtomic, stake.bonded.asset, stake.bonded.decimals);

  if (MoneyUtil.greaterThanOrEqual(withdrawable, requested)) {
    return { withdrawable, blockedBy: null };
  }

  return { withdrawable, blockedBy: StakeWithdrawalBlocker.UNBONDING_NOT_MATURED };
}
