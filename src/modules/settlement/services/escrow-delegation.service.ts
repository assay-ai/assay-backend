import { Inject, Injectable, Logger } from '@nestjs/common';

import { AccountId, AssetId, parseAccountId, toAccountId } from '@modules/chains/ports/caip.types';
import { UnsignedChainTransaction } from '@modules/chains/ports/unsigned-chain-transaction';

import {
  DelegationTerms,
  ESCROW_DELEGATION,
  EscrowDelegation,
  EscrowDelegationPort,
} from '../ports/escrow-delegation.port';
import {
  RelayedEscrowIntentFields,
  RelayedEscrowSubmission,
} from '../ports/relayed-escrow-intent.port';
import { EscrowAccountService } from './escrow-account.service';
import { WithdrawalService } from './withdrawal.service';

export interface RelayedDelegationResult {
  readonly submission: RelayedEscrowSubmission;
  readonly asset: AssetId;
  /**
   * Read back after the transaction landed; `null` when that read failed. The
   * submission is what happened — a failed follow-up read must not turn a
   * landed authorisation or revocation into an error (review S3-12).
   */
  readonly delegates: readonly EscrowDelegation[] | null;
}

/**
 * Agent payment delegation, for the payer's own (HUMAN) session.
 *
 * Building and relaying are the escrow-limits flow's, unchanged: the intent is
 * an EIP-712 request at the escrow's `authNonce`, and the submission goes
 * through `WithdrawalService.submitRelayedIntent` — the same own-account check,
 * the same rate limit on the relayer's gas, the same pre-flight that names the
 * contract's refusal before anything is spent. What differs is only what is
 * read back afterwards: the payer's delegates, from the chain.
 */
@Injectable()
export class EscrowDelegationService {
  private readonly logger = new Logger(EscrowDelegationService.name);

  constructor(
    @Inject(ESCROW_DELEGATION) private readonly delegation: EscrowDelegationPort,
    private readonly withdrawals: WithdrawalService,
    private readonly escrows: EscrowAccountService,
  ) {}

  assetFor(account: AccountId): Promise<AssetId> {
    return this.escrows.assetFor(account);
  }

  authorizeIntent(account: AccountId, terms: DelegationTerms): Promise<UnsignedChainTransaction> {
    return this.delegation.authorizeIntent(account, terms);
  }

  revokeIntent(account: AccountId, delegate: string): Promise<UnsignedChainTransaction> {
    return this.delegation.revokeIntent(account, delegateOn(account, delegate));
  }

  list(account: AccountId): Promise<readonly EscrowDelegation[]> {
    return this.delegation.list(account);
  }

  async submit(
    organizationId: string,
    account: AccountId,
    claimedPayer: string,
    intent: RelayedEscrowIntentFields,
  ): Promise<RelayedDelegationResult> {
    const asset = await this.escrows.assetFor(account);
    const { submission } = await this.withdrawals.submitRelayedIntent(
      organizationId,
      account,
      asset,
      claimedPayer,
      intent,
    );
    let delegates: readonly EscrowDelegation[] | null;
    try {
      delegates = await this.delegation.list(account);
    } catch (error) {
      this.logger.warn(
        `relayed ${intent.kind} for ${account} landed at ${submission.transactionHash}; the ` +
          `read-back of its delegates failed (${error instanceof Error ? error.message : error})`,
      );
      delegates = null;
    }
    return { submission, asset, delegates };
  }
}

/** A bare 0x delegate address, on the payer's own chain. */
export function delegateOn(account: AccountId, delegate: string): AccountId {
  return toAccountId(parseAccountId(account).chainId, delegate);
}
