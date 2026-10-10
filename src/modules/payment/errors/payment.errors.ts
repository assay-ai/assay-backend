import { AssertDomainErrorCodes, createDomainErrorFactory } from '@shared/errors/error-catalog';

/**
 * `PAYMENT_*` — payment intent lifecycle and voucher binding.
 */
export enum PaymentErrorCode {
  PAYMENT_INTENT_NOT_FOUND = 'PAYMENT_INTENT_NOT_FOUND',
  PAYMENT_INTENT_EXPIRED = 'PAYMENT_INTENT_EXPIRED',
  PAYMENT_INVALID_STATE_TRANSITION = 'PAYMENT_INVALID_STATE_TRANSITION',
  PAYMENT_IDEMPOTENCY_KEY_REUSED = 'PAYMENT_IDEMPOTENCY_KEY_REUSED',
  PAYMENT_VOUCHER_SIGNATURE_INVALID = 'PAYMENT_VOUCHER_SIGNATURE_INVALID',
  PAYMENT_VOUCHER_NONCE_REPLAYED = 'PAYMENT_VOUCHER_NONCE_REPLAYED',
  PAYMENT_VOUCHER_MALFORMED = 'PAYMENT_VOUCHER_MALFORMED',
  PAYMENT_VOUCHER_EXPIRED = 'PAYMENT_VOUCHER_EXPIRED',
  PAYMENT_VOUCHER_BINDING_MISMATCH = 'PAYMENT_VOUCHER_BINDING_MISMATCH',
  PAYMENT_REQUEST_HASH_MISMATCH = 'PAYMENT_REQUEST_HASH_MISMATCH',
  PAYMENT_REQUEST_NOT_CANONICALISABLE = 'PAYMENT_REQUEST_NOT_CANONICALISABLE',
  PAYMENT_RAIL_UNSUPPORTED = 'PAYMENT_RAIL_UNSUPPORTED',

  // ── Deposits — `deposit_intents`, a sibling of `payment_intents`,
  //    not a member of it. See `src/modules/payment/ports/deposit.types.ts`.
  PAYMENT_DEPOSIT_NOT_FOUND = 'PAYMENT_DEPOSIT_NOT_FOUND',
  PAYMENT_DEPOSIT_INVALID_STATE_TRANSITION = 'PAYMENT_DEPOSIT_INVALID_STATE_TRANSITION',
  PAYMENT_DEPOSIT_EXPIRED = 'PAYMENT_DEPOSIT_EXPIRED',
  PAYMENT_DEPOSIT_BROADCAST_UNSUPPORTED = 'PAYMENT_DEPOSIT_BROADCAST_UNSUPPORTED',
  PAYMENT_DEPOSIT_TRANSACTION_ALREADY_CLAIMED = 'PAYMENT_DEPOSIT_TRANSACTION_ALREADY_CLAIMED',
  PAYMENT_DEPOSIT_ASSET_NOT_SETTLEMENT_ASSET = 'PAYMENT_DEPOSIT_ASSET_NOT_SETTLEMENT_ASSET',
  PAYMENT_DEPOSIT_REQUIREMENTS_INCOMPLETE = 'PAYMENT_DEPOSIT_REQUIREMENTS_INCOMPLETE',
  PAYMENT_DEPOSIT_CHAIN_REQUIRED = 'PAYMENT_DEPOSIT_CHAIN_REQUIRED',
  PAYMENT_DEPOSIT_ACCOUNT_NOT_LINKED = 'PAYMENT_DEPOSIT_ACCOUNT_NOT_LINKED',
  PAYMENT_DEPOSIT_BELOW_MINIMUM = 'PAYMENT_DEPOSIT_BELOW_MINIMUM',

  // ── The x402 error mapping — the `X402_INVALID_REASON` vocabulary,
  //    mapped exactly as the reference table specifies. The SVM-specific
  //    reasons the table does not itemise (`invalid_exact_svm_payload_*`
  //    beyond signature and blockhash) fold into `PAYMENT_INVALID_PAYLOAD` —
  //    see `domain/x402-error-mapping.ts`.
  PAYMENT_INSUFFICIENT_FUNDS = 'PAYMENT_INSUFFICIENT_FUNDS',
  PAYMENT_INVALID_SIGNATURE = 'PAYMENT_INVALID_SIGNATURE',
  PAYMENT_AUTHORIZATION_EXPIRED = 'PAYMENT_AUTHORIZATION_EXPIRED',
  PAYMENT_UNSUPPORTED_NETWORK = 'PAYMENT_UNSUPPORTED_NETWORK',
  PAYMENT_UNSUPPORTED_SCHEME = 'PAYMENT_UNSUPPORTED_SCHEME',
  PAYMENT_DUPLICATE_SETTLEMENT = 'PAYMENT_DUPLICATE_SETTLEMENT',
  PAYMENT_SETTLEMENT_FAILED = 'PAYMENT_SETTLEMENT_FAILED',
  PAYMENT_INVALID_PAYLOAD = 'PAYMENT_INVALID_PAYLOAD',

  // ── The one edge that pays the provider, not just the platform.
  PAYMENT_PROVIDER_NOT_ASSIGNED = 'PAYMENT_PROVIDER_NOT_ASSIGNED',

  // ── The buyer's money is on the wrong CHAIN, not short.
  PAYMENT_NO_SETTLEABLE_CHAIN = 'PAYMENT_NO_SETTLEABLE_CHAIN',

  // ── The buyer's own on-chain escrow replaces the pooled vault.
  PAYMENT_ESCROW_NOT_OPEN = 'PAYMENT_ESCROW_NOT_OPEN',
  PAYMENT_ESCROW_ACCOUNT_CLAIMED = 'PAYMENT_ESCROW_ACCOUNT_CLAIMED',
  PAYMENT_ESCROW_BALANCE_UNAVAILABLE = 'PAYMENT_ESCROW_BALANCE_UNAVAILABLE',
  PAYMENT_VOUCHER_SEQ_MISMATCH = 'PAYMENT_VOUCHER_SEQ_MISMATCH',
  PAYMENT_VOUCHER_SEQ_ALREADY_USED = 'PAYMENT_VOUCHER_SEQ_ALREADY_USED',
  PAYMENT_WITHDRAWAL_PENDING = 'PAYMENT_WITHDRAWAL_PENDING',
}

export type PaymentErrorCodesArePrefixed = AssertDomainErrorCodes<'PAYMENT', `${PaymentErrorCode}`>;

export const PaymentErrors = createDomainErrorFactory('PAYMENT', {
  paymentIntentNotFound: {
    code: PaymentErrorCode.PAYMENT_INTENT_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `Payment intent not found${context?.id ? ` with id: ${context.id}` : ''}`,
  },
  paymentIntentExpired: {
    code: PaymentErrorCode.PAYMENT_INTENT_EXPIRED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Payment intent expired${context?.id ? `: ${context.id}` : ''}` +
      `${context?.expiresAt ? ` at ${context.expiresAt}` : ''}`,
  },
  /**
   * The one code every edge outside `PAYMENT_INTENT_TRANSITIONS` raises —
   * whether the edge is absent from the table, or the row moved under a
   * concurrent worker so the compare-and-swap matched nothing.
   *
   * `actual` is the difference between the two and is the first thing asked
   * when this fires: an edge that is simply illegal has none, while a lost race
   * names the state the winner left behind.
   */
  invalidStateTransition: {
    code: PaymentErrorCode.PAYMENT_INVALID_STATE_TRANSITION,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Illegal payment intent transition${context?.from && context?.to ? `: ${context.from} → ${context.to}` : ''}` +
      `${context?.actual ? ` (intent is ${context.actual})` : ''}` +
      `${context?.allowed ? `; ${context.from} may only move to: ${context.allowed}` : ''}` +
      `${context?.intentId ? ` [intent ${context.intentId}]` : ''}`,
  },
  idempotencyKeyReused: {
    code: PaymentErrorCode.PAYMENT_IDEMPOTENCY_KEY_REUSED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Idempotency key already used for a different request` +
      `${context?.idempotencyKey ? `: ${context.idempotencyKey}` : ''}`,
  },
  voucherSignatureInvalid: {
    code: PaymentErrorCode.PAYMENT_VOUCHER_SIGNATURE_INVALID,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Voucher signature failed verification${context?.payer ? ` for payer: ${context.payer}` : ''}`,
  },
  /**
   * The nonce has been seen before. Raised by both halves of the store — the
   * Redis reservation that loses a race, and the unique index that refuses the
   * second insert — because to a caller they are the same event: this voucher
   * has already been spent.
   */
  voucherNonceReplayed: {
    code: PaymentErrorCode.PAYMENT_VOUCHER_NONCE_REPLAYED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Voucher nonce already spent${context?.nonce ? `: ${context.nonce}` : ''}`,
  },
  /** Structurally invalid — a malformed CAIP id, a nonce that is not 16 hex bytes. */
  voucherMalformed: {
    code: PaymentErrorCode.PAYMENT_VOUCHER_MALFORMED,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Voucher is malformed${context?.field ? ` at ${context.field}` : ''}` +
      `${context?.reason ? `: ${context.reason}` : ''}`,
  },
  /**
   * `402`, not `400`: the agent did nothing wrong and the fix is to sign a new
   * voucher, which is exactly what a `402` tells a client to do. Mirrors
   * `PAYMENT_AUTHORIZATION_EXPIRED` in the x402 error mapping.
   */
  voucherExpired: {
    code: PaymentErrorCode.PAYMENT_VOUCHER_EXPIRED,
    statusCode: 402,
    message: (context?: Record<string, any>) =>
      `Voucher expired${context?.expiresAt ? ` at ${context.expiresAt}` : ''}` +
      `${context?.now ? ` (now ${context.now})` : ''}`,
  },
  /**
   * The voucher is authentic but authorises something other than this call —
   * a different payer, payee, resource, chain, or too small an amount.
   *
   * One code with a `field` rather than five codes: every one of them is the
   * same finding, that a signature was presented against a request it was not
   * signed for, and a caller has no reason to branch on which field disagreed.
   */
  voucherBindingMismatch: {
    code: PaymentErrorCode.PAYMENT_VOUCHER_BINDING_MISMATCH,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Voucher does not authorise this request` +
      `${context?.field ? ` (${context.field}` : ''}` +
      `${context?.field && context?.expected ? `: expected ${context.expected}` : ''}` +
      `${context?.field && context?.actual ? `, got ${context.actual}` : ''}` +
      `${context?.field ? ')' : ''}`,
  },
  requestHashMismatch: {
    code: PaymentErrorCode.PAYMENT_REQUEST_HASH_MISMATCH,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Voucher is bound to a different request${context?.expected ? ` (expected ${context.expected})` : ''}` +
      `${context?.actual ? `, got ${context.actual}` : ''}`,
  },
  /**
   * The request cannot be hashed at all — something in it is not JSON. Raised
   * before any comparison, because a hash of a coerced value would be a hash of
   * a request nobody sent.
   */
  requestNotCanonicalisable: {
    code: PaymentErrorCode.PAYMENT_REQUEST_NOT_CANONICALISABLE,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Request cannot be canonicalised${context?.path ? ` at ${context.path}` : ''}` +
      `${context?.reason ? `: ${context.reason}` : ''}`,
  },
  railUnsupported: {
    code: PaymentErrorCode.PAYMENT_RAIL_UNSUPPORTED,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Payment rail not supported${context?.rail ? `: ${context.rail}` : ''}`,
  },

  // ── Deposits ───────────────────────────────────────────────────────────
  depositIntentNotFound: {
    code: PaymentErrorCode.PAYMENT_DEPOSIT_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `Deposit intent not found${context?.id ? ` with id: ${context.id}` : ''}`,
  },
  depositInvalidStateTransition: {
    code: PaymentErrorCode.PAYMENT_DEPOSIT_INVALID_STATE_TRANSITION,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Illegal deposit intent transition${context?.from && context?.to ? `: ${context.from} → ${context.to}` : ''}` +
      `${context?.actual ? ` (intent is ${context.actual})` : ''}` +
      `${context?.intentId ? ` [intent ${context.intentId}]` : ''}`,
  },
  /**
   * `402`, matching `paymentIntentExpired`'s reasoning: the agent did nothing
   * wrong, the SVM blockhash the client already signed over is simply dead,
   * and the fix is a new `402` round trip, not a retry of the same payload.
   */
  depositIntentExpired: {
    code: PaymentErrorCode.PAYMENT_DEPOSIT_EXPIRED,
    statusCode: 402,
    message: (context?: Record<string, any>) =>
      `Deposit intent expired${context?.id ? `: ${context.id}` : ''}` +
      `${context?.expiresAt ? ` at ${context.expiresAt}` : ''}`,
  },
  /**
   * The buyer holds accounts on more than one chain and did not say which one
   * this deposit is for.
   *
   * `400`, not `409`: the request is malformed, the caller can fix it, and the
   * fix is one field. It is deliberately **not** inferred from "the chain you
   * used last time" — a deposit is irreversible and unbridgeable, so
   * a default is a mechanism for putting money somewhere it can never leave
   * except back to the buyer.
   */
  depositChainRequired: {
    code: PaymentErrorCode.PAYMENT_DEPOSIT_CHAIN_REQUIRED,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `This buyer can deposit on more than one chain; name one with \`chainId\`` +
      `${context?.chains ? ` — one of: ${context.chains}` : ''}`,
  },
  /**
   * A deposit for a chain the buyer has no linked account on.
   *
   * `409`, not `400`: the field is well-formed and the caller is entitled to
   * name a chain — this deployment simply has nobody to withdraw it. **This is
   * the error that stops money being lost**: a deposit credited to a chain
   * with no `agent_accounts` row is money that can never be withdrawn.
   *
   * Also the answer for an unparseable `chainId`. A malformed value matches no
   * linked account, and refusing it here rather than at the DTO keeps one
   * reason for one outcome — "you cannot deposit on that" — instead of two
   * spellings of it a client has to tell apart.
   */
  depositBelowMinimum: {
    code: PaymentErrorCode.PAYMENT_DEPOSIT_BELOW_MINIMUM,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `A deposit must be at least ${context?.minimumUsd ?? 5} USD` +
      `${context?.minimum ? ` (${context.minimum} atomic units)` : ''}`,
  },
  depositAccountNotLinked: {
    code: PaymentErrorCode.PAYMENT_DEPOSIT_ACCOUNT_NOT_LINKED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `No linked account on that chain` +
      `${context?.chainId ? `: ${context.chainId}` : ''}` +
      `${context?.chains ? `. You can deposit on: ${context.chains}` : ''}`,
  },
  /**
   * The amount named an asset that is not the chain's settlement asset.
   *
   * **Renamed from `PAYMENT_DEPOSIT_ASSET_NOT_USDC`.** That code, and the
   * message *"Deposits accept only the registered USDC of the chain"*, were
   * false on `eip155:46630`, which settles in **USDG** — a buyer who read it
   * would conclude they had used the wrong token when they had used the only
   * right one. The message was the visible half of that lie; the code is the
   * half that gets logged, alerted on and keyed off, so fixing only the message
   * would have left the falsehood in the machine-readable copy.
   *
   * Renaming a public error code is a breaking change, and it was taken rather
   * than avoided because the code has no client keying on it: `grep` over the
   * frontend finds it only inside two comments describing this very defect, and
   * no `docs/` or OpenAPI artefact names it outside the generated catalogue.
   * "USDC-only" is now a statement about the Solana chains' settlement asset,
   * not a rule of the deposit path.
   */
  depositAssetNotSettlementAsset: {
    code: PaymentErrorCode.PAYMENT_DEPOSIT_ASSET_NOT_SETTLEMENT_ASSET,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Deposits accept only the settlement asset of the chain` +
      `${context?.expected ? `, ${context.expected}` : ''}` +
      `${context?.asset ? ` — got ${context.asset}` : ''}` +
      `${context?.chainId ? ` on ${context.chainId}` : ''}`,
  },
  /**
   * The facilitator did not advertise everything the browser needs to build
   * the transfer.
   *
   * `502`, not `400`: `PaymentRequirements.extra` is typed `unknown` and is
   * filled in from what the facilitator told us, so a missing `feePayer` or
   * `memo` is the upstream failing to hold up its end — nothing the caller
   * sent could have caused it or can fix it. Raised rather than cast, because
   * casting produces a `402` whose fee-payer slot names `undefined` and whose
   * only symptom is a wallet signature the facilitator later rejects.
   */
  depositRequirementsIncomplete: {
    code: PaymentErrorCode.PAYMENT_DEPOSIT_REQUIREMENTS_INCOMPLETE,
    statusCode: 502,
    message: (context?: Record<string, any>) =>
      `The payment requirements are missing a field the client needs` +
      `${context?.field ? `: ${context.field}` : ''}`,
  },

  // ── The x402 error mapping ─────────────────────────────────────────────
  /**
   * The buyer's money is on a chain no provider for this tool settles on.
   *
   * Three things it is deliberately NOT:
   *
   * - **Not `PAYMENT_INSUFFICIENT_FUNDS`.** That code means "add money". This
   *   one means "add money *somewhere else*", and conflating them sends a buyer
   *   to top up an account that will never help.
   * - **Not a 402.** There is no `accepts[]` to send — with no bridging there is
   *   nothing to pay for on any chain the buyer can reach, and an empty
   *   `accepts[]` is a protocol violation and a lie.
   * - **Not a silent failover.** The router already tried:
   *   `CHAIN_NOT_SETTLEABLE` is a per-candidate rejection and this fires only
   *   when EVERY candidate was rejected for it. A buyer never silently gets a
   *   different provider than the quality ranking chose *because of* a chain
   *   constraint.
   *
   * The context fields exist so an agent — or the SDK — can do the one useful
   * thing: fund the other chain.
   */
  noSettleableChain: {
    code: PaymentErrorCode.PAYMENT_NO_SETTLEABLE_CHAIN,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `No provider for ${context?.tool ?? 'this tool'} settles on a chain you can pay from. ` +
      `You can pay on: ${context?.buyerChains ?? '(none)'}. ` +
      `This tool settles on: ${context?.toolChains ?? '(none)'}.`,
  },
  insufficientFunds: {
    code: PaymentErrorCode.PAYMENT_INSUFFICIENT_FUNDS,
    statusCode: 402,
    message: (context?: Record<string, any>) =>
      `Insufficient funds to cover this payment${context?.reason ? ` (${context.reason})` : ''}`,
  },
  invalidSignature: {
    code: PaymentErrorCode.PAYMENT_INVALID_SIGNATURE,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Payment payload signature is invalid${context?.reason ? ` (${context.reason})` : ''}`,
  },
  /** The SVM blockhash case: retry must request a fresh `402`, never resubmit the same payload. */
  authorizationExpired: {
    code: PaymentErrorCode.PAYMENT_AUTHORIZATION_EXPIRED,
    statusCode: 402,
    message: (context?: Record<string, any>) =>
      `Payment authorization expired${context?.reason ? ` (${context.reason})` : ''}; request a fresh 402`,
  },
  unsupportedNetwork: {
    code: PaymentErrorCode.PAYMENT_UNSUPPORTED_NETWORK,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Payment network not supported${context?.reason ? ` (${context.reason})` : ''}`,
  },
  unsupportedScheme: {
    code: PaymentErrorCode.PAYMENT_UNSUPPORTED_SCHEME,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Payment scheme not supported${context?.reason ? ` (${context.reason})` : ''}`,
  },
  /** 409, but idempotent — the caller should treat this as success and fetch the original. */
  duplicateSettlement: {
    code: PaymentErrorCode.PAYMENT_DUPLICATE_SETTLEMENT,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Settlement already in flight or completed for this payload` +
      `${context?.reason ? ` (${context.reason})` : ''}`,
  },
  /**
   * A buyer-broadcast deposit on a chain where the buyer cannot broadcast
   * alone — Solana, where the facilitator is the fee payer. `400`: the request
   * names a path this chain does not have; the signed-unsent settle is the one
   * to use.
   */
  depositBroadcastUnsupported: {
    code: PaymentErrorCode.PAYMENT_DEPOSIT_BROADCAST_UNSUPPORTED,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Deposits on ${context?.chainId ?? 'this chain'} are settled through the facilitator; ` +
      `a transaction the buyer broadcast cannot be claimed here`,
  },
  /**
   * `409`: this transaction already settled another deposit of this
   * organization. One transaction credits once.
   */
  depositTransactionAlreadyClaimed: {
    code: PaymentErrorCode.PAYMENT_DEPOSIT_TRANSACTION_ALREADY_CLAIMED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Transaction ${context?.transaction ?? ''} already settled deposit ` +
      `${context?.claimedBy ?? 'another deposit'}`,
  },
  settlementFailed: {
    code: PaymentErrorCode.PAYMENT_SETTLEMENT_FAILED,
    statusCode: 502,
    message: (context?: Record<string, any>) =>
      `Facilitator settlement failed${context?.reason ? `: ${context.reason}` : ''}`,
  },
  /**
   * Every SVM-specific `invalid_exact_svm_payload_*` reason the reference table
   * does not name individually (transaction, instructions, fee payer, compute
   * budget, transfer, asset, recipient, amount, memo) — the payload is
   * structurally wrong in some way the facilitator's own validation caught,
   * and no caller has a reason to branch on which.
   */
  invalidPayload: {
    code: PaymentErrorCode.PAYMENT_INVALID_PAYLOAD,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Payment payload is invalid${context?.reason ? `: ${context.reason}` : ''}`,
  },
  /**
   * `resolve()`'s `COMMIT` branch pays the provider, so it needs one — and a
   * database CHECK already refuses `SETTLED` without `provider_id` /
   * `provider_account`, so this should be unreachable through the normal
   * transition table. It exists for the same reason
   * `LEDGER_SETTLEMENT_CREDIT_MISMATCH` does: a caller reaching this edge some
   * other way fails loudly here rather than committing a hold with nothing to
   * credit it against.
   */
  providerNotAssigned: {
    code: PaymentErrorCode.PAYMENT_PROVIDER_NOT_ASSIGNED,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `Intent ${context?.intentId ?? '(unknown)'} reached a COMMIT edge with no provider assigned`,
  },

  /**
   * No `BuyerEscrow` exists for this account, so nothing can be paid out of
   * it. Also raised when a deposit tried to open one and the chain could not
   * confirm it — `context.reason` carries why, when present, and the mirror
   * is never written on that path (`DepositService.ensureEscrow`).
   */
  escrowNotOpen: {
    code: PaymentErrorCode.PAYMENT_ESCROW_NOT_OPEN,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `No escrow is open for this account${context?.account ? `: ${context.account}` : ''}` +
      `${context?.reason ? ` (${context.reason})` : '; fund a deposit to open one'}`,
  },

  /**
   * This account's escrow row belongs to a different organization.
   *
   * `buyer_escrows` is unique on the account alone — the chain has one escrow
   * per buyer address — so two organizations cannot both hold one. Refused, not
   * adopted; and the other organization's row is not written
   * (`BuyerEscrowRepository.upsertOpened`). 409: the caller's account is in use,
   * which retrying does not change.
   */
  escrowAccountClaimed: {
    code: PaymentErrorCode.PAYMENT_ESCROW_ACCOUNT_CLAIMED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `The escrow for this account is registered to another organization` +
      `${context?.account ? `: ${context.account}` : ''}` +
      `; deposit from an account this organization holds`,
  },

  /**
   * The chain could not be read and no reading is fresh enough to spend against.
   * **Fail closed** — never degrade to the ledger mirror, which is by
   * construction a lagging copy and can read higher than the chain.
   */
  escrowBalanceUnavailable: {
    code: PaymentErrorCode.PAYMENT_ESCROW_BALANCE_UNAVAILABLE,
    statusCode: 503,
    message: (context?: Record<string, any>) =>
      `The escrow balance could not be read` +
      `${context?.account ? ` for ${context.account}` : ''}` +
      `${context?.ageMs ? `; last reading is ${context.ageMs}ms old` : ''}` +
      `; no call is paid against a balance we cannot see`,
  },

  /** The voucher's `seq` is not the one `GET /escrow/next-seq` issued. */
  voucherSeqMismatch: {
    code: PaymentErrorCode.PAYMENT_VOUCHER_SEQ_MISMATCH,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Voucher sequence ${context?.actual ?? 'unknown'} was not issued to this account` +
      `${context?.expected ? ` (expected ${context.expected})` : ''}`,
  },

  /**
   * The seq was issued to this account and an earlier call already spent it —
   * a replay. Distinct from {@link voucherSeqMismatch}, which says the seq was
   * never handed out: a client told "not issued" goes looking for a bug in its
   * seq bookkeeping, while this one needs only a fresh voucher.
   */
  voucherSeqAlreadyUsed: {
    code: PaymentErrorCode.PAYMENT_VOUCHER_SEQ_ALREADY_USED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Voucher sequence ${context?.actual ?? 'unknown'} was already used for an earlier call ` +
      `on this account; a voucher pays for one call, sign a new one with a fresh sequence`,
  },

  /**
   * The buyer has a standing `request_withdraw`. New vouchers are refused while
   * it is open so the platform is not still taking money out of an escrow whose
   * owner has announced they are leaving. Vouchers already accepted are still
   * redeemed.
   */
  withdrawalPending: {
    code: PaymentErrorCode.PAYMENT_WITHDRAWAL_PENDING,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `A withdrawal is pending on this escrow` +
      `${context?.availableAt ? `, available at ${context.availableAt}` : ''}` +
      `; cancel it with request_withdraw(0) to resume paying calls`,
  },
});
