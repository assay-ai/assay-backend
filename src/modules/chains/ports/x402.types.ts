import { AccountId, AssetId, ChainId } from './caip.types';
import { Money } from './money.types';

/**
 * The x402 v2 wire vocabulary, expressed chain-neutrally.
 *
 * Only `PaymentPayload.payload` is chain-shaped, and it is deliberately opaque:
 * an SVM payload carries a base64 transaction, an EVM payload carries an
 * EIP-3009 authorization, and nothing outside `src/modules/chains/` is allowed
 * to look inside either. The adapter reads it; the domain passes it along.
 */

/** A transaction signature (SVM) or hash (EVM). Opaque outside the adapter. */
export type TxRef = string & { readonly __brand: 'TxRef' };

/** One entry of a `402` response's `accepts[]` array. */
export interface PaymentRequirements {
  readonly scheme: string;
  readonly network: ChainId;
  /** Atomic units, as required by x402 — never a decimal. */
  readonly amount: string;
  /** Chain-native asset reference: a mint address on SVM, a contract on EVM. */
  readonly asset: string;
  /** Chain-native recipient: the vault's token account on SVM, the address on EVM. */
  readonly payTo: string;
  readonly resource: string;
  readonly maxTimeoutSeconds: number;
  readonly description?: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** What the client returns in `X-PAYMENT`. */
export interface PaymentPayload {
  readonly x402Version: number;
  readonly scheme: string;
  readonly network: ChainId;
  /** Chain-specific and opaque. Only the adapter for `network` may read it. */
  readonly payload: Readonly<Record<string, unknown>>;
}

/** The platform-side record a payload must be bound to. */
export interface PaymentIntent {
  readonly id: string;
  readonly resource: string;
  readonly amount: Money;
  /** Owner of the receiving account — not the token account itself. */
  readonly payTo: AccountId;
  /**
   * The account this payment **credits** — the same split, and for the same
   * reason, as {@link BuildRequirementsInput.payer}.
   *
   * On Solana the escrow PDA both owns the receiving ATA and *is* the buyer's
   * balance, so `payTo` says everything and this field is unread. On EVM
   * `payTo` is the pooled `X402Escrow` contract (the mirror row's
   * `escrowAccountId`), while the buyer whose balance grows is the first
   * argument of `depositFor` and the `buyer` of the `Deposited` event — so the
   * binding check and `observeTransfer` must read this field, never `payTo`.
   *
   * Required, not defaulted to `payTo`: a default would make the EVM adapter
   * look for `depositFor(<the escrow contract>, …)`, which refused every real
   * deposit and — the direction that loses money — would *accept* a
   * transaction crediting an address no key controls.
   */
  readonly payer: AccountId;
  readonly chainId: ChainId;
  readonly expiresAt: Date;
}

export interface BuildRequirementsInput {
  readonly chainId: ChainId;
  readonly intentId: string;
  readonly resource: string;
  readonly amount: Money;
  /**
   * Owner of the receiving account, and the adapter derives its token account
   * — unless {@link payToIsTokenAccount} is set, in which case this is
   * already the token account and no derivation happens. See that flag's
   * comment for why both shapes are needed.
   */
  readonly payTo: AccountId;
  /**
   * `payTo` is already the destination token account, not its owner.
   *
   * A deposit's destination is now the buyer's own escrow ATA
   * (`DepositService.ensureEscrow`), which is already an ATA — deriving an
   * ATA of an ATA would compute an address nothing owns. The pooled-vault
   * path (and any future caller naming an owner) leaves this unset and keeps
   * the derivation. Defaults to `false` so every existing caller is
   * unaffected.
   */
  readonly payToIsTokenAccount?: boolean;
  /**
   * The account this payment **credits** — distinct from {@link payTo}, which
   * is where the tokens physically land.
   *
   * On Solana the two collapse: the escrow ATA both receives the transfer and
   * is the balance, so `payTo` alone says everything and this field is unread.
   * On EVM they are genuinely different accounts and neither implies the other.
   * The tokens land in a **pooled** `X402Escrow` contract whose per-buyer
   * accounting only moves inside `depositFor(buyer, amount)`, and a plain
   * transfer to that contract credits nobody — so the contract
   * must never be advertised as a destination, and the only account an EVM
   * `402` may name is this one.
   *
   * Required rather than optional, and deliberately not defaulted to `payTo`.
   * A default would be silent: `DepositService` passes the escrow as `payTo`,
   * so a fallback would have produced `depositFor(<the escrow contract>,
   * amount)` — a call that credits the contract's own address, which no key
   * controls. Making it required is what turns that into a compile error for
   * every caller instead of a transaction a buyer signs.
   */
  readonly payer: AccountId;
  /**
   * Whoever pays gas. SVM must advertise it so the client leaves the slot free.
   *
   * `null` on a chain that does not separate the payer from the fee payer —
   * see {@link ChainAdapter.requiresFeePayer}, which is what the caller asks
   * before deciding whether to fetch one. `SolanaChainAdapter` refuses `null`;
   * `EvmChainAdapter` never reads this field at all.
   */
  readonly feePayer: AccountId | null;
  readonly description?: string;
}

/** What a chain actually moved, as observed after settlement. */
export interface ObservedTransfer {
  readonly amount: string;
  readonly asset: AssetId;
  readonly decimals: number;
}

export interface SettlementReceipt {
  readonly transaction: TxRef;
  readonly network: ChainId;
  readonly payer: AccountId;
  readonly observed: ObservedTransfer;
}

/**
 * A signed off-chain promise to pay out of the buyer's own on-chain escrow
 * (rail B, voucher **v2**). The signature binds all of it, so a voucher
 * cannot be replayed against a different request, resource, amount, payee or
 * position in the buyer's sequence.
 *
 * ## This layout moved, and v1's claim that it never would was wrong
 *
 * v1's comment here said *"this layout is final, not provisional"*, on the
 * reasoning that the on-chain program would verify exactly those
 * fields. The program exists now and it verifies a different set. Two things
 * changed underneath the claim:
 *
 *  - **The money moved.** Payment no longer leaves a pooled platform vault on
 *    the platform's say-so; `redeem_voucher` debits `["escrow", payer]` and
 *    will not do it without the buyer's ed25519 signature over these exact
 *    bytes. So the payee (`provider`) and the buyer's monotonic `seq` are now
 *    inside the signed message, because the chain needs both.
 *  - **A red team added `issued_at`**. An `expires_at` alone
 *    bounds when a voucher dies but not how long it lived, and the program
 *    enforces `expires_at - issued_at <= MAX_VOUCHER_LIFETIME_SECONDS` because
 *    the backend that used to enforce that is assumed compromised.
 *
 * **An old signature is refused, never misread.** `b"x402:voucher:v2"` leads
 * the 239 bytes, so a v1 signature does not verify as a v2 voucher with the
 * fields meaning something else — it simply fails. That is the property that
 * made replacing the layout safe rather than merely necessary.
 *
 * Nine fields, and each one is load-bearing:
 *
 * | Field | What its absence would allow |
 * |---|---|
 * | `payer` | A captured voucher charged to a different account |
 * | `payTo` | The same signature redirected to another escrow |
 * | `provider` | A signed payment redirected to a provider the buyer never used |
 * | `amount` | A voucher for $0.001 settling a $1.00 call |
 * | `resource` | A voucher for a cheap tool spent on an expensive one |
 * | `requestHash` | A voucher for *this* tool spent on different arguments |
 * | `seq` | The same voucher spent twice |
 * | `issuedAt` | A voucher whose lifetime nothing bounds |
 * | `expiresAt` | A captured voucher replayable forever |
 *
 * There is deliberately **no intent id**. Rail B vouchers are signed locally
 * with no network round trip, so an agent cannot know a server-assigned intent
 * id at signing time, and a client-chosen one would be redundant with `seq`.
 */
export interface Voucher {
  /** CAIP-10. Whose key must have signed, and whose escrow is debited. */
  readonly payer: AccountId;
  /**
   * CAIP-10. The buyer's own escrow PDA — `["escrow", payer]` on the settlement
   * program. The program derives it from `payer` and compares, so a voucher
   * cannot be aimed at anyone else's escrow whatever this field says.
   */
  readonly payTo: AccountId;
  /** CAIP-10. Who gets paid. New in v2 — v1 had no payee in the signed bytes. */
  readonly provider: AccountId;
  /** The **exact** price. v1 treated this as a ceiling; `redeem_voucher` does not. */
  readonly amount: Money;
  /**
   * The x402 `resource` this voucher may be spent on.
   *
   * Signed as `sha256(resource)` (the message is fixed-width and a resource is
   * not), and still compared as a *string* against the tool's advertised
   * resource — see `computeResourceHash` in the payment domain.
   */
  readonly resource: string;
  /** Hash of the request this voucher pays for — the anti-replay binding. */
  readonly requestHash: string;
  /**
   * This buyer's payment counter as a decimal `u64` string, 1-based.
   *
   * Replaces v1's random `nonce`. A counter rather than a nonce because the
   * chain's replay guard is an 8,192-bit bitmap keyed on distance from the
   * highest redeemed number, which a random value cannot index. It is issued by
   * `GET /escrow/next-seq` and is a string because JSON has no `u64`.
   */
  readonly seq: string;
  /** Unix seconds, on the client's clock. Bounds the window's width. */
  readonly issuedAt: number;
  /** Unix seconds. The program adds its redemption grace on top. */
  readonly expiresAt: number;
}

export interface VerifyResponse {
  readonly isValid: boolean;
  readonly invalidReason?: string;
  readonly payer?: AccountId;
}

export interface SettleResponse {
  readonly success: boolean;
  readonly errorReason?: string;
  readonly network: ChainId;
  readonly transaction?: TxRef;
  readonly payer?: AccountId;
}
