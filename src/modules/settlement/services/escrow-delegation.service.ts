import { Inject, Injectable, Logger } from '@nestjs/common';

import { AccountId, AssetId, parseAccountId, toAccountId } from '@modules/chains/ports/caip.types';
import { UnsignedChainTransaction } from '@modules/chains/ports/unsigned-chain-transaction';

import {
  LoweredCaps,
  loweredCaps,
  lowersAnything,
  UnsettledVouchers,
} from '../domain/unsettled-vouchers';
import {
  DelegationTerms,
  ESCROW_DELEGATION,
  EscrowDelegation,
  EscrowDelegationKind,
  EscrowDelegationPort,
} from '../ports/escrow-delegation.port';
import {
  RelayedEscrowIntentFields,
  RelayedEscrowSubmission,
} from '../ports/relayed-escrow-intent.port';
import { EscrowAccountService } from './escrow-account.service';
import { UnsettledScope, UnsettledVoucherGuard } from './unsettled-voucher-guard.service';
import { WithdrawalService } from './withdrawal.service';

/** A standing delegation, with the payments it signed that the chain has not redeemed yet. */
export interface EscrowDelegationWithUnsettled extends EscrowDelegation {
  readonly unsettled: UnsettledVouchers;
}

export interface RelayedDelegationResult {
  readonly submission: RelayedEscrowSubmission;
  readonly asset: AssetId;
  /**
   * Read back after the transaction landed; `null` when that read failed. The
   * submission is what happened — a failed follow-up read must not turn a
   * landed authorisation or revocation into an error (review S3-12).
   */
  readonly delegates: readonly EscrowDelegationWithUnsettled[] | null;
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
    private readonly unsettled: UnsettledVoucherGuard,
  ) {}

  assetFor(account: AccountId): Promise<AssetId> {
    return this.escrows.assetFor(account);
  }

  /**
   * The two intents refuse when the relay budget is spent BEFORE building, so
   * the payer is never asked to sign a request the relay will then refuse
   * (BUG-D1-06).
   */
  async authorizeIntent(
    organizationId: string,
    account: AccountId,
    terms: DelegationTerms,
    acknowledgeUnsettled = false,
  ): Promise<UnsignedChainTransaction> {
    await this.withdrawals.assertRelayRoom(organizationId, account);
    // Lowering a cap below what the delegate's served, unredeemed payments need
    // strands them (BUG-D1-07): refused here, before the wallet is asked.
    const { scope, lowered } = await this.standing(account, terms);
    if (lowersAnything(lowered)) {
      const unsettled = await this.unsettled.read(scope);
      this.unsettled.assertNotStranding(unsettled, lowered, scope.asset, acknowledgeUnsettled);
    }
    return this.delegation.authorizeIntent(account, terms);
  }

  async revokeIntent(
    organizationId: string,
    account: AccountId,
    delegate: string,
  ): Promise<UnsignedChainTransaction> {
    await this.withdrawals.assertRelayRoom(organizationId, account);
    return this.delegation.revokeIntent(account, delegateOn(account, delegate));
  }

  /** The standing delegations, each with its unsettled payments (BUG-D1-07). */
  async list(account: AccountId): Promise<readonly EscrowDelegationWithUnsettled[]> {
    const readAt = new Date();
    const [delegates, asset] = await Promise.all([
      this.delegation.list(account),
      this.escrows.assetFor(account),
    ]);
    return Promise.all(
      delegates.map(async (d) => ({
        ...d,
        unsettled: await this.unsettled.read({
          payer: account,
          asset,
          delegate: d.delegate,
          carried: d.spentInWindow,
          readAt,
        }),
      })),
    );
  }

  async submit(
    organizationId: string,
    account: AccountId,
    claimedPayer: string,
    intent: RelayedEscrowIntentFields,
    acknowledgeUnsettled = false,
  ): Promise<RelayedDelegationResult> {
    const asset = await this.escrows.assetFor(account);
    const relay = () =>
      this.withdrawals.submitRelayedIntent(organizationId, account, asset, claimedPayer, intent);
    // The last check, under a pause on the payer's admission so no voucher is
    // admitted under the old caps while the new ones are relayed (BUG-D1-07).
    // A revocation is never refused for it — revoking is the brake, and its
    // in-flight risk is accepted — but it is relayed under the pause too.
    let submission;
    if (
      intent.kind === EscrowDelegationKind.AUTHORIZE_DELEGATE ||
      intent.kind === EscrowDelegationKind.REVOKE_DELEGATE
    ) {
      const delegate = delegateOn(account, intent.delegate);
      // A revocation lowers everything and needs no read of the grant first: a
      // chain read that fails must not stand between the payer and its brake.
      const { scope, lowered } =
        intent.kind === EscrowDelegationKind.AUTHORIZE_DELEGATE
          ? await this.standing(
              account,
              {
                delegate,
                maxVoucherAmount: intent.maxVoucherAmount,
                maxPerWindow: intent.maxPerWindow,
                validUntil: intent.validUntil,
              },
              asset,
            )
          : {
              scope: { payer: account, asset, delegate, carried: 0n, readAt: new Date() },
              lowered: { revoked: true },
            };
      ({ submission } = await this.unsettled.relayTightening({
        scope,
        lowered,
        acknowledged: intent.kind === EscrowDelegationKind.REVOKE_DELEGATE || acknowledgeUnsettled,
        relay,
      }));
    } else {
      ({ submission } = await relay());
    }
    let delegates: readonly EscrowDelegationWithUnsettled[] | null;
    try {
      delegates = await this.list(account);
    } catch (error) {
      this.logger.warn(
        `relayed ${intent.kind} for ${account} landed at ${submission.transactionHash}; the ` +
          `read-back of its delegates failed (${error instanceof Error ? error.message : error})`,
      );
      delegates = null;
    }
    return { submission, asset, delegates };
  }

  /**
   * The delegate's grant as the chain holds it now, and which of its caps
   * `change` lowers (BUG-D1-07). A key with no standing grant lowers nothing.
   */
  private async standing(
    account: AccountId,
    change: DelegationTerms,
    knownAsset?: AssetId,
  ): Promise<{ scope: UnsettledScope; lowered: LoweredCaps }> {
    const readAt = new Date();
    const [delegates, asset] = await Promise.all([
      this.delegation.list(account),
      knownAsset ? Promise.resolve(knownAsset) : this.escrows.assetFor(account),
    ]);
    const wanted = parseAccountId(change.delegate).address.toLowerCase();
    const current =
      delegates.find((d) => parseAccountId(d.delegate).address.toLowerCase() === wanted) ?? null;
    const scope: UnsettledScope = {
      payer: account,
      asset,
      delegate: current?.delegate ?? change.delegate,
      carried: current?.spentInWindow ?? 0n,
      readAt,
    };
    return { scope, lowered: current === null ? {} : loweredCaps(current, change) };
  }
}

/** A bare 0x delegate address, on the payer's own chain. */
export function delegateOn(account: AccountId, delegate: string): AccountId {
  return toAccountId(parseAccountId(account).chainId, delegate);
}
