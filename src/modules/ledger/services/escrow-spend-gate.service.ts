import { Inject, Injectable } from '@nestjs/common';

import { LedgerHoldRepository } from '@database/postgres/repositories/ledger-hold.repository';
import { AccountId, AssetId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { PaymentErrors } from '@modules/payment/errors/payment.errors';
import { PaymentRail } from '@modules/payment/ports/payment.types';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  ESCROW_BALANCE_READER,
  EscrowBalanceReaderPort,
  EscrowChainBalance,
} from '../ports/escrow-balance-reader.port';
import { LedgerErrors } from '../errors/ledger.errors';

export const ESCROW_SPEND_GATE_ENABLED = 'ESCROW_SPEND_GATE_ENABLED';

/**
 * Fail-closed parse of `ESCROW_SPEND_GATE_ENABLED`.
 *
 * Enabled only for the exact string `'true'` — an unset variable, a typo, an
 * empty string or a `'1'` all read as disabled. Modelled on
 * `PROVIDER_PAYOUT_EXECUTION_ENABLED`'s parse: for a switch whose
 * "on" position can refuse every paid call on the platform, fail-closed is the
 * direction that costs nothing to get wrong by omission.
 */
export function parseEscrowSpendGateEnabled(value: string | undefined): boolean {
  return value === 'true';
}

export interface Spendable {
  /** `escrow_ata.amount`, straight off the chain. */
  readonly chain: Money;
  /** `Σ amount` over every `OPEN` ledger hold against this account and asset. */
  readonly openHolds: Money;
  /** `chain − openHolds`, floored at zero. */
  readonly spendable: Money;
  /**
   * `BuyerEscrow.withdraw_requested`. Non-zero means the buyer has asked for
   * their money back and the escrow will pay it out as soon as the chain's own
   * delay elapses.
   *
   * It is deliberately **not** subtracted from {@link spendable}: a pending
   * withdrawal refuses the next call outright (see
   * {@link EscrowSpendGateService.assertAffordable}) rather than shrinking the
   * budget, because a partial request would otherwise let calls keep landing in
   * a race with the withdrawal they cannot see the timing of.
   */
  readonly withdrawRequested: bigint;
}

/**
 * Prices a call against the buyer's on-chain escrow, not the ledger.
 *
 * ## The flag governs rail A only
 *
 * `ESCROW_SPEND_GATE_ENABLED` defaults to disabled, and all it decides is
 * whether a rail-A intent is refused (see below). Turning it on is a cutover
 * with its own runbook, not something a deploy flips by accident.
 *
 * **Rail B is always priced against the chain**, whatever the flag says. A
 * rail-B voucher is collected from the buyer's escrow and from nothing else,
 * so a voucher the escrow cannot cover is a served call nobody can be charged
 * for. The ledger mirror cannot answer that question: nothing writes a
 * `WITHDRAWAL` entry, so after `request_withdraw` → wait → `withdraw` the
 * mirror still shows the old balance while the escrow is empty (A6 in the
 * no-platform-debt review). See {@link assertAffordable}.
 *
 * ## Rail A has no rail here
 *
 * An MCP rail-A call carries no signature, so nothing can ever debit an
 * escrow for it. While the gate is on, a rail-A intent is refused with
 * `PAYMENT_ESCROW_NOT_OPEN` rather than silently spending an unbacked
 * balance — the rejected alternative is "keep rail A spending an off-chain
 * pooled balance", which is exactly the property per-buyer escrows remove.
 *
 * ## Never falls back to the ledger
 *
 * `EscrowBalanceReaderPort.read` already fails closed on a stale or
 * unreadable chain — this class does not additionally catch that and
 * consult the ledger as a fallback. Doing so would reintroduce the ledger as
 * an authority on spending, which is the property per-buyer escrows remove.
 */
@Injectable()
export class EscrowSpendGateService {
  readonly enabled: boolean;

  constructor(
    @Inject(ESCROW_BALANCE_READER) private readonly reader: EscrowBalanceReaderPort,
    private readonly holds: LedgerHoldRepository,
    @Inject(ESCROW_SPEND_GATE_ENABLED) enabled: boolean,
  ) {
    this.enabled = enabled;
  }

  /**
   * `null` when the account has no escrow. Never negative — a mirror that has
   * drifted ahead of the chain (more held than the chain has) reports zero
   * spendable, not a negative figure a caller would have to clamp itself.
   */
  async spendable(
    _organizationId: string,
    account: AccountId,
    asset: AssetId,
  ): Promise<Spendable | null> {
    const reading = await this.reader.read(account, asset);
    if (!reading) {
      return null;
    }

    return this.netOfHolds(account, asset, reading);
  }

  private async netOfHolds(
    account: AccountId,
    asset: AssetId,
    reading: EscrowChainBalance,
  ): Promise<Spendable> {
    const openHoldsAtomic = await this.holds.sumOpenByAccount(account, asset);
    const chainAtomic = BigInt(reading.balance.amount);
    const spendableAtomic = chainAtomic > openHoldsAtomic ? chainAtomic - openHoldsAtomic : 0n;

    return {
      chain: reading.balance,
      openHolds: MoneyUtil.of(openHoldsAtomic, asset, reading.balance.decimals),
      spendable: MoneyUtil.of(spendableAtomic, asset, reading.balance.decimals),
      withdrawRequested: reading.withdrawRequested,
    };
  }

  /**
   * Throws unless `price` fits inside the buyer's on-chain escrow, net of
   * every open hold.
   *
   * Order matters at the call site: this is meant to run **before**
   * `createHold`, so an unaffordable call never opens a hold it then has to
   * release.
   *
   * ## Rail B is NOT behind the flag
   *
   * The flag decides only whether a rail-A intent is refused. For rail B
   * every check here runs whatever it says — no escrow, a standing
   * withdrawal, and a price over the chain balance net of open holds are all
   * refused.
   *
   * On chain, `request_withdraw` → wait `WITHDRAW_DELAY_SECONDS` → `withdraw`
   * is deliberately **not** blocked by pending redemptions: the program lets a
   * buyer leave without asking the platform's permission, which is the whole
   * custody guarantee. So a buyer can request a withdrawal, wait out the delay,
   * spend the escrow on calls in the meantime, and `withdraw` before the
   * redemption cron lands any of the vouchers those calls produced. And once
   * `withdraw` has landed, `withdrawRequested` is back to zero and only the
   * chain balance shows the escrow is empty — the ledger mirror does not,
   * because nothing writes a `WITHDRAWAL` entry. Either way every voucher
   * admitted dies `EscrowInsufficient` after its call was served.
   *
   * Nothing on chain stops that and nothing is meant to. The backend refusing
   * to *serve* a voucher the escrow cannot cover is the whole control, and a
   * control that only runs when a cutover flag is on is not a control.
   *
   * It costs one `EscrowBalanceReaderPort.read`, cached for
   * `ESCROW_BALANCE_CACHE_TTL_MS`, and one sum over open holds.
   */
  async assertAffordable(
    organizationId: string,
    account: AccountId,
    price: Money,
    context: { readonly rail: PaymentRail },
  ): Promise<void> {
    if (context.rail === PaymentRail.RAIL_A_PER_CALL) {
      if (this.enabled) {
        // No signature exists for this call, so no `redeem_voucher` can
        // ever debit an escrow for it. Behind the flag: a rail-A call has no
        // escrow to price, and refusing it here with the gate off would stop
        // every MCP rail-A call on the platform.
        throw PaymentErrors.escrowNotOpen({ account });
      }
      return;
    }

    const reading = await this.reader.read(account, price.asset as AssetId);

    if (!reading) {
      // No escrow means nothing a voucher could ever be redeemed against.
      throw PaymentErrors.escrowNotOpen({ account });
    }

    if (reading.withdrawRequested > 0n) {
      // Refuse a buyer with a standing withdrawal when
      // ACCEPTING a new voucher; the ones already accepted are still redeemed,
      // and `VoucherRedemptionService` deliberately does not consult this flag.
      //
      // The failure this refuses: the voucher is accepted, the buyer's
      // `withdraw()` lands first, the escrow drains, and `redeem_voucher` dies
      // with `EscrowInsufficient` — the call served, the money gone. Checked
      // before the amount, because it is not a question of how much is there.
      throw PaymentErrors.withdrawalPending({
        account,
        availableAt: reading.withdrawAvailableAt || undefined,
      });
    }

    const result = await this.netOfHolds(account, price.asset as AssetId, reading);

    if (MoneyUtil.compare(result.spendable, price) < 0) {
      // Same error the ledger's own CHECK raises for the same reason — the
      // backstop and this gate report insufficiency identically, so no caller
      // needs a second branch to recognise "the chain says no" from "the
      // ledger says no".
      throw LedgerErrors.insufficientAvailableBalance({
        accountId: account,
        required: price.amount,
        available: result.spendable.amount,
      });
    }
  }
}
