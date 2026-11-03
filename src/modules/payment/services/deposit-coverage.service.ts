import { Inject, Injectable } from '@nestjs/common';

import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { AccountId, AssetId } from '@modules/chains/ports/caip.types';
import { escrowLedgerClaim } from '@modules/ledger/domain/escrow-ledger-claim';
import {
  ESCROW_BALANCE_READER,
  EscrowBalanceReaderPort,
} from '@modules/ledger/ports/escrow-balance-reader.port';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { MoneyUtil } from '@shared/utils/money.util';

/** One read of a buyer's escrow against what the ledger says it holds. */
export interface EscrowCoverage {
  /** What the buyer's escrow holds on chain now. */
  readonly chain: bigint;
  /** `escrowLedgerClaim` of the buyer's balance, before the credit asked about. */
  readonly claim: bigint;
  /** Whether `claim + extra <= chain`. */
  readonly covered: boolean;
}

/**
 * The guard that keeps deposit credits backed by the buyer's own escrow (H-1).
 *
 * A `Deposited` event proves money ENTERED the escrow at some block, not that
 * it is still there. A buyer who deposits outside an intent, withdraws on
 * chain (the withdrawal booker debits only what the ledger has as available),
 * and then reports the old hash would otherwise be credited with money that
 * left. So every write that grows what the ledger says a buyer's escrow holds
 * from a deposit, and the promotion to spendable, asks the chain first:
 *
 *   `escrowLedgerClaim(ledger) + credit <= escrow balance on chain`
 *
 * the same sum the reconciler compares (`ESCROW_MIRROR_DRIFT`). The chain read
 * is live (the EVM reader has no cache), and a failed read throws: an unknown
 * balance is never treated as enough.
 */
@Injectable()
export class DepositCoverageService {
  constructor(
    @Inject(ESCROW_BALANCE_READER) private readonly escrowReader: EscrowBalanceReaderPort,
    private readonly ledger: LedgerService,
    private readonly intents: PaymentIntentRepository,
  ) {}

  /**
   * Whether the buyer's escrow covers its ledger claim plus `extra` atomic
   * units. `extra` is the credit about to be written (`0n` when the credit is
   * already on the ledger, as at finality).
   */
  async check(
    organizationId: string,
    account: AccountId,
    asset: AssetId,
    extra: bigint,
  ): Promise<EscrowCoverage> {
    const [reading, balance, heldOnChain] = await Promise.all([
      this.escrowReader.read(account, asset),
      this.ledger.getBalance(organizationId, account, asset),
      this.intents.sumHeldOnChainByAccounts(asset, [account]),
    ]);
    // No escrow on chain is a zero balance, never "unknown".
    const chain = reading ? MoneyUtil.toAtomic(reading.balance) : 0n;
    const claim = escrowLedgerClaim(
      {
        available: BigInt(balance.available.amount),
        held: BigInt(balance.held.amount),
        pending: BigInt(balance.pending.amount),
      },
      heldOnChain.get(account) ?? 0n,
    );
    return { chain, claim, covered: claim + extra <= chain };
  }
}
