import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';

import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { assertRailOffered } from '@modules/chains/chain-metadata';
import {
  AccountId,
  chainIdOf,
  isAccountId,
  parseAccountId,
} from '@modules/chains/ports/caip.types';
import {
  VoucherAuthorityKind,
  VoucherAuthorityRefusal,
  VoucherDelegationTerms,
} from '@modules/chains/ports/voucher-authority.types';
import { Voucher } from '@modules/chains/ports/x402.types';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  VOUCHER_ADMISSION_CHAIN_LAG_MS,
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
import { decayVoucherWindow } from '../domain/voucher-window';
import { EscrowSeqService } from './escrow-seq.service';
import { PaymentIntentService, VoucherAdmission } from './payment-intent.service';

/**
 * C0 and C1 control characters — anything that would break the line-separated
 * canonical message. The control characters are the point of the pattern, so
 * `no-control-regex` is disabled here rather than worked around.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** A delegate the chain says may sign for the payer, as read for this decision. */
interface AdmittedDelegation {
  readonly delegate: AccountId;
  readonly terms: VoucherDelegationTerms;
  /** Taken just before the chain read: no redemption after it is in `terms`. */
  readonly readAt: Date;
}

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
 *   4  signature      — did the payer authorise it?      ~50µs; chain reads
 *                       (its own key, an on-chain        only when the payer's
 *                       delegate within caps, or its     own key did not sign
 *                       EIP-1271 wallet)
 *   4b escrow limit   — the payer's own per-voucher      no I/O (the caller's
 *                       limit                             escrow read)
 *   5  seq issued     — did we hand this number out?     one Postgres read
 *   6  intent insert  — record it, durably, if it fits   one Postgres
 *                       the windows (escrow + delegate)   transaction, under
 *                                                         the payer's lock
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
    const delegation = await this.assertAuthorisedByPayer(voucher, signature, input, now);
    this.assertWithinEscrowLimit(voucher, input);
    await this.assertIssuedSeq(voucher, input);

    return this.record(voucher, input, delegation);
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
   * The voucher must be authorised by `voucher.payer` — the account inside the
   * signed message, by then already checked to be the authenticated caller —
   * under the CHAIN's rule, which this mirrors exactly
   * (`X402Escrow._voucherAuthority`):
   *
   *   (a) the payer's own key signed it — checked first, synchronously, with no
   *       I/O, exactly as before delegation existed;
   *   (b) a DELEGATE key the payer authorised on chain signed it, the delegate is
   *       not revoked or lapsed, and the voucher fits the delegate's own caps;
   *   (c) the payer has code and its EIP-1271 wallet accepts the signature —
   *       which the chain accepts, and the platform does NOT serve on (see
   *       `voucherWalletSignatureUnsupported`, review S2-4).
   *
   * (b) is answered by the chain adapter from CHAIN STATE and fails closed.
   * Returns the delegate and its terms for (b), null otherwise; the delegate is
   * recorded on the intent, and its window is checked when the intent is
   * written (see `record`).
   *
   * Verifying against a signer taken from anywhere else, a header or a request
   * field, would let an attacker present someone else's voucher alongside their
   * own key and have it pass — which is why the delegate is never something the
   * caller names: it is whoever the signature recovers to, and only the chain
   * says whether that key may sign for this payer.
   */
  private async assertAuthorisedByPayer(
    voucher: Voucher,
    signature: string,
    input: RedeemVoucherInput,
    now: number,
  ): Promise<AdmittedDelegation | null> {
    const adapter = this.chains.resolve(input.chainId);

    if (typeof signature !== 'string' || signature.length === 0) {
      throw PaymentErrors.voucherSignatureInvalid({ payer: voucher.payer });
    }

    // (a)
    if (adapter.verifyVoucherSignature(voucher, signature, voucher.payer)) {
      return null;
    }
    if (typeof adapter.authorizeVoucherSigner !== 'function') {
      throw PaymentErrors.voucherSignatureInvalid({ payer: voucher.payer });
    }

    // Path (c) is not asked at all: see `voucherWalletSignatureUnsupported`.
    // `readAt` is taken BEFORE the read: the delegate's counter it returns can
    // contain no redemption confirmed after this instant.
    const readAt = new Date();
    const answer = await adapter.authorizeVoucherSigner(voucher, signature, now, {
      allowErc1271: false,
    });
    switch (answer.kind) {
      case VoucherAuthorityKind.PAYER:
        return null;
      case VoucherAuthorityKind.ERC1271:
        // Unreachable with `allowErc1271: false`; refused rather than trusted if
        // an adapter ever answers it anyway.
        throw PaymentErrors.voucherWalletSignatureUnsupported({ payer: voucher.payer });
      case VoucherAuthorityKind.DELEGATE:
        this.assertWithinDelegation(voucher, input, answer.delegate, answer.terms);
        return { delegate: answer.delegate, terms: answer.terms, readAt };
      case 'REFUSED':
        if (answer.reason === VoucherAuthorityRefusal.ERC1271_NOT_ACCEPTED) {
          throw PaymentErrors.voucherWalletSignatureUnsupported({ payer: voucher.payer });
        }
        if (
          answer.reason === VoucherAuthorityRefusal.DELEGATE_REVOKED ||
          answer.reason === VoucherAuthorityRefusal.DELEGATE_EXPIRED
        ) {
          throw PaymentErrors.voucherDelegateInactive({
            payer: voucher.payer,
            delegate: answer.signer,
            reason: answer.reason,
          });
        }
        throw PaymentErrors.voucherSignatureInvalid({ payer: voucher.payer });
    }
  }

  /**
   * (b)'s caps, which the chain will apply at redemption and which therefore
   * have to hold BEFORE the call is served — a voucher the chain will refuse is
   * a provider working for nothing.
   *
   * - The signer must be the delegate bound to THIS agent credential: an agent
   *   spends only through the key it proved it holds.
   * - The delegation must outlive the voucher's whole REDEEMABLE life:
   *   `validUntil >= expiresAt + redeemGrace`. The chain checks `validUntil` at
   *   the redemption block, and the redemption job runs after settlement — any
   *   time up to the grace after `expiresAt`. A delegation that lapses inside
   *   that grace is a served call refused at redemption (review S2-1), so the
   *   margin is the latest instant the chain would still redeem.
   * - `amount <= maxVoucherAmount`, the delegate's per-voucher cap.
   *
   * The delegate's WINDOW is checked in `record`, atomically with the insert
   * (BUG-D1-02), and so are the escrow's own limits, which bind a delegate on
   * top of its caps (BUG-D1-03).
   */
  private assertWithinDelegation(
    voucher: Voucher,
    input: RedeemVoucherInput,
    delegate: AccountId,
    terms: VoucherDelegationTerms,
  ): void {
    const bound = input.boundDelegate ?? null;
    if (bound === null || !sameAccount(bound, delegate)) {
      throw PaymentErrors.voucherDelegateNotBound({ delegate, bound });
    }

    if (voucher.expiresAt + terms.redeemGraceSeconds > terms.validUntil) {
      throw PaymentErrors.voucherDelegateLimitExceeded({
        limit: 'validUntil',
        allowed:
          `a voucher expiring by ` +
          new Date((terms.validUntil - terms.redeemGraceSeconds) * 1000).toISOString() +
          ` (the delegation ends ${new Date(terms.validUntil * 1000).toISOString()} and the ` +
          `chain redeems up to ${terms.redeemGraceSeconds}s after a voucher expires)`,
      });
    }

    const amount = BigInt(voucher.amount.amount);
    if (amount > terms.maxVoucherAmount) {
      throw PaymentErrors.voucherDelegateLimitExceeded({
        limit: 'maxVoucherAmount',
        allowed: terms.maxVoucherAmount.toString(),
      });
    }
  }

  /**
   * The payer's OWN escrow per-voucher limit (`setLimits`), which the chain
   * applies at redemption to every voucher, whoever signed it (BUG-D1-03).
   * Checked against the escrow reading the caller made for this call; a caller
   * that passes none (no escrow open) leaves it to the gates that refuse that.
   *
   * The escrow's window is checked in `record`, under the payer's lock.
   */
  private assertWithinEscrowLimit(voucher: Voucher, input: RedeemVoucherInput): void {
    const escrow = input.escrow ?? null;
    if (escrow === null) return;
    if (BigInt(voucher.amount.amount) > escrow.maxVoucherAmount) {
      throw PaymentErrors.voucherEscrowLimitExceeded({
        limit: 'maxVoucherAmount',
        allowed: escrow.maxVoucherAmount.toString(),
      });
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
   * A unique-index violation on the seq is not a transient failure to recover
   * from — `PaymentIntentService.create` already turns it into
   * `PAYMENT_VOUCHER_SEQ_ALREADY_USED`, which is exactly the answer a genuine
   * replay deserves. The one thing undone on failure is the window place: the
   * `CREATED` row is the reservation the next admission counts (BUG-D1-02), so
   * a voucher whose funds could not be secured gives it back at once.
   */
  private async record(
    voucher: Voucher,
    input: RedeemVoucherInput,
    delegation: AdmittedDelegation | null,
  ): Promise<PaymentIntent> {
    assertRailOffered(input.chainId, railName(PaymentRail.RAIL_B_VOUCHER));
    const delegate = delegation?.delegate ?? null;

    const intent = await this.intents.create(
      {
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
        voucherResourceHash: this.chains
          .resolve(input.chainId)
          .voucherResourceHash(voucher.resource),
        voucherIssuedAt: voucher.issuedAt,
        // The delegate whose on-chain window this voucher will count against, so
        // the next delegate-signed call sees it before it reaches the chain.
        voucherDelegate: delegate,
        credentialId: input.credentialId ?? null,
        // No idempotency key on this path, deliberately. The seq *is* rail B's
        // idempotency key, and it is stricter: a replayed voucher is refused
        // rather than answered with the original intent, which is what the
        // single-use requirement asks for. Carrying both would leave two unique
        // indexes racing to report the same replay under different error codes.
        expiresAt: new Date(voucher.expiresAt * 1000),
      },
      this.admission(voucher, input, delegation),
    );

    try {
      return await this.intents.secureFunds(input.organizationId, intent.id);
    } catch (error) {
      // Nothing was reserved: give the window back now rather than at the
      // voucher's deadline. Best effort — the deadline still frees it.
      await this.intents
        .abandonUnsecuredVoucher(input.organizationId, intent.id)
        .catch((abandonError: unknown) => {
          this.logger.warn(
            `Intent ${intent.id}: funds not secured and could not be taken out of the ` +
              `window count; it frees at the voucher's deadline. ${describe(abandonError)}`,
          );
        });
      throw error;
    }
  }

  /**
   * The windows this voucher must fit, checked under the payer's lock and
   * atomically with the insert (BUG-D1-02): for each window, the chain's
   * counter decayed to now, plus every voucher accepted that the chain has not
   * counted yet (in flight, served and unredeemed, or redeemed after the
   * counter was read), plus this one, must fit the cap.
   *
   * - The ESCROW's window (`maxPerWindow` from `setLimits`): every voucher of
   *   the payer, the payer's own and every delegate's.
   * - The DELEGATE's window, for a delegate-signed voucher: its own vouchers.
   *
   * Undefined when there is nothing to check (no escrow reading and no
   * delegate), and the insert then takes no lock.
   */
  private admission(
    voucher: Voucher,
    input: RedeemVoucherInput,
    delegation: AdmittedDelegation | null,
  ): VoucherAdmission | undefined {
    const escrow = input.escrow ?? null;
    if (escrow === null && delegation === null) return undefined;

    const nowSeconds = Math.floor(Date.now() / 1000);
    const amount = BigInt(voucher.amount.amount);
    const lagged = (at: Date) => new Date(at.getTime() - VOUCHER_ADMISSION_CHAIN_LAG_MS);
    const escrowCarried =
      escrow === null
        ? 0n
        : decayVoucherWindow(escrow.spentInWindow, escrow.windowStartedAt, nowSeconds);

    return {
      scope: {
        payer: input.agentAccount,
        assetId: voucher.amount.asset,
        delegate: delegation?.delegate ?? null,
        escrowSince: lagged(escrow?.observedAt ?? delegation?.readAt ?? new Date()),
        delegateSince: delegation === null ? null : lagged(delegation.readAt),
      },
      admit: (open) => {
        // A change tightening the payer's caps is being relayed (BUG-D1-07):
        // admitting under the caps that are about to go could strand this one.
        // Refused before the insert, so nothing is reserved and the seq stays
        // free for the retry.
        if (open.pausedUntil) {
          throw PaymentErrors.voucherAdmissionPaused({
            retryAfterSeconds: Math.max(
              1,
              Math.ceil((open.pausedUntil.getTime() - Date.now()) / 1000),
            ),
          });
        }
        if (escrow !== null) {
          const used = escrowCarried + open.escrow;
          if (used + amount > escrow.maxPerWindow) {
            throw PaymentErrors.voucherEscrowLimitExceeded({
              limit: 'maxPerWindow',
              allowed: (escrow.maxPerWindow > used ? escrow.maxPerWindow - used : 0n).toString(),
            });
          }
        }
        if (delegation !== null) {
          const used = delegation.terms.carriedInWindow + open.delegate;
          if (used + amount > delegation.terms.maxPerWindow) {
            const cap = delegation.terms.maxPerWindow;
            throw PaymentErrors.voucherDelegateLimitExceeded({
              limit: 'maxPerWindow',
              allowed: (cap > used ? cap - used : 0n).toString(),
            });
          }
        }
      },
    };
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

/** One account, compared on its chain and its address case-insensitively. */
function sameAccount(a: AccountId, b: AccountId): boolean {
  const left = parseAccountId(a);
  const right = parseAccountId(b);
  return (
    left.chainId === right.chainId && left.address.toLowerCase() === right.address.toLowerCase()
  );
}
