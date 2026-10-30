import {
  CHAIN_STATE_GATE,
  ChainDoor,
  ChainStateGatePort,
} from '@modules/chains/ports/chain-state-gate.port';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import {
  PaymentIntentRepository,
  RedeemableIntent,
  RedemptionExclusions,
} from '@database/postgres/repositories/payment-intent.repository';
import { BlockedRole, BlockSubjectKind, subjectKey } from '@modules/blocklist/domain/account-block';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';
import { AccountId, AssetId } from '@modules/chains/ports/caip.types';
import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  CLOCK_SKEW_TOLERANCE_SECONDS,
  DEBT_VOIDED_PREFIX,
  FEE_SPIKE_DEFERRED,
  LANDING_SETTLE_SECONDS,
  LANDING_UNKNOWN_ALERT_SECONDS,
  maxVoucherRedeemableLifeSeconds,
  PLATFORM_VOID_OUTCOME_PREFIX,
  PROVIDER_FORFEIT_PREFIX,
  redeemGraceSeconds,
  REDEMPTION_DEADLINE_MARGIN_SECONDS,
  VOUCHER_REDEMPTION_ALERTS,
  VOUCHER_REDEMPTION_BATCH,
} from '../constants/voucher-redemption.constants';
import { PaymentIntentStatus, PaymentRail } from '../ports/payment.types';
import {
  RedeemOutcome,
  RedeemOutcomeKind,
  RedeemVoucherRequest,
  UsedSeqRecord,
  VOUCHER_REDEEMER,
  VoucherRedeemerPort,
} from '../ports/voucher-redeemer.port';
import { PaymentIntentService } from './payment-intent.service';

// Re-exported: callers and specs have always imported it from here.
export { PROVIDER_FORFEIT_PREFIX };

/** The eip155 refusal of a seq that already has an on-chain record (D-23). */
const SEQ_USED = 'VoucherSeqUsed';

/**
 * Refusals the PROVIDER causes. A voucher that dies of one — refused with it
 * outright, or `VoucherExpired` after being retried on it — is forfeited by the
 * provider: the buyer's hold is released and nobody is credited.
 *
 * The block causes are this service's own names (see {@link forfeit}); they are
 * recorded on the intent like a program error so a voucher that is still
 * inside its landing window when the block is seen is forfeited, not lapsed,
 * when it finally closes — even if the block was lifted in between.
 */
const PROVIDER_CAUSED_ERRORS: ReadonlySet<string> = new Set([
  // Unless it is only because of slash records the provider did not cause:
  // see `UNPLANNED_SLASH_SHORTFALL`.
  'ProviderBelowMinimumStake',
  'ProviderBlocked',
  'PayeeBlocked',
  'PayeeBlockedOnChain',
]);

function isProviderCaused(error: string | null): error is string {
  return error !== null && PROVIDER_CAUSED_ERRORS.has(error);
}

/**
 * The provider-caused cause recorded on the intent, or `null`. Reads a bare
 * cause (`ProviderBelowMinimumStake`), a forfeit already recorded
 * (`provider_forfeit:<cause>`, so a crash between the forfeit's reason and its
 * release forfeits again rather than lapsing — review #2, M1), and a forfeit
 * that names the refusal beside it (`<cause> (refused <error>)`, review #2, L5).
 */
function recordedProviderCause(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const bare = stored.startsWith(PROVIDER_FORFEIT_PREFIX)
    ? stored.slice(PROVIDER_FORFEIT_PREFIX.length)
    : stored;
  const head = bare.split(' ')[0];
  return PROVIDER_CAUSED_ERRORS.has(head) ? head : null;
}

/**
 * `ProviderBelowMinimumStake` when the provider is short of free stake ONLY
 * because of slash records it did not cause — records this platform never
 * planned, or records a revoked (e.g. stolen) verifier key signed (review
 * 2026-10-24 wave 2 M-2). This service's own name, recorded on the intent in
 * place of the program error.
 *
 * It is NOT in {@link PROVIDER_CAUSED_ERRORS}: it is not sticky, a later
 * refusal replaces it, and it never turns a close the buyer caused into the
 * provider's forfeit. The voucher is retried until its on-chain deadline (the
 * reaper is releasing those records meanwhile); one that dies of it — closed
 * `VoucherExpired` with this as its last refusal — is forfeited under this
 * cause: the buyer is not charged, nobody is paid, the platform pays nothing.
 */
const UNPLANNED_SLASH_SHORTFALL = 'ProviderStakeHeldByUnplannedSlash';
const BELOW_MINIMUM = 'ProviderBelowMinimumStake';

/**
 * Refusals the BUYER causes by tightening its own grant or caps: a revoked
 * or expired delegate, a lowered per-voucher or window cap. Each is retried
 * until {@link REDEMPTION_DEADLINE_MARGIN_SECONDS} before the voucher's
 * on-chain deadline — a re-grant or a raised cap in the meantime makes the
 * same voucher redeemable — and only then becomes buyer debt
 * (review-buyer-debt M3).
 */
const BUYER_TIGHTENING_ERRORS: ReadonlySet<string> = new Set([
  'DelegateIsRevoked',
  'DelegateIsExpired',
  'DelegateVoucherExceedsPerCallLimit',
  'DelegateWindowLimitExceeded',
  'VoucherExceedsPerCallLimit',
  'EscrowWindowLimitExceeded',
]);

/** The program error the EVM contract reverts with for any blocked party (D-19). */
const ADDRESS_BLOCKED = 'AddressBlocked';

/**
 * This service's own name for a voucher frozen because its payer, payer
 * organization or delegate is blocked (platform blocklist or on chain),
 * recorded on every such voucher each pass
 * (`PaymentIntentRepository.recordPayerBlocks`). Blocking a buyer freezes
 * collection, and a voucher that expires frozen is the buyer's debt — without
 * this record it would close with no recorded cause and be voided as a
 * platform failure.
 */
const PAYER_BLOCKED = 'PayerBlocked';

/**
 * The refusals that make a voucher the BUYER's debt when it can no longer be
 * redeemed and the provider did not cause it: refusals about the buyer's own
 * grant, caps, funding, block or signature — each something the buyer did or
 * controls. Enumerated from the code: {@link BUYER_TIGHTENING_ERRORS}; the
 * empty escrow (`EscrowInsufficient`, retryable on eip155); a payer-side block
 * (`AddressBlocked` when the payee side is not the one blocked, and
 * {@link PAYER_BLOCKED}); and the signature refusals of both chains — the
 * buyer produced those bytes, and voiding them would let a buyer who can make
 * a signature pass admission but fail on chain call for free.
 */
const BUYER_SIDE_CAUSES: ReadonlySet<string> = new Set([
  ...BUYER_TIGHTENING_ERRORS,
  'EscrowInsufficient',
  ADDRESS_BLOCKED,
  PAYER_BLOCKED,
  'SignerIsNotPayer',
  'InvalidSignature',
  'MalleableSignature',
  'BadSignatureV',
  'MissingBuyerSignature',
]);

/** The prefix of a revert the chain gave no name for (`UNKNOWN_REVERT:none`, `UNKNOWN_REVERT:0x…`). */
const UNKNOWN_REVERT_PREFIX = 'UNKNOWN_REVERT:';

/**
 * The causes that mean the PLATFORM failed to redeem the voucher (incident
 * 2026-10-29), by the tag of their `voided:PLATFORM_<tag>` mark:
 *
 * - **no recorded refusal** — `null`, or `VoucherExpired` as the closing cause
 *   (`VoucherExpired` closes with the last RETRY's refusal, so a bare one means
 *   no attempt was ever refused for the voucher). This is what every
 *   transport failure leaves: a send that throws (redeemer unfunded,
 *   `eth_sendRawTransaction` failing), an RPC that does not answer, a batch
 *   that throws, a pause or a misconfiguration — none records a cause. Tag
 *   `UNREDEEMED`;
 * - **`UNKNOWN_REVERT:*`** — the chain reverted and named no reason (out of
 *   gas, a send the node refused): nothing says the buyer did it. Tag
 *   `UNKNOWN_REVERT`;
 * - **{@link FEE_SPIKE_DEFERRED}** — the platform chose not to send while L1
 *   fees spiked. Tag `FEE_SPIKE_DEFERRED`.
 *
 * Any other cause is buyer debt, whether it is in {@link BUYER_SIDE_CAUSES}
 * or not. **The default for an unknown cause is buyer debt**, deliberately:
 * an unlisted cause is a NAMED refusal — the chain said something about the
 * voucher the buyer signed or its escrow — and a void is final (the provider
 * can never be paid for it, and a buyer able to provoke such a refusal would
 * call for free), while a debt can still be settled by the buyer re-signing
 * or voided by hand (`PaymentIntentService.voidDebt`). The causes that carry
 * no information about the voucher are exactly the ones listed here, so an
 * outage cannot reach the debt default. An unlisted cause is logged as
 * unclassified so it can be added to one side.
 */
function platformVoidTag(cause: string | null): string | null {
  if (cause === null || cause === 'VoucherExpired') return 'UNREDEEMED';
  if (cause.startsWith(UNKNOWN_REVERT_PREFIX)) return 'UNKNOWN_REVERT';
  if (cause === FEE_SPIKE_DEFERRED) return 'FEE_SPIKE_DEFERRED';
  return null;
}

/**
 * `findLanding` looked at this intent's own transactions and none of them
 * redeemed it — as far as the node that answered can see. See
 * {@link VoucherRedemptionService.pastLandingWindow}.
 */
const NOT_FOUND_YET = Symbol('NOT_FOUND_YET');

/**
 * Turns each passed rail-B hold into money that has actually moved.
 *
 * ## Why this exists at all
 *
 * Under the escrow, a verdict does not move money. `PaymentIntentService.resolve`
 * marks a rail-B intent `SETTLED` and leaves its hold OPEN, because the buyer's
 * money is in the buyer's own escrow and only `redeem_voucher` can debit it.
 * This is the one caller that retires such a hold, and it does so only after a
 * transaction has confirmed and only while naming its signature.
 *
 * ## Ascending `seq`, per buyer — where the chain needs it
 *
 * Whether order matters is the CHAIN's answer
 * ({@link VoucherRedeemerPort.requiresAscendingSeq}), asked once per pass.
 *
 * **Solana (`true`).** The settlement program admits a voucher on
 * `seq > escrow.seq_high` and nothing else. There is no replay bitmap and no
 * out-of-order window: **a lower seq that lands after a higher one is dead,
 * permanently.** Redeeming seq 40 before seq 7 does not delay seq 7, it
 * destroys it — the call was served and its voucher can no longer be
 * collected. Three rules keep that from happening:
 *
 * - the queue holds a row back while a lower seq of its payer is still open,
 *   and leaves out a payer's later seqs behind a blocked one (the repository);
 * - the batch is ordered `(agent_account, voucher_seq)` ascending, by the
 *   repository's own query, so a buyer's oldest voucher is always reached
 *   first; and
 * - a buyer whose voucher did **not** land in this pass has the rest of their
 *   vouchers skipped ({@link run}). Submitting the next one would advance
 *   `seq_high` past the one still being retried and turn a transient failure
 *   into a permanent loss.
 *
 * Skipping costs at most one tick of latency for that buyer and nothing at all
 * for every other buyer in the batch, because the skip is per account.
 *
 * **`eip155` (`false`).** `AssayEscrow` admits each `(payer, seq)` once, in any
 * order (D-23): a lower seq landing after a higher one is still paid. None of
 * the three hold-backs applies — a voucher that is retried, held or broken
 * holds back nothing of its payer's — and a batch may carry several of one
 * payer's vouchers, never the same one twice. The ascending order is kept; it
 * is harmless.
 *
 * ## Who bears an unredeemable voucher: never the platform
 *
 * The platform never pays or owes a provider: the money for a served paid call
 * comes only from the paying buyer's own escrow. When the chain refuses a
 * voucher for good, it is asked first whether one of this intent's own
 * recorded transactions already redeemed it — a landing whose receipt was
 * never seen gets the same refusal — and if one did, the hold is committed
 * with that transaction. Otherwise the CAUSE decides who loses the money:
 *
 * - **the provider caused it** → the provider forfeits ({@link forfeit});
 * - **the platform failed to redeem it** — the redeemer could not send
 *   (unfunded, transport/RPC failure), the chain reverted with no named
 *   reason, a fee-spike deferral, a pause or misconfiguration that outlived
 *   the voucher ({@link platformVoidTag}) → the call is **voided**
 *   ({@link voidForPlatform}): the hold is released, the buyer is not charged
 *   and never refused for it, and the provider is not paid (owner decision
 *   after the 2026-10-29 incident, where an unfunded redeemer turned 228
 *   served calls into debt the buyers had done nothing to cause);
 * - **anything else** — a buyer tightening (revoked or shortened delegate,
 *   lower caps), an empty escrow, a payer block lifted after the deadline, a
 *   bad signature, any other named refusal → the call becomes **buyer debt**
 *   ({@link lapse}): the buyer's hold stays OPEN, nobody is credited, and the
 *   payer's paid calls are refused (`PAYMENT_DEBT_OUTSTANDING`) until the
 *   buyer signs a replacement voucher (`BuyerDebtService`), which this job
 *   then redeems like any other. A debt not settled within 30 days is written
 *   off: the hold is released and the provider is not paid. (A verdict too
 *   late for its voucher still becomes debt in `PaymentIntentService`.)
 *
 * ## Unless the provider caused it: the provider forfeits
 *
 * A voucher that dies because of the provider — its bonded stake fell below
 * the minimum (it unstaked, or was slashed), or the provider or its payee is
 * blocked — is never paid by the platform. The buyer's hold is released and
 * nobody is credited ({@link forfeit}). A block on the provider side forfeits
 * at once rather than waiting for the voucher to expire; a stake refusal is
 * retried until the deadline first, because the provider may top it up.
 *
 * Before ANY lapse or platform void the provider is checked live — stake against the chain's
 * minimum, and blocks — and a provider at fault right now forfeits instead.
 * A provider-caused refusal, once recorded on the intent, is never overwritten
 * by a later one from elsewhere and decides the close whatever the closing
 * refusal is, so a provider that dipped below its minimum while the voucher
 * was live cannot top up afterwards and be paid (review 2026-10-15, M1 and M3;
 * review #2, M1). A provider block is recorded on every awaiting voucher,
 * frozen ones included, so it survives a payer block too (review #2, M2).
 */
@Injectable()
export class VoucherRedemptionService {
  private readonly logger = new Logger(VoucherRedemptionService.name);
  /** Payers already logged as held in this pass: one line per payer, not per row. */
  private readonly loggedHolds = new Set<string>();
  /** This pass's on-chain blocked accounts, lower-case CAIP-10 — see {@link exclusions}. */
  private chainBlocked: ReadonlySet<string> = new Set();
  /**
   * Whether {@link chainBlocked} could be read this pass. When it could not,
   * the payee is asked live per row instead of being taken as unblocked.
   */
  private chainBlockedKnown = true;
  /**
   * Whether this pass's chain admits any seq order, so a retryable refusal
   * backs off (`recordRedemptionRetry`) instead of being met again on every
   * pass (review 2026-10-23 I-1). Solana keeps one row per payer in its queue
   * and retries every pass, as it always has.
   */
  private retryBackoff = false;

  constructor(
    private readonly payments: PaymentIntentRepository,
    // This job credits a provider only through `commitRedeemedHold`, out of a
    // redemption that landed: it holds no ledger to write anything else with.
    private readonly intents: PaymentIntentService,
    @Inject(VOUCHER_REDEEMER) private readonly redeemer: VoucherRedeemerPort,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    private readonly blocklist: AccountBlocklistService,
    /** Injected so a test can age a hold without waiting out the chain's window. */
    @Optional() private readonly now: () => number = () => Date.now(),
    // The ON-CHAIN pause and blocklist (D-19). Optional: without it the
    // contract's own refusal is what the pass meets.
    @Optional()
    @Inject(CHAIN_STATE_GATE)
    private readonly chainState: ChainStateGatePort | null = null,
  ) {}

  /**
   * One pass over the passed-but-unredeemed holds of `asset`.
   *
   * Never throws: a redemption pass that rejects is logged by Nest and then
   * forgotten, and the holds it did not reach would sit until the next tick
   * with nothing saying why.
   */
  async run(asset: AssetId): Promise<void> {
    // The blocked parties are left out IN the query, before its LIMIT: held
    // after it, 100 rows of one blocked payer at the head of the queue would
    // fill every pass and starve every other buyer (audit E-1). The per-row
    // check below stays as a second line for a block that lands mid-pass.
    const exclusions = await this.exclusions(asset);
    await this.recordProviderBlocks(asset, exclusions);
    await this.recordPayerBlocks(asset, exclusions);
    // Asked of the chain, once per pass: see the class comment.
    const ordered = this.redeemer.requiresAscendingSeq?.(asset) ?? true;
    this.retryBackoff = !ordered;
    const pending = ordered
      ? await this.payments.findAwaitingRedemption(
          asset,
          PaymentIntentStatus.SETTLED,
          PaymentRail.RAIL_B_VOUCHER,
          VOUCHER_REDEMPTION_BATCH,
          exclusions,
        )
      : await this.payments.findAwaitingRedemption(
          asset,
          PaymentIntentStatus.SETTLED,
          PaymentRail.RAIL_B_VOUCHER,
          VOUCHER_REDEMPTION_BATCH,
          exclusions,
          { orderedBySeq: false },
        );
    this.loggedHolds.clear();

    if (pending.length === 0) {
      return;
    }

    // Buyers whose current voucher did not land. On a chain that requires
    // ascending seq every later seq of theirs in this batch is skipped — see
    // the class comment: submitting it would advance `seq_high` past the one
    // still being retried and kill it outright. A throw counts as "did not
    // land" for the same reason a `RETRY` does: this process does not know
    // whether the transaction reached the chain. Elsewhere it is unused.
    const blocked = new Set<string>();

    // The batch size is the CHAIN's answer, not a policy of this service:
    // Solana's `redeem_voucher` takes one voucher and there is no room in a
    // transaction for a second, so `1` runs the loop below unchanged and
    // Solana's behaviour is byte-identical to what it has always been.
    // Asked for this asset's chain: a pass is one asset, so the least capable
    // chain wired elsewhere does not get a say.
    const batchSize = this.redeemer.maxBatchSizeFor?.(asset) ?? this.redeemer.maxBatchSize;
    if (batchSize > 1) {
      return this.runBatched(pending, blocked, ordered, batchSize);
    }

    for (const row of pending) {
      // Payer side first: a blocked buyer freezes collection, and that freeze
      // must hold even when the provider is blocked too (review L4).
      if (await this.held(row)) {
        await this.recordHeldProviderCause(row);
        blocked.add(row.agentAccount);
        continue;
      }
      const forfeit = await this.forfeitIfProviderBlocked(row);
      if (forfeit !== null) {
        if (!forfeit.settled) blocked.add(row.agentAccount);
        continue;
      }
      if (ordered && blocked.has(row.agentAccount)) {
        this.logger.log(
          `Intent ${row.id} (seq ${row.voucherSeq}) is held back this pass: an earlier voucher ` +
            `for ${row.agentAccount} has not been redeemed, and redeeming this one would make ` +
            `that one unredeemable for ever`,
        );
        continue;
      }

      let stop = false;
      try {
        const landed = await this.redeemOne(row);
        stop = landed.stop;
        if (!landed.settled) {
          blocked.add(row.agentAccount);
        }
      } catch (error) {
        // One hold's failure must not cost the rest of the pass. The row keeps
        // its open hold and the next tick finds it again.
        blocked.add(row.agentAccount);
        this.logger.error(
          `Redemption of intent ${row.id} (seq ${row.voucherSeq}) threw past its own ` +
            `handling: ${describe(error)}`,
        );
      }
      if (stop) {
        return;
      }
    }
  }

  /**
   * `stop` ends the whole pass; `settled` says whether this buyer's seq is
   * finished with — redeemed, forfeited or lapsed — so the next one of theirs
   * may go.
   */
  private async redeemOne(row: RedeemableIntent): Promise<{ stop: boolean; settled: boolean }> {
    const request = this.toRequest(row);
    if (!request) {
      // `settled: false` — this seq is never going to be redeemed, and the
      // buyer's later vouchers must not step over it while a human decides
      // what to do with the hold.
      return { stop: false, settled: false };
    }

    const outcome = await this.redeemer.redeem(request.request);
    return this.applyOutcome(row, request.issuedAt, outcome, request.request);
  }

  /**
   * One pass, in batches of `batchSize` (the asset's chain's `maxBatchSizeFor`).
   *
   * Where the chain requires ascending seq (`ordered`), **one row per payer per
   * batch**: rows arrive ordered `(agent_account ASC, voucher_seq ASC)`, so the
   * FIRST row per payer is that payer's lowest unredeemed seq — exactly the one
   * that must land before any later one of theirs — and a payer who was
   * blocked is skipped from then on.
   *
   * Where it does not (`eip155`, D-23), a batch may carry several of one
   * payer's vouchers, but **never the same `(payer, seq)` twice**: the second
   * copy would revert the whole batch with `VoucherSeqUsed`. A blocked payer's
   * later vouchers still go.
   *
   * The rows a batch could not carry are not dropped — they are carried into the
   * next one.
   */
  private async runBatched(
    pending: readonly RedeemableIntent[],
    blocked: Set<string>,
    ordered: boolean,
    batchSize: number,
  ): Promise<void> {
    let queue: readonly RedeemableIntent[] = pending;

    while (queue.length > 0) {
      const batch: { row: RedeemableIntent; request: RedeemVoucherRequest; issuedAt: number }[] =
        [];
      const seen = new Set<string>();
      const carried: RedeemableIntent[] = [];

      for (const row of queue) {
        // Payer side first — see the per-row loop in `run` (review L4).
        if (await this.held(row)) {
          await this.recordHeldProviderCause(row);
          blocked.add(row.agentAccount);
          continue;
        }
        const forfeit = await this.forfeitIfProviderBlocked(row);
        if (forfeit !== null) {
          if (!forfeit.settled) blocked.add(row.agentAccount);
          continue;
        }
        if (ordered && blocked.has(row.agentAccount)) {
          this.logger.log(
            `Intent ${row.id} (seq ${row.voucherSeq}) is held back this pass: an earlier voucher ` +
              `for ${row.agentAccount} has not been redeemed, and redeeming this one would make ` +
              `that one unredeemable for ever`,
          );
          continue;
        }
        // One per payer where order matters; one per (payer, seq) everywhere.
        const slot = ordered ? row.agentAccount : `${row.agentAccount}#${row.voucherSeq}`;
        if (batch.length >= batchSize || seen.has(slot)) {
          carried.push(row);
          continue;
        }

        const built = this.toRequest(row);
        if (!built) {
          // Nothing will ever redeem it, and the buyer's later vouchers must
          // not step over it while a human decides what to do with the hold.
          blocked.add(row.agentAccount);
          continue;
        }

        seen.add(slot);
        batch.push({ row, request: built.request, issuedAt: built.issuedAt });
      }

      if (batch.length === 0) {
        return;
      }

      let outcomes: readonly RedeemOutcome[];
      try {
        outcomes = await this.redeemer.redeemBatch(batch.map((entry) => entry.request));
      } catch (error) {
        // One batch's failure must not cost the rest of the pass, and this
        // process does not know whether the transaction reached the chain — so
        // every payer in it is blocked and their holds stay open.
        for (const entry of batch) {
          blocked.add(entry.row.agentAccount);
        }
        this.logger.error(
          `A redemption batch of ${batch.length} threw past its own handling: ${describe(error)}`,
        );
        return;
      }

      // Positional, and matched by index alone: a redemption carries no id the
      // chain echoes back. A short array means the rest were not attempted —
      // `SolanaVoucherRedeemer.redeemBatch` stops at a pass-ending outcome — so
      // those payers are blocked rather than assumed settled.
      for (const [index, entry] of batch.entries()) {
        const outcome = outcomes[index];
        if (!outcome) {
          blocked.add(entry.row.agentAccount);
          continue;
        }

        let landed: { stop: boolean; settled: boolean };
        try {
          landed = await this.applyOutcome(entry.row, entry.issuedAt, outcome, entry.request);
        } catch (error) {
          blocked.add(entry.row.agentAccount);
          this.logger.error(
            `Redemption of intent ${entry.row.id} (seq ${entry.row.voucherSeq}) threw past its ` +
              `own handling: ${describe(error)}`,
          );
          continue;
        }

        if (!landed.settled) {
          blocked.add(entry.row.agentAccount);
        }
        if (landed.stop) {
          return;
        }
      }

      queue = carried;
    }
  }

  /**
   * The nine signed fields, or `null` for a row nothing can redeem.
   *
   * Shared by the per-row pass and the batch pass so the two cannot disagree
   * about what is redeemable or about which bytes go on the wire.
   */
  /**
   * Whether a payer-side party to this voucher is on the account blocklist —
   * the payer's organization or account, or the delegate that signed. A
   * blocked provider or payee is not held: the provider forfeits the voucher
   * at once (see {@link forfeitIfProviderBlocked}). Checked BEFORE the
   * provider side, so a voucher whose payer and provider are both blocked
   * stays frozen until the payer's block is lifted (review 2026-10-15, L4).
   *
   * A held row is not refused, released or lapsed at once: it keeps its
   * hold and is found again on the next pass after the block is lifted. The
   * payer is added to `blocked` by the caller, so a later seq of theirs is not
   * redeemed over it — the same rule as a voucher that did not land.
   *
   * **Blocking a buyer freezes collection.** The hold stays open and the
   * provider is not paid while the block stands. The chain refuses a voucher
   * after `expiresAt + redeemGraceSeconds` (about 30 minutes after the call on
   * Solana, about two hours on eip155)
   * with `VoucherExpired`, so a block that lasts longer than that does not
   * "resume": the next pass after the unblock meets `UNREDEEMABLE`, and the
   * call becomes buyer debt ({@link lapse}) — the platform pays nothing. The
   * block is recorded on the row ({@link recordPayerBlocks}) so that close is
   * not mistaken for a platform failure. A
   * provider-side block seen meanwhile is recorded on the row
   * ({@link recordHeldProviderCause}), so the provider still forfeits.
   */
  /**
   * What the queue leaves out this pass: every standing platform block, and
   * the on-chain blocked accounts of this asset's chain (confirmed live).
   */
  private async exclusions(asset: AssetId): Promise<RedemptionExclusions> {
    const organizationIds: string[] = [];
    const walletKeys: string[] = [];
    for (const hit of this.blocklist.list()) {
      const key = subjectKey(hit.subjectKind, hit.subject);
      if (!key) continue;
      (hit.subjectKind === BlockSubjectKind.ORGANIZATION ? organizationIds : walletKeys).push(key);
    }
    let chainAccounts: readonly string[] = [];
    this.chainBlockedKnown = true;
    if (this.chainState?.blockedAccounts) {
      try {
        chainAccounts = await this.chainState.blockedAccounts(asset.split('/')[0]);
      } catch {
        chainAccounts = [];
        this.chainBlockedKnown = false;
      }
    }
    this.chainBlocked = new Set(chainAccounts.map((account) => account.toLowerCase()));
    return { organizationIds, walletKeys, chainAccounts };
  }

  /** Log a held row once per payer per pass. */
  private logHeld(row: RedeemableIntent, why: string): void {
    if (this.loggedHolds.has(row.agentAccount)) return;
    this.loggedHolds.add(row.agentAccount);
    this.logger.warn(
      `Intent ${row.id} (seq ${row.voucherSeq}) of ${row.agentAccount} is held back: ${why}`,
    );
  }

  /**
   * Records a provider-side block on every awaiting voucher of `asset` — held
   * ones included, which the queue leaves out — so a provider blocked while
   * its buyer is blocked too still forfeits once both are lifted (review #2,
   * M2). Best effort: a failure is logged and the per-row checks still run.
   */
  private async recordProviderBlocks(asset: AssetId, blocked: RedemptionExclusions): Promise<void> {
    if (
      blocked.organizationIds.length === 0 &&
      blocked.walletKeys.length === 0 &&
      blocked.chainAccounts.length === 0
    ) {
      return;
    }
    try {
      await this.payments.recordProviderBlocks(asset, blocked, [...PROVIDER_CAUSED_ERRORS]);
    } catch (error) {
      this.logger.warn(`Provider blocks could not be recorded this pass: ${describe(error)}`);
    }
  }

  /**
   * Records a payer-side block on every awaiting voucher of `asset` whose
   * payer, payer organization or delegate is blocked — the queue leaves them
   * out — as {@link PAYER_BLOCKED}, so one that expires frozen closes as buyer
   * debt and not as a platform void. Provider causes and the unplanned-slash
   * shortfall are kept (the provider still forfeits). Best effort, like
   * {@link recordProviderBlocks}.
   */
  private async recordPayerBlocks(asset: AssetId, blocked: RedemptionExclusions): Promise<void> {
    try {
      await this.payments.recordPayerBlocks(asset, blocked, PAYER_BLOCKED, [
        ...PROVIDER_CAUSED_ERRORS,
        UNPLANNED_SLASH_SHORTFALL,
      ]);
    } catch (error) {
      this.logger.warn(`Payer blocks could not be recorded this pass: ${describe(error)}`);
    }
  }

  /**
   * A held row is frozen, not closed — but a provider-side block on it is
   * still recorded, sticky, so the close after the payer's unblock forfeits
   * (review #2, M2). Never overwrites a provider cause already recorded.
   */
  private async recordHeldProviderCause(row: RedeemableIntent): Promise<void> {
    if (recordedProviderCause(row.redemptionLastError) !== null) return;
    try {
      const cause = await this.providerBlockCause(row);
      if (cause !== null) {
        await this.payments.recordRedemptionError(row.organizationId, row.id, cause);
      }
    } catch (error) {
      this.logger.warn(
        `Intent ${row.id}: whether its provider is blocked could not be recorded while it is ` +
          `held: ${describe(error)}`,
      );
    }
  }

  private async held(row: RedeemableIntent): Promise<boolean> {
    return this.heldByBlock(row) || (await this.heldByChain(row));
  }

  /**
   * Whether the CHAIN would refuse this voucher right now for a reason that is
   * not the provider's: the program is paused, or the payer or the delegate is
   * on the on-chain blocklist (`assertActive(payer, provider, delegate)` in
   * `_redeem`).
   *
   * The PAYEE is deliberately not asked here: a payee blocked on chain is the
   * provider's side, so the provider forfeits ({@link forfeitIfProviderBlocked})
   * rather than the voucher being held until it expires (review 2026-10-15, M1).
   *
   * Held before batching so one bad voucher does not revert the whole atomic
   * `redeemVoucherBatch` — the same hold as the platform's own blocklist: the
   * row keeps its hold and is retried on the next pass after the unpause or
   * unblock. The gate answers only on a LIVE confirmation of what the cache
   * says, so a stale cache never holds a voucher the chain would redeem.
   */
  private async heldByChain(row: RedeemableIntent): Promise<boolean> {
    if (!this.chainState) return false;
    const reason = await this.chainState.holdReason(ChainDoor.REDEEM, [
      { role: 'PAYER', account: row.agentAccount },
      { role: 'DELEGATE', account: row.voucherDelegate },
    ]);
    if (!reason) return false;
    this.logHeld(
      row,
      `${reason}. It keeps its hold (collection is frozen); past its on-chain expiry it ` +
        `becomes buyer debt if its payer side is blocked, or is voided if the contracts are paused.`,
    );
    return true;
  }

  private heldByBlock(row: RedeemableIntent): boolean {
    const blocked = this.blocklist.firstBlocked([
      {
        role: BlockedRole.ORGANIZATION,
        kind: BlockSubjectKind.ORGANIZATION,
        subject: row.organizationId,
      },
      { role: BlockedRole.PAYER, kind: BlockSubjectKind.WALLET, subject: row.agentAccount },
      { role: BlockedRole.DELEGATE, kind: BlockSubjectKind.WALLET, subject: row.voucherDelegate },
    ]);
    if (!blocked) return false;
    this.logHeld(
      row,
      `its ${blocked.role.toLowerCase()} is blocked (block ${blocked.hit.blockId}). It keeps its ` +
        `hold (collection is frozen); past its on-chain expiry it becomes buyer debt.`,
    );
    return true;
  }

  /**
   * The provider-side block on this voucher, as the forfeit cause, or `null`:
   * the provider's organization or its payee wallet on the platform blocklist,
   * or the payee on the on-chain blocklist — this pass's confirmed snapshot,
   * or a live read of the payee when the snapshot could not be read (review
   * 2026-10-15, M1).
   */
  private async providerBlockCause(row: RedeemableIntent): Promise<string | null> {
    const blocked = this.blocklist.firstBlocked([
      { role: BlockedRole.PROVIDER, kind: BlockSubjectKind.ORGANIZATION, subject: row.providerId },
      { role: BlockedRole.PAYEE, kind: BlockSubjectKind.WALLET, subject: row.providerAccount },
    ]);
    if (blocked) {
      return blocked.role === BlockedRole.PROVIDER ? 'ProviderBlocked' : 'PayeeBlocked';
    }
    if (!row.providerAccount) return null;
    if (this.chainBlocked.has(row.providerAccount.toLowerCase())) {
      return 'PayeeBlockedOnChain';
    }
    if (!this.chainBlockedKnown && (await this.isBlockedLive(row.providerAccount)) === true) {
      return 'PayeeBlockedOnChain';
    }
    return null;
  }

  /** A live on-chain blocklist read; `null` when it cannot be told. */
  private async isBlockedLive(account: string | null): Promise<boolean | null> {
    if (!account || !this.chainState?.isBlockedLive) return null;
    return this.chainState.isBlockedLive(account);
  }

  /**
   * Whose address an `AddressBlocked` revert is about. The contract does not
   * say, so each party is read live: `'PAYER'` when the payer or the delegate
   * is blocked (the voucher is held, as for any payer-side block), `'PAYEE'`
   * when only the payee is (the provider forfeits), `null` when it cannot be
   * told (retried).
   */
  private async addressBlockedSide(row: RedeemableIntent): Promise<'PAYER' | 'PAYEE' | null> {
    const [payer, delegate, payee] = await Promise.all([
      this.isBlockedLive(row.agentAccount),
      row.voucherDelegate ? this.isBlockedLive(row.voucherDelegate) : Promise.resolve(false),
      this.isBlockedLive(row.providerAccount),
    ]);
    if (payer === true || delegate === true) return 'PAYER';
    if (payee === true && payer === false && delegate === false) return 'PAYEE';
    return null;
  }

  /**
   * Forfeits at once a voucher whose provider or payee is blocked (finding
   * 14): a blocked provider is never paid for it. `null` when no provider-side
   * block applies.
   *
   * Goes through {@link closeUnredeemable}, so a transaction this intent
   * already recorded is looked for on chain first — a voucher that landed is
   * committed, not forfeited. `settled: false` (the payer's later seqs wait)
   * only when the row cannot be built or the attempt threw.
   */
  private async forfeitIfProviderBlocked(
    row: RedeemableIntent,
  ): Promise<{ settled: boolean } | null> {
    const cause = await this.providerBlockCause(row);
    if (cause === null) return null;
    try {
      const built = this.toRequest(row);
      if (!built) return { settled: false };
      return await this.closeUnredeemable(row, built.request, cause, true);
    } catch (error) {
      this.logger.error(
        `Forfeit of intent ${row.id} (seq ${row.voucherSeq}) for ${cause} threw: ` +
          `${describe(error)}. The hold stays open for the next pass.`,
      );
      return { settled: false };
    }
  }

  private toRequest(
    row: RedeemableIntent,
  ): { request: RedeemVoucherRequest; issuedAt: number } | null {
    if (!row.providerAccount || !row.providerId || !row.voucherResourceHash) {
      // Refused before anything is built. `redeem_voucher` derives the
      // provider's earnings account from the provider key, and the 239 signed
      // bytes carry the resource hash — a row missing either would submit a
      // transaction that pays nobody, or 239 bytes the buyer never signed.
      // Both are permanent, so this is logged rather than retried quietly.
      this.logger.error(
        `Intent ${row.id} awaits redemption but is missing ` +
          `${!row.providerAccount || !row.providerId ? 'a provider' : 'its resource hash'}. ` +
          `Nothing will redeem it; release the hold by hand.`,
      );
      return null;
    }

    const issuedAt = row.voucherIssuedAt === null ? null : Number(row.voucherIssuedAt);
    if (issuedAt === null) {
      this.logger.error(
        `Intent ${row.id} awaits redemption but has no voucher issued_at. Nothing will ` +
          `redeem it; release the hold by hand.`,
      );
      return null;
    }

    return {
      issuedAt,
      request: {
        payer: row.agentAccount as AccountId,
        provider: row.providerAccount as AccountId,
        amount: MoneyUtil.of(row.priceAmount, row.assetId as AssetId, row.decimals),
        asset: row.assetId as AssetId,
        resourceHash: row.voucherResourceHash,
        requestHash: row.requestHash,
        seq: row.voucherSeq,
        issuedAt,
        expiresAt: Math.floor(row.expiresAt.getTime() / 1000),
        signature: row.voucherSignature,
        delegate: (row.voucherDelegate as AccountId | null) ?? null,
        // Kept on the intent BEFORE the broadcast, so a redemption whose
        // receipt this pass never sees is found on chain by the next one.
        recordAttempt: (txRef) =>
          this.payments.recordRedemptionTxRef(row.organizationId, row.id, txRef),
      },
    };
  }

  /**
   * What one outcome does to one hold. Unchanged from the per-row pass, and
   * shared with the batch pass so a batched redemption and a single one cannot
   * treat the same verdict differently.
   */
  private async applyOutcome(
    row: RedeemableIntent,
    issuedAt: number,
    outcome: RedeemOutcome,
    request: RedeemVoucherRequest,
  ): Promise<{ stop: boolean; settled: boolean }> {
    switch (outcome.kind) {
      case RedeemOutcomeKind.REDEEMED:
        // `signature` may be null for a transaction this process submitted and
        // did not observe confirming. The hold must still be retired, and the
        // honest ref names the seq rather than inventing a signature.
        await this.intents.commitRedeemedHold(
          row.organizationId,
          row.id,
          outcome.signature ?? `unobserved:seq=${row.voucherSeq}`,
        );
        return { stop: false, settled: true };

      case RedeemOutcomeKind.RETRY:
        await this.warnIfOverdue(row, issuedAt, outcome.programError);
        // The EVM contract reverts `AddressBlocked` for ANY blocked party. A
        // payee the snapshot missed is the provider's side: forfeit, never
        // retry it into `VoucherExpired` (review 2026-10-15, M1).
        if (
          outcome.programError === ADDRESS_BLOCKED &&
          (await this.addressBlockedSide(row)) === 'PAYEE'
        ) {
          return this.closeUnredeemable(row, request, 'PayeeBlockedOnChain', true);
        }
        // Kept so the `VoucherExpired` that ends a run of retries can still
        // say why (see `PROVIDER_CAUSED_ERRORS`). A bare RPC failure names no
        // program error and says nothing about the voucher, so it does not
        // overwrite one that did — and nothing overwrites a provider-caused
        // one: once the provider has been seen at fault for this voucher, a
        // later refusal from elsewhere must not turn its forfeit into buyer
        // debt (review 2026-10-15, M3).
        if (
          outcome.programError !== null &&
          recordedProviderCause(row.redemptionLastError) === null
        ) {
          // Below the minimum only because of records the provider did not
          // cause: recorded under its own, non-sticky name (review 2026-10-24
          // wave 2 M-2) and retried until the deadline like any other.
          const recorded =
            outcome.programError === BELOW_MINIMUM &&
            (await this.shortOnlyByUnplannedSlashes(row, request))
              ? UNPLANNED_SLASH_SHORTFALL
              : outcome.programError;
          await this.payments.recordRedemptionError(row.organizationId, row.id, recorded);
        }
        // A buyer tightening still refusing one pass before the voucher's
        // deadline: no re-grant came, and the next attempt can only be
        // `VoucherExpired`. It becomes buyer debt now (the provider is still
        // checked live first, and a landed transaction is still looked for).
        if (
          outcome.programError !== null &&
          BUYER_TIGHTENING_ERRORS.has(outcome.programError) &&
          recordedProviderCause(row.redemptionLastError) === null &&
          this.atRedemptionDeadline(row)
        ) {
          return this.closeUnredeemable(row, request, outcome.programError, false);
        }
        // Any order: this row waits out a back-off, so a run of refusals
        // cannot fill every pass ahead of rows that would redeem (I-1).
        if (this.retryBackoff) {
          await this.payments.recordRedemptionRetry(row.organizationId, row.id);
        }
        // Not settled: on a chain that requires ascending seq this buyer's
        // later vouchers wait a tick. See the class comment — going ahead of a
        // retryable seq there makes it unredeemable.
        return { stop: false, settled: false };

      case RedeemOutcomeKind.UNREDEEMABLE: {
        // A provider cause recorded on the intent decides the close WHATEVER
        // the closing refusal is: a provider seen below its minimum (or
        // blocked) while the voucher was live forfeits even if the buyer then
        // revoked and the chain answers `DelegateIsRevoked` (review #2, M1).
        const recorded = recordedProviderCause(row.redemptionLastError);
        if (recorded !== null) {
          return this.closeUnredeemable(row, request, recorded, true, outcome.programError);
        }
        // `VoucherExpired` ends a run of retries and no longer says why; the
        // refusal recorded on the last RETRY does.
        const cause =
          outcome.programError === 'VoucherExpired'
            ? (row.redemptionLastError ?? outcome.programError)
            : outcome.programError;
        return this.closeUnredeemable(
          row,
          request,
          cause,
          // A voucher that died of an unplanned-slash shortfall is forfeited
          // at its deadline, under that cause, never made buyer debt (M-2).
          isProviderCaused(cause) || cause === UNPLANNED_SLASH_SHORTFALL,
          outcome.programError,
        );
      }

      case RedeemOutcomeKind.PAUSED:
        // Every remaining hold would be refused identically, and each attempt
        // costs a transaction fee. Stop; the next tick finds them all.
        this.logger.warn(
          `redeem_voucher is paused on chain — stopping this pass after intent ${row.id}. ` +
            `${VOUCHER_REDEMPTION_BATCH} holds are waiting on the pause being lifted.`,
        );
        return { stop: true, settled: false };

      case RedeemOutcomeKind.MISCONFIGURED:
        // Same stop as `PAUSED` and for the same arithmetic — every remaining
        // hold is refused identically — but this one does not lift by itself,
        // so it pages instead of logging.
        await this.reportMisconfiguration(row, outcome.programError);
        return { stop: true, settled: false };
    }
  }

  /**
   * Closes a voucher nothing will redeem from here: committed with the
   * transaction that already landed it if there is one, else forfeited by the
   * provider ({@link forfeit}), voided when the platform failed to redeem it
   * ({@link voidForPlatform}), or turned into buyer debt ({@link lapse}). The
   * platform never pays.
   *
   * Every refusal, not only `VoucherSeqNotIncreasing` (Solana) or
   * `VoucherSeqUsed` (`eip155`): a voucher that ALREADY landed gets that one, or `VoucherExpired` when the retry comes after its
   * deadline, which is checked first (final review N-2). Closing it without
   * looking charges the buyer a second time (review 2026-10-15 P-1). The seq
   * is dead on chain — or, for a forfeit, never going to be redeemed — so
   * while it waits the payer's later vouchers may go ahead (`settled: true`).
   */
  private async closeUnredeemable(
    row: RedeemableIntent,
    request: RedeemVoucherRequest,
    cause: string | null,
    forfeit: boolean,
    /** The chain's own refusal that closes it, when there is one. */
    refusedWith: string | null = null,
  ): Promise<{ stop: boolean; settled: boolean }> {
    if (
      forfeit &&
      isProviderCaused(cause) &&
      recordedProviderCause(row.redemptionLastError) === null
    ) {
      // Recorded before anything else: if the voucher is not closed this pass
      // (landing window), the cause survives a block lifted in the meantime.
      await this.payments.recordRedemptionError(row.organizationId, row.id, cause);
    }
    const landing = await this.findLanding(row, request);
    if (landing === undefined) {
      await this.reportLandingUnknown(row, cause);
      return { stop: false, settled: true };
    }
    if (landing !== null && landing !== NOT_FOUND_YET) {
      await this.intents.commitRedeemedHold(row.organizationId, row.id, landing);
      return { stop: false, settled: true };
    }
    if (landing === NOT_FOUND_YET && !this.pastLandingWindow(row)) {
      this.logger.warn(
        `Intent ${row.id} (seq ${row.voucherSeq}) was refused ${cause ?? 'unknown'} ` +
          `and the chain does not show its own transactions yet. Not closed before ` +
          `${LANDING_SETTLE_SECONDS}s past its redemption deadline: a lagging node ` +
          `answers "not found" for a mined one (final review N-7).`,
      );
      return { stop: false, settled: true };
    }
    if (refusedWith === SEQ_USED && this.redeemer.usedSeqRecord) {
      // The seq is used on chain and none of our transactions shows it: the
      // chain's own record decides, before any forfeit or debt (M-B1).
      return this.closeSeqUsedUnobserved(row, request, cause);
    }
    if (forfeit) {
      await this.forfeit(row, cause ?? 'unknown');
      return { stop: false, settled: true };
    }

    // About to void it or make it buyer debt. Not if the provider is at fault right now:
    // asked LIVE, not taken from whatever the last retry recorded (review
    // 2026-10-15, M3/M1) — the provider forfeits, and the refusal that closed
    // the voucher is kept beside its cause (review #2, L5).
    const fault = await this.providerFaultNow(row, request);
    if (fault === undefined) {
      // Unknown. Retried each pass, but only until the landing deadline
      // (review #2, L4): a read that keeps failing is then taken as neutral —
      // the call is voided or becomes buyer debt by its cause, which pays
      // nobody and pages.
      if (!this.pastLandingWindow(row)) {
        this.logger.warn(
          `Intent ${row.id} (seq ${row.voucherSeq}) was refused ${cause ?? 'unknown'}, and ` +
            `whether its provider is at fault could not be read. The hold stays open until ` +
            `${LANDING_SETTLE_SECONDS}s past its redemption deadline.`,
        );
        return { stop: false, settled: true };
      }
      await this.closeNotProviderCaused(row, cause);
    } else if (fault !== null) {
      await this.forfeit(row, cause && cause !== fault ? `${fault} (refused ${cause})` : fault);
    } else {
      await this.closeNotProviderCaused(row, cause);
    }
    // Settled, in the only sense this loop cares about: the hold is closed
    // and nothing will ever redeem this seq, so it cannot be stepped over.
    return { stop: false, settled: true };
  }

  /**
   * `VoucherSeqUsed` (eip155, D-23) means `held(payer, seq)` exists: this seq
   * was redeemed. The redeemer is the platform's key and the seq is unique per
   * payer account, so in practice the landing is ours, unobserved. Asked of
   * the record itself:
   *
   * - it names this voucher's provider and amount and is still `Held` →
   *   committed as a redemption (`unobserved:seq=`, which reads the hold off
   *   the record) and paged as a WARN. The buyer is not asked to pay a second
   *   time;
   * - it names them and is `Collected`, and this platform's own row already
   *   records the hold (`held_status` HELD or COLLECTED) → the landing is ours
   *   and already booked; the hold sync books the collection. Nothing new;
   * - it is `Refunded`, `Collected` with nothing of ours to attribute it to,
   *   or names another provider or amount → an anomaly, paged CRITICAL. Never
   *   booked as a new redemption and NOT buyer debt: the hold stays open for a
   *   human (review 2026-10-24 F-L3);
   * - it says the seq is unused (a node behind the one that refused) or cannot
   *   be read → the hold stays open and the next pass asks again.
   *
   * `settled: true` in every case: the seq is used on chain, so nothing of
   * this payer's can be stepped over by going ahead.
   */
  private async closeSeqUsedUnobserved(
    row: RedeemableIntent,
    request: RedeemVoucherRequest,
    cause: string | null,
  ): Promise<{ stop: boolean; settled: boolean }> {
    let record: UsedSeqRecord;
    try {
      record = (await this.redeemer.usedSeqRecord?.(request)) ?? 'NONE';
    } catch (error) {
      this.logger.warn(
        `Intent ${row.id} (seq ${row.voucherSeq}) was refused ${SEQ_USED} and the chain's ` +
          `record of the seq could not be read: ${describe(error)}. The hold stays open.`,
      );
      return { stop: false, settled: true };
    }

    const price = MoneyUtil.of(row.priceAmount, row.assetId as AssetId, row.decimals);
    const details = {
      intentId: row.id,
      buyer: row.agentAccount,
      provider: row.providerAccount ?? 'unknown',
      seq: row.voucherSeq,
      amount: MoneyUtil.format(price),
      lastRefusal: cause ?? 'none',
    };

    if (record === 'COLLECTED' && (await this.ownHoldRecorded(row))) {
      this.logger.warn(
        `Intent ${row.id} (seq ${row.voucherSeq}) was refused ${SEQ_USED}; the escrow's record ` +
          `is Collected and this platform's row already records the hold — nothing new is booked.`,
      );
      return { stop: false, settled: true };
    }

    if (record === 'HELD') {
      await this.intents.commitRedeemedHold(
        row.organizationId,
        row.id,
        `unobserved:seq=${row.voucherSeq}`,
      );
      this.logger.warn(
        `Intent ${row.id} (seq ${row.voucherSeq}) was refused ${SEQ_USED}; no transaction ` +
          `of its own shows the landing, but the escrow's record names its provider and amount. ` +
          `Committed as redeemed unobserved — not buyer debt.`,
      );
      await this.alerts.emit({
        severity: AlertSeverity.WARN,
        name: VOUCHER_REDEMPTION_ALERTS.SEQ_USED_UNOBSERVED,
        summary:
          `A rail-B voucher was found redeemed on chain by no transaction this process ` +
          `recorded; committed from the escrow's held(payer, seq) record`,
        details,
        aggregation: AlertAggregation.PER_EVENT,
      });
      return { stop: false, settled: true };
    }

    if (record === 'NONE' && !this.pastLandingWindow(row)) {
      this.logger.warn(
        `Intent ${row.id} (seq ${row.voucherSeq}) was refused ${SEQ_USED} but the record ` +
          `read says the seq is unused (a lagging node?). The hold stays open for the next pass.`,
      );
      return { stop: false, settled: true };
    }

    const what =
      record === 'NONE'
        ? 'still reads unused'
        : record === 'MISMATCH'
          ? 'names another provider or amount'
          : record === 'REFUNDED'
            ? 'names this voucher but was REFUNDED'
            : 'names this voucher but was COLLECTED with no hold of ours recorded';
    this.logger.error(
      `CRITICAL: intent ${row.id} (seq ${row.voucherSeq}) was refused ${SEQ_USED}, and the ` +
        `escrow's record of that seq ${what}. ` +
        `Not booked as a redemption, not buyer debt: the hold stays open until a human decides.`,
    );
    await this.alerts.emit({
      severity: AlertSeverity.CRITICAL,
      name: VOUCHER_REDEMPTION_ALERTS.SEQ_USED_ANOMALY,
      summary:
        `A rail-B voucher's seq is used on chain by a record that is not this voucher ` +
        `(${record}); the hold stays open and nobody is charged until a human decides`,
      details: { ...details, record },
      aggregation: AlertAggregation.ONCE_PER_INCIDENT,
      dedupeKey: row.id,
      suppressionWindowSeconds: 24 * 60 * 60,
    });
    return { stop: false, settled: true };
  }

  /**
   * Whether this platform's own row already records the voucher's hold — the
   * redemption was booked (`held_status` HELD) or its collection too
   * (COLLECTED) — so a `Collected` record on chain is attributable to it.
   * Unreadable reads as "no": the caller then raises the anomaly and keeps the
   * hold open, which is the safe side.
   */
  private async ownHoldRecorded(row: RedeemableIntent): Promise<boolean> {
    try {
      const intent = await this.intents.findById(row.organizationId, row.id);
      return intent.heldStatus === 'HELD' || intent.heldStatus === 'COLLECTED';
    } catch (error) {
      this.logger.warn(`Intent ${row.id}: its hold record could not be read: ${describe(error)}`);
      return false;
    }
  }

  /**
   * Why the provider is at fault for this voucher right now, as a forfeit
   * cause; `null` when it is not; `undefined` when that cannot be told.
   *
   * - its bonded stake is below the chain's minimum (a live read through the
   *   redeemer; a chain without one is not asked) for its own reasons — a
   *   shortfall only from slash records it did not cause is `null`, or
   * - it or its payee is blocked (the platform blocklist, this pass's on-chain
   *   snapshot, or a live read of the payee).
   */
  private async providerFaultNow(
    row: RedeemableIntent,
    request: RedeemVoucherRequest,
  ): Promise<string | null | undefined> {
    const blocked = await this.providerBlockCause(row);
    if (blocked !== null) return blocked;
    if ((await this.isBlockedLive(row.providerAccount)) === true) return 'PayeeBlockedOnChain';
    if (!this.redeemer.providerBelowMinimumStake) return null;
    try {
      if (!(await this.redeemer.providerBelowMinimumStake(request))) return null;
      // Short only because of records the provider did not cause: not its
      // fault, so the close keeps its buyer-side handling. Only a voucher whose
      // own refusal was that shortfall (recorded as `UNPLANNED_SLASH_SHORTFALL`
      // on a RETRY, then `VoucherExpired`) is forfeited under it — never a
      // close the buyer caused (review 2026-10-24 wave 3 N-2).
      return (await this.shortOnlyByUnplannedSlashes(row, request)) ? null : BELOW_MINIMUM;
    } catch (error) {
      this.logger.warn(
        `Intent ${row.id}: the provider's stake could not be read live: ${describe(error)}`,
      );
      return undefined;
    }
  }

  /**
   * Whether the provider is below its minimum free stake only because of
   * slash records it did not cause (review 2026-10-24 wave 2 M-2). `false`
   * when the chain cannot tell or the read fails: the refusal is then the
   * provider's, exactly as before.
   */
  private async shortOnlyByUnplannedSlashes(
    row: RedeemableIntent,
    request: RedeemVoucherRequest,
  ): Promise<boolean> {
    if (!this.redeemer.providerShortOnlyByUnplannedSlashes) return false;
    try {
      const short = await this.redeemer.providerShortOnlyByUnplannedSlashes(request);
      if (short) {
        this.logger.warn(
          `Intent ${row.id} (seq ${row.voucherSeq}): its provider is below the minimum free ` +
            `stake only because of slash records it did not cause (unplanned, or signed by a ` +
            `revoked verifier key). Not the provider's fault; retried until its deadline.`,
        );
      }
      return short;
    } catch (error) {
      this.logger.warn(
        `Intent ${row.id}: whether its provider's stake shortfall is its own could not be ` +
          `read: ${describe(error)}`,
      );
      return false;
    }
  }

  /**
   * The provider caused the voucher to fail, so the provider is not paid: the
   * buyer's hold is released and **nothing is credited to anyone** — the
   * platform pays nothing either.
   *
   * The reason is written **before** the release: `findAwaitingRedemption`
   * selects on `hold_released_at IS NULL`, so a crash between the two leaves
   * the row where the next pass finds it and forfeits again, and releasing an
   * already released hold is a no-op.
   */
  private async forfeit(row: RedeemableIntent, cause: string): Promise<void> {
    const price = MoneyUtil.of(row.priceAmount, row.assetId as AssetId, row.decimals);

    await this.payments.recordRedemptionError(
      row.organizationId,
      row.id,
      `${PROVIDER_FORFEIT_PREFIX}${cause}`,
    );

    await this.intents.releaseHold({
      organizationId: row.organizationId,
      id: row.id,
      holdId: row.holdId,
    });

    this.logger.warn(
      `Intent ${row.id} (seq ${row.voucherSeq}): the provider forfeits ${MoneyUtil.format(price)} ` +
        `(${cause}). The buyer's hold is released and nobody is credited.`,
    );
    await this.alerts.emit({
      severity: AlertSeverity.WARN,
      name: VOUCHER_REDEMPTION_ALERTS.PROVIDER_FORFEIT,
      summary:
        `A provider forfeits a voucher it caused to fail (${cause}) — the buyer is not ` +
        `charged ${MoneyUtil.format(price)} and the platform pays nothing`,
      details: {
        intentId: row.id,
        buyer: row.agentAccount,
        provider: row.providerAccount ?? 'unknown',
        providerId: row.providerId ?? 'unknown',
        seq: row.voucherSeq,
        forfeited: MoneyUtil.format(price),
        cause,
      },
      aggregation: AlertAggregation.PER_EVENT,
    });
  }

  /**
   * The transaction that already redeemed this voucher; `null` when this
   * intent recorded none; {@link NOT_FOUND_YET} when it recorded some and the
   * chain shows none of them redeemed it; or `undefined` when that cannot be
   * told yet (a transaction still pending, an RPC that did not answer) — the
   * hold then stays open for the next pass.
   *
   * The references are read from the database now, not from the queue row: a
   * pass that overlapped this one may have recorded its transaction after the
   * row was read. A chain whose redeemer cannot look (no `findLanding`) keeps
   * the old behaviour: the refusal closes the voucher at once.
   */
  private async findLanding(
    row: RedeemableIntent,
    request: RedeemVoucherRequest,
  ): Promise<string | typeof NOT_FOUND_YET | null | undefined> {
    if (!this.redeemer.findLanding) return null;
    try {
      const refs = await this.payments.findRedemptionTxRefs(row.organizationId, row.id);
      if (refs.length === 0) return null;
      return (await this.redeemer.findLanding(request, refs)) ?? NOT_FOUND_YET;
    } catch (error) {
      this.logger.warn(
        `Intent ${row.id} (seq ${row.voucherSeq}) was refused, and whether one of its own ` +
          `transactions redeemed it is not known yet: ${describe(error)}. The hold stays open.`,
      );
      return undefined;
    }
  }

  /**
   * Whether every transaction this intent recorded is old enough that any RPC
   * node would have it. None is broadcast after the voucher's on-chain
   * deadline (`expires_at` + skew + grace) — prevalidation refuses it first —
   * so {@link LANDING_SETTLE_SECONDS} past that deadline is a safe age for all
   * of them.
   */
  private pastLandingWindow(row: RedeemableIntent): boolean {
    return Math.floor(this.now() / 1000) >= this.landingDeadline(row);
  }

  /**
   * Whether the voucher is within {@link REDEMPTION_DEADLINE_MARGIN_SECONDS} of
   * its on-chain deadline (`expiresAt + redeemGraceSeconds`, per the row's
   * chain): the last pass that can still redeem it.
   */
  private atRedemptionDeadline(row: RedeemableIntent): boolean {
    const deadline = Math.floor(row.expiresAt.getTime() / 1000) + redeemGraceSeconds(row.assetId);
    return Math.floor(this.now() / 1000) >= deadline - REDEMPTION_DEADLINE_MARGIN_SECONDS;
  }

  /** Unix seconds at which {@link pastLandingWindow} turns true. */
  private landingDeadline(row: RedeemableIntent): number {
    return (
      Math.floor(row.expiresAt.getTime() / 1000) +
      CLOCK_SKEW_TOLERANCE_SECONDS +
      redeemGraceSeconds(row.assetId) +
      LANDING_SETTLE_SECONDS
    );
  }

  /**
   * The provider did not cause it: voided when the platform failed to redeem
   * it ({@link platformVoidTag}), else buyer debt. A cause on neither list
   * takes the debt default and is logged as unclassified.
   */
  private async closeNotProviderCaused(row: RedeemableIntent, cause: string | null): Promise<void> {
    const tag = platformVoidTag(cause);
    if (tag !== null) {
      await this.voidForPlatform(row, cause, tag);
      return;
    }
    if (cause !== null && !BUYER_SIDE_CAUSES.has(cause)) {
      this.logger.warn(
        `Intent ${row.id} (seq ${row.voucherSeq}) closes on ${cause}, which is neither a ` +
          `buyer-side nor a platform-side cause: buyer debt by default.`,
      );
    }
    await this.lapse(row, cause);
  }

  /**
   * The PLATFORM failed to redeem the voucher, so the served call is VOIDED
   * (incident 2026-10-29): the hold is released, the buyer is not charged and
   * its paid calls are not refused, and nobody is credited — the provider is
   * not paid and the platform pays nothing. Mark and release are one ledger
   * transaction under the payer's lock (`PaymentIntentService.voidUnredeemed`),
   * so it never counts as debt. Reason `voided:PLATFORM_<tag>`.
   *
   * Pages once per asset and cause per incident window, not per voucher: one
   * outage voids every voucher it outlives.
   */
  private async voidForPlatform(
    row: RedeemableIntent,
    cause: string | null,
    tag: string,
  ): Promise<void> {
    const price = MoneyUtil.of(row.priceAmount, row.assetId as AssetId, row.decimals);
    const outcome = `${PLATFORM_VOID_OUTCOME_PREFIX}${tag}`;
    const voided = await this.intents.voidUnredeemed(
      {
        organizationId: row.organizationId,
        id: row.id,
        payer: row.agentAccount,
        holdId: row.holdId,
      },
      `${DEBT_VOIDED_PREFIX}${outcome}`,
    );
    if (!voided) {
      this.logger.warn(
        `Intent ${row.id} (seq ${row.voucherSeq}) was to be voided (${outcome}) but is no ` +
          `longer awaiting redemption; left as it is.`,
      );
      return;
    }

    this.logger.error(
      `Intent ${row.id} (seq ${row.voucherSeq}) was never redeemed because of the platform ` +
        `(${cause ?? 'no recorded refusal'}): VOIDED. ${MoneyUtil.format(price)} is released to ` +
        `${row.agentAccount}, the buyer is not charged, and the provider is not paid.`,
    );
    await this.alerts.emit({
      severity: AlertSeverity.CRITICAL,
      name: VOUCHER_REDEMPTION_ALERTS.PLATFORM_VOIDED,
      summary:
        `Served calls' vouchers are being voided because the platform could not redeem them ` +
        `(${outcome}): buyers are not charged and providers are not paid until the redeemer ` +
        `is fixed`,
      details: {
        asset: row.assetId,
        outcome,
        firstIntentId: row.id,
        firstCause: cause ?? 'none',
        firstAmount: MoneyUtil.format(price),
      },
      aggregation: AlertAggregation.ONCE_PER_INCIDENT,
      dedupeKey: `${row.assetId}:${outcome}`,
    });
  }

  /**
   * The voucher can never be redeemed, the provider did not cause it and the
   * platform did not fail to send it, so the served call becomes BUYER DEBT: the hold stays OPEN (the amount stays
   * out of the buyer's spendable balance), nobody is credited, and the payer's
   * paid calls are refused until the buyer signs a replacement voucher
   * (`BuyerDebtService`) — then this job redeems it like any other, and the
   * provider is credited out of the buyer's escrow. Unsettled for
   * `BUYER_DEBT_WRITE_OFF_DAYS`, it is written off and the provider is not
   * paid. The platform pays nothing at any point.
   *
   * One statement: `findAwaitingRedemption` leaves a lapsed row out, so the
   * row leaves the queue in the same write that records why.
   */
  private async lapse(row: RedeemableIntent, cause: string | null): Promise<void> {
    const price = MoneyUtil.of(row.priceAmount, row.assetId as AssetId, row.decimals);
    const reason = cause ?? 'unknown';

    await this.payments.lapseRedemption(row.organizationId, row.id, reason);

    this.logger.error(
      `Intent ${row.id} (seq ${row.voucherSeq}) can never be redeemed (${reason}): it is buyer ` +
        `debt. ${MoneyUtil.format(price)} stays held in ${row.agentAccount}'s escrow, the provider ` +
        `is not credited, and the payer's paid calls are refused until it signs a replacement.`,
    );
    await this.alerts.emit({
      severity: AlertSeverity.CRITICAL,
      name: VOUCHER_REDEMPTION_ALERTS.UNREDEEMABLE,
      summary:
        `A served call's voucher can never be redeemed (${reason}) — it is now buyer debt: ` +
        `${MoneyUtil.format(price)} stays held, the provider is not credited, and the payer's ` +
        `paid calls are refused until the buyer signs a replacement voucher. The platform pays ` +
        `nothing`,
      details: {
        intentId: row.id,
        buyer: row.agentAccount,
        provider: row.providerAccount ?? 'unknown',
        seq: row.voucherSeq,
        owed: MoneyUtil.format(price),
        cause: reason,
      },
      aggregation: AlertAggregation.PER_EVENT,
    });
  }

  /**
   * This deployment is not the program's redeemer, so nothing will redeem.
   *
   * `ONCE_PER_INCIDENT` on a fixed key: the condition holds for every hold on
   * every pass until an admin moves `Config.redeemer` or this process is
   * re-pointed, and one page is the whole signal. Per-event would be one page
   * per scheduler tick for as long as the fault stands.
   */
  private async reportMisconfiguration(
    row: RedeemableIntent,
    programError: string | null,
  ): Promise<void> {
    this.logger.error(
      `redeem_voucher refuses this deployment (${programError ?? 'Config.redeemer mismatch'}) — ` +
        `stopping the pass at intent ${row.id}. NO voucher can be redeemed until ` +
        `Config.redeemer names the key this process pays with; every rail-B hold stays open ` +
        `and is voided (the provider is not paid) once it outlives the redemption window.`,
    );

    await this.alerts.emit({
      severity: AlertSeverity.CRITICAL,
      name: VOUCHER_REDEMPTION_ALERTS.MISCONFIGURED,
      summary:
        `redeem_voucher is refused for the whole deployment ` +
        `(${programError ?? 'Config.redeemer mismatch'}) — no voucher can be redeemed until ` +
        `Config.redeemer matches this process's fee payer`,
      details: {
        intentId: row.id,
        buyer: row.agentAccount,
        seq: row.voucherSeq,
        programError: programError ?? 'none',
      },
      aggregation: AlertAggregation.ONCE_PER_INCIDENT,
      dedupeKey: VOUCHER_REDEMPTION_ALERTS.MISCONFIGURED,
    });
  }

  /**
   * A refused voucher whose landing has stayed unknown — {@link findLanding}
   * keeps throwing — long past {@link pastLandingWindow}: CRITICAL, once per
   * intent. The hold is left open, as it must be without an answer, but no
   * longer in silence (round-two review R2-6).
   */
  private async reportLandingUnknown(
    row: RedeemableIntent,
    programError: string | null,
  ): Promise<void> {
    const overdueSeconds = Math.floor(this.now() / 1000) - this.landingDeadline(row);
    if (overdueSeconds < LANDING_UNKNOWN_ALERT_SECONDS) {
      return;
    }

    this.logger.error(
      `CRITICAL: intent ${row.id} (seq ${row.voucherSeq}) was refused ` +
        `${programError ?? 'unknown'} and whether it landed is still unknown ` +
        `${overdueSeconds}s past its landing window. Its hold stays open until the chain answers.`,
    );
    await this.alerts.emit({
      severity: AlertSeverity.CRITICAL,
      name: VOUCHER_REDEMPTION_ALERTS.LANDING_UNKNOWN,
      summary:
        `A refused rail-B voucher's landing is still unknown ${overdueSeconds}s past its ` +
        `landing window; its hold stays open`,
      details: {
        intentId: row.id,
        buyer: row.agentAccount,
        seq: row.voucherSeq,
        overdueSeconds,
        lastRefusal: programError ?? 'none',
      },
      aggregation: AlertAggregation.ONCE_PER_INCIDENT,
      dedupeKey: row.id,
      // Once a day per intent: the lookup is retried every pass, and an RPC
      // outage with N stuck intents must not page N times an hour.
      suppressionWindowSeconds: 24 * 60 * 60,
    });
  }

  /**
   * Overdue holds need an alert.
   *
   * Counted from `issued_at` rather than from the intent's own timestamps,
   * because `maxVoucherRedeemableLifeSeconds` is the chain's window and the
   * chain counts from the signed field. Once past it the next pass will come
   * back `VoucherExpired` and the call is closed — buyer debt, or voided when
   * the platform failed to redeem it — so this fires
   * *before* the collection fails, not after it.
   */
  private async warnIfOverdue(
    row: RedeemableIntent,
    issuedAt: number,
    programError: string | null,
  ): Promise<void> {
    const ageSeconds = Math.floor(this.now() / 1000) - issuedAt;
    const deadlineSeconds = maxVoucherRedeemableLifeSeconds(row.assetId);
    if (ageSeconds <= deadlineSeconds) {
      return;
    }

    await this.alerts.emit({
      severity: AlertSeverity.WARN,
      name: VOUCHER_REDEMPTION_ALERTS.OVERDUE,
      summary:
        `A rail-B hold is ${ageSeconds}s old and still not redeemed — past the ` +
        `${deadlineSeconds}s the chain will still accept`,
      details: {
        intentId: row.id,
        buyer: row.agentAccount,
        seq: row.voucherSeq,
        ageSeconds,
        deadlineSeconds,
        lastRefusal: programError ?? 'none',
      },
      aggregation: AlertAggregation.ONCE_PER_INCIDENT,
      dedupeKey: row.id,
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
