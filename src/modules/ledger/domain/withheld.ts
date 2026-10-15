/**
 * `withheld` — the value we did **not** take.
 *
 * This is the single most important figure a buyer sees, and the reason is a fact
 * about the ledger rather than about the UI: **a refund is a `HOLD_RELEASE`, and
 * a `HOLD_RELEASE` moves the balance back to exactly where it started.** An
 * agent whose guarantee fired forty times last month and an agent whose
 * guarantee never fired once see the same balance, the same spend history and
 * the same numbers. Without a figure for the money that was reserved and then
 * given back, the product's central claim is not observable from any surface
 * the platform exposes.
 *
 * ```text
 * withheld  =  Σ amount held for intents that reached a terminal state
 *              charging the agent nothing
 *
 *              bucket 1  REFUNDED           failed verification        ← the guarantee
 *              bucket 2  VOIDED | EXPIRED   provider or platform error ← never your fault
 * ```
 *
 * Two buckets, never one. A provider timeout is not the verification engine
 * catching bad data — it is a call that never produced data at all. Merging them
 * into a single heroic number is the first thing a sceptical reader takes apart,
 * and they would be right to.
 *
 * ## The rule that is in no document: a hold must have existed
 *
 * The definition above says *"charging the agent nothing"*, which on its face
 * includes an intent that expired in `CREATED` — priced, terminal, never
 * charged. It is excluded here, and the exclusion is what makes the figure
 * checkable.
 *
 * `CREATED → EXPIRED` carries `HoldEffect.NONE` because nothing was ever
 * reserved: the agent's balance was never touched in either direction, so there
 * is no `HOLD_RELEASE` in the journal to reconcile against. Counting it would
 * put money in `withheld` that the ledger has no record of, and
 * `withheld == Σ HOLD_RELEASE` — the property the whole figure rests on — would
 * fail by exactly the price of every abandoned quote. Worse, it would inflate
 * the guarantee with calls that were never going to happen, which is the same
 * error as counting free-tier value (excluded for the same reason).
 *
 * So the test is `holdId !== null`: **value can only be withheld if it was
 * first held.** {@link isWithheldIntent} is the single place that is written.
 *
 * The amount is the hold's, not the intent's price. A rail-A call is held at
 * the quote (the dearest eligible binding) and re-priced to the binding that
 * served, and a refund gives back the whole hold. A call that settles below
 * its hold releases the remainder on a COMMITTED hold; that release is not
 * withheld value either, and is its own term below, `settlementRemainders`.
 *
 * ## What this file is not
 *
 * It is not a query. It is the definition the queries must agree with, in the
 * same relationship `balance-fold.ts` has to the snapshot table: the ledger side
 * (`Σ HOLD_RELEASE`) and the intent side (`Σ price` over the buckets) are two
 * independent computations of one number, and `reconcileWithheld` is what
 * decides which is right when they differ. A figure with no way to be falsified
 * is a claim, not a record.
 */

import { AssetId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { MoneyUtil } from '@shared/utils/money.util';

/**
 * Why the agent was not charged.
 *
 * Named rather than derived at each surface: the decomposition must be
 * rendered identically on the overview,
 * the guarantee panel and the statement, and three surfaces that each map
 * statuses to buckets in their own way is three chances to disagree in front of
 * the same user.
 */
export enum WithheldBucket {
  /**
   * Verification struck the response down. **This is the guarantee firing.**
   *
   * Terminal status `REFUNDED`. Distinct from every other bucket because it is
   * the only one that also means something about the provider — a strike, and
   * downstream a possible slash.
   */
  FAILED_VERIFICATION = 'FAILED_VERIFICATION',

  /**
   * The call never produced a usable outcome — a provider error, a request the
   * provider rejected, or an intent that expired with its funds reserved.
   *
   * Terminal statuses `VOIDED` and `EXPIRED`. Not the guarantee, and it must
   * not be presented as the guarantee.
   */
  PROVIDER_OR_PLATFORM_ERROR = 'PROVIDER_OR_PLATFORM_ERROR',
}

/** The label each bucket is rendered under. One wording, every surface. */
export const WITHHELD_BUCKET_LABEL: Readonly<Record<WithheldBucket, string>> = Object.freeze({
  [WithheldBucket.FAILED_VERIFICATION]: 'failed verification',
  [WithheldBucket.PROVIDER_OR_PLATFORM_ERROR]: 'provider or platform error',
});

/**
 * Terminal status → bucket, for the statuses that withhold.
 *
 * A status absent from this map does not withhold. `SETTLED` is absent because
 * the agent was charged; `CREATED`, `FUNDS_SECURED`, `PROVIDER_EXECUTING` and
 * `VERIFYING` are absent because they are not terminal and the call may still
 * end either way.
 *
 * Keyed by the string value rather than by `PaymentIntentStatus` so the ledger
 * domain does not take an import edge on the payment domain for four string
 * constants. The pairing is asserted against the real enum in the payment
 * module's tests, which is where a new terminal status would be added.
 */
export const WITHHELD_STATUS_BUCKET: Readonly<Record<string, WithheldBucket>> = Object.freeze({
  REFUNDED: WithheldBucket.FAILED_VERIFICATION,
  VOIDED: WithheldBucket.PROVIDER_OR_PLATFORM_ERROR,
  EXPIRED: WithheldBucket.PROVIDER_OR_PLATFORM_ERROR,
});

/** The statuses that put an intent's listed price into `withheld`. */
export const WITHHELD_STATUSES: readonly string[] = Object.freeze(
  Object.keys(WITHHELD_STATUS_BUCKET),
);

/**
 * An open time window. Either edge omitted means unbounded on that side.
 *
 * Lives beside the definition rather than on `LedgerPort`: the port is the
 * money-movement contract and knows nothing about reporting windows.
 */
export interface WithheldPeriod {
  readonly from?: Date;
  readonly to?: Date;
}

/** The minimum an intent must expose for its withholding to be decided. */
export interface WithheldCandidate {
  readonly status: string;
  /** The hold that reserved the price. `null` means nothing was ever reserved. */
  readonly holdId: string | null;
}

/**
 * Did this intent withhold its listed price?
 *
 * Both halves are load-bearing and neither is redundant: the status says the
 * call ended without a charge, and the hold says there was something to not
 * charge. See the file comment for why an intent that expired in `CREATED` is
 * not withheld money.
 */
export function isWithheldIntent(intent: WithheldCandidate): boolean {
  return intent.holdId !== null && intent.status in WITHHELD_STATUS_BUCKET;
}

/** Which bucket an intent falls in, or `null` if it withheld nothing. */
export function withheldBucketOf(intent: WithheldCandidate): WithheldBucket | null {
  if (!isWithheldIntent(intent)) return null;
  return WITHHELD_STATUS_BUCKET[intent.status];
}

/** One bucket's contribution, with the call count the figure is meaningless without. */
export interface WithheldBucketTotal {
  readonly bucket: WithheldBucket;
  readonly label: string;
  readonly calls: number;
  readonly amount: Money;
}

/**
 * `withheld`, decomposed.
 *
 * `calls` sits beside `amount` everywhere because the figure must never be
 * rendered as a bare number: *"$3.41 not charged this month, across
 * 214 calls"* is a record, and `$3.41` on its own is an advertisement.
 */
export interface WithheldTotal {
  readonly asset: AssetId;
  readonly calls: number;
  readonly amount: Money;
  /** Always both buckets, in declaration order, zero-filled. */
  readonly buckets: readonly WithheldBucketTotal[];
}

/** One intent's contribution to the total. */
export interface WithheldEntry {
  readonly status: string;
  readonly holdId: string | null;
  readonly price: Money;
}

/**
 * Sums entries into one decomposed total.
 *
 * Both buckets are always present, zero-filled — a bucket that vanishes when it
 * is empty makes two periods incomparable, and an absent "failed verification"
 * row reads as *"we do not report that"* rather than as *"nothing failed"*.
 */
export function sumWithheld(
  asset: AssetId,
  decimals: number,
  entries: readonly WithheldEntry[],
): WithheldTotal {
  const perBucket = new Map<WithheldBucket, { calls: number; amount: bigint }>();
  for (const bucket of Object.values(WithheldBucket)) {
    perBucket.set(bucket, { calls: 0, amount: 0n });
  }

  for (const entry of entries) {
    const bucket = withheldBucketOf(entry);
    if (!bucket) continue;

    const running = perBucket.get(bucket) as { calls: number; amount: bigint };
    running.calls += 1;
    running.amount += MoneyUtil.toAtomic(entry.price);
  }

  const buckets = Object.values(WithheldBucket).map((bucket) => {
    const running = perBucket.get(bucket) as { calls: number; amount: bigint };
    return {
      bucket,
      label: WITHHELD_BUCKET_LABEL[bucket],
      calls: running.calls,
      amount: MoneyUtil.of(running.amount, asset, decimals),
    };
  });

  return {
    asset,
    calls: buckets.reduce((total, bucket) => total + bucket.calls, 0),
    amount: MoneyUtil.sum(buckets.map((bucket) => bucket.amount)),
    buckets,
  };
}

export function zeroWithheld(asset: AssetId, decimals: number): WithheldTotal {
  return sumWithheld(asset, decimals, []);
}

/**
 * The two independent computations of `withheld`, and their difference.
 *
 * The requirement is stated as *"reconciles exactly against `Σ HOLD_RELEASE`"*,
 * and that is very nearly true.
 * The exception is real, small, and must be named rather than rounded away:
 *
 * > `PaymentIntentService.secureFunds` opens the hold **before** the
 * > compare-and-swap that publishes `FUNDS_SECURED`, because the hold is what
 * > makes that status true. A caller that loses the race releases the hold it
 * > just opened. The journal then carries a `HOLD_CREATE` and a `HOLD_RELEASE`
 * > for a hold the intent never recorded — `hold_id` stays `null`, because the
 * > update that would have written it is the one that was lost.
 *
 * Those releases are **orphaned**: real ledger movements belonging to no
 * withheld intent. They are not withheld value — nothing was withheld, the
 * money was never committed to anything — but they do sit in `Σ HOLD_RELEASE`.
 *
 * So the identity this returns is the honest one:
 *
 * ```text
 *   holdReleaseTotal  ==  withheld  +  settlementRemainders  +  orphanedReleases
 * ```
 *
 * `settlementRemainders` is the remainder a cheaper serve returns on its own
 * committed hold: expected, one per such call, so it is kept out of the orphan
 * term rather than burying a real orphan among them (final review N-8).
 *
 * and `ok` asserts it. Reporting a bare `withheld == Σ HOLD_RELEASE` and
 * quietly tolerating a delta would mean the first genuine bug in hold accounting
 * — a double release, a release against the wrong hold — arrives looking exactly
 * like the benign race, and nobody would look twice. A named term that is
 * normally zero is a term whose becoming non-zero is a signal.
 */
export interface WithheldReconciliation {
  /** The intent side: `Σ` held amount over the withheld buckets. */
  readonly withheld: WithheldTotal;
  /** The ledger side: `Σ HOLD_RELEASE` over the same window and account. */
  readonly holdReleaseTotal: Money;
  /**
   * `Σ HOLD_RELEASE` that belongs to no withheld intent — see above.
   *
   * Normally zero. Non-zero is either the `secureFunds` race or a bug, and the
   * two are told apart by whether the count is small and the holds are all
   * unreferenced by their intents.
   */
  readonly orphanedReleases: Money;
  /** The first {@link MAX_LISTED_ORPHANED_HOLD_IDS} of them; `orphanedHoldCount` is all. */
  readonly orphanedHoldIds: readonly string[];
  readonly orphanedHoldCount: number;
  /** `Σ HOLD_RELEASE` of the remainders returned on committed holds — see above. */
  readonly settlementRemainders: Money;
  /** `holdReleaseTotal == withheld + settlementRemainders + orphanedReleases`. */
  readonly ok: boolean;
  /** `holdReleaseTotal - (withheld + settlementRemainders + orphanedReleases)`, atomic. */
  readonly difference: string;
}

/**
 * How many orphaned hold ids a reconciliation lists. Orphans are normally
 * none; past this many the count says enough, and a response that grows with
 * an account's history is not one to return on every `GET /balances`.
 */
export const MAX_LISTED_ORPHANED_HOLD_IDS = 100;

/**
 * Assembles the reconciliation and decides whether it balances.
 *
 * Pure, and takes both sides as arguments, for the same reason
 * `verifySnapshots` folds the journal rather than trusting it: the point of the
 * check is that the two sides were obtained by different routes.
 */
export function reconcileWithheld(input: {
  readonly withheld: WithheldTotal;
  readonly holdReleaseTotal: Money;
  readonly orphanedReleases: Money;
  readonly orphanedHoldIds: readonly string[];
  /** Every orphan, when `orphanedHoldIds` was already capped; its length otherwise. */
  readonly orphanedHoldCount?: number;
  readonly settlementRemainders: Money;
}): WithheldReconciliation {
  const difference =
    MoneyUtil.toAtomic(input.holdReleaseTotal) -
    (MoneyUtil.toAtomic(input.withheld.amount) +
      MoneyUtil.toAtomic(input.settlementRemainders) +
      MoneyUtil.toAtomic(input.orphanedReleases));

  return {
    withheld: input.withheld,
    holdReleaseTotal: input.holdReleaseTotal,
    orphanedReleases: input.orphanedReleases,
    orphanedHoldIds: input.orphanedHoldIds.slice(0, MAX_LISTED_ORPHANED_HOLD_IDS),
    orphanedHoldCount: input.orphanedHoldCount ?? input.orphanedHoldIds.length,
    settlementRemainders: input.settlementRemainders,
    ok: difference === 0n,
    difference: difference.toString(),
  };
}
