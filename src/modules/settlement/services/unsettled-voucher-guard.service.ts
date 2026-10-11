import { Injectable, Logger } from '@nestjs/common';

import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { AccountId, AssetId } from '@modules/chains/ports/caip.types';
import { VOUCHER_ADMISSION_CHAIN_LAG_MS } from '@modules/payment/constants/voucher.constants';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  LoweredCaps,
  lowersAnything,
  StrandReason,
  strandedBy,
  UnsettledVouchers,
} from '../domain/unsettled-vouchers';
import { SettlementErrors } from '../errors/settlement.errors';

/** The most a relayed tightening may keep the payer's admission paused, should the relay hang. */
export const TIGHTENING_ADMISSION_HOLD_MS = 120_000;

/**
 * How long admission stays paused AFTER a tightening landed: a voucher whose
 * chain read was taken before the landing (old caps) and whose insert comes
 * after it must not be admitted. The read-to-insert gap is one RPC call.
 */
export const TIGHTENING_ADMISSION_SETTLE_MS = 15_000;

/** Where the chain counter beside an unsettled read comes from. */
export interface UnsettledScope {
  readonly payer: AccountId;
  readonly asset: AssetId;
  /** Only this delegate's vouchers; null for every voucher of the payer (the escrow's window). */
  readonly delegate: AccountId | null;
  /** The chain's counter for that window, decayed to `readAt`. */
  readonly carried: bigint;
  /** When the chain was read. */
  readonly readAt: Date;
}

/**
 * Lowering caps with payments in flight (BUG-D1-07).
 *
 * Both the escrow's limits and a delegate's grant are applied by the chain at
 * REDEMPTION, minutes after the call was served. A buyer who lowers either
 * below what those payments need makes the chain refuse them, and the
 * platform pays the provider. Two defences, both here:
 *
 * - **Refuse, unless acknowledged.** The intent route (before the wallet is
 *   asked) and the submit route (before the relayer spends gas) compare the
 *   lowered caps with every voucher the chain has not redeemed yet, and refuse
 *   `SETTLEMENT_UNSETTLED_VOUCHERS_AT_RISK` when one would be stranded. The
 *   buyer can wait (they usually settle within a minute) or say
 *   `acknowledgeUnsettled: true`, which is then a decision, not an accident.
 * - **No new voucher while a tightening is relayed.** The submit-time check and
 *   a pause on the payer's admission are written in one transaction under the
 *   payer's admission lock, so a voucher admitted under the old caps either
 *   is counted by the check or is refused by the pause. The pause outlives the
 *   landing by {@link TIGHTENING_ADMISSION_SETTLE_MS}, and is lifted at once
 *   when the relay was refused (nothing landed).
 *
 * A change that lowers nothing is passed straight through: a raise cannot
 * strand anything that fits today.
 */
@Injectable()
export class UnsettledVoucherGuard {
  private readonly logger = new Logger(UnsettledVoucherGuard.name);

  constructor(private readonly intents: PaymentIntentRepository) {}

  /** The unsettled vouchers in one window, beside its chain counter. */
  async read(scope: UnsettledScope): Promise<UnsettledVouchers> {
    const totals = await this.intents.unsettledVouchers(this.repositoryScope(scope));
    return beside(totals, scope.carried);
  }

  /** Refuses when `lowered` strands an unsettled voucher and the buyer did not acknowledge it. */
  assertNotStranding(
    unsettled: UnsettledVouchers,
    lowered: LoweredCaps,
    asset: AssetId,
    acknowledged: boolean,
  ): void {
    const reasons = strandedBy(unsettled, lowered);
    if (reasons.length === 0 || acknowledged) return;
    throw SettlementErrors.unsettledVouchersAtRisk({
      count: unsettled.count,
      amount: formatAtomic(unsettled.total, asset),
      reasons: reasons.map(describeReason).join('; '),
    });
  }

  /**
   * Relays a change under the admission pause, after the last check. `relay`
   * runs only when nothing would be stranded (or the buyer acknowledged it).
   * A change that lowers nothing is relayed as is.
   */
  async relayTightening<T>(args: {
    readonly scope: UnsettledScope;
    readonly lowered: LoweredCaps;
    readonly acknowledged: boolean;
    readonly relay: () => Promise<T>;
  }): Promise<T> {
    const { scope, lowered } = args;
    if (!lowersAnything(lowered)) return args.relay();

    const [totals] = await this.intents.holdVoucherAdmission(
      scope.payer,
      new Date(Date.now() + TIGHTENING_ADMISSION_HOLD_MS),
      [this.repositoryScope(scope)],
    );
    let resumeAt: Date | null = new Date();
    try {
      this.assertNotStranding(
        beside(totals, scope.carried),
        lowered,
        scope.asset,
        args.acknowledged,
      );
      const result = await args.relay();
      resumeAt = new Date(Date.now() + TIGHTENING_ADMISSION_SETTLE_MS);
      return result;
    } catch (error) {
      // A refusal by name (ours, or the relay's: rate limit, pre-flight, chain
      // revert) means nothing landed, so the pause can go now. Anything else —
      // a timeout, a lost receipt — may still land: the pause is left to run
      // out on its own, so no voucher is admitted against caps that may be gone.
      if (!isDefiniteRefusal(error)) resumeAt = null;
      throw error;
    } finally {
      if (resumeAt !== null) {
        await this.intents
          .resumeVoucherAdmission(scope.payer, resumeAt)
          .catch((error: unknown) =>
            this.logger.warn(
              `could not lift the voucher admission pause of ${scope.payer}; it ends on its own ` +
                `within ${TIGHTENING_ADMISSION_HOLD_MS / 1000} s: ${String(error)}`,
            ),
          );
      }
    }
  }

  private repositoryScope(scope: UnsettledScope) {
    return {
      payer: scope.payer,
      assetId: scope.asset,
      delegate: scope.delegate,
      since: new Date(scope.readAt.getTime() - VOUCHER_ADMISSION_CHAIN_LAG_MS),
    };
  }
}

function beside(
  totals: {
    count: number;
    total: bigint;
    largest: bigint;
    redeemableUntil: Date | null;
    redeemedSince: bigint;
  },
  carried: bigint,
): UnsettledVouchers {
  return {
    count: totals.count,
    total: totals.total,
    largest: totals.largest,
    windowNeeds: totals.count === 0 ? 0n : carried + totals.redeemedSince + totals.total,
    redeemableUntil: totals.redeemableUntil,
  };
}

function isDefiniteRefusal(error: unknown): boolean {
  const code = (error as { errorCode?: unknown } | null)?.errorCode;
  return (
    typeof code === 'string' &&
    (code === 'SETTLEMENT_UNSETTLED_VOUCHERS_AT_RISK' ||
      code.startsWith('SETTLEMENT_RELAYED_INTENT_') ||
      code.startsWith('SETTLEMENT_DELEGATION_'))
  );
}

function describeReason(reason: StrandReason): string {
  switch (reason) {
    case StrandReason.MAX_VOUCHER_AMOUNT:
      return 'one is larger than the new per-payment cap';
    case StrandReason.MAX_PER_WINDOW:
      return 'together they no longer fit the new 24-hour cap';
    case StrandReason.VALID_UNTIL:
      return 'the new expiry is before they can be redeemed';
    case StrandReason.REVOKED:
      return 'a revoked key cannot be redeemed for';
  }
}

function formatAtomic(amount: bigint, asset: AssetId): string {
  try {
    const { decimals, symbol } = getAssetMetadata(asset);
    return MoneyUtil.format(MoneyUtil.of(amount, asset, decimals), { symbol });
  } catch {
    return `${amount} atomic units`;
  }
}
