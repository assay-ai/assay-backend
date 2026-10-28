import { Injectable, Logger } from '@nestjs/common';

import { DepositIntentRepository } from '@database/postgres/repositories/deposit-intent.repository';
import { isRegisteredAsset } from '@modules/chains/ports/asset-registry';
import { AccountId, AssetId, chainIdOf, isAccountId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { DepositIntentStatus } from '@modules/payment/ports/deposit.types';
import { ApiErrors } from '@shared/api';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  GetBalancesResponseDto,
  MoneyDto,
  WithheldReconciliationDto,
} from '../dto/get-balances.dto';
import { WithheldPeriod, WithheldReconciliation, WithheldTotal } from '../domain/withheld';
import { AccountBalance } from '../ports/ledger.types';
import { EscrowSpendGateService, Spendable } from './escrow-spend-gate.service';
import { LedgerService } from './ledger.service';
import { LedgerWithheldService } from './ledger-withheld.service';

/**
 * The rows this organization actually owns — everything addressed by a real
 * CAIP-10 account, and none of `INTERNAL_ACCOUNTS`.
 *
 * ## Why an organization has rows it does not own
 *
 * `LedgerHoldService.commitHoldAndCredit` prepares the `PLATFORM_FEE` entry
 * under the **paying** organization's id (the provider credit beside it
 * correctly uses `credit.providerOrganizationId`), so `platform:fees` is
 * written into the books of every organization that has ever paid for a call.
 * That is a deliberate consequence of writing both legs under one lock in one
 * transaction, and `ledger-book.ts` keeps `platformFees` as a book distinct
 * from `agentLiabilities` — it is the platform's money, sitting in a row keyed
 * by the customer who generated it.
 *
 * ## Why filtering here rather than in `listBalances`
 *
 * `LedgerPort.listBalances` means "every row for this organization" and the
 * reconciler needs it to keep meaning that — `total_liabilities` is the sum of
 * all three books and would understate the vault's obligation without the
 * platform's. This class is the customer-facing boundary, and the only one:
 * `getBalances` and `getWithheld` are its two consumers.
 *
 * ## What it prevents
 *
 * `AccountBalanceDto` used to carry **no account id**, so two rows for one asset
 * were indistinguishable on the wire. A client could not tell which row was its
 * own; one that took the first got whichever the database ordered first, and one
 * that summed them reported money the organization cannot spend. The end-to-end
 * acceptance suite hit this the first time a paid call settled on rail A.
 * Multichain support closes it: every row now carries its `accountId` and its
 * `chainId`, and balances are a list, never a sum — no field spans rows — see
 * `test/unit/ledger/balances-per-chain.spec.ts`.
 * Filtering here is still what keeps `platform:fees` out of that list.
 *
 * `isAccountId` is the discriminator `LedgerJournalService.notifyBalanceCrossings`
 * already uses to decide the same question — an internal account has no
 * organization to speak to — so the two agree by construction.
 */
function ownAccountsOnly(balances: readonly AccountBalance[]): AccountBalance[] {
  return balances.filter((balance) => isAccountId(balance.accountId));
}

/** One asset's `Σ requested_amount` over deposit intents still in flight. */
interface PendingDepositTotal {
  readonly assetId: string;
  readonly decimals: number;
  readonly amount: string;
}

/**
 * Deposit intents that have been sent but have not yet landed on chain — see
 * `AccountBalanceDto.pendingDeposits`.
 *
 * **Only `SETTLING` counts.** A `CREATED` intent is a quote the buyer may never
 * sign (declined wallet prompt, closed tab): no transfer was submitted, so no
 * money is in flight, and it would stay counted until the expiry sweep. The
 * `CREATED -> SETTLING` step is taken when the client submits its payload, so
 * `SETTLING` is exactly "a transfer is known". It is deliberately *not*
 * bounded by `expiresAt`: settlement is already in flight and the transaction
 * may have landed. `expiresAt` stops a new payload being accepted
 * (`DepositService.settleDeposit`), it does not mean the money is gone.
 */
const PENDING_DEPOSIT_PREDICATE = 'intent.status = :settling';

/**
 * `GET /balances` — the account's balances, and the `withheld` figure
 * with the reconciliation that makes it checkable rather than claimed.
 *
 * A thin composition over the two services that own the halves of the answer,
 * kept separate from both because `LedgerService` is `LedgerPort` — the
 * contract every other domain talks to — and DTO shaping belongs to the one
 * caller that renders HTTP, not to the facade every domain shares.
 *
 * `LedgerWithheldService` is injected directly rather than reached through
 * `LedgerService`: it joins the journal against `payment_intents`, and routing
 * that through the ledger facade would put a cross-domain reporting query in
 * the contract every money-moving caller depends on.
 *
 * **Which assets get a `withheld` entry.** Every asset that appears in
 * `listBalances`. This is a deliberate simplification rather than a second
 * distinct-assets query: `HOLD_RELEASE` can only exist for an asset that has
 * already had `HOLD_CREATE` written against it, and `AccountBalanceRepository.
 * ensureRows` materialises a zero snapshot row the first time any entry is
 * written for an `(account, asset)` pair — so an asset with withheld activity
 * and *no* balance row is not a reachable state. If that assumption ever
 * breaks, this method under-reports rather than errors, which is the
 * direction a dashboard should fail in.
 */
@Injectable()
export class BalancesService {
  private readonly logger = new Logger(BalancesService.name);

  constructor(
    private readonly ledger: LedgerService,
    private readonly withheld: LedgerWithheldService,
    private readonly deposits: DepositIntentRepository,
    private readonly escrowGate: EscrowSpendGateService,
  ) {}

  async getBalances(organizationId: string): Promise<GetBalancesResponseDto> {
    const balances = ownAccountsOnly(await this.ledger.listBalances(organizationId));
    const assets = scalesByAsset(balances);

    const [withheld, pendingByAsset, chainByAccount] = await Promise.all([
      this.withheld.reconcileAssets(
        organizationId,
        [...assets].map(([asset, decimals]) => ({ asset, decimals })),
      ),
      this.pendingDepositsByAsset(organizationId),
      this.chainFiguresFor(organizationId, balances),
    ]);

    return {
      balances: balances.map((balance) =>
        toBalanceDto(
          balance,
          pendingByAsset,
          chainByAccount.get(chainKey(balance)) ?? UNREAD_CHAIN,
        ),
      ),
      withheld: withheld.map(toReconciliationDto),
    };
  }

  /**
   * The chain figure per `(account, asset)`, reported alongside the
   * ledger mirror. Purely informational here: `GET /balances` never gates on
   * `ESCROW_SPEND_GATE_ENABLED`, because showing a buyer their real escrow
   * balance is useful whether or not the platform is spending against it yet.
   *
   * A chain read that fails (or is stale past the ceiling) reports
   * `readable: false` for that account rather than failing the whole endpoint
   * — one unreadable escrow must not take down a balances page that also
   * lists five others.
   *
   * **`readable` is why the map carries a wrapper rather than a bare
   * `Spendable | null`.** The port answers `null` for an account with no
   * escrow yet, and the `catch` produced the same `null` for an account it
   * could not read — so the wire could not tell "you have not deposited"
   * from "we could not look", and both rendered as a blank where a buyer
   * reads zero. The two are now `chainReadable: true` with null figures and
   * `chainReadable: false` respectively.
   */
  private async chainFiguresFor(
    organizationId: string,
    balances: readonly AccountBalance[],
  ): Promise<Map<string, ChainFigures>> {
    const result = new Map<string, ChainFigures>();

    await Promise.all(
      balances.map(async (balance) => {
        try {
          const spendable = await this.escrowGate.spendable(
            organizationId,
            balance.accountId as AccountId,
            balance.asset,
          );
          result.set(chainKey(balance), { figures: spendable, readable: true });
        } catch (error) {
          this.logger.warn(
            `Could not read the on-chain escrow for ${balance.accountId}/${balance.asset}: ${describe(error)}`,
          );
          result.set(chainKey(balance), UNREAD_CHAIN);
        }
      }),
    );

    return result;
  }

  /**
   * `withheld` alone, decomposed and windowed by `from`/`to`.
   *
   * Delegates entirely to `LedgerWithheldService.reconcile`; this method's only
   * job is picking which assets to reconcile, the same way `getBalances` does —
   * see the class comment for why that is "every asset with a balance" rather
   * than a second distinct-assets query.
   */
  async getWithheld(
    organizationId: string,
    period: WithheldPeriod = {},
  ): Promise<WithheldReconciliationDto[]> {
    if (period.from && period.to && period.from >= period.to) {
      throw ApiErrors.invalidTimeRange({
        from: period.from.toISOString(),
        to: period.to.toISOString(),
      });
    }

    const balances = ownAccountsOnly(await this.ledger.listBalances(organizationId));

    const withheld = await this.withheld.reconcileAssets(
      organizationId,
      [...scalesByAsset(balances)].map(([asset, decimals]) => ({ asset, decimals })),
      period,
    );

    return withheld.map(toReconciliationDto);
  }

  /**
   * `Σ requestedAmount` per asset over deposit intents still in flight — money
   * that has not yet reached the ledger at all (contrast the `pending` bucket
   * on `AccountBalance`, which is money the ledger has already observed on
   * chain but not yet finalised).
   *
   * "In flight" is `PENDING_DEPOSIT_PREDICATE`: a transfer was submitted
   * (`SETTLING`); an unsigned `CREATED` intent is not counted.
   */
  private async pendingDepositsByAsset(
    organizationId: string,
  ): Promise<Map<string, PendingDepositTotal>> {
    const rows = await this.deposits
      .createQueryBuilder('intent')
      .select('intent.assetId', 'assetId')
      .addSelect('intent.decimals', 'decimals')
      .addSelect('COALESCE(SUM(intent.requestedAmount), 0)', 'amount')
      .where('intent.organizationId = :organizationId', { organizationId })
      .andWhere(PENDING_DEPOSIT_PREDICATE, {
        settling: DepositIntentStatus.SETTLING,
      })
      .groupBy('intent.assetId')
      .addGroupBy('intent.decimals')
      .getRawMany<PendingDepositTotal>();

    return new Map(rows.map((row) => [row.assetId, row]));
  }
}

/**
 * The chain half of one row, and whether it was read at all.
 *
 * `figures: null, readable: true` is the chain answering that this account has
 * no escrow yet. `readable: false` is this platform not having asked
 * successfully. See {@link BalancesService.chainFiguresFor}.
 */
interface ChainFigures {
  readonly figures: Spendable | null;
  readonly readable: boolean;
}

const UNREAD_CHAIN: ChainFigures = { figures: null, readable: false };

/**
 * Every distinct asset in these rows, each with the scale the ledger itself
 * quotes it in — in first-seen order, so the `withheld` list keeps the order
 * the balances have.
 *
 * The scale comes off the row rather than out of the asset registry because
 * the registry only knows the assets this platform settles **today**, and a
 * ledger row in a retired token is exactly the case that used to fail: one
 * such row made `getAssetMetadata` throw `CHAIN_ASSET_UNKNOWN` and answered
 * `400` for the entire response, so an organization holding one historical
 * row saw none of its balances. Balances are a list; a
 * list that refuses to be printed because one entry is unfamiliar is not one.
 */
function scalesByAsset(balances: readonly AccountBalance[]): Map<AssetId, number> {
  const scales = new Map<AssetId, number>();
  for (const balance of balances) {
    if (!scales.has(balance.asset)) {
      scales.set(balance.asset, balance.decimals);
    }
  }
  return scales;
}

function toMoneyDto(money: Money): MoneyDto {
  return { amount: money.amount, asset: money.asset, decimals: money.decimals };
}

/** `(account, asset)` — how `chainFiguresFor`'s map is keyed and read back. */
function chainKey(balance: Pick<AccountBalance, 'accountId' | 'asset'>): string {
  return `${balance.accountId}:${balance.asset}`;
}

function toBalanceDto(
  balance: AccountBalance,
  pendingByAsset: Map<string, PendingDepositTotal>,
  chain: ChainFigures,
) {
  const pending = pendingByAsset.get(balance.asset);
  const pendingDeposits = pending
    ? MoneyUtil.of(pending.amount, balance.asset as AssetId, pending.decimals)
    : MoneyUtil.zero(balance.asset as AssetId, balance.decimals);

  return {
    // The row names its own chain, read off THIS row's account. Two
    // chains are two rows and nothing on the wire spans them; a client no
    // longer has to parse CAIP out of the asset string to know which chain a
    // row is, and two rows for one asset are no longer indistinguishable (the
    // defect this class's comment describes).
    chainId: chainIdOf(balance.accountId as AccountId),
    accountId: balance.accountId,
    asset: balance.asset,
    decimals: balance.decimals,
    available: toMoneyDto(balance.available),
    held: toMoneyDto(balance.held),
    pending: toMoneyDto(balance.pending),
    total: toMoneyDto(balance.total),
    pendingDeposits: toMoneyDto(pendingDeposits),
    // `null`, never zero, when the chain could not be read; see the
    // DTO's own doc comments.
    chainBalance: chain.figures ? toMoneyDto(chain.figures.chain) : null,
    spendable: chain.figures ? toMoneyDto(chain.figures.spendable) : null,
    // The chain figure, not `available` — `withdraw()` pays
    // `min(requested, escrow_ata.amount)`, so that is the number a withdrawal
    // actually respects. A promotional/card-restricted split still has
    // no column, so nothing narrower is subtracted from it.
    withdrawable: chain.figures ? toMoneyDto(chain.figures.chain) : null,
    // Which of the three nulls above this row is carrying. See the DTO.
    chainReadable: chain.readable,
    // Whether this platform has metadata (symbol, peg) for the row's asset.
    // False does NOT make the row's own figures less real: they are ledger
    // facts quoted at the ledger's own scale, and they are reported.
    assetKnown: isRegisteredAsset(balance.asset),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toWithheldTotalDto(total: WithheldTotal) {
  return {
    asset: total.asset,
    calls: total.calls,
    amount: toMoneyDto(total.amount),
    buckets: total.buckets.map((bucket) => ({
      bucket: bucket.bucket,
      label: bucket.label,
      calls: bucket.calls,
      amount: toMoneyDto(bucket.amount),
    })),
  };
}

function toReconciliationDto(reconciliation: WithheldReconciliation): WithheldReconciliationDto {
  return {
    withheld: toWithheldTotalDto(reconciliation.withheld),
    holdReleaseTotal: toMoneyDto(reconciliation.holdReleaseTotal),
    orphanedReleases: toMoneyDto(reconciliation.orphanedReleases),
    orphanedHoldIds: [...reconciliation.orphanedHoldIds],
    orphanedHoldCount: reconciliation.orphanedHoldCount,
    settlementRemainders: toMoneyDto(reconciliation.settlementRemainders),
    ok: reconciliation.ok,
    difference: reconciliation.difference,
  };
}
