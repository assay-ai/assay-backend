import { AssertDomainErrorCodes, createDomainErrorFactory } from '@shared/errors/error-catalog';

/**
 * `SETTLEMENT_*` — the on-chain settlement program, signed attestations and
 * slash execution.
 *
 * `settlementNotPermitted` is the code for a core constraint: the platform has
 * no path to slash on its own authority. It is a 403 rather than a 500 because
 * refusing is the correct, expected behaviour, not a malfunction.
 */
export enum SettlementErrorCode {
  SETTLEMENT_SLASH_NOT_PERMITTED = 'SETTLEMENT_SLASH_NOT_PERMITTED',
  SETTLEMENT_RESERVES_BREACH = 'SETTLEMENT_RESERVES_BREACH',

  // ── The buyer's escrow exit, now a chain transaction ─────────────────────
  SETTLEMENT_WITHDRAWALS_FROZEN = 'SETTLEMENT_WITHDRAWALS_FROZEN',
  /** `withdraw`'s destination named the escrow's own token account — the program refuses it too. */
  SETTLEMENT_WITHDRAWAL_DESTINATION_INVALID = 'SETTLEMENT_WITHDRAWAL_DESTINATION_INVALID',
  /** `withdraw` built before `BuyerEscrow.withdraw_available_at`, or with no request outstanding. */
  SETTLEMENT_WITHDRAWAL_NOT_YET_AVAILABLE = 'SETTLEMENT_WITHDRAWAL_NOT_YET_AVAILABLE',
  /** The chain could not be read, so the escrow's own mint is unknown and no intent can be built. */
  SETTLEMENT_ESCROW_CHAIN_UNREADABLE = 'SETTLEMENT_ESCROW_CHAIN_UNREADABLE',

  // ── Submitting a buyer's signed, relayed escrow request ─────────────────
  /** The signed request names a buyer who is not this session's account. */
  SETTLEMENT_RELAYED_INTENT_FOR_ANOTHER_BUYER = 'SETTLEMENT_RELAYED_INTENT_FOR_ANOTHER_BUYER',
  /** The signature is not 65 bytes of hex, so there is nothing to submit. */
  SETTLEMENT_RELAYED_INTENT_MALFORMED = 'SETTLEMENT_RELAYED_INTENT_MALFORMED',
  /** The chain refused the relayed call, by name — before or after it was sent. */
  SETTLEMENT_RELAYED_INTENT_REFUSED = 'SETTLEMENT_RELAYED_INTENT_REFUSED',
  /** This account or organization has spent its share of the relayer's gas budget. */
  SETTLEMENT_RELAYED_INTENT_RATE_LIMITED = 'SETTLEMENT_RELAYED_INTENT_RATE_LIMITED',
  /** The submission budget could not be counted, so nothing was submitted. */
  SETTLEMENT_RELAYED_INTENT_UNAVAILABLE = 'SETTLEMENT_RELAYED_INTENT_UNAVAILABLE',
  // ── Agent payment delegation ─────────────────────────────────────────────
  /** A delegation request the escrow would refuse: bad delegate, caps or horizon. */
  SETTLEMENT_DELEGATION_INVALID = 'SETTLEMENT_DELEGATION_INVALID',
  /** A revocation of a delegate that is not authorised (never was, or already revoked). */
  SETTLEMENT_DELEGATION_NOT_ACTIVE = 'SETTLEMENT_DELEGATION_NOT_ACTIVE',
  /** Lowering these caps now would leave served, unredeemed vouchers unredeemable (BUG-D1-07). */
  SETTLEMENT_UNSETTLED_VOUCHERS_AT_RISK = 'SETTLEMENT_UNSETTLED_VOUCHERS_AT_RISK',
  // ── Boot-time configuration of the public reserves page ─────────────────
  SETTLEMENT_PUBLIC_RESERVES_ASSET_INVALID = 'SETTLEMENT_PUBLIC_RESERVES_ASSET_INVALID',
  SETTLEMENT_PUBLIC_RESERVES_ASSET_NOT_ENABLED = 'SETTLEMENT_PUBLIC_RESERVES_ASSET_NOT_ENABLED',
}

export type SettlementErrorCodesArePrefixed = AssertDomainErrorCodes<
  'SETTLEMENT',
  `${SettlementErrorCode}`
>;

export const SettlementErrors = createDomainErrorFactory('SETTLEMENT', {
  slashNotPermitted: {
    code: SettlementErrorCode.SETTLEMENT_SLASH_NOT_PERMITTED,
    statusCode: 403,
    message: (context?: Record<string, any>) =>
      `Slash requires a signed verifier attestation — the platform cannot slash on its own authority` +
      `${context?.classification ? ` (classification: ${context.classification})` : ''}`,
  },
  /**
   * `vault_balance < Σ liabilities` — any breach pages immediately and halts
   * payouts.
   * 500, not 409: this is never a caller's mistake to retry around, it means
   * either an accounting bug or funds leaving the vault without a matching
   * ledger entry, and both are stop-everything conditions.
   */
  reservesBreach: {
    code: SettlementErrorCode.SETTLEMENT_RESERVES_BREACH,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `PROOF OF RESERVES BREACH on ${context?.asset ?? 'vault asset'}: vault holds ${context?.vaultBalance ?? '?'}` +
      ` but liabilities total ${context?.liabilities ?? '?'} — halt payouts and freeze withdrawals immediately`,
  },

  // ── Escrow exit ──────────────────────────────────────────────────────────

  /**
   * `withdraw`'s destination named the escrow's own token account.
   *
   * The program refuses it too (`DestinationIsEscrowAta`); refusing it here
   * means discovering that costs no network fee.
   */
  withdrawalDestinationInvalid: {
    code: SettlementErrorCode.SETTLEMENT_WITHDRAWAL_DESTINATION_INVALID,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Withdrawal destination may not be the escrow's own token account` +
      `${context?.destination ? `: ${context.destination}` : ''}`,
  },
  /**
   * `withdraw` built before `BuyerEscrow.withdraw_available_at`, or with no
   * `request_withdraw` outstanding at all — the two collapse to one refusal
   * because both mean the same thing to a buyer: there is nothing to pay out
   * right now.
   */
  withdrawalNotYetAvailable: {
    code: SettlementErrorCode.SETTLEMENT_WITHDRAWAL_NOT_YET_AVAILABLE,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `No withdrawal is available yet` +
      `${context?.availableAt ? ` (available at ${context.availableAt})` : ''}`,
  },
  /**
   * The settlement chain could not be read, so the escrow's own mint is
   * unknown — and every buyer-signed escrow transaction names that mint.
   *
   * **A refusal, by name, in place of a decode failure.** The condition that
   * produces it today is a deployed program whose `Config` carries an older
   * layout than this backend's decoder (`CHAIN_ACCOUNT_LAYOUT_UNEXPECTED`,
   * "expected 8 bytes, got 1"), but an RPC outage and an unset
   * `SETTLEMENT_PROGRAM_ID` reach it too: the caller's question — *can this
   * escrow transaction be built right now?* — has the same answer in all
   * three, and `reason` carries which one it was.
   *
   * **`GET /escrow` does NOT raise this**; it degrades to `chainReadable:
   * false` and renders what the database knows. This code is for the three
   * `*-intent` routes, which would have to invent a mint to answer — a
   * transaction built against a guessed mint is a transaction aimed at the
   * wrong token account, and `withdraw` moves money.
   *
   * `503`, matching `PAYMENT_ESCROW_BALANCE_UNAVAILABLE`: the remedy is
   * another attempt once the chain (or the deploy) is readable again, and a
   * buyer holding signed bytes is unaffected — their exit never depended on
   * this platform answering.
   */
  escrowChainUnreadable: {
    code: SettlementErrorCode.SETTLEMENT_ESCROW_CHAIN_UNREADABLE,
    statusCode: 503,
    message: (context?: Record<string, any>) =>
      `The settlement chain could not be read` +
      `${context?.account ? ` for ${context.account}` : ''}` +
      `, so the escrow's own mint is unknown and no escrow transaction can be built` +
      `${context?.reason ? `: ${context.reason}` : ''}`,
  },
  /**
   * Withdrawals are frozen because the last reconciliation found a breach.
   *
   * A vault below its liabilities means halt payouts, page on-call and **freeze
   * withdrawals pending investigation**. Paying out during a known shortfall
   * is a first-come-first-served race between users over money that is already
   * not all there.
   */
  withdrawalsFrozen: {
    code: SettlementErrorCode.SETTLEMENT_WITHDRAWALS_FROZEN,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Withdrawals are frozen on ${context?.asset ?? 'this asset'}: the last reconciliation ` +
      `found the vault below its liabilities and the discrepancy is under investigation`,
  },
  // ── The relayed submit path ──────────────────────────────────────────────

  /**
   * The signed request names a buyer who is not this session's own account.
   *
   * **403, and it is the whole threat model of the route in one refusal.** The
   * contract would accept this: a genuine signature by buyer B over a message
   * naming B verifies no matter who sends the transaction — `SignerIsNotBuyer`
   * fires on the signer, not on the sender. So the chain is not the layer that
   * can say no here, and the thing being protected is not B's escrow (which is
   * safe either way) but **the platform's own gas**: without this, one session
   * could make the relayer pay for every signature it could scrape.
   *
   * Not 404 and not 400: the caller is authenticated, the request is
   * well-formed, and what is being refused is the use of somebody else's
   * authority — which is what 403 means.
   *
   * **Why the name is `FOR_ANOTHER_BUYER` and not `NOT_YOURS`.**
   * `surface-consistency.spec.ts` bans a 403 on any lookup-shaped code, because
   * a 403 on a *lookup* confirms the resource exists and that is the leak. The
   * first spelling of this code was `…_NOT_YOURS` and the gate caught it — and
   * the gate was right to, on its own terms. This refusal is not a lookup:
   * nothing is resolved by a caller-supplied id, the address in question is one
   * the caller typed themselves, and every 20-byte address "exists" on an EVM
   * chain, so there is no existence to confirm. What the old name got wrong was
   * that it described a tenant boundary; what is actually being refused is a
   * signed message made out to a different buyer. The name now says that, and
   * the 403 stays.
   */
  relayedIntentForAnotherBuyer: {
    code: SettlementErrorCode.SETTLEMENT_RELAYED_INTENT_FOR_ANOTHER_BUYER,
    statusCode: 403,
    message: (context?: Record<string, any>) =>
      `This signed request names ${context?.buyer ?? 'another buyer'}, which is not this ` +
      `session's account${context?.account ? ` (${context.account})` : ''} — the platform does ` +
      `not relay one buyer's request on another buyer's session`,
  },
  /**
   * The signature is not `r || s || v`.
   *
   * Refused here so that a typo costs an HTTP round trip rather than an
   * `eth_estimateGas` and a decode failure deep inside viem's ABI encoder,
   * where the message names a word rather than a field.
   */
  relayedIntentMalformed: {
    code: SettlementErrorCode.SETTLEMENT_RELAYED_INTENT_MALFORMED,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `The relayed escrow request cannot be submitted` +
      `${context?.reason ? `: ${context.reason}` : ''}`,
  },
  /**
   * The chain refused, **by name**.
   *
   * `reason` is an `Errors.sol` name — `BadNonce`, `SignatureExpired`,
   * `MalleableSignature`, `SignerIsNotBuyer`, `EscrowLimitsUnchanged` — or
   * `UNKNOWN_REVERT:0x…` when the selector belongs to somebody else's contract.
   * A buyer should learn *"that nonce is used"*, not read a decode error, and a
   * 500 here would be this platform reporting its own failure for the chain
   * correctly applying a rule.
   *
   * `transactionHash` is present exactly when the refusal cost gas: absent means
   * the pre-flight `eth_call` caught it and **nothing was sent**, present means
   * state moved between the pre-flight and the send and the transaction reverted.
   * The two are worth telling apart — the second is the one that costs the
   * relayer money.
   */
  relayedIntentRefused: {
    code: SettlementErrorCode.SETTLEMENT_RELAYED_INTENT_REFUSED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `The relayed escrow request was refused${context?.reason ? `: ${context.reason}` : ''}` +
      (context?.transactionHash
        ? ` — transaction ${context.transactionHash} was sent and reverted`
        : ' — nothing was submitted'),
  },
  /**
   * Too many relayed submissions from this account or this organization.
   *
   * The relayer's ETH float is the resource under attack, and a *valid*
   * signature is not self-limiting: a buyer can sign a fresh `SetLimits` at the
   * next `authNonce` for ever, and every one of them is a transaction the
   * platform pays for. The pre-flight stops the invalid ones for the price of an
   * RPC call; this is what stops the valid ones.
   */
  relayedIntentRateLimited: {
    code: SettlementErrorCode.SETTLEMENT_RELAYED_INTENT_RATE_LIMITED,
    statusCode: 429,
    message: (context?: Record<string, any>) =>
      `You have reached the limit of ${context?.limit ?? '?'} escrow changes the platform ` +
      `relays for ${context?.scope === 'organization' ? 'your organization' : 'this account'} ` +
      `per ${describeWindow(context?.windowSeconds)}. Nothing was submitted.` +
      (context?.retryAt ? ` You can make the next one from ${context.retryAt}.` : ''),
  },
  /**
   * The budget could not be counted, so **nothing was submitted**.
   *
   * The counter fails closed, and the reasoning is `RedisSigningRateLimiter`'s
   * next door: the thing being bounded is a public route that spends the
   * platform's own money, and failing open would hand anyone who can knock Redis
   * over the entire float above its floor — which is easier than anything else
   * on this path. What it costs is stated in the report rather than hidden: while
   * the counter is down, a buyer holding no ETH cannot start an exit. Nothing is
   * lost, it is delayed, and `withdraw()` — the transaction that actually moves
   * money — never passed through here at all.
   */
  relayedIntentUnavailable: {
    code: SettlementErrorCode.SETTLEMENT_RELAYED_INTENT_UNAVAILABLE,
    statusCode: 503,
    message: () =>
      `The relayed-submission budget could not be counted, so nothing was submitted. The ` +
      `signature is still valid until its deadline; try again`,
  },

  // ── Agent payment delegation ─────────────────────────────────────────────

  /**
   * A delegation the escrow would refuse, caught before the payer is asked to
   * sign: the delegate is not an address on the payer's chain or is the payer
   * itself, a cap is zero or above the escrow's own ceiling (set the escrow
   * limits first), or `validUntil` is less than an hour after the request's
   * deadline (D-21) or more than a year out. `reason` names which, in the
   * contract's own terms.
   */
  delegationInvalid: {
    code: SettlementErrorCode.SETTLEMENT_DELEGATION_INVALID,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `This delegation cannot be authorised${context?.reason ? `: ${context.reason}` : ''}`,
  },
  /** Nothing to revoke: the delegate is not authorised on this escrow. */
  delegationNotActive: {
    code: SettlementErrorCode.SETTLEMENT_DELEGATION_NOT_ACTIVE,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `${context?.delegate ?? 'This delegate'} is not authorised on this escrow, so there is ` +
      `nothing to revoke`,
  },
  /**
   * The new caps are below what payments already served and not yet redeemed
   * need, so the chain would refuse them at redemption and the provider would
   * go unpaid (BUG-D1-07). Refused BEFORE anything is signed or relayed, unless
   * the request says `acknowledgeUnsettled: true`; they usually settle within a
   * minute, after which the same change goes through.
   */
  unsettledVouchersAtRisk: {
    code: SettlementErrorCode.SETTLEMENT_UNSETTLED_VOUCHERS_AT_RISK,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `${context?.count ?? 'Some'} payment${context?.count === 1 ? ' is' : 's are'} still being ` +
      `settled${context?.amount ? ` (${context.amount})` : ''}, and this change would leave the ` +
      `chain unable to redeem ${context?.count === 1 ? 'it' : 'them'}` +
      `${context?.reasons ? ` (${context.reasons})` : ''}. Wait until ` +
      `${context?.count === 1 ? 'it settles' : 'they settle'}, usually under a minute, or send ` +
      `the change again with acknowledgeUnsettled to accept that. Nothing was submitted.`,
  },

  // ── Public reserves page ─────────────────────────────────────────────────

  /**
   * Both of these fail the **boot**, not a request.
   *
   * A misconfigured proof-of-reserves page publishes wrong figures under a
   * heading that invites people to trust them, and it does so silently — there
   * is no request that looks abnormal. Failing the deploy is the only point at
   * which anybody is looking.
   */
  publicReservesAssetInvalid: {
    code: SettlementErrorCode.SETTLEMENT_PUBLIC_RESERVES_ASSET_INVALID,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `${context?.variable ?? 'PUBLIC_RESERVES_ASSET'} is not a CAIP-19 asset id: ` +
      `${context?.value ?? '(empty)'}`,
  },

  /**
   * The named asset is on a chain this deployment does not reconcile, so the
   * page would publish figures for a network nothing here checks — the same
   * mainnet/devnet mislabel `ENABLED_CHAINS` exists to prevent, arriving
   * from the other direction.
   */
  publicReservesAssetNotEnabled: {
    code: SettlementErrorCode.SETTLEMENT_PUBLIC_RESERVES_ASSET_NOT_ENABLED,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `${context?.variable ?? 'PUBLIC_RESERVES_ASSET'} names ${context?.value ?? '?'} on ` +
      `${context?.chain ?? '?'}, which is not in ENABLED_CHAINS ` +
      `(${context?.enabled ?? ''})`,
  },
});

/** `3600` → "hour", `86400` → "day", anything else in minutes. */
function describeWindow(seconds: unknown): string {
  if (seconds === 3600) return 'hour';
  if (seconds === 86_400) return 'day';
  return typeof seconds === 'number' ? `${Math.round(seconds / 60)} minutes` : 'window';
}
