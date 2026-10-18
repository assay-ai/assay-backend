import { Inject, Injectable, Logger } from '@nestjs/common';

import { EscrowWithdrawalEventRepository } from '@database/postgres/repositories/escrow-withdrawal-event.repository';
import { LedgerEntryRepository } from '@database/postgres/repositories/ledger-entry.repository';
import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { AccountId } from '@modules/chains/ports/caip.types';

import { MoneyDto } from '../dto/get-balances.dto';
import {
  GetStatementBalanceResponseDto,
  StatementBalanceCheckDto,
  StatementBalanceDto,
} from '../dto/get-statement-balance.dto';
import {
  ESCROW_BALANCE_READER,
  EscrowBalanceReaderPort,
} from '../ports/escrow-balance-reader.port';
import { OrganizationEscrow, WithdrawalsService } from './withdrawals.service';

/**
 * `GET /statements/balance` (B7): the money half of a monthly statement, per
 * escrow — `opening + deposits − withdrawals − paid = closing`.
 *
 * **Derived, never written, and checked.** Each figure is a sum over records
 * that already exist: credited deposits (the ledger's deposit entries),
 * claimed withdrawals (the withdrawal index) and charged rail-B calls (the
 * same rule as `GET /receipts/summary`). The opening balance is the same sums
 * before the period. For a period that has not ended the closing balance is
 * checked against the escrow read from the chain now, allowing for charged
 * payments the chain has not taken yet; a difference is reported, never
 * corrected. Nothing here moves money or decides anything.
 *
 * Only escrows whose withdrawals are indexed (eip155) get a statement.
 */
@Injectable()
export class StatementService {
  private readonly logger = new Logger(StatementService.name);

  constructor(
    private readonly withdrawalsService: WithdrawalsService,
    private readonly ledgerEntries: LedgerEntryRepository,
    private readonly paymentIntents: PaymentIntentRepository,
    private readonly withdrawals: EscrowWithdrawalEventRepository,
    @Inject(ESCROW_BALANCE_READER) private readonly reader: EscrowBalanceReaderPort,
  ) {}

  async balance(
    organizationId: string,
    from: Date,
    to: Date,
    now: Date = new Date(),
  ): Promise<GetStatementBalanceResponseDto> {
    const escrows = await this.withdrawalsService.organizationEscrows(organizationId);
    const items: StatementBalanceDto[] = [];
    for (const escrow of escrows) {
      items.push(await this.forEscrow(organizationId, escrow, from, to, now));
    }
    return { items };
  }

  private async forEscrow(
    organizationId: string,
    escrow: OrganizationEscrow,
    from: Date,
    to: Date,
    now: Date,
  ): Promise<StatementBalanceDto> {
    const sums = async (start: Date | null, end: Date) => {
      const [deposits, withdrawn, paid] = await Promise.all([
        this.ledgerEntries.sumDeposits(
          organizationId,
          escrow.accountId,
          escrow.assetId,
          start,
          end,
        ),
        this.withdrawals.sumWithdrawn([escrow], start, end),
        this.paymentIntents.sumEscrowPaid(
          organizationId,
          escrow.accountId,
          escrow.assetId,
          start,
          end,
        ),
      ]);
      const withdrawals = withdrawn.get(`${escrow.chainId}:${escrow.buyerAddress}`) ?? 0n;
      return { deposits, withdrawals, paid };
    };

    const before = await sums(null, from);
    const during = await sums(from, to);
    const opening = before.deposits - before.withdrawals - before.paid;
    const closing = opening + during.deposits - during.withdrawals - during.paid;

    return {
      account: escrow.accountId,
      chainId: escrow.chainId,
      opening: money(opening, escrow),
      deposits: money(during.deposits, escrow),
      withdrawals: money(during.withdrawals, escrow),
      paid: money(during.paid, escrow),
      closing: money(closing, escrow),
      check:
        to.getTime() > now.getTime() ? await this.check(organizationId, escrow, closing) : null,
    };
  }

  /** The closing balance against the escrow read now; `null` when the chain cannot be read. */
  private async check(
    organizationId: string,
    escrow: OrganizationEscrow,
    closing: bigint,
  ): Promise<StatementBalanceCheckDto | null> {
    let reading;
    try {
      reading = await this.reader.read(escrow.accountId as AccountId, escrow.assetId);
    } catch (error) {
      this.logger.warn(
        `statement check: the escrow ${escrow.accountId} could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
    const balance = reading ? BigInt(reading.balance.amount) : 0n;
    const stillSettling = await this.paymentIntents.sumEscrowChargedNotRedeemed(
      organizationId,
      escrow.accountId,
      escrow.assetId,
    );
    const difference = balance - stillSettling - closing;
    return {
      escrowBalance: money(balance, escrow),
      stillSettling: money(stillSettling, escrow),
      difference: money(difference, escrow),
      matches: difference === 0n,
      observedAt: (reading?.observedAt ?? new Date()).toISOString(),
    };
  }
}

function money(amount: bigint, escrow: OrganizationEscrow): MoneyDto {
  return { amount: amount.toString(), asset: escrow.assetId, decimals: escrow.decimals };
}
