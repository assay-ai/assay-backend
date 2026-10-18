import { Inject, Injectable, Logger } from '@nestjs/common';

import { AccountBalanceRepository } from '@database/postgres/repositories/account-balance.repository';
import { AccountId, AssetId } from '@modules/chains/ports/caip.types';
import { VAULT_PORT, VaultPort } from '@modules/chains/ports/vault.port';
import { MoneyUtil } from '@shared/utils/money.util';

import { SettlementErrors } from '../errors/settlement.errors';
import { ProofOfReserves } from '../ports/treasury-vault.types';

/**
 * The custody half of the treasury vault: where the **legacy** pooled vault is, whether it
 * can be trusted, and whether it currently holds enough to cover everything
 * the ledger says is owed against it.
 *
 * Every new deposit now goes onto the buyer's own escrow, so `checkReserves`
 * is now a check over what has not yet been migrated by the cutover runbook
 * rather than over every buyer's balance — it stays exactly as strict
 * until that runbook empties the vault.
 *
 * This class never *moves* money. It reads chain state through `VaultPort` and reads liabilities
 * through the ledger's own balance table. Both reads are best-effort snapshots
 * taken moments apart, not one atomic view: the chain and the ledger are two
 * different systems and nothing holds them both still while this runs. That is
 * fine for the inequality `checkReserves` checks — a deposit in flight only
 * ever makes the ledger side momentarily *ahead* of the chain side via
 * `DEPOSIT_PENDING` (money the ledger already counts as a liability before the
 * chain write is even visible here), never the reverse, so a race can produce
 * a false "breach" for a few seconds around a settlement, never a false
 * "reserves are fine". The scheduled 5-minute proof-of-reserves check is what
 * pages on-call; a single ad hoc call racing a settlement is not itself proof
 * of anything.
 */
@Injectable()
export class TreasuryVaultService {
  private readonly logger = new Logger(TreasuryVaultService.name);

  constructor(
    @Inject(VAULT_PORT) private readonly vault: VaultPort,
    private readonly balances: AccountBalanceRepository,
  ) {}

  getVaultAccount(asset: AssetId): Promise<AccountId> {
    return this.vault.getVaultAccount(asset);
  }

  getVaultOwner(asset: AssetId): Promise<AccountId> {
    return this.vault.getVaultOwner(asset);
  }

  /**
   * `vault_balance ≥ Σ liabilities`, checked and returned.
   *
   * Throws `SETTLEMENT_RESERVES_BREACH` — loudly and distinctly — the moment
   * the inequality fails, rather than returning `{ ok: false }` that a caller
   * could accidentally not check. `assertVaultControl` runs first: a reserves
   * figure computed against an unproven vault address is worse than no figure
   * at all, because it looks authoritative.
   */
  async checkReserves(asset: AssetId): Promise<ProofOfReserves> {
    await this.vault.assertVaultControl(asset);

    const vault = await this.vault.getVaultAccount(asset);
    const vaultBalance = await this.vault.getVaultBalance(asset);
    const totals = await this.balances.sumLiabilities(asset);
    const liabilities = MoneyUtil.of(
      totals.available + totals.held + totals.pending,
      asset,
      vaultBalance.decimals,
    );

    if (MoneyUtil.lessThan(vaultBalance, liabilities)) {
      this.logger.error(
        `PROOF OF RESERVES BREACH on ${asset}: vault ${vault} holds ${MoneyUtil.format(vaultBalance)} ` +
          `but liabilities total ${MoneyUtil.format(liabilities)} across ${totals.organizations} organizations`,
      );
      throw SettlementErrors.reservesBreach({
        asset,
        vaultBalance: vaultBalance.amount,
        liabilities: liabilities.amount,
      });
    }

    return {
      asset,
      vault,
      vaultBalance,
      liabilities,
      surplus: MoneyUtil.subtract(vaultBalance, liabilities),
      organizations: totals.organizations,
      checkedAt: new Date(),
    };
  }
}
