import { Column, Entity, Index } from 'typeorm';
import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * The unit of accounting.
 *
 * Mutable, unlike `ledger_entries`: an intent has a lifecycle and its status
 * changes. Every change is a compare-and-swap against the previous status, so
 * the row's history is the sequence of edges that could have produced it, and
 * the money that moved with each of them is in the journal under `intent_id`.
 *
 * Never soft-deleted: a deleted payment record is a reconciliation hole.
 */
@Entity('payment_intents')
@Index('idx_payment_intents_status_expires_at', ['status', 'expiresAt'])
@Index('idx_payment_intents_agent', ['organizationId', 'agentId'])
export class PaymentIntentEntity extends OrganizationScopedEntityWithoutSoftDelete {
  /** One of `PaymentIntentStatus`; the CHECK constraint holds the enum. */
  @Column({ name: 'status', type: 'varchar', length: 24 })
  status: string;

  /** Why it last moved. The expiry sweep writes its reason here. */
  @Column({ name: 'status_reason', type: 'varchar', length: 256, nullable: true })
  statusReason: string | null;

  @Column({ name: 'agent_id', type: 'uuid' })
  agentId: string;

  /** CAIP-10. */
  @Column({ name: 'agent_account', type: 'varchar', length: 256 })
  agentAccount: string;

  /**
   * Who is paid — `null` until the router has picked one.
   *
   * An MCP agent buys a *tool*; the provider behind it is a routing decision
   * taken after the intent exists and the hold is open, and failover can change
   * it mid-call. See `RoutedPaymentIntents…` for why this is nullable and for
   * the two CHECKs that keep it honest.
   */
  @Column({ name: 'provider_id', type: 'uuid', nullable: true })
  providerId: string | null;

  /** CAIP-10. Null exactly when `providerId` is — a CHECK enforces the pair. */
  @Column({ name: 'provider_account', type: 'varchar', length: 256, nullable: true })
  providerAccount: string | null;

  @Column({ name: 'tool_id', type: 'uuid' })
  toolId: string;

  /**
   * Which binding served the call — `null` until the router has picked one,
   * and `null` forever on every row written before traffic weighting.
   *
   * The exploration floor is defined as "the first 1,000 calls of a binding",
   * so something has to count calls per binding. {@link toolId} plus
   * {@link providerId} *would* resolve one today, via
   * `uq_tool_bindings_organization_tool` — an incidental uniqueness constraint
   * that a future decision to allow two bindings per tool would quietly
   * invalidate, taking the count with it.
   *
   * Deliberately **not backfilled**. Old rows could be resolved by that same
   * join, but writing the answer down would record a fact nobody observed:
   * it asserts "this call went to binding X" on the authority of what the
   * table looks like now. `NULL` says "we did not record this", which is true
   * and, unlike an inferred value, tells a provider disputing an exploration
   * count which rows were actually measured.
   */
  @Column({ name: 'binding_id', type: 'uuid', nullable: true })
  bindingId: string | null;

  /** `RAIL_A_PER_CALL` | `RAIL_B_VOUCHER`. */
  @Column({ name: 'rail', type: 'varchar', length: 24 })
  rail: string;

  /**
   * The value sent upstream as `X-Assay-Call-Id` on every attempt this intent
   * produced.
   *
   * Independent of `id`, deliberately — see the `CallIdAndCallClass…` migration
   * for the full argument. In short: a call id must be attachable before an
   * intent exists (the connectivity check and the sandbox mapping tester have
   * no payment record at all), and the invoker that sends it must not need to
   * know about payments — sending `id` upstream would wire that dependency back
   * in.
   *
   * `UNIQUE`, unscoped to `organization_id`: the platform mints this value
   * itself, so a
   * collision is a bug in the minting path, not a legitimate cross-tenant
   * event, and a per-tenant index would hide exactly that.
   */
  @Column({ name: 'call_id', type: 'varchar', length: 64 })
  callId: string;

  /**
   * What kind of call this is, fixed at creation. `PAID` | `FREE` | `TEST` |
   * `EXPLORATION`; the CHECK constraint holds the enum. See
   * `PaymentIntentCallClass` for what each means and why `TEST` and
   * `EXPLORATION` have no producer yet.
   */
  @Column({ name: 'call_class', type: 'varchar', length: 16 })
  callClass: string;

  /**
   * The asset all four amounts are denominated in.
   *
   * One asset per intent, stored once: a price in USDC with a fee in something
   * else is not a fee split, it is two unrelated numbers, and the CHECK
   * constraint that keeps `provider_amount + platform_fee = price_amount`
   * honest only means anything because they share a scale.
   */
  @Column({ name: 'asset_id', type: 'varchar', length: 256 })
  assetId: string;

  @Column({ name: 'decimals', type: 'int' })
  decimals: number;

  @Column({ name: 'price_amount', type: 'numeric', precision: 78, scale: 0 })
  priceAmount: string;

  @Column({ name: 'provider_amount', type: 'numeric', precision: 78, scale: 0 })
  providerAmount: string;

  @Column({ name: 'platform_fee', type: 'numeric', precision: 78, scale: 0 })
  platformFee: string;

  /** What the chain actually moved. May exceed `price_amount` on SVM. */
  @Column({ name: 'settled_amount', type: 'numeric', precision: 78, scale: 0, nullable: true })
  settledAmount: string | null;

  /** sha256 of the canonical request — what this payment is authorised for. */
  @Column({ name: 'request_hash', type: 'varchar', length: 128 })
  requestHash: string;

  /**
   * Which version of the spend policy governed this call.
   *
   * `spend_policies` has been append-only from the start precisely so that *"a
   * receipt links to the exact policy version in force when its intent was
   * created"* is answerable; this is the pointer that makes it so. It is the
   * first question an auditor asks after a spend spike — was the limit $50 or
   * $500 at the time, and who raised it — and an overwritten row cannot answer
   * it.
   *
   * `NULL` on every intent created before enforcement existed, and on any call
   * whose organization has no policy at all. Back-filling a version those calls
   * were never governed by would be a fabricated audit trail.
   */
  @Column({ name: 'spend_policy_version', type: 'int', nullable: true })
  spendPolicyVersion: number | null;

  @Column({ name: 'chain_id', type: 'varchar', length: 128 })
  chainId: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  /**
   * The durable half of the idempotency guarantee.
   *
   * A partial unique index on `(organization_id, agent_id, idempotency_key)`
   * is what makes a replayed request return the original intent even when both
   * copies arrive at the same instant on two API instances. Redis is a fast
   * path in front of this; Redis being flushed must not allow a double charge.
   */
  @Column({ name: 'idempotency_key', type: 'varchar', length: 255, nullable: true })
  idempotencyKey: string | null;

  /**
   * The rail-B voucher **sequence number** (voucher v2) — a decimal `u64`.
   *
   * `numeric`/`bigint` over the wire is a string, and it stays one all the way
   * through: a `u64` does not fit a JavaScript `number`, and a seq silently
   * rounded at 2^53 is a voucher aimed at the wrong bit of the chain's replay
   * bitmap.
   *
   * Its uniqueness index is `(agent_account, voucher_seq)` and NOT global: a
   * seq counts from 1 per escrow, so buyer A's seq 5 and buyer B's seq 5 are two
   * different vouchers and a global index would refuse the second.
   */
  @Column({ name: 'voucher_seq', type: 'bigint', nullable: true })
  voucherSeq: string | null;

  /**
   * The buyer's signature over the voucher's signed bytes, in the chain's own
   * encoding — base58 ed25519 (88 chars) on Solana, 0x-hex secp256k1 (132) on
   * eip155. 256 wide since multichain support; do not narrow it back to the
   * ed25519 shape.
   *
   * Stored because `redeem_voucher` replays it verbatim, minutes after the
   * call was served, and no key in this backend could produce it again. Null
   * on rail A, which has no voucher, and on rail-B rows written before voucher
   * v2 — both of which the redemption job skips rather than guesses at.
   */
  @Column({ name: 'voucher_signature', type: 'varchar', length: 256, nullable: true })
  voucherSignature: string | null;

  /**
   * `'sha256:' + 64 hex` — offset 152 of the signed bytes.
   *
   * The one voucher field that is derivable from nothing else on this row: it
   * hashes the tool's `resource` string, and a binding's resource can change
   * after the voucher was signed. Recomputing it at redemption time would
   * produce 239 bytes the buyer never signed.
   */
  @Column({ name: 'voucher_resource_hash', type: 'varchar', length: 71, nullable: true })
  voucherResourceHash: string | null;

  /**
   * Unix seconds — offset 223 of the signed bytes.
   *
   * Also the instant `MAX_VOUCHER_REDEEMABLE_LIFE_SECONDS` (2,220s) is counted
   * from, which is what makes a hold overdue rather than merely slow. Kept as
   * a `bigint` string for the reason `voucherSeq` is: the chain reads an
   * `i64`, and the byte layout does not care what JavaScript can hold.
   */
  @Column({ name: 'voucher_issued_at', type: 'bigint', nullable: true })
  voucherIssuedAt: string | null;

  /**
   * The DELEGATE key that signed this rail-B voucher (CAIP-10), when it was not
   * the payer: agent payment delegation, `X402Escrow.authorizeDelegate`. NULL
   * when the payer's own key authorised it. Read to add a delegate's in-flight
   * vouchers to its on-chain window before a call is served.
   */
  @Column({ name: 'voucher_delegate', type: 'varchar', length: 256, nullable: true })
  voucherDelegate: string | null;

  /**
   * Every transaction the redemption job signed to redeem this rail-B voucher,
   * recorded BEFORE its broadcast (`PaymentIntentRepository.recordRedemptionTxRef`).
   * Read when the chain answers `VoucherSeqNotIncreasing`, to tell a voucher
   * that already landed unobserved from one that never can (review 2026-10-15
   * P-1). Empty on rail A and on a voucher never sent.
   */
  @Column({ name: 'redemption_tx_refs', type: 'text', array: true, default: () => "'{}'" })
  redemptionTxRefs: string[];

  /**
   * The last program error a redemption attempt of this rail-B voucher was
   * refused with (`PaymentIntentRepository.recordRedemptionError`), or
   * `provider_forfeit:<cause>` once the provider forfeited it. Read when the
   * chain answers `VoucherExpired`, which no longer says why the voucher was
   * not redeemed in time. NULL on rail A and on a voucher never refused.
   */
  @Column({ name: 'redemption_last_error', type: 'text', nullable: true })
  redemptionLastError: string | null;

  /**
   * When this served rail-B call became BUYER DEBT: its voucher can no longer
   * be redeemed for a reason that is not the provider's, so the hold stays
   * open and nobody is credited until the buyer signs a replacement voucher
   * (which clears this) or the debt is written off after 30 days
   * (`redemption_last_error = 'uncollected:<cause>'`, hold released). While set
   * with the hold open, the payer's paid calls are refused
   * (`PAYMENT_DEBT_OUTSTANDING`). NULL otherwise.
   */
  @Column({ name: 'redemption_lapsed_at', type: 'timestamptz', nullable: true })
  redemptionLapsedAt: Date | null;

  /**
   * When the buyer's REPLACEMENT voucher for this debt was accepted
   * (`PaymentIntentRepository.replaceLapsedVoucher`). The row is back in the
   * redemption queue, but it is still debt: `redemption_lapsed_at` is kept (the
   * write-off clock does not restart) and the payer's paid calls stay refused
   * until the replacement is collected. Cleared when the replacement lapses
   * too. NULL otherwise.
   */
  @Column({ name: 'redemption_replaced_at', type: 'timestamptz', nullable: true })
  redemptionReplacedAt: Date | null;

  /**
   * The `resource` the rail-B voucher signed (`/mcp/tools/<name>`), so a
   * debt's replacement can be built after the tool was renamed or deleted.
   * NULL on rail A and on rows written before the column.
   */
  @Column({ name: 'voucher_resource', type: 'text', nullable: true })
  voucherResource: string | null;

  /**
   * The agent credential that made the call, when the caller had one (the MCP
   * path). Several credentials of one agent are several delegate keys, so
   * spend is split by it as well as by agent. Null on rows written before the
   * column, and on paths with no credential.
   */
  @Column({ name: 'credential_id', type: 'uuid', nullable: true })
  credentialId: string | null;

  /** The ledger hold reserving `price_amount`, opened at `FUNDS_SECURED`. */
  @Column({ name: 'hold_id', type: 'uuid', nullable: true })
  holdId: string | null;

  /**
   * When the hold was resolved.
   *
   * Recorded on the intent rather than inferred from the ledger so the expiry
   * sweep can find its own unfinished work — an intent moved to `EXPIRED` by a
   * pass that then died before releasing — with one indexed predicate instead
   * of a join into another domain's tables.
   */
  @Column({ name: 'hold_released_at', type: 'timestamptz', nullable: true })
  holdReleasedAt: Date | null;

  /** Response class from the response classifier. */
  @Column({ name: 'classification', type: 'varchar', length: 32, nullable: true })
  classification: string | null;

  /** Verification verdict. */
  @Column({ name: 'verification_verdict', type: 'varchar', length: 32, nullable: true })
  verificationVerdict: string | null;

  /**
   * A buyer's dispute over this call (G3.B1): `OPEN` while a guaranteed
   * dispute keeps the hold from being collected, then `UPHELD` | `REJECTED`.
   * The quality stats count an upheld call as a failed one.
   */
  @Column({ name: 'dispute_outcome', type: 'varchar', length: 16, nullable: true })
  disputeOutcome: string | null;

  /**
   * The dispute hold ("redeem into hold", G3.B1): `HELD` | `COLLECTED` |
   * `REFUNDED`. Rail B mirrors the escrow's `held[payer][seq]`; rail A is the
   * provider's ledger credit withheld for the hold window. Null: no hold (a
   * call not yet redeemed, or collected the old way).
   */
  @Column({ name: 'held_status', type: 'varchar', length: 12, nullable: true })
  heldStatus: string | null;

  /** When the payment went into the hold (the redemption, or rail A's settlement). */
  @Column({ name: 'held_at', type: 'timestamptz', nullable: true })
  heldAt: Date | null;

  /** When the hold may be collected (`PaymentHeld.collectableAt`; rail A: + the window). */
  @Column({ name: 'collectable_at', type: 'timestamptz', nullable: true })
  collectableAt: Date | null;

  /** The collect or refund transaction (rail B). */
  @Column({ name: 'held_tx_ref', type: 'text', nullable: true })
  heldTxRef: string | null;

  /** Failed collect or refund attempts on the held payment (back-off). */
  @Column({ name: 'held_attempts', type: 'int', default: 0 })
  heldAttempts: number;

  /** Not retried before this instant. */
  @Column({ name: 'held_retry_at', type: 'timestamptz', nullable: true })
  heldRetryAt: Date | null;

  @Column({ name: 'held_last_error', type: 'text', nullable: true })
  heldLastError: string | null;
}
