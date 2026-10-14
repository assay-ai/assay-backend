import { AccountId, AssetId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';

/**
 * What became of one `redeem_voucher` submission.
 *
 * Four outcomes and not two, because the three failure modes call for three
 * different responses and collapsing any pair of them loses money in a
 * different direction.
 */
export enum RedeemOutcomeKind {
  /** The money moved, or had already moved. Retire the hold. */
  REDEEMED = 'REDEEMED',
  /** Nothing landed and the next pass may do better. Leave the hold open. */
  RETRY = 'RETRY',
  /** The chain will never accept this voucher. Give the buyer their money back. */
  UNREDEEMABLE = 'UNREDEEMABLE',
  /** The program is paused. Stop the pass — do not burn a fee per hold. */
  PAUSED = 'PAUSED',
  /**
   * The deployment is wrong, not the voucher. Stop the pass and page a human.
   *
   * `Config.redeemer` makes redemption permissioned:
   * `redeem_voucher.rent_payer` must equal `Config.redeemer`, so a process
   * paying with any other key is refused `NotRedeemer` on **every** hold it
   * touches. Filing that as `RETRY` would hammer one misconfiguration once a
   * minute for ever and file nothing; as `UNREDEEMABLE` it would hand every
   * buyer their money back and pay every provider out of platform funds for a
   * fault that a single `update_config` fixes. It is neither: the vouchers are
   * all still good and none of them may be attempted again until somebody acts.
   */
  MISCONFIGURED = 'MISCONFIGURED',
}

export interface RedeemOutcome {
  readonly kind: RedeemOutcomeKind;
  /** The confirmed transaction signature, and `null` on every other outcome. */
  readonly signature: string | null;
  /**
   * The program's own name for the failure — never a number.
   *
   * The settlement program's `#[error_code]` enum is not append-only in
   * practice (an earlier revision deleted a variant from the middle and shifted
   * every code above it down by one), so a number that decided behaviour would
   * silently start deciding a different question.
   */
  readonly programError: string | null;
}

/**
 * Everything the precompile and the instruction need, and nothing else.
 *
 * The nine voucher fields are exactly the ones the buyer signed. Reconstructing
 * even one of them differently produces 239 bytes the buyer never signed, and
 * the redemption dies with `MissingBuyerSignature` after the call has been
 * served — so every one of them is carried rather than recomputed downstream.
 */
export interface RedeemVoucherRequest {
  /** The buyer — CAIP-10. Also the key whose signature the precompile proves. */
  readonly payer: AccountId;
  /** CAIP-10. Whose `ProviderStake`, `ProviderTerms` and `ProviderEarnings` are named. */
  readonly provider: AccountId;
  /** The exact price the buyer signed, never a ceiling. */
  readonly amount: Money;
  /** The asset whose mint the escrow ATA holds. */
  readonly asset: AssetId;
  /** `'sha256:' + 64 hex` — see `payment/domain/resource-hash.ts`. */
  readonly resourceHash: string;
  /** 64 hex characters. */
  readonly requestHash: string;
  /** A decimal `u64`, as a string: a `seq` rounded at 2^53 is a different voucher. */
  readonly seq: string;
  /** Unix seconds. */
  readonly issuedAt: number;
  /** Unix seconds. */
  readonly expiresAt: number;
  /** Base58, the buyer's — over the 239 bytes, produced by a key this backend never holds. */
  readonly signature: string;
  /**
   * The DELEGATE key that signed (CAIP-10), when it was not the payer — agent
   * payment delegation. The redeemer pre-validates the delegate's on-chain grant
   * (revoked, lapsed, caps, window) exactly as `X402Escrow._redeem` will, so a
   * voucher the chain will refuse is never broadcast.
   */
  readonly delegate?: AccountId | null;
  /**
   * Records the reference of a transaction carrying this voucher, BEFORE it is
   * broadcast (review 2026-10-15 P-1). An implementation that can name its
   * transaction before sending it calls this first and does not send if it
   * rejects; {@link VoucherRedeemerPort.findLanding} is later handed back every
   * reference recorded.
   */
  readonly recordAttempt?: (txRef: string) => Promise<void>;
}

/**
 * Submits redemptions.
 *
 * **How many fit in one transaction is a property of the CHAIN, not of this
 * port.** On Solana the answer is one and it is measured, not an oversight: one
 * `redeem_voucher` plus its ed25519 precompile is 1,187 of a legacy
 * transaction's 1,232 bytes, and two of anything is 1,760 even when both
 * vouchers share a buyer and a provider — so any "~4-6 per transaction" or
 * ~$0.0001-per-call estimate rests on a batch that does not exist there.
 * On `eip155` the packet limit that forbade it does not exist, and
 * `redeemVoucherBatch` takes 64.
 *
 * {@link VoucherRedeemerPort.maxBatchSize} is how the caller learns which,
 * without knowing either chain: `1` leaves `VoucherRedemptionService`'s pass
 * byte-identical to what it has always done.
 *
 * The port never returns key material and never takes a signer: the buyer's
 * signature arrives on the request, having been produced by a wallet this
 * backend has no access to, and the fee payer is resolved behind the
 * implementation through `FeePayerSignerPort` (Solana) or the relayer EOA
 * (`eip155`).
 */
export interface VoucherRedeemerPort {
  /**
   * How many vouchers this chain may put in ONE transaction.
   *
   * `1` on Solana, deliberately: `redeem_voucher` takes one voucher and the
   * pass loop is unchanged from what it has always done. `64` on `eip155`
   * (`MAX_REDEEM_BATCH`, validated at 16.4 % of `maxTxGasLimit = 32,000,000`).
   */
  readonly maxBatchSize: number;

  redeem(request: RedeemVoucherRequest): Promise<RedeemOutcome>;

  /**
   * One transaction for many vouchers, where the chain has one.
   *
   * **Positional: `outcomes[i]` is `requests[i]`'s, and the array is never
   * reordered.** The caller matches a hold to an outcome by index and by
   * nothing else — a redemption carries no id the chain echoes back, so a
   * reordered reply would retire the wrong hold and pay the wrong provider.
   *
   * An implementation whose `maxBatchSize` is `1` satisfies this by looping,
   * which is not a batch and is not pretending to be one.
   */
  redeemBatch(requests: readonly RedeemVoucherRequest[]): Promise<readonly RedeemOutcome[]>;

  /**
   * Which of `txRefs` — transactions recorded through
   * {@link RedeemVoucherRequest.recordAttempt} — redeemed this voucher on
   * chain, or `null` when none of them did. Throws when it cannot tell yet (one
   * is still pending, or the RPC did not answer).
   *
   * Asked when a voucher comes back `VoucherSeqNotIncreasing`: that is also what
   * a voucher that ALREADY landed gets, and absorbing it would pay the provider
   * a second time (review 2026-10-15 P-1). Optional: a chain without it has
   * that refusal absorbed as before.
   */
  findLanding?(request: RedeemVoucherRequest, txRefs: readonly string[]): Promise<string | null>;
}

export const VOUCHER_REDEEMER = 'VOUCHER_REDEEMER';
