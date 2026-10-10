import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';

import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { assertRailOffered } from '@modules/chains/chain-metadata';
import { chainIdOf, isAccountId } from '@modules/chains/ports/caip.types';
import { Voucher } from '@modules/chains/ports/x402.types';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  VOUCHER_CLOCK_SKEW_TOLERANCE_SECONDS,
  VOUCHER_MAX_TTL_SECONDS,
  VOUCHER_SEQ_RE,
} from '../constants/voucher.constants';
import { REQUEST_HASH_RE, computeRequestHash } from '../domain/request-hash';
import { PaymentErrors } from '../errors/payment.errors';
import {
  PaymentIntent,
  PaymentIntentCallClass,
  PaymentRail,
  railName,
} from '../ports/payment.types';
import { RedeemVoucherInput } from '../ports/voucher.types';
import { EscrowSeqService } from './escrow-seq.service';
import { PaymentIntentService } from './payment-intent.service';

/**
 * C0 and C1 control characters — anything that would break the line-separated
 * canonical message. The control characters are the point of the pattern, so
 * `no-control-regex` is disabled here rather than worked around.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** A `resource` longer than this is not a resource identifier. */
const MAX_RESOURCE_LENGTH = 512;

/**
 * Redeeming a rail-B voucher, on voucher v2.
 *
 * The requirement is one sentence — *an authorization must not be reusable for
 * a different request* — and it decomposes into two independent obligations,
 * which is why this class does two independent things.
 *
 * **1. The voucher must authorise *this* call.** A valid ed25519 signature
 * proves only that the payer signed *some* struct. It proves nothing about
 * whether that struct describes the request about to be executed. So every
 * field of the voucher is compared, one at a time, against what the server
 * independently knows — the session's account, its escrow PDA, the provider
 * the router chose, the tool's resource, the quoted price, and a
 * `requestHash` recomputed here from the call as received. The signature is
 * then what makes those comparisons meaningful: because the agent signed over
 * all of it, a value that survives comparison is a value the agent actually
 * agreed to.
 *
 * **2. The voucher must be spendable once.** Under v2 that guarantee is no
 * longer this class's own store — it is `uq_payment_intents_account_voucher_seq`,
 * a durable index keyed on `(account, seq)`, plus the chain's own 8,192-bit
 * replay bitmap on `BuyerEscrow`. Both survive a Redis flush on their own,
 * which is why there is no fast layer here any more — see `assertIssuedSeq`.
 *
 * ## Order of checks, and why it is this order
 *
 * ```text
 *   1  shape          — is this even a voucher?          cheap, no I/O
 *   2  expiry/window   — is it still alive, and sane?     cheap, no I/O
 *   3  binding        — does it authorise this call?     cheap, one sha256
 *   4  signature      — did the payer really sign it?    ~50µs of ed25519
 *   5  seq issued     — did we hand this number out?     one Postgres read
 *   6  intent insert  — record it, durably               one Postgres write
 * ```
 *
 * Expiry before signature is a security requirement: signature
 * verification is the expensive step, and an attacker must not be able to make
 * us perform it by the thousand on obviously dead vouchers.
 *
 * The seq is checked *after* the signature and not before, for the same reason
 * the v1 nonce reservation was: an unauthenticated seq check invites nothing
 * here (it is stateless), but keeping the ordering symmetric with the durable
 * insert below — which genuinely could be abused to probe which numbers are
 * live — costs nothing and keeps the two single-use steps adjacent.
 */
@Injectable()
export class VoucherService {
  private readonly logger = new Logger(VoucherService.name);

  constructor(
    private readonly intents: PaymentIntentService,
    private readonly chains: ChainAdapterRegistry,
    private readonly seqs: EscrowSeqService,
  ) {}

  /**
   * Verifies a voucher and turns it into a payment intent with the price held
   * against the agent's balance.
   *
   * Returns the intent in `FUNDS_SECURED`. There is no half-way outcome: either
   * the voucher was good and the money is reserved, or nothing happened and
   * this threw.
   */
  async redeem(input: RedeemVoucherInput): Promise<PaymentIntent> {
    const { voucher, signature } = input.signed;
    const now = Math.floor(Date.now() / 1000);

    this.assertWellFormed(voucher);
    this.assertUnexpired(voucher, now);
    this.assertAuthorisesCall(voucher, input);
    this.assertSignedByPayer(voucher, signature, input);
    await this.assertIssuedSeq(voucher, input);

    return this.record(voucher, input);
  }

  // ── 1. Shape ─────────────────────────────────────────────────────────────

  /**
   * Refuses anything that is not structurally a voucher, before any of it is
   * interpreted.
   *
   * This is not defensive noise. Two of these checks are load bearing:
   *
   * - **The seq grammar.** The sequence number is the key of the index that
   *   makes a voucher single-use. Left free-form, `"1"`, `" 1"` and `"01"` are
   *   three keys and one number, and an index doing byte comparison would
   *   treat padded variants as fresh. The signature covers the seq and so a
   *   variant would fail verification anyway — but the index must not depend
   *   on a check that happens somewhere else.
   * - **Control characters in `resource`.** The canonical message is
   *   newline-separated, and `resource` is the only field whose grammar does
   *   not already exclude a newline.
   */
  private assertWellFormed(voucher: Voucher): void {
    if (!voucher || typeof voucher !== 'object') {
      throw PaymentErrors.voucherMalformed({ field: 'voucher', reason: 'not an object' });
    }

    for (const field of ['payer', 'payTo', 'provider'] as const) {
      if (!isAccountId(voucher[field])) {
        throw PaymentErrors.voucherMalformed({ field, reason: 'not a CAIP-10 account id' });
      }
    }

    if (typeof voucher.resource !== 'string' || voucher.resource.length === 0) {
      throw PaymentErrors.voucherMalformed({ field: 'resource', reason: 'missing' });
    }
    if (voucher.resource.length > MAX_RESOURCE_LENGTH) {
      throw PaymentErrors.voucherMalformed({
        field: 'resource',
        reason: `longer than ${MAX_RESOURCE_LENGTH} characters`,
      });
    }
    if (CONTROL_CHARACTERS_RE.test(voucher.resource)) {
      throw PaymentErrors.voucherMalformed({
        field: 'resource',
        reason: 'contains a control character',
      });
    }

    if (typeof voucher.requestHash !== 'string' || !REQUEST_HASH_RE.test(voucher.requestHash)) {
      throw PaymentErrors.voucherMalformed({
        field: 'requestHash',
        reason: 'not a sha256: hex digest',
      });
    }

    if (typeof voucher.seq !== 'string' || !VOUCHER_SEQ_RE.test(voucher.seq)) {
      throw PaymentErrors.voucherMalformed({
        field: 'seq',
        reason: 'not a decimal u64 string',
      });
    }

    if (!Number.isSafeInteger(voucher.issuedAt) || voucher.issuedAt <= 0) {
      throw PaymentErrors.voucherMalformed({
        field: 'issuedAt',
        reason: 'not a positive unix-seconds integer',
      });
    }

    if (!Number.isSafeInteger(voucher.expiresAt) || voucher.expiresAt <= 0) {
      throw PaymentErrors.voucherMalformed({
        field: 'expiresAt',
        reason: 'not a positive unix-seconds integer',
      });
    }

    try {
      // The one constructor. It is the difference between an amount and a
      // string that looks like one — `"1e6"`, `"-1"` and `" 10"` all die here.
      MoneyUtil.of(voucher.amount?.amount, voucher.amount?.asset, voucher.amount?.decimals);
    } catch (error) {
      throw PaymentErrors.voucherMalformed({ field: 'amount', reason: describe(error) });
    }
  }

  // ── 2. Expiry / window ───────────────────────────────────────────────────

  /**
   * The voucher's window, checked here **and** on chain.
   *
   * Voucher v2 moved the lifetime bound onto the program, because
   * `MAX_VOUCHER_LIFETIME_SECONDS` was a rule of the backend and the backend
   * is assumed compromised — it was a term closing the invariant that the
   * attacker himself supplied. That makes this copy redundant for *security*
   * and worth keeping for *diagnosis*: `redeem_voucher` answers
   * `InvalidVoucherWindow` after a transaction fee, and this answers
   * `PAYMENT_VOUCHER_MALFORMED` before the call is served. The three window
   * rules and the expiry check are the program's and this server's, named
   * identically on both sides.
   *
   * `expiresAt`'s own lower bound is checked with **no clock-skew allowance**.
   * Leniency there would extend the interval during which a captured voucher
   * is still spendable, and the single-use index is the only thing defending
   * that interval. Skew is instead applied to `issuedAt`'s upper bound, where
   * a lenient check only accepts a voucher a fast client clock produced —
   * it cannot resurrect a captured one.
   */
  private assertUnexpired(voucher: Voucher, now: number): void {
    if (voucher.expiresAt <= voucher.issuedAt) {
      throw PaymentErrors.voucherMalformed({
        field: 'expiresAt',
        reason: 'not after issuedAt',
      });
    }
    if (voucher.expiresAt - voucher.issuedAt > VOUCHER_MAX_TTL_SECONDS) {
      throw PaymentErrors.voucherMalformed({
        field: 'expiresAt',
        reason: `more than ${VOUCHER_MAX_TTL_SECONDS}s after issuedAt`,
      });
    }
    if (voucher.issuedAt > now + VOUCHER_CLOCK_SKEW_TOLERANCE_SECONDS) {
      throw PaymentErrors.voucherMalformed({
        field: 'issuedAt',
        reason: `more than ${VOUCHER_CLOCK_SKEW_TOLERANCE_SECONDS}s in the future`,
      });
    }
    if (voucher.expiresAt <= now) {
      throw PaymentErrors.voucherExpired({ expiresAt: voucher.expiresAt, now });
    }
  }

  // ── 3. Binding ───────────────────────────────────────────────────────────

  /**
   * Compares every field of the voucher against what the server knows.
   *
   * Each of these has an attack behind it, and none is implied by the
   * signature — the signature makes them *stick*, it does not make them *true*
   * of this request:
   *
   * - `payer` ≠ the authenticated caller: a voucher lifted from another agent.
   * - `payTo` ≠ this session's escrow PDA: the same signature aimed at
   *   somewhere else.
   * - `provider` ≠ the provider the router chose: a signed payment redirected
   *   to a provider the buyer never bought from. New in v2 — the payee is
   *   inside the signed bytes now.
   * - `resource` ≠ the tool being called: goal case 2, a voucher for the cheap
   *   tool spent on the expensive one.
   * - `amount` ≠ the price: a voucher signed against a stale quote, in either
   *   direction — see the comment on the check itself for why this is an
   *   equality and not a ceiling under v2.
   * - `requestHash` ≠ the recomputed hash: goal case 6, a voucher for this tool
   *   spent on different arguments.
   *
   * `requestHash` is compared last of the bindings because it is the only one
   * that costs a sha256, and any of the others failing means we never needed
   * it.
   */
  private assertAuthorisesCall(voucher: Voucher, input: RedeemVoucherInput): void {
    // Everything must live on one chain. A voucher whose payer is on devnet and
    // whose asset is on mainnet is not a payment, and letting the pieces come
    // from different chains would let a testnet signature authorise real money.
    for (const [field, value] of [
      ['payer', voucher.payer],
      ['payTo', voucher.payTo],
      ['provider', voucher.provider],
      ['amount.asset', voucher.amount.asset],
    ] as const) {
      const chainId = chainIdOf(value);
      if (chainId !== input.chainId) {
        throw PaymentErrors.voucherBindingMismatch({
          field: `${field} chain`,
          expected: input.chainId,
          actual: chainId,
        });
      }
    }

    this.assertEquals('payer', voucher.payer, input.agentAccount);
    // This session's escrow PDA. v1 compared against the pooled platform
    // vault; there is no pooled vault on the paying path any more, and the
    // program checks the same field against the escrow it derives from
    // `voucher.payer` — so a wrong comparison here can refuse a good voucher
    // but can never redirect a buyer's payment to anyone else's escrow.
    this.assertEquals('payTo', voucher.payTo, input.escrowPda);
    // New in v2: the payee is inside the signed bytes.
    this.assertEquals('provider', voucher.provider, input.providerAccount);
    this.assertEquals('resource', voucher.resource, input.resource);

    // Asset and scale first. `MoneyUtil.compare` refuses operands that disagree
    // on either by throwing a `MONEY_*` error, and a voucher that does not
    // authorise this call should say so as a binding failure rather than as
    // arithmetic that could not be performed. Checking here also means the
    // agent-supplied `decimals` never reaches the arithmetic at all.
    this.assertEquals('amount.asset', voucher.amount.asset, input.price.asset);
    this.assertEquals(
      'amount.decimals',
      String(voucher.amount.decimals),
      String(input.price.decimals),
    );

    // **EXACT, not a ceiling.** `redeem_voucher` moves `voucher.amount` and
    // nothing else, so "at least the price" would authorise the program to
    // take more than the buyer was quoted, and "at most" would let the chain's
    // own balance maths fail a voucher for less than the price. v1's ceiling
    // existed for the `upto` scheme, where usage is metered after the fact;
    // that scheme is not available on this rail, and its absence is a known
    // limitation rather than something to paper over with a tolerance.
    if (MoneyUtil.compare(voucher.amount, input.price) !== 0) {
      throw PaymentErrors.voucherBindingMismatch({
        field: 'amount',
        expected: input.price.amount,
        actual: voucher.amount.amount,
      });
    }

    const requestHash = computeRequestHash({
      ...input.call,
      toolId: input.toolId,
      providerId: input.providerId,
      // Taken from the price the server is charging, not from the voucher: the
      // hash has to be a statement about this call, and a pre-image assembled
      // out of the thing being verified verifies nothing.
      amount: input.price.amount,
      asset: input.price.asset,
    });

    if (voucher.requestHash !== requestHash) {
      throw PaymentErrors.requestHashMismatch({
        expected: requestHash,
        actual: voucher.requestHash,
      });
    }
  }

  // ── 4. Signature ─────────────────────────────────────────────────────────

  /**
   * The signer is `voucher.payer` — the account inside the signed message, and
   * by then already checked to be the authenticated caller.
   *
   * Verifying against a signer taken from anywhere else, a header or a request
   * field, would let an attacker present someone else's voucher alongside their
   * own key and have it pass.
   */
  private assertSignedByPayer(
    voucher: Voucher,
    signature: string,
    input: RedeemVoucherInput,
  ): void {
    const adapter = this.chains.resolve(input.chainId);

    if (typeof signature !== 'string' || signature.length === 0) {
      throw PaymentErrors.voucherSignatureInvalid({ payer: voucher.payer });
    }

    if (!adapter.verifyVoucherSignature(voucher, signature, voucher.payer)) {
      throw PaymentErrors.voucherSignatureInvalid({ payer: voucher.payer });
    }
  }

  // ── 5. Seq issued ────────────────────────────────────────────────────────

  /**
   * The seq must be one this backend issued to this account.
   *
   * **There is no Redis reservation any more.** v1's `VoucherNonceStore` had
   * two jobs — fast rejection and surviving a Redis flush — and under v2 they
   * go to two different, already-durable places: `wasIssued` below is a read
   * of `buyer_escrows.next_seq`, the allocator's own high-water mark, and
   * single-use is the job of `uq_payment_intents_account_voucher_seq` in
   * `record()` plus the chain's 8,192-bit replay bitmap on `BuyerEscrow`. Both
   * survive a Redis flush on their own — there is nothing left for a fast
   * layer to protect.
   *
   * `wasIssued` is stateless with respect to *use*: it stays `true` for a seq
   * this backend has already spent. That is deliberate — it answers "could
   * this seq ever be valid". "Has it already been spent" is read next from the
   * intents themselves, and `record()`'s durable insert is the final word.
   */
  private async assertIssuedSeq(voucher: Voucher, input: RedeemVoucherInput): Promise<void> {
    const issued = await this.seqs.wasIssued(
      input.organizationId,
      input.agentAccount,
      BigInt(voucher.seq),
    );
    if (!issued) {
      throw PaymentErrors.voucherSeqMismatch({
        account: input.agentAccount,
        actual: voucher.seq,
      });
    }

    // A sequential replay is refused here, by name, rather than left to the
    // unique index in `record()` — which still arbitrates a concurrent one,
    // with the same error.
    const used = await this.intents.isVoucherSeqUsed(
      input.organizationId,
      input.agentAccount,
      voucher.seq,
    );
    if (used) {
      throw PaymentErrors.voucherSeqAlreadyUsed({
        account: input.agentAccount,
        actual: voucher.seq,
      });
    }
  }

  // ── 6. Record ────────────────────────────────────────────────────────────

  /**
   * Writes the intent — which is what makes the seq durably spent, via
   * `uq_payment_intents_account_voucher_seq` — and then reserves the price
   * against the agent's balance.
   *
   * No try/catch and nothing to release on failure: v1's release-on-failure
   * branch existed only to give a Redis reservation back, and there is no
   * reservation any more. A unique-index violation on the seq is not a
   * transient failure to recover from — `PaymentIntentService.create` already
   * turns it into `PAYMENT_VOUCHER_SEQ_ALREADY_USED`, which is exactly the
   * answer a genuine replay deserves, and any other failure simply propagates with
   * nothing to undo.
   */
  private async record(voucher: Voucher, input: RedeemVoucherInput): Promise<PaymentIntent> {
    assertRailOffered(input.chainId, railName(PaymentRail.RAIL_B_VOUCHER));

    const intent = await this.intents.create({
      organizationId: input.organizationId,
      agentId: input.agentId,
      agentAccount: input.agentAccount,
      providerId: input.providerId,
      providerAccount: input.providerAccount,
      toolId: input.toolId,
      // The rail-B half of `assertRailOffered`'s two call sites. Both
      // chains this deployment can enable offer rail B, so today this refuses
      // nothing; it is here because the ASSERTION belongs at the site that
      // chooses a rail, and a check that only exists on the rail that happens to
      // be restricted is one nobody thinks to move when the restriction moves.
      rail: PaymentRail.RAIL_B_VOUCHER,
      // The call id is minted here rather than threaded in from a caller —
      // this path has no router and no invoker in front of it yet (`redeem()`
      // still has no caller), so there is no upstream request this value
      // could be echoed onto today. It is still recorded, both because a call
      // id is intrinsic to every payment intent (the column is `NOT NULL`) and
      // so a future caller that dials `providerId` directly has something to
      // send. Rail B always names a provider in the signed voucher itself, so
      // this is always `PAID` — there is no `FREE` voucher.
      callId: randomUUID(),
      callClass: PaymentIntentCallClass.PAID,
      price: input.price,
      platformFee: input.platformFee,
      requestHash: voucher.requestHash,
      chainId: input.chainId,
      voucherSeq: voucher.seq,
      // The three fields `redeem_voucher` cannot reconstruct minutes later.
      // The signature is the buyer's and no key here could produce it again;
      // `resourceHash` hashes a `resource` string that a binding may since have
      // changed; `issuedAt` is both a signed field and the instant the 2,220s
      // redemption deadline runs from. The resource hash is the CHAIN's —
      // sha256 on Solana, keccak256 on eip155 — because it is replayed as
      // signed bytes and nothing recomputes it.
      voucherSignature: input.signed.signature,
      voucherResourceHash: this.chains.resolve(input.chainId).voucherResourceHash(voucher.resource),
      voucherIssuedAt: voucher.issuedAt,
      // No idempotency key on this path, deliberately. The seq *is* rail B's
      // idempotency key, and it is stricter: a replayed voucher is refused
      // rather than answered with the original intent, which is what the
      // single-use requirement asks for. Carrying both would leave two unique
      // indexes racing to report the same replay under different error codes.
      expiresAt: new Date(voucher.expiresAt * 1000),
    });

    return this.intents.secureFunds(input.organizationId, intent.id);
  }

  private assertEquals(field: string, actual: string, expected: string): void {
    if (actual !== expected) {
      throw PaymentErrors.voucherBindingMismatch({ field, expected, actual });
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
