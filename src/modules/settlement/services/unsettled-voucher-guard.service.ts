import { Inject, Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { AccountId, AssetId } from '@modules/chains/ports/caip.types';
import {
  EvmRelayerTiming,
  readEvmRelayerTiming,
  relayedSendBudgetMs,
} from '@modules/chains/evm/evm-relayer-timing';
import { EVM_CONSTANTS } from '@modules/chains/evm/evm.constants';
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
import { TIGHTEN_DELAY, TightenDelayPort } from '../ports/tighten-delay.port';

/**
 * How long admission stays paused AFTER a tightening landed, on the database's
 * clock — and, independently of the clock, an admission whose chain read was
 * taken before the landing plus this margin is refused (see
 * `PaymentIntentRepository.insertAdmittedVoucherIntent`). The same margin the
 * admission already allows an RPC node to answer behind the chain.
 */
export const TIGHTENING_ADMISSION_SETTLE_MS = VOUCHER_ADMISSION_CHAIN_LAG_MS;

/**
 * The least a relayed tightening keeps admission paused while its relay is
 * pending: the relayer's whole send budget (queue wait, RPC calls, receipt
 * wait, all from config) plus the chain-lag margin. By then the relay has
 * answered or timed out; on an unknown outcome the pause also runs until the
 * signed request's own deadline has passed (it cannot land after it).
 */
export function tighteningHoldMs(timing: EvmRelayerTiming): number {
  return relayedSendBudgetMs(timing) + VOUCHER_ADMISSION_CHAIN_LAG_MS;
}

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
 * below what those payments need makes the chain refuse them, and the calls
 * become buyer debt the buyer must re-sign (the platform never pays them).
 * Two defences, both here:
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
 *   is counted by the check or is refused by the pause. Each request holds its
 *   own pause, for as long as its outcome can be unknown; see
 *   {@link UnsettledVoucherGuard.relayTightening}.
 *
 * A change that lowers nothing is passed straight through: a raise cannot
 * strand anything that fits today.
 *
 * ## It stands down on an escrow with the tighten delay (assay-evm D-21)
 *
 * There a tightening binds an already-valid voucher only `TIGHTEN_DELAY_SECONDS`
 * (`EVM_CONSTANTS.TIGHTEN_DELAY_SECONDS`, 10,800 s since D-24) after it lands — longer than any voucher stays redeemable — so it
 * can no longer strand one, and a voucher admitted against a read taken just
 * before the landing is covered too. Both defences are then skipped: nothing is
 * refused, nothing needs acknowledging, and no admission pause is written.
 * Whether a payer's escrow has it is asked of {@link TightenDelayPort} on each
 * change, so the guard keeps protecting until the upgrade is seen and stands
 * down as soon as it is; this whole class goes once every chain has it.
 */
@Injectable()
export class UnsettledVoucherGuard implements OnApplicationBootstrap {
  private readonly logger = new Logger(UnsettledVoucherGuard.name);
  private readonly timing: EvmRelayerTiming;

  constructor(
    private readonly intents: PaymentIntentRepository,
    @Optional() config?: ConfigService,
    @Optional()
    @Inject(TIGHTEN_DELAY)
    private readonly tightenDelay: TightenDelayPort | null = null,
  ) {
    this.timing = readEvmRelayerTiming((key) =>
      config ? config.get<string>(key) : process.env[key],
    );
  }

  /**
   * Fails the boot when the pause table is not in its per-request shape: every
   * locked voucher admission reads it, so running without the migration would
   * refuse every rail-B payment with a SQL error (review finding 13).
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.intents.assertAdmissionPauseSchema();
  }

  /** The unsettled vouchers in one window, beside its chain counter. */
  async read(scope: UnsettledScope): Promise<UnsettledVouchers> {
    const totals = await this.intents.unsettledVouchers(this.repositoryScope(scope));
    return beside(totals, scope.carried);
  }

  /**
   * Whether `payer`'s escrow makes a tightening wait (D-21), so this guard has
   * nothing to protect there. False when unknown: the guard then stays up.
   */
  async standsDown(payer: AccountId): Promise<boolean> {
    return (await this.tightenDelay?.holdsTightening(payer)) ?? false;
  }

  /** `TIGHTEN_DELAY_SECONDS` where {@link standsDown}, else `0`. */
  async tightenDelaySeconds(payer: AccountId): Promise<number> {
    return (await this.standsDown(payer)) ? EVM_CONSTANTS.TIGHTEN_DELAY_SECONDS : 0;
  }

  /**
   * The intent-route check: reads the unsettled vouchers in `scope` and refuses
   * when `lowered` would strand one, unless acknowledged. Nothing is read when
   * the change lowers nothing or the escrow has the tighten delay.
   */
  async refuseIfStranding(
    scope: UnsettledScope,
    lowered: LoweredCaps,
    acknowledged: boolean,
  ): Promise<void> {
    if (!lowersAnything(lowered) || (await this.standsDown(scope.payer))) return;
    this.assertNotStranding(await this.read(scope), lowered, scope.asset, acknowledged);
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
   * Relays a change under its own admission pause, after the last check.
   * `relay` runs only when nothing would be stranded (or the buyer
   * acknowledged it). A change that lowers nothing, or one on an escrow with
   * the tighten delay, is relayed as is.
   *
   * The pause is this request's alone (one row; another request's outcome
   * cannot end it) and covers only what the change can strand: one delegate's
   * vouchers for a change of its grant, every voucher of the payer for the
   * escrow's own limits. It lasts as long as the outcome can be unknown:
   *
   * - **landed**: until the chain-lag margin after the landing, and for any
   *   admission whose chain read predates that;
   * - **refused by name** (nothing landed): lifted at once;
   * - **unknown** (a timeout, a lost receipt): left to run its full length,
   *   which is the relayer's whole send budget and never shorter than the
   *   signed request's deadline plus the margin — after both, nothing can land.
   */
  async relayTightening<T>(args: {
    readonly scope: UnsettledScope;
    readonly lowered: LoweredCaps;
    readonly acknowledged: boolean;
    /** The signed request's deadline, unix seconds on the chain's clock. */
    readonly deadline: bigint;
    readonly relay: () => Promise<T>;
  }): Promise<T> {
    const { scope, lowered } = args;
    if (!lowersAnything(lowered) || (await this.standsDown(scope.payer))) return args.relay();

    const lagSeconds = VOUCHER_ADMISSION_CHAIN_LAG_MS / 1000;
    const { pauseId, totals } = await this.intents.holdVoucherAdmission(
      {
        payer: scope.payer,
        delegate: scope.delegate,
        holdSeconds: Math.ceil(tighteningHoldMs(this.timing) / 1000),
        notBeforeEpochSeconds: Number(args.deadline) + lagSeconds,
      },
      [this.repositoryScope(scope)],
    );
    let outcome: 'landed' | 'refused' | 'unknown' = 'unknown';
    try {
      this.assertNotStranding(
        beside(totals[0], scope.carried),
        lowered,
        scope.asset,
        args.acknowledged,
      );
      const result = await args.relay();
      outcome = 'landed';
      return result;
    } catch (error) {
      // A refusal by name (ours, or the relay's: rate limit, pre-flight, chain
      // revert, a send given up unsent) means nothing landed and nothing will. Anything else may
      // still land: the pause runs its full length.
      if (isDefiniteRefusal(error)) outcome = 'refused';
      throw error;
    } finally {
      await this.endPause(scope.payer, pauseId, outcome);
    }
  }

  private async endPause(
    payer: AccountId,
    pauseId: string,
    outcome: 'landed' | 'refused' | 'unknown',
  ): Promise<void> {
    if (outcome === 'unknown') return;
    try {
      if (outcome === 'landed') {
        await this.intents.landVoucherAdmissionPause(
          pauseId,
          TIGHTENING_ADMISSION_SETTLE_MS / 1000,
        );
      } else {
        await this.intents.releaseVoucherAdmissionPause(pauseId);
      }
    } catch (error) {
      // Either way the row ends on its own, at its full length: the safe side.
      this.logger.warn(
        `could not end the voucher admission pause ${pauseId} of ${payer} (${outcome}); it ` +
          `runs its full length instead: ${String(error)}`,
      );
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
      code === 'CHAIN_RELAY_NOT_SENT' ||
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
