import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { HELD_PAYMENTS, HeldPaymentsPort } from '@modules/payment/ports/held-payments.port';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { BuyerEscrowEntity } from '@database/postgres/entities/buyer-escrow.entity';
import { ReconciliationRunEntity } from '@database/postgres/entities/reconciliation-run.entity';
import { AccountBalanceRepository } from '@database/postgres/repositories/account-balance.repository';
import { BuyerEscrowRepository } from '@database/postgres/repositories/buyer-escrow.repository';
import { LedgerEntryRepository } from '@database/postgres/repositories/ledger-entry.repository';
import { ReconciliationRunRepository } from '@database/postgres/repositories/reconciliation-run.repository';
import { getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { AccountId, AssetId } from '@modules/chains/ports/caip.types';
import { VAULT_PORT, VaultPort } from '@modules/chains/ports/vault.port';
import {
  ESCROW_BALANCE_READER,
  EscrowBalanceReaderPort,
  EscrowChainBalance,
} from '@modules/ledger/ports/escrow-balance-reader.port';
import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  RECONCILIATION_ALERTS,
  RECONCILIATION_ESCROW_PAGE,
  RECONCILIATION_MAX_CONSECUTIVE_FAILURES,
  RECONCILIATION_SHORTFALL_TOLERANCE_ATOMIC,
  RECONCILIATION_SURPLUS_TOLERANCE_UNITS,
  RECONCILIATION_WARN_ALERT_WINDOW_SECONDS,
} from '../constants/reconciliation.constants';
import { LedgerLiabilities, foldLiabilities, vaultLiabilities } from '../domain/ledger-book';
import {
  ReconciliationFinding,
  ReconciliationFindingCode,
  ReconciliationReport,
  ReconciliationSeverity,
} from '../ports/reconciliation.types';

/**
 * The 5-minute reconciler, over each enabled chain's vault — the EVM escrow
 * contract (`settlementAssetsOn`; Solana has no vault to reconcile).
 *
 * The reason for it fits in one line: *without it, every later bug is a
 * silent money bug.* Everything about the design below
 * follows from taking that literally.
 *
 * ## What it compares
 *
 * ```text
 *   chain          ledger (journal)                    ledger (snapshot)
 *   ─────          ────────────────                    ─────────────────
 *   vault    ≥     agent liabilities                   Σ available+held+pending
 *   balance        + provider payable          =       (account_balances)
 *                  + platform fees
 *      └── check 1 ──┘                     └──── check 2 ────┘
 * ```
 *
 * Check 1's provider and platform figures leave out what rail-B redemptions
 * already paid out of the buyer's escrow (`vaultLiabilities`); check 2 keeps
 * the journal's own fold, which still carries those credits as earnings.
 *
 * **Two comparisons, not one, because they fail differently.** Check 1 catches
 * value that left the vault without a journal entry, or a liability recorded
 * against money that never arrived. Check 2 catches a derivation bug: the
 * journal — which *is* the truth — disagreeing with the cache every hot path
 * actually reads. A reconciler that only ran check 1 against the snapshot
 * could not detect check 2 at all, because it would be comparing the chain
 * against the very number that is wrong.
 *
 * ## What it does not do
 *
 * It never repairs anything. The rule is explicit — *never "correct" the ledger
 * to match the chain by hand; find the missing or extra entry and write a
 * compensating entry with a cause.* Automatic repair would destroy the evidence
 * needed to find the bug, and a reconciler with write access to balances is a
 * second, unreviewed way for money to move.
 *
 * ## The platform never owes a provider
 *
 * An unredeemable rail-B voucher no longer credits anybody: the provider
 * forfeits it, or it becomes buyer debt (the buyer's hold stays open) and is
 * paid from the buyer's escrow once re-signed, or written off. So no ledger
 * entry is ever written that the vault must fund for a provider. A breach here
 * is a
 * real discrepancy to investigate.
 *
 * ## Why it does not throw on a breach
 *
 * It records and alerts, because a throw would
 * abort the pass *before* the `reconciliation_runs` row is written, and that
 * row is the artefact an incident is reconstructed from. A breach here is a
 * `CRITICAL` finding, a persisted row, an alert, and a frozen withdrawal path
 * — all of which survive the process dying immediately afterwards.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    @Inject(VAULT_PORT) private readonly vault: VaultPort,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    private readonly entries: LedgerEntryRepository,
    private readonly balances: AccountBalanceRepository,
    private readonly runs: ReconciliationRunRepository,
    @Inject(ESCROW_BALANCE_READER) private readonly escrowReader: EscrowBalanceReaderPort,
    private readonly escrows: BuyerEscrowRepository,
    // "Redeem into hold" (G3.B1): held payments are in the escrow contract but
    // in no buyer's balance. Optional: without them nothing is held.
    @Optional() private readonly intents: PaymentIntentRepository | null = null,
    @Optional() @Inject(HELD_PAYMENTS) private readonly held: HeldPaymentsPort | null = null,
  ) {}

  /**
   * One pass over one asset. Always records a row; alerts unless everything
   * matched.
   *
   * Never rejects. A chain read that fails is itself a finding, recorded and
   * escalated if it keeps happening — a reconciler whose failures propagate as
   * exceptions is a reconciler that goes quiet exactly when the infrastructure
   * is unhealthy, which is when it is most needed.
   */
  async reconcile(asset: AssetId): Promise<ReconciliationReport> {
    const startedAt = new Date();
    const decimals = getAssetMetadata(asset).decimals;

    try {
      return await this.run(asset, decimals, startedAt);
    } catch (error) {
      return this.recordFailure(asset, startedAt, error);
    }
  }

  /**
   * Whether the withdrawal path is frozen for this asset.
   *
   * A vault below its liabilities means *halt payouts, page on-call, freeze
   * withdrawals pending investigation*. This is the read that enforces the
   * last of the three.
   *
   * **A missing history is not a freeze.** A deployment whose reconciler has
   * never run has no evidence of a breach, and refusing every withdrawal on
   * that basis would make the first deploy of this code an outage. The
   * *staleness* of a run is deliberately not checked here either — that
   * belongs to the reconciler's own consecutive-failure escalation, which
   * pages, rather than to a per-request check that would silently start
   * refusing users when a cron job stops.
   */
  async isFrozen(asset: AssetId): Promise<boolean> {
    const latest = await this.runs.findLatest(asset);
    return latest?.severity === ReconciliationSeverity.CRITICAL;
  }

  // ── The pass ─────────────────────────────────────────────────────────────

  private async run(
    asset: AssetId,
    decimals: number,
    startedAt: Date,
  ): Promise<ReconciliationReport> {
    // Control first. A vault balance read
    // from an address whose control has not been proven is not evidence of
    // anything, and it would look authoritative in the stored row forever.
    await this.vault.assertVaultControl(asset);

    const vault = await this.vault.getVaultAccount(asset);
    // `getVaultBalanceAt`, not `getVaultBalance`: the balance and the slot it
    // was true at come out of ONE round trip, so the row can never print two
    // moments as one. The proof-of-reserves page publishes both.
    const { balance: vaultBalance, slot: vaultSlot } = await this.vault.getVaultBalanceAt(asset);

    const journal = await this.entries.sumByEntryType(asset);
    const books = foldLiabilities(journal.totals);
    // What the vault must hold: rail-B redemptions already paid their
    // credits and fees out of the buyer's escrow. See `vaultLiabilities`.
    const liabilities = vaultLiabilities(books, await this.entries.sumPaidAtRedemption(asset));

    const snapshot = await this.balances.sumLiabilities(asset);
    const snapshotTotal = snapshot.available + snapshot.held + snapshot.pending;

    const vaultAtomic = MoneyUtil.toAtomic(vaultBalance);
    const difference = vaultAtomic - liabilities.total;

    const escrows = await this.walkEscrows(asset, decimals);
    // The vault IS the escrow contract, so what it holds beyond the buyer
    // escrows the walk read is value in no `buyer_escrows` row. Only known
    // when every escrow was read. The escrow's held payments (G3.B1): in the
    // contract, in no buyer balance.
    const totalHeld = await this.readTotalHeld(asset);
    const mirroredHeld = this.intents ? await this.intents.sumHeldOnChain(asset) : 0n;
    const outsideEscrows =
      escrows.unreadable === 0 ? vaultAtomic - escrows.total - (totalHeld ?? 0n) : null;

    const findings = [
      ...this.checkReserves(
        asset,
        decimals,
        vault,
        vaultAtomic,
        liabilities,
        difference,
        outsideEscrows,
      ),
      ...this.checkSnapshot(decimals, asset, books.total, snapshotTotal),
      ...this.checkBooks(decimals, asset, books),
      ...escrows.findings,
      ...this.checkHeld(asset, decimals, totalHeld, mirroredHeld),
    ];

    const finishedAt = new Date();

    return this.record({
      asset,
      decimals,
      severity: worstOf(findings),
      findings,
      vault,
      vaultBalance,
      vaultSlot,
      agentLiabilitiesAtomic: liabilities.agentLiabilities,
      openHoldsAtomic: liabilities.openHolds,
      providerPayableAtomic: liabilities.providerPayable,
      platformFeesAtomic: liabilities.platformFees,
      totalLiabilitiesAtomic: liabilities.total,
      snapshotLiabilitiesAtomic: snapshotTotal,
      differenceAtomic: difference,
      journalEntries: journal.entries,
      escrowTotalAtomic: escrows.total,
      escrowAccounts: escrows.read,
      escrowShortfallAccounts: escrows.shortfalls,
      startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    });
  }

  /** `totalHeld()`, or `null` when the escrow has no hold or it could not be read. */
  private async readTotalHeld(asset: AssetId): Promise<bigint | null> {
    if (!this.held) return null;
    try {
      return await this.held.totalHeld(asset);
    } catch (error) {
      this.logger.warn(`totalHeld() on ${asset} could not be read: ${(error as Error).message}`);
      return null;
    }
  }

  /** Check 6 (G3.B1): the escrow's `totalHeld()` against the calls mirrored as held. */
  private checkHeld(
    asset: AssetId,
    decimals: number,
    totalHeld: bigint | null,
    mirroredHeld: bigint,
  ): ReconciliationFinding[] {
    if (totalHeld === null || totalHeld === mirroredHeld) return [];
    return [
      {
        code: ReconciliationFindingCode.HELD_MIRROR_DRIFT,
        severity: ReconciliationSeverity.WARN,
        summary:
          `Held payments on ${asset}: the escrow holds ${format(totalHeld, decimals)}, the ` +
          `platform mirrors ${format(mirroredHeld, decimals)} as held — drift ` +
          `${format(totalHeld - mirroredHeld, decimals)}. Transient while a redemption, collect ` +
          `or refund is booked; persistent means a missed PaymentHeld, HeldCollected or ` +
          `HeldRefunded.`,
        details: {
          asset,
          totalHeld: totalHeld.toString(),
          mirroredHeld: mirroredHeld.toString(),
        },
      },
    ];
  }

  // ── Check 4 and 5: every buyer's own escrow ──────────────────────────────

  /**
   * Walks `buyer_escrows` a page at a time, reads each page from the chain in
   * batches, and folds the findings.
   *
   * **Keyset-paginated over Postgres, batched over the RPC.** The two page
   * sizes are different numbers for different reasons and neither is a policy
   * choice: `RECONCILIATION_ESCROW_PAGE` is how many mirror rows one query
   * carries, and `getMultipleAccounts`'s own 100-address limit is what bounds
   * the chain read underneath `readMany`. The second is the mitigation
   * that keeps failing closed affordable as buyers grow — without it this pass
   * is one RPC round trip per buyer, every five minutes, forever.
   *
   * **An escrow that could not be read is neither a shortfall nor silence.** It
   * is absent from the reading map, counted, and reported as a finding of its
   * own, because a pass that skipped unreadable accounts would report clean
   * while blind — the same argument `RECONCILIATION_BLIND` makes about the whole
   * run, one account at a time.
   */
  private async walkEscrows(asset: AssetId, decimals: number): Promise<EscrowWalk> {
    const findings: ReconciliationFinding[] = [];
    let total = 0n;
    let read = 0;
    let shortfalls = 0;
    let unreadable = 0;
    let after: string | null = null;

    for (;;) {
      const page: BuyerEscrowEntity[] = await this.escrows.listAll(
        asset,
        RECONCILIATION_ESCROW_PAGE,
        after,
      );
      if (page.length === 0) {
        break;
      }
      after = page[page.length - 1].id;

      const accounts = page.map((row) => row.accountId as AccountId);
      const readings = await this.escrowReader.readMany(accounts, asset);
      const mirror = await this.balances.sumByAccounts(asset, accounts);
      // Held payments (G3.B1) are out of the escrow balance but still in the
      // buyer's ledger hold: take them off both sides before comparing.
      const heldOnChain = this.intents
        ? await this.intents.sumHeldOnChainByAccounts(asset, accounts)
        : new Map<string, bigint>();

      for (const row of page) {
        const account = row.accountId as AccountId;
        const reading = readings.get(account);
        if (!reading) {
          unreadable += 1;
          continue;
        }

        read += 1;
        const chain = MoneyUtil.toAtomic(reading.balance);
        total += chain;

        const inHold = heldOnChain.get(account) ?? 0n;
        const held = (mirror.get(account)?.held ?? 0n) - inHold;
        // `pending` too: a deposit settled and awaiting finality is already in
        // the escrow on chain. Leaving it out paged drift for every deposit on
        // a chain whose finality lags (~20 minutes on eip155:46630).
        const mirrored =
          (mirror.get(account)?.available ?? 0n) + held + (mirror.get(account)?.pending ?? 0n);

        if (chain < held) {
          shortfalls += 1;
          findings.push(this.escrowShortfall(asset, decimals, account, row, chain, held));
        } else if (chain !== mirrored) {
          findings.push(this.escrowDrift(asset, decimals, account, chain, mirrored));
        }

        this.realignSeq(row, reading);
      }

      if (page.length < RECONCILIATION_ESCROW_PAGE) {
        break;
      }
    }

    if (unreadable > 0) {
      findings.push({
        code: ReconciliationFindingCode.RECONCILIATION_FAILED,
        severity: ReconciliationSeverity.WARN,
        summary:
          `${unreadable} buyer escrow${unreadable === 1 ? '' : 's'} on ${asset} could not be ` +
          `read this pass — either no escrow account exists at those seeds or the chain read ` +
          `failed. Their balances are unknown, not healthy.`,
        details: { asset, unreadableEscrows: unreadable, escrowsRead: read },
      });
    }

    return { findings, total, read, shortfalls, unreadable };
  }

  /**
   * Check 4: the buyer's escrow against what the platform has reserved from it.
   *
   * `CRITICAL`, unconditionally and with no tolerance, for the same reason
   * `RECONCILIATION_SHORTFALL_TOLERANCE_ATOMIC` is zero: this is money a hold
   * says is spoken for and the chain says is not there. Every redemption
   * standing behind those holds will fail with `EscrowInsufficient` — the
   * platform has served the calls and cannot collect.
   */
  private escrowShortfall(
    asset: AssetId,
    decimals: number,
    account: AccountId,
    row: BuyerEscrowEntity,
    chain: bigint,
    held: bigint,
  ): ReconciliationFinding {
    const short = held - chain;
    return {
      code: ReconciliationFindingCode.ESCROW_SHORTFALL,
      severity: ReconciliationSeverity.CRITICAL,
      summary:
        `ESCROW SHORTFALL on ${asset}: buyer ${account} holds ${format(chain, decimals)} in ` +
        `escrow ${row.escrowAccountId} but ${format(held, decimals)} is reserved against it — ` +
        `short by ${format(short, decimals)}. Every redemption behind those holds will fail with ` +
        `EscrowInsufficient; the calls are already served.`,
      // `account` by name, because "some escrow is short" is not actionable.
      details: {
        asset,
        account,
        escrowAccountId: row.escrowAccountId,
        escrowAssetAccountId: row.escrowAssetAccountId,
        chainBalance: chain.toString(),
        openHolds: held.toString(),
        shortfall: short.toString(),
      },
    };
  }

  /**
   * Check 5: the chain against the mirror, in either direction.
   *
   * `WARN`, not `CRITICAL`, and the asymmetry with check 4 is the same one
   * `checkReserves` already draws between a shortfall and a surplus: a shortfall
   * is money someone owns that is not there, while drift is a bookkeeping
   * question with the chain as the tiebreak.
   *
   * It is also **expected and transient** by construction. A rail-B hold is retired
   * on the redemption, not on the verdict, so between `redeem_voucher`
   * landing and its `HOLD_COMMIT` being written the chain is genuinely lower
   * than the mirror — on every pass, for as long as that gap lasts. Paging on it
   * would page on ordinary operation, which is why it carries the day-long WARN
   * suppression window and a per-account dedupe key.
   */
  private escrowDrift(
    asset: AssetId,
    decimals: number,
    account: AccountId,
    chain: bigint,
    mirrored: bigint,
  ): ReconciliationFinding {
    const drift = mirrored - chain;
    return {
      code: ReconciliationFindingCode.ESCROW_MIRROR_DRIFT,
      severity: ReconciliationSeverity.WARN,
      summary:
        `Escrow mirror drift on ${asset} for ${account}: the chain holds ` +
        `${format(chain, decimals)}, the mirror says ${format(mirrored, decimals)} ` +
        `(available + held + pending) — drift ${format(drift, decimals)}. Nobody's money is missing and ` +
        `the chain wins; a redemption that landed before its HOLD_COMMIT looks exactly like ` +
        `this until the commit is written.`,
      details: {
        asset,
        account,
        chainBalance: chain.toString(),
        mirrorBalance: mirrored.toString(),
        drift: drift.toString(),
      },
    };
  }

  /**
   * The voucher-sequence self-heal, and this is its only caller.
   *
   * A chain read reporting `seq_high >= next_seq` means the chain has already
   * redeemed a number the allocator is about to hand out — the signature of a
   * database restored from a backup taken before some of its vouchers were
   * redeemed. Re-issuing those numbers would mean the buyer signs, the call is
   * served, and the redemption dies `VoucherSeqNotIncreasing`: `seq_high` only
   * ever rises, so a re-issued number is refused for ever.
   *
   * Raising `next_seq` past `seq_high` costs nothing. The numbers in between
   * become holes, and the current program makes holes free and unbounded — there is no
   * bitmap and no forward-jump limit any more, only `seq > seq_high`.
   *
   * Fire-and-forget on purpose: the bump is idempotent (`WHERE next_seq < $3`),
   * a failure is logged rather than propagated, and a reconciliation pass must
   * not be aborted by a repair it attempted on the side. The WARN below is how
   * the operator hears about it.
   */
  private realignSeq(row: BuyerEscrowEntity, reading: EscrowChainBalance): void {
    const nextSeq = BigInt(row.nextSeq);
    if (reading.seqHigh < nextSeq) {
      return;
    }

    const target = reading.seqHigh + 1n;
    void this.escrows
      .bumpNextSeqTo(row.organizationId, row.accountId, target)
      .then((moved) => {
        if (moved > 0) {
          this.logger.warn(
            `escrow_seq_realigned: ${row.accountId} next_seq ${nextSeq} -> ${target} ` +
              `(chain seq_high ${reading.seqHigh}). The allocator was about to re-issue a ` +
              `sequence number the chain has already redeemed.`,
          );
        }
      })
      .catch((error: unknown) => {
        this.logger.error(
          `Could not realign next_seq for ${row.accountId} to ${target}: ${describe(error)}`,
        );
      });
  }

  // ── The rules ────────────────────────────────────────────────────────────

  /**
   * Check 1: the chain against the journal.
   *
   * The shortfall side has no tolerance, deliberately — see
   * `RECONCILIATION_SHORTFALL_TOLERANCE_ATOMIC`. The surplus side does,
   * because anyone can transfer into the vault ATA and a page that a stranger
   * can trigger is not a page.
   */
  private checkReserves(
    asset: AssetId,
    decimals: number,
    vault: AccountId,
    vaultAtomic: bigint,
    liabilities: LedgerLiabilities,
    difference: bigint,
    outsideEscrows: bigint | null = null,
  ): ReconciliationFinding[] {
    const details = {
      asset,
      vault,
      vaultBalance: vaultAtomic.toString(),
      agentLiabilities: liabilities.agentLiabilities.toString(),
      openHolds: liabilities.openHolds.toString(),
      providerPayable: liabilities.providerPayable.toString(),
      platformFees: liabilities.platformFees.toString(),
      totalLiabilities: liabilities.total.toString(),
      difference: difference.toString(),
    };

    if (difference < -RECONCILIATION_SHORTFALL_TOLERANCE_ATOMIC) {
      const shortfall = -difference;
      return [
        {
          code: ReconciliationFindingCode.RESERVES_BREACH,
          severity: ReconciliationSeverity.CRITICAL,
          summary:
            `PROOF OF RESERVES BREACH on ${asset}: vault ${vault} holds ` +
            `${format(vaultAtomic, decimals)} but the ledger owes ` +
            `${format(liabilities.total, decimals)} — short by ` +
            `${format(shortfall, decimals)} ` +
            `(agents ${format(liabilities.agentLiabilities, decimals)}, ` +
            `providers ${format(liabilities.providerPayable, decimals)}, ` +
            `platform ${format(liabilities.platformFees, decimals)}). ` +
            `Halt payouts and freeze withdrawals, and find the entry the vault does not back.`,
          details: { ...details, shortfall: shortfall.toString() },
        },
      ];
    }

    const tolerance = RECONCILIATION_SURPLUS_TOLERANCE_UNITS * 10n ** BigInt(decimals);
    if (difference > tolerance) {
      // Where it sits, when that is known: held by the escrow contract but in
      // no buyer escrow the platform mirrors (a direct deposit by a payer with
      // no `buyer_escrows` row looks exactly like this).
      const outside = outsideEscrows !== null && outsideEscrows > 0n ? outsideEscrows : null;
      return [
        {
          code: ReconciliationFindingCode.UNEXPLAINED_SURPLUS,
          severity: ReconciliationSeverity.WARN,
          summary:
            `Vault ${vault} holds ${format(difference, decimals)} more than the ledger ` +
            `accounts for on ${asset} — value arrived without a journal entry. ` +
            (outside === null
              ? `Check for an uncredited deposit before assuming it is a stray transfer.`
              : `${format(outside, decimals)} of the vault is outside every buyer escrow the ` +
                `platform mirrors: look for a Deposited event whose buyer has no buyer_escrows ` +
                `row before assuming it is a stray transfer.`),
          details: {
            ...details,
            surplus: difference.toString(),
            ...(outside === null ? {} : { outsideBuyerEscrows: outside.toString() }),
          },
        },
      ];
    }

    return [];
  }

  /**
   * Check 2: the journal against the snapshot it is supposed to define.
   *
   * `CRITICAL`, not `WARN`. A snapshot that disagrees with the journal means
   * every balance the hot path has read since the drift began was wrong — the
   * spend checks, the hold checks, the figure shown to the agent. The vault
   * may still cover the total, so check 1 can be perfectly clean while this
   * one is on fire, which is the whole reason it is a separate comparison.
   */
  private checkSnapshot(
    decimals: number,
    asset: AssetId,
    journalTotal: bigint,
    snapshotTotal: bigint,
  ): ReconciliationFinding[] {
    if (journalTotal === snapshotTotal) {
      return [];
    }

    const drift = snapshotTotal - journalTotal;
    return [
      {
        code: ReconciliationFindingCode.SNAPSHOT_DRIFT,
        severity: ReconciliationSeverity.CRITICAL,
        summary:
          `Balance snapshot disagrees with the journal on ${asset}: snapshot totals ` +
          `${format(snapshotTotal, decimals)}, the journal folds to ` +
          `${format(journalTotal, decimals)} — drift ${format(drift, decimals)}. ` +
          `Every balance read since the drift began was wrong; the journal is authoritative.`,
        details: {
          asset,
          journalTotal: journalTotal.toString(),
          snapshotTotal: snapshotTotal.toString(),
          drift: drift.toString(),
        },
      },
    ];
  }

  /**
   * Check 3: no book may be negative.
   *
   * A negative provider payable means more was paid out than was ever
   * credited; a negative agent book means more was withdrawn than deposited.
   * Both are impossible through the ledger's own guards — every debit path
   * checks the bucket under a row lock and Postgres has a CHECK constraint
   * underneath — so a negative total here means a write that bypassed both.
   * It is also the one class of error that can hide inside a healthy
   * inequality: one book far negative and another far positive sum to a total
   * the vault still covers.
   */
  private checkBooks(
    decimals: number,
    asset: AssetId,
    liabilities: LedgerLiabilities,
  ): ReconciliationFinding[] {
    const books: readonly [string, bigint][] = [
      ['agentLiabilities', liabilities.agentLiabilities],
      ['openHolds', liabilities.openHolds],
      ['providerPayable', liabilities.providerPayable],
      ['platformFees', liabilities.platformFees],
    ];

    return books
      .filter(([, value]) => value < 0n)
      .map(([book, value]) => ({
        code: ReconciliationFindingCode.NEGATIVE_BOOK,
        severity: ReconciliationSeverity.CRITICAL,
        summary:
          `Ledger book "${book}" folded to ${format(value, decimals)} on ${asset} — ` +
          `more has left this book than ever entered it. A write bypassed the ledger's ` +
          `own balance guards.`,
        details: { asset, book, total: value.toString() },
      }));
  }

  // ── Recording and alerting ───────────────────────────────────────────────

  /**
   * Writes the row, then alerts.
   *
   * That order is load bearing. The row is the durable record; the alert is a
   * best-effort message to a human. Alerting first and crashing before the
   * insert would page someone about a run with no evidence behind it, and the
   * next pass — five minutes later — would page again with the same absence.
   */
  private async record(
    input: Omit<ReconciliationReport, 'id' | 'alerted'>,
  ): Promise<ReconciliationReport> {
    const row = await this.persist(input);
    const alerted = await this.raise(input.findings);

    if (alerted && row.id) {
      // Best effort. A failure to flip the flag must not lose the run, and the
      // findings on the row already say the run was not clean.
      await this.runs
        .update({ id: row.id }, { alerted: true })
        .catch((error: unknown) =>
          this.logger.error(`Could not mark run ${row.id} as alerted: ${describe(error)}`),
        );
    }

    if (input.findings.length === 0) {
      // Deliberately `debug`, and deliberately not an alert: a clean run is
      // the expected state and 288 reassurances a day is how a channel stops
      // being read. The row in `reconciliation_runs` is the record that it
      // happened.
      this.logger.debug(
        `Reconciliation clean on ${input.asset}: vault ` +
          `${input.vaultBalance ? MoneyUtil.format(input.vaultBalance) : 'unknown'} covers ` +
          `${atomicOrUnknown(input.totalLiabilitiesAtomic, input.decimals)} across ` +
          `${input.journalEntries} journal entries`,
      );
    }

    return { ...input, id: row.id, alerted };
  }

  private async persist(
    input: Omit<ReconciliationReport, 'id' | 'alerted'>,
  ): Promise<ReconciliationRunEntity> {
    const row = this.runs.create({
      assetId: input.asset,
      decimals: input.decimals,
      vaultAccount: input.vault,
      vaultBalance: input.vaultBalance?.amount ?? null,
      vaultSlot: input.vaultSlot === null ? null : String(input.vaultSlot),
      agentLiabilities: nullableAtomic(input.agentLiabilitiesAtomic),
      openHolds: nullableAtomic(input.openHoldsAtomic),
      providerPayable: nullableAtomic(input.providerPayableAtomic),
      platformFees: nullableAtomic(input.platformFeesAtomic),
      totalLiabilities: nullableAtomic(input.totalLiabilitiesAtomic),
      snapshotLiabilities: nullableAtomic(input.snapshotLiabilitiesAtomic),
      difference: nullableAtomic(input.differenceAtomic),
      escrowTotal: nullableAtomic(input.escrowTotalAtomic),
      escrowAccounts: input.escrowAccounts,
      escrowShortfallAccounts: input.escrowShortfallAccounts,
      severity: input.severity,
      findings: input.findings,
      alerted: false,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      durationMs: input.durationMs,
    });

    return this.runs.save(row);
  }

  /** @returns whether anything was emitted. `false` only for a clean run. */
  private async raise(findings: readonly ReconciliationFinding[]): Promise<boolean> {
    if (findings.length === 0) {
      return false;
    }

    for (const finding of findings) {
      await this.alerts
        .emit({
          severity: toAlertSeverity(finding.severity),
          name: alertNameOf(finding.code),
          summary: finding.summary,
          details: finding.details,
          // Otherwise an unresolved finding pages again every 5-minute pass
          // for as long as it stays open. The book/asset pair is the grain:
          // two different books breaching at once are two incidents.
          aggregation: AlertAggregation.ONCE_PER_INCIDENT,
          dedupeKey: dedupeKeyOf(finding),
          suppressionWindowSeconds: suppressionWindowOf(finding.severity),
        })
        .catch((error: unknown) => {
          // The sink failing must not swallow the finding. This line is the
          // last resort and carries the whole summary, numbers included.
          this.logger.error(
            `Alert sink refused ${finding.code} (${describe(error)}): ${finding.summary}`,
          );
        });
    }

    return true;
  }

  /**
   * The pass could not complete.
   *
   * Recorded as a run rather than dropped, because "the reconciler could not
   * read the chain" and "the reconciler is not running" look identical in an
   * empty table, and only one of them is survivable. Escalates to `CRITICAL`
   * once enough consecutive passes have failed that nobody has actually
   * checked the money for a meaningful stretch of time.
   */
  private async recordFailure(
    asset: AssetId,
    startedAt: Date,
    error: unknown,
  ): Promise<ReconciliationReport> {
    const consecutive = (await this.countRecentFailures(asset)) + 1;
    const blind = consecutive >= RECONCILIATION_MAX_CONSECUTIVE_FAILURES;

    const finding: ReconciliationFinding = blind
      ? {
          code: ReconciliationFindingCode.RECONCILIATION_BLIND,
          severity: ReconciliationSeverity.CRITICAL,
          summary:
            `Reconciliation has failed ${consecutive} consecutive times on ${asset} — ` +
            `nobody has verified the vault against the ledger for at least ` +
            `${consecutive * 5} minutes. Last error: ${describe(error)}`,
          details: { asset, consecutiveFailures: consecutive, error: describe(error) },
        }
      : {
          code: ReconciliationFindingCode.RECONCILIATION_FAILED,
          severity: ReconciliationSeverity.WARN,
          summary:
            `Reconciliation pass on ${asset} could not complete: ${describe(error)}. ` +
            `The figures are unknown, not healthy.`,
          details: { asset, consecutiveFailures: consecutive, error: describe(error) },
        };

    const finishedAt = new Date();

    return this.record({
      asset,
      decimals: getAssetMetadata(asset).decimals,
      severity: finding.severity,
      findings: [finding],
      vault: null,
      vaultBalance: null,
      // A read that failed has no slot. `null`, never `0` — slot 0 is a real
      // slot, and printing it would be a claim about the genesis block.
      vaultSlot: null,
      agentLiabilitiesAtomic: null,
      openHoldsAtomic: null,
      providerPayableAtomic: null,
      platformFeesAtomic: null,
      totalLiabilitiesAtomic: null,
      snapshotLiabilitiesAtomic: null,
      differenceAtomic: null,
      journalEntries: 0,
      escrowTotalAtomic: null,
      escrowAccounts: null,
      escrowShortfallAccounts: null,
      startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    }).catch((persistError: unknown) => {
      // The database is the thing that failed, most likely. Nothing left but
      // to shout, and shouting is still better than returning quietly.
      this.logger.error(
        `Reconciliation on ${asset} failed (${describe(error)}) and the failure could not ` +
          `be recorded either (${describe(persistError)})`,
      );
      return {
        id: '',
        asset,
        decimals: getAssetMetadata(asset).decimals,
        severity: finding.severity,
        findings: [finding],
        alerted: false,
        vault: null,
        vaultBalance: null,
        vaultSlot: null,
        agentLiabilitiesAtomic: null,
        openHoldsAtomic: null,
        providerPayableAtomic: null,
        platformFeesAtomic: null,
        totalLiabilitiesAtomic: null,
        snapshotLiabilitiesAtomic: null,
        differenceAtomic: null,
        journalEntries: 0,
        escrowTotalAtomic: null,
        escrowAccounts: null,
        escrowShortfallAccounts: null,
        startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      } satisfies ReconciliationReport;
    });
  }

  /** How many of the most recent runs failed, counting back from the newest. */
  private async countRecentFailures(asset: AssetId): Promise<number> {
    const recent = await this.runs
      .findRecent(asset, RECONCILIATION_MAX_CONSECUTIVE_FAILURES)
      .catch(() => [] as ReconciliationRunEntity[]);

    let consecutive = 0;
    for (const run of recent) {
      if (!isFailure(run)) {
        break;
      }
      consecutive += 1;
    }
    return consecutive;
  }
}

/** What one full walk of `buyer_escrows` produced. */
interface EscrowWalk {
  readonly findings: readonly ReconciliationFinding[];
  /** `Σ` over every escrow ATA that could be read. */
  readonly total: bigint;
  /** How many were read — never how many rows exist, which is a different number. */
  readonly read: number;
  readonly shortfalls: number;
  /** Rows whose escrow could not be read — `total` is then a lower bound. */
  readonly unreadable: number;
}

/** A run with no figures is a run that could not complete. */
function isFailure(run: ReconciliationRunEntity): boolean {
  return run.vaultBalance === null || run.totalLiabilities === null;
}

function worstOf(findings: readonly ReconciliationFinding[]): ReconciliationSeverity {
  if (findings.some((f) => f.severity === ReconciliationSeverity.CRITICAL)) {
    return ReconciliationSeverity.CRITICAL;
  }
  if (findings.some((f) => f.severity === ReconciliationSeverity.WARN)) {
    return ReconciliationSeverity.WARN;
  }
  return ReconciliationSeverity.OK;
}

function toAlertSeverity(severity: ReconciliationSeverity): AlertSeverity {
  switch (severity) {
    case ReconciliationSeverity.CRITICAL:
      return AlertSeverity.CRITICAL;
    case ReconciliationSeverity.WARN:
      return AlertSeverity.WARN;
    default:
      return AlertSeverity.INFO;
  }
}

function alertNameOf(code: ReconciliationFindingCode): string {
  switch (code) {
    case ReconciliationFindingCode.RESERVES_BREACH:
      return RECONCILIATION_ALERTS.RESERVES_BREACH;
    case ReconciliationFindingCode.UNEXPLAINED_SURPLUS:
      return RECONCILIATION_ALERTS.UNEXPLAINED_SURPLUS;
    case ReconciliationFindingCode.SNAPSHOT_DRIFT:
      return RECONCILIATION_ALERTS.SNAPSHOT_DRIFT;
    case ReconciliationFindingCode.NEGATIVE_BOOK:
      return RECONCILIATION_ALERTS.NEGATIVE_BOOK;
    case ReconciliationFindingCode.ESCROW_SHORTFALL:
      return RECONCILIATION_ALERTS.ESCROW_SHORTFALL;
    case ReconciliationFindingCode.ESCROW_MIRROR_DRIFT:
      return RECONCILIATION_ALERTS.ESCROW_MIRROR_DRIFT;
    case ReconciliationFindingCode.RECONCILIATION_BLIND:
      return RECONCILIATION_ALERTS.RECONCILIATION_BLIND;
    default:
      return RECONCILIATION_ALERTS.RECONCILIATION_FAILED;
  }
}

/**
 * The suppression grain within one alert `name`: `details.asset` alone for most
 * codes, plus `details.book` for `NEGATIVE_BOOK` (two books on one asset going
 * negative at once are two incidents, not one) and `details.account` for the two
 * per-buyer escrow findings (`${asset}:${account}` — one buyer's drift must not
 * suppress another buyer's shortfall).
 * Falls back to `'unknown'` rather than throwing — a finding whose `details`
 * happens to omit these keys must still page, just without a useful grain.
 */
function dedupeKeyOf(finding: ReconciliationFinding): string {
  const asset = finding.details.asset ?? 'unknown';
  const grain = finding.details.book ?? finding.details.account;
  return grain === undefined ? `${asset}` : `${asset}:${grain}`;
}

/**
 * How long this finding stays quiet after paging.
 *
 * `undefined` for `CRITICAL` — the sink's own default hour — and a day for
 * everything else. See `RECONCILIATION_WARN_ALERT_WINDOW_SECONDS` for why the
 * two severities deserve different cadences rather than different channels.
 */
function suppressionWindowOf(severity: ReconciliationSeverity): number | undefined {
  return severity === ReconciliationSeverity.CRITICAL
    ? undefined
    : RECONCILIATION_WARN_ALERT_WINDOW_SECONDS;
}

/** Display only — atomic units rendered at the asset's scale. */
function format(atomic: bigint, decimals: number): string {
  const negative = atomic < 0n;
  const digits = (negative ? -atomic : atomic).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? '' : `.${digits.slice(digits.length - decimals)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

function nullableAtomic(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

function atomicOrUnknown(value: bigint | null, decimals: number): string {
  return value === null ? 'unknown' : format(value, decimals);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
