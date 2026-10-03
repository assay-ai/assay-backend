import { ReconciliationRunEntity } from '@database/postgres/entities/reconciliation-run.entity';
import { StakeSnapshotEntity } from '@database/postgres/entities/stake-snapshot.entity';
import { AssetId, ChainId, chainIdOf } from '@modules/chains/ports/caip.types';

import { ReconciliationFindingCode, ReconciliationSeverity } from '../ports/reconciliation.types';

/**
 * The payload behind the public `/reserves` page, assembled from plain
 * rows.
 *
 * **Pure on purpose.** Every rule that matters on this page is a decision about
 * what to say when a figure is missing, stale or negative, and those are the
 * cases that must be tested — without a database, without Nest, without a
 * chain. `PublicReservesService` reads three things and hands them here; it
 * does no thinking, so there is nowhere else for a rule to hide.
 *
 * The page makes claims about somebody's money to an audience with no account
 * and no other source. So the governing rule throughout is: **say less rather
 * than say something that is not known.** `$0.00` is an assertion; absence is
 * not.
 */

export enum PublicReservesState {
  /** A reconciliation ran and its figures are the ones shown. */
  NORMAL = 'NORMAL',
  /** No run has ever completed on this deployment. Not zero — unknown. */
  NO_RECONCILIATION = 'NO_RECONCILIATION',
  /**
   * The last run could not read the chain, so there is nothing current to
   * publish. Showing the previous run's numbers without saying so would be
   * asserting a reconciliation that did not happen.
   */
  LAST_CHECK_FAILED = 'LAST_CHECK_FAILED',
}

/** One row of the "Reconciliation history" panel. */
export interface PublicReservesHistoryRow {
  readonly checkedAt: Date;
  readonly vaultBalance: string | null;
  readonly totalLiabilities: string | null;
  readonly difference: string | null;
  readonly vaultSlot: string | null;
  /**
   * The run could not read the chain. Kept in the list rather than filtered
   * out: "a non-zero difference is a public incident, not a private one", and a
   * check that could not run at all is the same kind of fact.
   */
  readonly failed: boolean;
}

/** The fleet's bonded stake, carrying the time IT was read. */
export interface PublicReservesStake {
  readonly bondedTotal: string;
  readonly decimals: number;
  readonly asset: string;
  readonly providerCount: number;
  /**
   * **Not** `reconciledAt`. The snapshot comes off a different cron than the
   * reconciliation, which is the entire reason it has its own table; a page
   * that printed one timestamp for both would re-assert the simultaneity that
   * separation exists to deny.
   */
  readonly readAt: Date;
}

/**
 * One chain's panel.
 *
 * Named `PublicReservesChain` rather than `PublicReserves` because it is not
 * the page: it is one of the page's rows, and balances are a list, never a
 * sum.
 */
export interface PublicReservesChain {
  /** CAIP-2, printed as-is. The panel says which network it is about. */
  readonly chainId: ChainId;
  readonly asset: AssetId;
  /**
   * `USDC`, from the asset registry — what the page prints before the
   * mint. `null` when the configured asset is not in the registry, which the
   * page then renders as the bare mint rather than inventing a ticker.
   */
  readonly assetSymbol: string | null;
  readonly state: PublicReservesState;
  readonly decimals: number | null;
  readonly vaultAccount: string | null;
  readonly vaultBalance: string | null;
  readonly totalLiabilities: string | null;
  /** Signed. A surplus and a shortfall are different events. */
  readonly difference: string | null;
  readonly accounts: number | null;
  /** `null` for every row written before the proof-of-reserves migration. Never invented. */
  readonly vaultSlot: string | null;
  readonly reconciledAt: Date | null;
  /**
   * The fleet stake snapshot, and **only on the chain it was read from**.
   *
   * There is one `stake_snapshots` table and one sweep, and the sweep reads the
   * Solana settlement program. Repeating that figure under every panel would
   * say that Solana's bonded stake backs a liability on 46630, which is exactly
   * the cross-chain claim this page refuses to make. Every other chain therefore
   * carries `null` — absence, not zero — until a sweep exists for it.
   */
  readonly stake: PublicReservesStake | null;
  readonly history: readonly PublicReservesHistoryRow[];
}

/**
 * A LIST, never a total.
 *
 * A single "total reserves" figure across two chains is a number nobody can act
 * on: money on 46630 does not back a liability on Solana, and a page showing one
 * chain 5 % over and the other 5 % short as "balanced" would be asserting
 * exactly the thing the chains' independence exists to deny. Worse, the fold is
 * not observable as wrong until the second chain diverges, which is the first
 * moment anybody needs the page.
 *
 * So the page renders one panel per chain, each with its own state, its own
 * timestamp and its own slot, and a reader who wants a sum computes it
 * themselves and owns the assumption.
 *
 * **This interface has one field and must keep having one field.**
 * `test/unit/settlement/public-reserves.spec.ts` asserts `Object.keys` on the
 * payload for that reason: a total that is only ever rendered correctly today
 * is a total somebody will read tomorrow.
 */
export interface PublicReserves {
  readonly chains: readonly PublicReservesChain[];
}

export interface PublicReservesChainInput {
  readonly chainId: ChainId;
  readonly asset: AssetId;
  readonly run: ReconciliationRunEntity | null;
  /** Resolved by the caller — the registry lives behind the `chains/` boundary. */
  readonly assetSymbol: string | null;
  /** The one fleet snapshot, or `null`. Filtered onto its own chain below. */
  readonly stake: StakeSnapshotEntity | null;
  readonly accounts: number;
  readonly history: readonly ReconciliationRunEntity[];
}

/** The page: one panel per chain, in the order the caller supplied. */
export function buildPublicReserves(chains: readonly PublicReservesChainInput[]): PublicReserves {
  return { chains: chains.map(buildPublicReservesChain) };
}

export function buildPublicReservesChain(input: PublicReservesChainInput): PublicReservesChain {
  // Only on its own chain — see `PublicReservesChain.stake`.
  const onThisChain =
    input.stake !== null && chainIdOf(input.stake.stakeAsset as AssetId) === input.chainId;
  const stake =
    onThisChain && input.stake
      ? {
          bondedTotal: input.stake.bondedTotal,
          decimals: input.stake.decimals,
          asset: input.stake.stakeAsset,
          providerCount: input.stake.providerCount,
          readAt: input.stake.readAt,
        }
      : null;

  const history = input.history.map(toHistoryRow);

  if (!input.run) {
    return {
      chainId: input.chainId,
      // The asset and the chain are known even with no run: they are what this
      // deployment is CONFIGURED to publish, not something a run reported. A
      // panel that could not name its own network would be unreadable beside
      // another panel.
      asset: input.asset,
      state: PublicReservesState.NO_RECONCILIATION,
      assetSymbol: input.assetSymbol,
      decimals: null,
      vaultAccount: null,
      vaultBalance: null,
      totalLiabilities: null,
      difference: null,
      accounts: null,
      vaultSlot: null,
      reconciledAt: null,
      // Stake and history are real readings of their own and survive: the
      // stake sweep does not depend on the reconciler having ever run, and an
      // empty history is what a fresh deployment has anyway.
      stake,
      history,
    };
  }

  const blind = isBlind(input.run);

  return {
    chainId: input.chainId,
    asset: input.asset,
    state: blind ? PublicReservesState.LAST_CHECK_FAILED : PublicReservesState.NORMAL,
    assetSymbol: input.assetSymbol,
    decimals: input.run.decimals,
    vaultAccount: input.run.vaultAccount,
    // A blind run's figures are null in the row already — the reconciler
    // records failure rather than guessing. Passing them through unchanged is
    // what keeps this function from being the place a number gets invented.
    vaultBalance: input.run.vaultBalance,
    totalLiabilities: input.run.totalLiabilities,
    difference: input.run.difference,
    // The account count is read live, not off the run, so it stays true even
    // when the chain half of the last check failed.
    accounts: input.accounts,
    vaultSlot: input.run.vaultSlot,
    reconciledAt: input.run.finishedAt,
    stake,
    history,
  };
}

function toHistoryRow(run: ReconciliationRunEntity): PublicReservesHistoryRow {
  return {
    checkedAt: run.finishedAt,
    vaultBalance: run.vaultBalance,
    totalLiabilities: run.totalLiabilities,
    difference: run.difference,
    vaultSlot: run.vaultSlot,
    failed: isBlind(run),
  };
}

/**
 * `RECONCILIATION_BLIND` specifically, never `severity === CRITICAL`.
 *
 * The distinction is the whole point. A `RESERVES_BREACH` is also `CRITICAL`,
 * and it is a **successful** check reporting a real shortfall — the exact event
 * a reader comes to this page for. Keying the state off severity would replace
 * that number with "the last check failed" and hide it.
 */
function isBlind(run: ReconciliationRunEntity): boolean {
  if (run.severity !== ReconciliationSeverity.CRITICAL) {
    return false;
  }
  const findings = Array.isArray(run.findings) ? run.findings : [];
  return findings.some(
    (finding) =>
      typeof finding === 'object' &&
      finding !== null &&
      (finding as { code?: unknown }).code === ReconciliationFindingCode.RECONCILIATION_BLIND,
  );
}
