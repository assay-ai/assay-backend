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
import { LedgerAccountId, LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  CLOCK_SKEW_TOLERANCE_SECONDS,
  LANDING_SETTLE_SECONDS,
  LANDING_UNKNOWN_ALERT_SECONDS,
  MAX_VOUCHER_REDEEMABLE_LIFE_SECONDS,
  REDEEM_GRACE_SECONDS,
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
 * The `chainTxRef` a platform-absorbed `PROVIDER_CREDIT` carries.
 *
 * There is no transaction — that is the whole point of the entry — and a NULL
 * would be indistinguishable from a credit whose signature somebody forgot to
 * record. The program's own name for the refusal is appended, so one `grep`
 * over the journal answers both *how much has the platform absorbed* and *why*.
 */
export const PLATFORM_ABSORBED_TX_REF_PREFIX = 'platform_absorbed:';

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
 * before seq 7 does not delay seq 7, it destroys it — the call was served, the
 * buyer keeps their money, and the platform pays the provider out of its own funds.
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
 * ## Who bears an unredeemable voucher: neither party
 *
 * The backend prevents an out-of-order redemption and must still handle it.
 * When `VoucherSeqNotIncreasing` comes back, the chain is asked first whether
 * one of this intent's own recorded transactions already redeemed it — a
 * landing whose receipt was never seen gets the same refusal — and if one did,
 * the hold is committed with that transaction. Otherwise the hold is
 * **released** — the buyer keeps their money — and the provider is credited
 * anyway, out of the platform's own funds. That direction is safe and it is the incentive to keep
 * verification fast: the party that can make redemption slow is the only party
 * that pays for it.
 *
 * The credit is written **before** the release, and the order is not
 * cosmetic — see {@link absorb}.
 */
@Injectable()
export class VoucherRedemptionService {
  private readonly logger = new Logger(VoucherRedemptionService.name);
  /** Payers already logged as held in this pass: one line per payer, not per row. */
  private readonly loggedHolds = new Set<string>();

  constructor(
    private readonly payments: PaymentIntentRepository,
    private readonly intents: PaymentIntentService,
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
    const pending = await this.payments.findAwaitingRedemption(
      asset,
      PaymentIntentStatus.SETTLED,
      PaymentRail.RAIL_B_VOUCHER,
      VOUCHER_REDEMPTION_BATCH,
      await this.exclusions(asset),
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
      if (await this.held(row)) {
        blocked.add(row.agentAccount);
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
   * finished with — redeemed or absorbed — so the next one of theirs may go.
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
        if (await this.held(row)) {
          blocked.add(row.agentAccount);
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
   * Whether a party to this voucher is on the account blocklist — the payer's
   * organization or account, the provider or its payout account, or the
   * delegate that signed.
   *
   * A held row is not refused, released or absorbed at once: it keeps its
   * hold and is found again on the next pass after the block is lifted. The
   * payer is added to `blocked` by the caller, so a later seq of theirs is not
   * redeemed over it — the same rule as a voucher that did not land.
   *
   * **A hold that outlasts the voucher's on-chain expiry is absorbed by the
   * platform (owner decision, audit E-2).** The chain refuses a voucher after
   * `expiresAt + REDEEM_GRACE_SECONDS` (about 35 minutes after the call) with
   * `VoucherExpired`, so a block that lasts longer than that does not
   * "resume": the next pass after the unblock meets `UNREDEEMABLE`, and
   * {@link absorb} pays the provider out of the platform's own funds while the
   * buyer is not charged (their hold is released). The platform bears that
   * cost on purpose: it is the price of not moving money for a blocked party.
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
    if (this.chainState?.blockedAccounts) {
      try {
        chainAccounts = await this.chainState.blockedAccounts(asset.split('/')[0]);
      } catch {
        chainAccounts = [];
      }
    }
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

  private async held(row: RedeemableIntent): Promise<boolean> {
    return this.heldByBlock(row) || (await this.heldByChain(row));
  }

  /**
   * Whether the CHAIN would refuse this voucher right now: the program is
   * paused, or the payer, the payee or the delegate is on the on-chain
   * blocklist (`assertActive(payer, provider, delegate)` in `_redeem`).
   *
   * Held before batching so one bad voucher does not revert the whole atomic
   * `redeemVoucherBatch` — the same hold as the platform's own blocklist: the
   * row keeps its hold and is retried on the next pass after the unpause or
   * unblock, and once past its on-chain expiry it is absorbed by the platform
   * (the provider is paid, the buyer is not charged; see {@link held}). The
   * gate answers only on a LIVE confirmation of what the cache says, so a
   * stale cache never holds a voucher the chain would redeem.
   */
  private async heldByChain(row: RedeemableIntent): Promise<boolean> {
    if (!this.chainState) return false;
    const reason = await this.chainState.holdReason(ChainDoor.REDEEM, [
      { role: 'PAYER', account: row.agentAccount },
      { role: 'PAYEE', account: row.providerAccount },
      { role: 'DELEGATE', account: row.voucherDelegate },
    ]);
    if (!reason) return false;
    this.logHeld(
      row,
      `${reason}. It keeps its hold; past its on-chain expiry it is absorbed by the platform.`,
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
      { role: BlockedRole.PROVIDER, kind: BlockSubjectKind.ORGANIZATION, subject: row.providerId },
      { role: BlockedRole.PAYEE, kind: BlockSubjectKind.WALLET, subject: row.providerAccount },
      { role: BlockedRole.DELEGATE, kind: BlockSubjectKind.WALLET, subject: row.voucherDelegate },
    ]);
    if (!blocked) return false;
    this.logHeld(
      row,
      `its ${blocked.role.toLowerCase()} is blocked (block ${blocked.hit.blockId}). It keeps its ` +
        `hold; past its on-chain expiry it is absorbed by the platform.`,
    );
    return true;
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
        // Not settled: this buyer's later vouchers wait a tick. See the class
        // comment — going ahead of a retryable seq makes it unredeemable.
        return { stop: false, settled: false };

      case RedeemOutcomeKind.UNREDEEMABLE: {
        // Every refusal, not only `VoucherSeqNotIncreasing`: a voucher that
        // ALREADY landed gets that one, or `VoucherExpired` when the retry
        // comes after its deadline, which is checked first (final review N-2).
        // Absorbing it pays the provider a second time (review 2026-10-15 P-1).
        // The seq is dead on chain whatever the answer, so while it waits the
        // payer's later vouchers may go ahead (`settled: true`).
        const landing = await this.findLanding(row, request);
        if (landing === undefined) {
          await this.reportLandingUnknown(row, outcome.programError);
          return { stop: false, settled: true };
        }
        if (landing !== null && landing !== NOT_FOUND_YET) {
          await this.intents.commitRedeemedHold(row.organizationId, row.id, landing);
          return { stop: false, settled: true };
        }
        if (landing === NOT_FOUND_YET && !this.pastLandingWindow(row)) {
          this.logger.warn(
            `Intent ${row.id} (seq ${row.voucherSeq}) was refused ${outcome.programError ?? 'unknown'} ` +
              `and the chain does not show its own transactions yet. Not absorbed before ` +
              `${LANDING_SETTLE_SECONDS}s past its redemption deadline: a lagging node ` +
              `answers "not found" for a mined one (final review N-7).`,
          );
          return { stop: false, settled: true };
        }
        await this.absorb(row, outcome.programError);
        // Settled, in the only sense this loop cares about: the hold is closed
        // and nothing will ever redeem this seq, so it cannot be stepped over.
        return { stop: false, settled: true };
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
   * The transaction that already redeemed this voucher; `null` when this
   * intent recorded none; {@link NOT_FOUND_YET} when it recorded some and the
   * chain shows none of them redeemed it; or `undefined` when that cannot be
   * told yet (a transaction still pending, an RPC that did not answer) — the
   * hold then stays open for the next pass.
   *
   * The references are read from the database now, not from the queue row: a
   * pass that overlapped this one may have recorded its transaction after the
   * row was read. A chain whose redeemer cannot look (no `findLanding`) keeps
   * the old behaviour, and the refusal is absorbed.
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
   * The buyer keeps the money and the provider is paid anyway.
   *
   * **The credit comes first and the release second, and the order is what
   * makes a crash between them recoverable.** `findAwaitingRedemption` selects
   * on `hold_released_at IS NULL`, so releasing first would take the row out of
   * the queue — and a crash before the credit would leave the provider unpaid
   * with nothing left to find them by. Credit first, and a crash leaves the row
   * exactly where the next pass looks; the partial unique index on
   * `(organization_id, intent_id, entry_type)` for `PROVIDER_CREDIT` is what
   * stops the retry paying twice.
   */
  private async absorb(row: RedeemableIntent, programError: string | null): Promise<void> {
    const asset = row.assetId as AssetId;
    const providerAmount = MoneyUtil.of(row.providerAmount, asset, row.decimals);

    await this.ledger.appendNow({
      organizationId: row.providerId as string,
      accountId: row.providerAccount as LedgerAccountId,
      entryType: LedgerEntryType.PROVIDER_CREDIT,
      money: providerAmount,
      intentId: row.id,
      chainTxRef: `${PLATFORM_ABSORBED_TX_REF_PREFIX}${programError ?? 'unknown'}`,
    });

    await this.intents.releaseHold({
      organizationId: row.organizationId,
      id: row.id,
      holdId: row.holdId,
    });

    await this.alerts.emit({
      severity: AlertSeverity.CRITICAL,
      name: VOUCHER_REDEMPTION_ALERTS.UNREDEEMABLE,
      summary:
        `A voucher can never be redeemed (${programError ?? 'unknown refusal'}) — the buyer ` +
        `keeps ${MoneyUtil.format(providerAmount)} and the platform pays the provider`,
      details: {
        intentId: row.id,
        buyer: row.agentAccount,
        provider: row.providerAccount ?? 'unknown',
        seq: row.voucherSeq,
        absorbed: MoneyUtil.format(providerAmount),
        programError: programError ?? 'none',
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
        `and starts costing the platform once it outlives the redemption window.`,
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
    });
  }

  /**
   * Overdue holds need an alert.
   *
   * Counted from `issued_at` rather than from the intent's own timestamps,
   * because `MAX_VOUCHER_REDEEMABLE_LIFE_SECONDS` is the chain's window and the
   * chain counts from the signed field. Once past it the next pass will come
   * back `VoucherExpired` and the platform pays — so this fires *before* the
   * loss, not after it.
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
