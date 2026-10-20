import { Inject, Injectable } from '@nestjs/common';

import { AccountBalanceRepository } from '@database/postgres/repositories/account-balance.repository';
import { ReconciliationRunRepository } from '@database/postgres/repositories/reconciliation-run.repository';
import { StakeSnapshotRepository } from '@database/postgres/repositories/stake-snapshot.repository';
import { getAssetMetadata, isRegisteredAsset } from '@modules/chains/ports/asset-registry';
import { AssetId, chainIdOf } from '@modules/chains/ports/caip.types';

import {
  PublicReserves,
  PublicReservesChainInput,
  buildPublicReserves,
} from '../domain/public-reserves';

export const PUBLIC_RESERVES_CONFIG = Symbol('PUBLIC_RESERVES_CONFIG');

export interface PublicReservesConfig {
  /**
   * The assets this page publishes — **one per enabled chain**, derived rather
   * than named (see the module). Was a single `asset` until multichain support
   * made the page a list.
   */
  readonly assets: readonly AssetId[];
  /** How many history rows each panel shows. The page draws four. */
  readonly historyLimit: number;
}

/**
 * The read behind the public proof-of-reserves page.
 *
 * **I/O only.** It reads four rows and hands them to `buildPublicReserves`,
 * which owns every rule about what to say when a figure is missing, stale or
 * negative. Nothing here decides anything, so there is one place to look for
 * the page's behaviour and one place to test it.
 *
 * **No chain call happens in a page request.** The page promises "reconciled
 * every five minutes" and therefore reads back what the reconciler already
 * wrote, rather than reconciling on demand: a public endpoint that issued an
 * RPC per request would be both slow and a free amplifier. `ReconciliationService`
 * treats a breach's severity as a field, and a field is what a page can print.
 */
@Injectable()
export class PublicReservesService {
  constructor(
    private readonly runs: ReconciliationRunRepository,
    private readonly snapshots: StakeSnapshotRepository,
    private readonly balances: AccountBalanceRepository,
    @Inject(PUBLIC_RESERVES_CONFIG) private readonly config: PublicReservesConfig,
  ) {}

  async read(): Promise<PublicReserves> {
    // One sweep row for the whole fleet, read once rather than per panel — and
    // then attached only to the chain it was read FROM, which
    // `buildPublicReservesChain` decides. Reading it per asset would be the
    // same row fetched twice and would not make it any more per-chain.
    const stake = await this.snapshots.findLatest();

    // Per asset, and nothing crosses between the iterations. There is no fold
    // here and there must not be one: balances are a list, never a
    // sum, and the reduce that would break it is the easiest line in this file
    // to write by accident.
    const panels: PublicReservesChainInput[] = await Promise.all(
      this.config.assets.map(async (asset) => {
        const [run, accounts, history] = await Promise.all([
          this.runs.findLatest(asset),
          this.balances.countFundedCustomerAccounts(asset),
          this.runs.findRecent(asset, this.config.historyLimit),
        ]);

        // `getAssetMetadata` throws on an unregistered asset. A page that 500s
        // because a ticker is missing would be trading the whole reserves check
        // for a cosmetic string, so the symbol is simply absent and the page
        // shows the mint.
        const assetSymbol = isRegisteredAsset(asset) ? getAssetMetadata(asset).symbol : null;

        return { chainId: chainIdOf(asset), asset, run, accounts, history, assetSymbol, stake };
      }),
    );

    return buildPublicReserves(panels);
  }
}
