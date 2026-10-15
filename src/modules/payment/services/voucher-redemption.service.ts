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
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  CLOCK_SKEW_TOLERANCE_SECONDS,
  LANDING_SETTLE_SECONDS,
  LANDING_UNKNOWN_ALERT_SECONDS,
  MAX_VOUCHER_REDEEMABLE_LIFE_SECONDS,
  PROVIDER_FORFEIT_PREFIX,
  REDEEM_GRACE_SECONDS,
  REDEMPTION_DEADLINE_MARGIN_SECONDS,
  VOUCHER_REDEMPTION_ALERTS,
  VOUCHER_REDEMPTION_BATCH,
} from '../constants/voucher-redemption.constants';
import { PaymentIntentStatus, PaymentRail } from '../ports/payment.types';
import {
  RedeemOutcome,
  RedeemOutcomeKind,
  RedeemVoucherRequest,
  VOUCHER_REDEEMER,
  VoucherRedeemerPort,
} from '../ports/voucher-redeemer.port';
import { PaymentIntentService } from './payment-intent.service';

/**
 * The `chainTxRef` a LEGACY platform-absorbed `PROVIDER_CREDIT` carries.
 *
 * Nothing writes one any more — the platform never pays or owes a provider; a
 * voucher that cannot be redeemed is forfeited by the provider or becomes
 * buyer debt (see the class comment). The literal stays so the historical rows
 * can still be labelled (`PLATFORM_ABSORBED_SQL`, reported as uncollected).
 */
export const PLATFORM_ABSORBED_TX_REF_PREFIX = 'platform_absorbed:';

// Re-exported: callers and specs have always imported it from here.
export { PROVIDER_FORFEIT_PREFIX };

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
 * ## Ascending `seq`, per buyer, and it is now load-bearing
 *
 * The settlement program admits a voucher on `seq > escrow.seq_high` and
 * nothing else. There is no replay bitmap and no out-of-order window: **a lower
 * seq that lands after a higher one is dead, permanently.** Redeeming seq 40
 * before seq 7 does not delay seq 7, it destroys it — the call was served and
 * its voucher can no longer be collected.
 *
 * Two rules keep that from happening, and both are in this file:
 *
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
 * - **anything else** — a buyer tightening (revoked or shortened delegate,
 *   lower caps), an empty escrow, a pause, an outage, a late verdict, a payer
 *   block lifted after the deadline → the call becomes **buyer debt**
 *   ({@link lapse}): the buyer's hold stays OPEN, nobody is credited, and the
 *   payer's paid calls are refused (`PAYMENT_DEBT_OUTSTANDING`) until the
 *   buyer signs a replacement voucher (`BuyerDebtService`), which this job
 *   then redeems like any other. A debt not settled within 30 days is written
 *   off: the hold is released and the provider is not paid.
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
 * Before ANY lapse the provider is checked live — stake against the chain's
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

  constructor(
    private readonly payments: PaymentIntentRepository,
    private readonly intents: PaymentIntentService,
    // Never written to here: this job credits a provider only through
    // `commitRedeemedHold`, out of a redemption that landed. Kept injected so
    // the wiring (and every spec that asserts "nothing was credited") stays put.
    private readonly ledger: LedgerService,
    @Inject(VOUCHER_REDEEMER) private readonly redeemer: VoucherRedeemerPort,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    private readonly blocklist: AccountBlocklistService,
    /** Injected so a test can age a hold without waiting 37 minutes. */
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
    const pending = await this.payments.findAwaitingRedemption(
      asset,
      PaymentIntentStatus.SETTLED,
      PaymentRail.RAIL_B_VOUCHER,
      VOUCHER_REDEMPTION_BATCH,
      exclusions,
    );
    this.loggedHolds.clear();

    if (pending.length === 0) {
      return;
    }

    // Buyers whose current voucher did not land. Every later seq of theirs in
    // this batch is skipped — see the class comment: submitting it would
    // advance `seq_high` past the one still being retried and kill it outright.
    // A throw counts as "did not land" for the same reason a `RETRY` does: this
    // process does not know whether the transaction reached the chain.
    const blocked = new Set<string>();

    // `maxBatchSize` is the CHAIN's answer, not a policy of this service:
    // Solana's `redeem_voucher` takes one voucher and there is no room in a
    // transaction for a second, so `1` runs the loop below unchanged and
    // Solana's behaviour is byte-identical to what it has always been.
    if (this.redeemer.maxBatchSize > 1) {
      return this.runBatched(pending, blocked);
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
      if (blocked.has(row.agentAccount)) {
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
   * One pass, in batches of `maxBatchSize`, **one row per payer per batch**.
   *
   * Rows arrive ordered `(agent_account ASC, voucher_seq ASC)`, so the FIRST row
   * per payer is that payer's lowest unredeemed seq — exactly the one that must
   * land before any later one of theirs. Taking one per payer therefore
   * satisfies the ordering rule and `redeemVoucherBatch`'s no-duplicates rule at
   * once: the same payer twice in one batch reverts the batch, because the first
   * copy already advanced `seqHigh`.
   *
   * The rows a batch could not carry are not dropped — they are carried into the
   * next one, and a payer who was blocked is skipped from then on.
   */
  private async runBatched(
    pending: readonly RedeemableIntent[],
    blocked: Set<string>,
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
        if (blocked.has(row.agentAccount)) {
          this.logger.log(
            `Intent ${row.id} (seq ${row.voucherSeq}) is held back this pass: an earlier voucher ` +
              `for ${row.agentAccount} has not been redeemed, and redeeming this one would make ` +
              `that one unredeemable for ever`,
          );
          continue;
        }
        if (batch.length >= this.redeemer.maxBatchSize || seen.has(row.agentAccount)) {
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

        seen.add(row.agentAccount);
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
   * after `expiresAt + REDEEM_GRACE_SECONDS` (about 30 minutes after the call)
   * with `VoucherExpired`, so a block that lasts longer than that does not
   * "resume": the next pass after the unblock meets `UNREDEEMABLE`, and the
   * call becomes buyer debt ({@link lapse}) — the platform pays nothing. A
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
        `becomes buyer debt.`,
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
          await this.payments.recordRedemptionError(
            row.organizationId,
            row.id,
            outcome.programError,
          );
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
        // Not settled: this buyer's later vouchers wait a tick. See the class
        // comment — going ahead of a retryable seq makes it unredeemable.
        return { stop: false, settled: false };

      case RedeemOutcomeKind.UNREDEEMABLE: {
        // A provider cause recorded on the intent decides the close WHATEVER
        // the closing refusal is: a provider seen below its minimum (or
        // blocked) while the voucher was live forfeits even if the buyer then
        // revoked and the chain answers `DelegateIsRevoked` (review #2, M1).
        const recorded = recordedProviderCause(row.redemptionLastError);
        if (recorded !== null) {
          return this.closeUnredeemable(row, request, recorded, true);
        }
        // `VoucherExpired` ends a run of retries and no longer says why; the
        // refusal recorded on the last RETRY does.
        const cause =
          outcome.programError === 'VoucherExpired'
            ? (row.redemptionLastError ?? outcome.programError)
            : outcome.programError;
        return this.closeUnredeemable(row, request, cause, isProviderCaused(cause));
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
   * provider ({@link forfeit}) or turned into buyer debt ({@link lapse}). The
   * platform never pays.
   *
   * Every refusal, not only `VoucherSeqNotIncreasing`: a voucher that ALREADY
   * landed gets that one, or `VoucherExpired` when the retry comes after its
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
    if (forfeit) {
      await this.forfeit(row, cause ?? 'unknown');
      return { stop: false, settled: true };
    }

    // About to make it buyer debt. Not if the provider is at fault right now:
    // asked LIVE, not taken from whatever the last retry recorded (review
    // 2026-10-15, M3/M1) — the provider forfeits, and the refusal that closed
    // the voucher is kept beside its cause (review #2, L5).
    const fault = await this.providerFaultNow(row, request);
    if (fault === undefined) {
      // Unknown. Retried each pass, but only until the landing deadline
      // (review #2, L4): a read that keeps failing is then taken as neutral —
      // the call becomes buyer debt, which pays nobody and pages.
      if (!this.pastLandingWindow(row)) {
        this.logger.warn(
          `Intent ${row.id} (seq ${row.voucherSeq}) was refused ${cause ?? 'unknown'}, and ` +
            `whether its provider is at fault could not be read. The hold stays open until ` +
            `${LANDING_SETTLE_SECONDS}s past its redemption deadline.`,
        );
        return { stop: false, settled: true };
      }
      await this.lapse(row, cause);
    } else if (fault !== null) {
      await this.forfeit(row, cause && cause !== fault ? `${fault} (refused ${cause})` : fault);
    } else {
      await this.lapse(row, cause);
    }
    // Settled, in the only sense this loop cares about: the hold is closed
    // and nothing will ever redeem this seq, so it cannot be stepped over.
    return { stop: false, settled: true };
  }

  /**
   * Why the provider is at fault for this voucher right now, as a forfeit
   * cause; `null` when it is not; `undefined` when that cannot be told.
   *
   * - its bonded stake is below the chain's minimum (a live read through the
   *   redeemer; a chain without one is not asked), or
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
      return (await this.redeemer.providerBelowMinimumStake(request))
        ? 'ProviderBelowMinimumStake'
        : null;
    } catch (error) {
      this.logger.warn(
        `Intent ${row.id}: the provider's stake could not be read live: ${describe(error)}`,
      );
      return undefined;
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
   * its on-chain deadline (`expiresAt + REDEEM_GRACE_SECONDS`): the last pass
   * that can still redeem it.
   */
  private atRedemptionDeadline(row: RedeemableIntent): boolean {
    const deadline = Math.floor(row.expiresAt.getTime() / 1000) + REDEEM_GRACE_SECONDS;
    return Math.floor(this.now() / 1000) >= deadline - REDEMPTION_DEADLINE_MARGIN_SECONDS;
  }

  /** Unix seconds at which {@link pastLandingWindow} turns true. */
  private landingDeadline(row: RedeemableIntent): number {
    return (
      Math.floor(row.expiresAt.getTime() / 1000) +
      CLOCK_SKEW_TOLERANCE_SECONDS +
      REDEEM_GRACE_SECONDS +
      LANDING_SETTLE_SECONDS
    );
  }

  /**
   * The voucher can never be redeemed and the provider did not cause it, so
   * the served call becomes BUYER DEBT: the hold stays OPEN (the amount stays
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
        `and becomes buyer debt once it outlives the redemption window.`,
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
   * because `MAX_VOUCHER_REDEEMABLE_LIFE_SECONDS` is the chain's window and the
   * chain counts from the signed field. Once past it the next pass will come
   * back `VoucherExpired` and the call becomes buyer debt — so this fires
   * *before* the collection fails, not after it.
   */
  private async warnIfOverdue(
    row: RedeemableIntent,
    issuedAt: number,
    programError: string | null,
  ): Promise<void> {
    const ageSeconds = Math.floor(this.now() / 1000) - issuedAt;
    if (ageSeconds <= MAX_VOUCHER_REDEEMABLE_LIFE_SECONDS) {
      return;
    }

    await this.alerts.emit({
      severity: AlertSeverity.WARN,
      name: VOUCHER_REDEMPTION_ALERTS.OVERDUE,
      summary:
        `A rail-B hold is ${ageSeconds}s old and still not redeemed — past the ` +
        `${MAX_VOUCHER_REDEEMABLE_LIFE_SECONDS}s the program will still accept`,
      details: {
        intentId: row.id,
        buyer: row.agentAccount,
        seq: row.voucherSeq,
        ageSeconds,
        deadlineSeconds: MAX_VOUCHER_REDEEMABLE_LIFE_SECONDS,
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
