import { Inject, Injectable, Logger } from '@nestjs/common';

import { AccountId, AssetId, parseAccountId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { EscrowLimits } from '@modules/chains/ports/escrow.types';
import { UnsignedChainTransaction } from '@modules/chains/ports/unsigned-chain-transaction';

import { decayVoucherWindow } from '@modules/payment/domain/voucher-window';

import { loweredCaps, lowersAnything, UnsettledVouchers } from '../domain/unsettled-vouchers';
import { SettlementErrors } from '../errors/settlement.errors';
import {
  ESCROW_INTENT_BUILDER,
  EscrowIntentBuilderPort,
  EscrowIntentKind,
} from '../ports/escrow-intent-builder.port';
import {
  RELAYED_ESCROW_INTENT,
  RelayedEscrowIntent,
  RelayedEscrowIntentFields,
  RelayedEscrowIntentPort,
  RelayedEscrowSubmission,
} from '../ports/relayed-escrow-intent.port';
import {
  WITHDRAW_GAS_GRANT,
  WithdrawGasGrant,
  WithdrawGasGrantPort,
} from '../ports/withdraw-gas-grant.port';
import { EscrowAccountService, EscrowState } from './escrow-account.service';
import { ReconciliationService } from './reconciliation.service';
import { RelayedIntentRateLimiter } from './relayed-intent-rate-limiter.service';
import { UnsettledScope, UnsettledVoucherGuard } from './unsettled-voucher-guard.service';

export interface EscrowIntentInput {
  readonly kind: EscrowIntentKind;
  readonly amount: Money | null;
  readonly limits: EscrowLimits | null;
  readonly destination: AccountId | null;
  /**
   * `SET_LIMITS` only: the buyer accepts that lowering the limits leaves
   * payments still being settled unredeemable (BUG-D1-07).
   */
  readonly acknowledgeUnsettled?: boolean;
}

export interface EscrowIntentResult {
  readonly transaction: UnsignedChainTransaction;
  /** The state as it was when the bytes were built, so the console can re-render without a second call. */
  readonly escrow: EscrowState;
  /**
   * The gas grant this `withdraw` triggered, or `null`.
   *
   * `null` on `SET_LIMITS` and `REQUEST_WITHDRAW` — neither is the transaction
   * the buyer needs native gas for — and `null` on a chain that has no grant.
   * See {@link WithdrawalService.buildIntent} for why it is consulted where it
   * is, and `withdraw-gas-grant.port.ts` for the four states.
   */
  readonly gasGrant: WithdrawGasGrant | null;
}

/**
 * What a relayed submission answers with: what landed, and the state it left
 * behind — read off the CHAIN, not off the request.
 *
 * The escrow snapshot is taken after the transaction is mined rather than
 * predicted from what was submitted, for the same reason
 * {@link EscrowIntentResult.escrow} exists: a console should be able to
 * re-render from one response. Predicting it would publish the platform's
 * arithmetic about a contract's state, which is the one number a buyer has a
 * right to get from the contract.
 */
export interface RelayedEscrowIntentResult {
  readonly submission: RelayedEscrowSubmission;
  readonly escrow: EscrowState;
}

/**
 * The buyer's exit, and the buyer's brake, as they are after the per-buyer
 * escrow. Despite the name, this is now the one domain
 * service `EscrowController` calls for all four buyer-signed intents —
 * `set_escrow_limits`, `request_withdraw`, `withdraw`, `close_escrow` — the
 * same shape `ProviderStakeIntentService.createIntent` already has for a
 * provider's four.
 *
 * **This class no longer moves money and no longer holds a signature.** What
 * it does is decide whether an intent is possible to build right now, and
 * hand the bytes to the buyer's wallet. Every check the old nine-step
 * withdrawal-authorization version made has moved, and saying where is the
 * point of this comment:
 *
 * | old step | now |
 * |---|---|
 * | signature present / well-formed / unexpired | gone — there is no authorization struct; the buyer signs a transaction |
 * | binding: `owner == session.agentAccount` | the escrow PDA is derived from the session's account, so a mis-aimed request has no address to go to |
 * | signature valid | the chain's, at `withdraw` |
 * | freeze on `isFrozen(asset)` | KEPT — see below |
 * | nonce reservation (Redis) | gone; `BuyerEscrow.withdraw_requested` is a single slot on chain, so a replay overwrites rather than duplicates |
 * | Squads proposal | gone; the buyer signs `withdraw` themselves |
 * | `WITHDRAWAL` ledger debit | gone — nothing writes one, so the ledger mirror keeps the pre-withdrawal balance; `EscrowSpendGateService` prices every rail-B call against the chain instead |
 *
 * **The freeze stays, and it is the only platform-side veto left.** A
 * reserves breach means the books and the chain disagree, and continuing to
 * hand out withdrawal bytes while that is true would be handing out claims on
 * money that may not exist. It refuses to *build*; it cannot stop a buyer who
 * already holds signed bytes, and it must not — the whole design says a
 * buyer's exit does not depend on the platform's cooperation. That asymmetry
 * is deliberate: the freeze is a brake on the platform's own eagerness to
 * help, not a gate on the buyer. Applied only to the two withdrawal-shaped
 * kinds — `set_escrow_limits` and `close_escrow` move no money out of the
 * platform's control and are not what a reserves breach is about.
 *
 * Every precondition specific to *which* intent — destination validity,
 * `withdraw_available_at`, the close quarantine — lives in
 * `EscrowIntentBuilderPort`, not here: this class does not know the shape of
 * a `BuyerEscrow` account, and it does not need to.
 */
@Injectable()
export class WithdrawalService {
  private readonly logger = new Logger(WithdrawalService.name);

  constructor(
    @Inject(ESCROW_INTENT_BUILDER) private readonly builder: EscrowIntentBuilderPort,
    private readonly reconciliation: ReconciliationService,
    private readonly escrows: EscrowAccountService,
    /**
     * The withdraw gas grant. Reached through a port, never as
     * `EvmGasGrantService`: this is a settlement service and the grant is
     * behind the chain boundary — see `withdraw-gas-grant.port.ts`.
     */
    @Inject(WITHDRAW_GAS_GRANT) private readonly gasGrants: WithdrawGasGrantPort,
    /**
     * The relayed submit half. Reached through a port for the same reason the
     * grant is: this is a settlement service and the relayer lives behind the
     * chain boundary. See `relayed-escrow-intent.port.ts` for why it is a
     * SECOND port rather than a method on the builder.
     */
    @Inject(RELAYED_ESCROW_INTENT) private readonly relayed: RelayedEscrowIntentPort,
    private readonly relayedRate: RelayedIntentRateLimiter,
    private readonly unsettled: UnsettledVoucherGuard,
  ) {}

  async buildIntent(
    organizationId: string,
    account: AccountId,
    asset: AssetId,
    input: EscrowIntentInput,
  ): Promise<EscrowIntentResult> {
    if (
      input.kind === EscrowIntentKind.REQUEST_WITHDRAW ||
      input.kind === EscrowIntentKind.WITHDRAW
    ) {
      await this.assertNotFrozen(asset);
    }

    const transaction = await this.builder.buildIntent({
      kind: input.kind,
      account,
      asset,
      amount: input.amount,
      limits: input.limits,
      destination: input.destination,
    });

    // A relayed request (EIP-712, the platform sends it) is refused here, before
    // the payer is asked to sign, when the relay budget is spent (BUG-D1-06).
    if (transaction.kind === 'typed-data') {
      await this.assertRelayRoom(organizationId, account);
    }

    // Lowering the escrow's limits below what its served, unredeemed payments
    // need strands them — every signer's, delegates' included (BUG-D1-07).
    // Refused here, before the wallet is asked, unless acknowledged — or not at
    // all on an escrow with the tighten delay (D-21), where it cannot strand.
    const before =
      input.kind === EscrowIntentKind.SET_LIMITS
        ? await this.escrows.get(organizationId, account, asset)
        : null;
    if (before !== null && input.limits !== null) {
      const check = limitsCheck(account, asset, before, input.limits);
      if (check !== null) {
        await this.unsettled.refuseIfStranding(
          check.scope,
          check.lowered,
          input.acknowledgeUnsettled === true,
        );
      }
    }

    /*
      The gas grant, and **only after the bytes exist**.

      ## Why here and not one line earlier

      The grant's second control is a MATURED withdrawal: it will not fund an
      address whose `withdraw()` would revert for another hour. That is the same
      precondition the builder has just enforced — `EvmEscrowIntentBuilder`
      refuses a `WITHDRAW` with `withdrawRequested == 0` or before
      `withdrawAvailableAt`, throwing `SETTLEMENT_WITHDRAWAL_NOT_YET_AVAILABLE`
      — so past this line the precondition is established by the code path
      itself rather than hoped for.

      Running the grant BEFORE the builder would spend a once-ever, never
      refundable budget on a buyer whose intent then failed to build for an
      unrelated reason (a destination naming somebody else, an RPC that could
      not be read). The grant would have paid, the buyer would have no
      transaction, and the address could never be funded again. The cost of
      this ordering is one extra RPC round trip before the grant is consulted,
      on the rarest route in the domain.

      ## Why not one line later, on the way back from `escrows.get`

      Nothing forbids it and nothing gains from it: the grant moves ETH, not
      the escrow's tokens, so the snapshot below is identical either way.

      ## Why `SET_LIMITS` and `REQUEST_WITHDRAW` get nothing

      Neither is the transaction that needs native gas. On `eip155` both are
      relayed EIP-712 signature requests — the buyer signs, the relayer sends,
      the buyer pays no gas at all. Only `withdraw()` is `msg.sender`-only, and
      that is precisely why the grant exists.
    */
    const gasGrant =
      input.kind === EscrowIntentKind.WITHDRAW
        ? await this.grantWithdrawGas(organizationId, account)
        : null;

    const escrow = before ?? (await this.escrows.get(organizationId, account, asset));

    return { transaction, escrow, gasGrant };
  }

  /**
   * **The buyer signed; the platform sends** — the verb this domain
   * shipped without.
   *
   * `buildIntent` above issues an EIP-712 request and, until this method, no
   * route anywhere took the signature back. Both relayed doors worked on a
   * chain and neither was reachable from the product.
   *
   * ## The ruling this implements
   *
   * **The signature is the authority for *what* happens; the session is the
   * authority for *whether we pay for it*.** Everything about validity is the
   * contract's and is not re-implemented anywhere on this path — a wrong signer
   * is `SignerIsNotBuyer`, a replay is `BadNonce`, a malleated `s` is
   * `MalleableSignature`, a stale one is `SignatureExpired`, and all four were
   * proved live. What this platform decides is whose gas budget is spent, and
   * it decides it in three places, in this order and for a reason:
   *
   * 1. **The binding, first, because it is free.** A signed request naming
   *    somebody else is refused by name before an RPC call or a Redis round
   *    trip. The chain would *accept* such a submission — a genuine signature
   *    by B over a message naming B verifies whoever sends it — so this is the
   *    one refusal on the path that only the platform can make. Without it, one
   *    session could make the relayer pay for every signature it could scrape.
   * 2. **The freeze, for `REQUEST_WITHDRAW` only**, exactly as `buildIntent`
   *    applies it. Refusing to *build* a withdrawal request while the vault is
   *    known short and then happily *submitting* one would make the freeze
   *    mean nothing — a buyer could keep bytes from before it and post them.
   *    `SET_LIMITS` moves no money out of the platform's control and is not
   *    what a reserves breach is about, so it is not frozen.
   * 3. **The rate limit, last of the three and before anything is spent.** See
   *    `domain/relayed-intent-rate-limit.ts`: the pre-flight makes an *invalid*
   *    submission cost an RPC call instead of gas, and this is what bounds the
   *    *valid* ones, which a buyer can produce indefinitely by signing at each
   *    new `authNonce`.
   *
   * ## What this method still does not do
   *
   * It writes no ledger row. A relayed `setLimitsBySig` moves no money at all,
   * and a relayed `requestWithdrawBySig` only starts a clock — the debit is the
   * reconciler's, from the observed `total_withdrawn` delta, exactly as the
   * table at the top of this class says. Adding a row here would double-count
   * against it.
   */
  async submitRelayedIntent(
    organizationId: string,
    account: AccountId,
    asset: AssetId,
    claimedBuyer: string,
    intent: RelayedEscrowIntentFields,
    acknowledgeUnsettled = false,
  ): Promise<RelayedEscrowIntentResult> {
    this.assertIsOwnAccount(account, claimedBuyer);

    if (intent.kind === EscrowIntentKind.REQUEST_WITHDRAW) {
      await this.assertNotFrozen(asset);
    }

    const relay = async () => {
      await this.relayedRate.admit(account, organizationId);
      return this.relayed.submit({ ...intent, account } as RelayedEscrowIntent);
    };

    // Lowered limits are checked once more against the unsettled payments, and
    // relayed under a pause on the payer's admission, so no voucher is admitted
    // under the old limits in between (BUG-D1-07).
    let submission: RelayedEscrowSubmission;
    const check =
      intent.kind === EscrowIntentKind.SET_LIMITS
        ? limitsCheck(account, asset, await this.escrows.get(organizationId, account, asset), {
            maxVoucherAmount: intent.maxVoucherAmount,
            maxPerWindow: intent.maxPerWindow,
          })
        : null;
    if (check !== null) {
      submission = await this.unsettled.relayTightening({
        scope: check.scope,
        lowered: check.lowered,
        acknowledged: acknowledgeUnsettled,
        deadline: intent.deadline,
        relay,
      });
    } else {
      submission = await relay();
    }
    const escrow = await this.escrows.get(organizationId, account, asset);

    this.logger.log(
      `relayed ${intent.kind} for ${account} landed at ${submission.transactionHash} ` +
        `(${submission.gasUsed} gas)`,
    );

    return { submission, escrow };
  }

  /**
   * The payer's payments the chain has not redeemed yet, beside the escrow's
   * own window (BUG-D1-07). `null` when the chain could not be read.
   */
  async unsettledVouchers(
    organizationId: string,
    account: AccountId,
    asset: AssetId,
  ): Promise<UnsettledVouchers | null> {
    const escrow = await this.escrows.get(organizationId, account, asset);
    const scope = escrowWindowScope(account, asset, escrow);
    return scope === null ? null : this.unsettled.read(scope);
  }

  /**
   * How long a tightening of this payer's escrow waits before it binds a
   * voucher already signed: `TIGHTEN_DELAY_SECONDS` on an escrow with D-21,
   * else `0` (it binds at once, and can strand what is unsettled).
   */
  tightenDelaySeconds(account: AccountId): Promise<number> {
    return this.unsettled.tightenDelaySeconds(account);
  }

  /**
   * Refuses when the next relayed submission for this account would be
   * rate limited, so a route that builds something to sign can say so before
   * the wallet prompt (BUG-D1-06). Records nothing; `submitRelayedIntent` is
   * still where the budget is spent and enforced.
   */
  async assertRelayRoom(organizationId: string, account: AccountId): Promise<void> {
    await this.relayedRate.assertRoom(account, organizationId);
  }

  /**
   * The `buyer` inside the signed message must be the session's own account.
   *
   * Compared **case-insensitively**, because EIP-55 is a checksum carried in the
   * case of the hex digits: `0x7fd9…f8d1` and `0x7FD9…F8D1` are one address, and
   * a wallet is entitled to echo back either. Nothing else about a CAIP-10
   * string varies by case on `eip155`.
   *
   * On a namespace where case *is* significant this comparison would be too
   * permissive — and there is no such implementation: `NamespaceRelayedEscrowIntent`
   * has an `eip155` entry and nothing else, so a Solana account is refused
   * `CHAIN_UNSUPPORTED` two lines later regardless of what this decides.
   *
   * The comparison is also not the only thing standing here. The call is encoded
   * from `account` — the session's — and never from `claimedBuyer`, so a
   * submission that somehow got past this would name the session's own address
   * and be refused `SignerIsNotBuyer` by the contract at the pre-flight, before
   * any gas. This refusal exists to give that case a name and a 403 instead of
   * a chain revert.
   */
  private assertIsOwnAccount(account: AccountId, claimedBuyer: string): void {
    const { address } = parseAccountId(account);
    if (address.toLowerCase() !== claimedBuyer.toLowerCase()) {
      throw SettlementErrors.relayedIntentForAnotherBuyer({ buyer: claimedBuyer, account });
    }
  }

  /**
   * The grant, and a broken grant is never a broken withdrawal.
   *
   * This class's own rule is that *"a buyer's exit does not depend on the
   * platform's cooperation"*, and letting a throw out of here would break it in
   * the exact case it was written for: an RPC outage, a database the grant
   * cannot reach, an unconfigured cap. The bytes are already built and are
   * already valid; a buyer who has their own ETH would then be denied a
   * withdrawal because a faucet they never needed was down.
   *
   * So it degrades to `UNAVAILABLE` — a state a control firing can never
   * produce — and logs at `error`, because a faucet that is failing every call
   * is an operational fact and the alert on the success path cannot report it.
   */
  private async grantWithdrawGas(
    organizationId: string,
    account: AccountId,
  ): Promise<WithdrawGasGrant | null> {
    try {
      return await this.gasGrants.grantWithdrawGas(organizationId, account);
    } catch (error) {
      this.logger.error(
        `withdraw gas grant could not be consulted for ${account}; the withdrawal is unaffected: ${
          (error as Error).message
        }`,
      );
      return { kind: 'UNAVAILABLE' };
    }
  }

  private async assertNotFrozen(asset: AssetId): Promise<void> {
    if (await this.reconciliation.isFrozen(asset)) {
      throw SettlementErrors.withdrawalsFrozen({ asset });
    }
  }
}

/** The escrow's own window, as the chain last showed it; null when it could not be read. */
function escrowWindowScope(
  account: AccountId,
  asset: AssetId,
  escrow: EscrowState,
): UnsettledScope | null {
  if (!escrow.chainReadable || escrow.spentInWindow === null) return null;
  const readAt = escrow.observedAt ? new Date(escrow.observedAt) : new Date();
  const startedAt = escrow.windowStartedAt ? Date.parse(escrow.windowStartedAt) / 1000 : 0;
  return {
    payer: account,
    asset,
    delegate: null,
    carried: decayVoucherWindow(
      BigInt(escrow.spentInWindow.amount),
      Math.floor(startedAt),
      Math.floor(readAt.getTime() / 1000),
      escrow.windowSeconds,
    ),
    readAt,
  };
}

/**
 * Which of the escrow's limits `next` lowers, and the window its unsettled
 * payments land on. Null when nothing is lowered or the chain was not read.
 */
function limitsCheck(account: AccountId, asset: AssetId, escrow: EscrowState, next: EscrowLimits) {
  if (escrow.maxVoucherAmount === null || escrow.maxPerWindow === null) return null;
  const lowered = loweredCaps(
    {
      maxVoucherAmount: BigInt(escrow.maxVoucherAmount.amount),
      maxPerWindow: BigInt(escrow.maxPerWindow.amount),
    },
    { maxVoucherAmount: next.maxVoucherAmount, maxPerWindow: next.maxPerWindow },
  );
  if (!lowersAnything(lowered)) return null;
  const scope = escrowWindowScope(account, asset, escrow);
  return scope === null ? null : { scope, lowered };
}
