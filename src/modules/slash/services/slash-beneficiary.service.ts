import { Inject, Injectable } from '@nestjs/common';

import {
  AccountId,
  AssetId,
  ChainNamespace,
  chainIdOf,
  namespaceOf,
} from '@modules/chains/ports/caip.types';
import { VAULT_PORT, VaultPort } from '@modules/chains/ports/vault.port';

import { SlashErrors } from '../errors/slash.errors';
import { SLASH_EXECUTOR, SlashExecutorPort } from '../ports/slash-executor.port';

/**
 * Which on-chain account a penalty's compensating share is paid into.
 *
 * ## The answer is derived, not chosen
 *
 * A window-level penalty is paid **once** on chain and
 * split across the harmed agents **in the ledger**. That makes the on-chain
 * `beneficiary` a platform account — and exactly which one is then forced by
 * two independent constraints, neither of them a preference:
 *
 * - **The reconciler forces the vault.** `ReconciliationService` compares
 *   `VaultPort.getVaultBalance(asset)` against total ledger liabilities.
 *   `SLASH_DISTRIBUTION` raises agent liabilities, so unless the money lands in
 *   the vault the very next run reports a proof of reserves breach. This is
 *   also why the platform's own 30% must never become a ledger entry: it goes
 *   to `economics.treasury`, which is not the vault.
 * - **The program forbids the obvious wrong answer.** A judgement whose
 *   `beneficiary` is the treasury cannot execute — `beneficiary_token_account`
 *   and `treasury_token_account` derive to one address and Anchor rejects the
 *   duplicate mutable account (2040) before the handler runs, so the failure
 *   has no name. The program's comment asks the off-chain issuer to refuse
 *   rather than discover it on chain; {@link resolve} is that refusal.
 *
 * Picking the treasury here would also have repeated a defect this codebase has
 * already shipped once, where `/balances` handed a buyer the platform's own fee
 * account — the same mistake at the scale of penalties.
 *
 * ## What this costs, stated rather than hidden
 *
 * `SlashRecord.beneficiary` will name the vault, not an agent. **The chain no
 * longer records who was compensated**; the ledger becomes the only place that
 * knows. That is the price of one transaction instead of one per harmed agent,
 * and it is an accepted trade.
 */
@Injectable()
export class SlashBeneficiaryService {
  constructor(
    @Inject(VAULT_PORT) private readonly vault: VaultPort,
    @Inject(SLASH_EXECUTOR) private readonly executor: SlashExecutorPort,
  ) {}

  /**
   * The CAIP-10 account to name as `beneficiary` for a penalty in `asset`.
   *
   * `assertVaultControl` is called rather than assumed. It proves on chain that
   * the vault ATA's authority really is the derived vault PDA — which is the
   * property that makes this address safe to sign: `slash` derives the payee
   * token account from `beneficiary` itself, so if that derivation did not land
   * on the account `getVaultBalance` reads, the penalty would be paid into
   * somewhere the reconciler cannot see. The failure would then surface as an
   * unexplained shortfall weeks later rather than as an error here.
   */
  async resolve(asset: AssetId): Promise<AccountId> {
    // On EVM the "vault" is the `X402Escrow` contract, and a plain ERC-20
    // transfer into it credits nobody (`test_donationsDoNotBecomeAnybodysBalance`
    // in assay-evm) — naming it would burn the agent share. EVM window cases
    // are paid pro rata to the harmed agents by `SlashPartsService` and never
    // reach here; anything else on EVM has no beneficiary rule, and says so.
    if (namespaceOf(asset) === ChainNamespace.EIP155) {
      throw SlashErrors.beneficiaryUnsupported({
        chainId: chainIdOf(asset),
        reason:
          'the EVM vault is the escrow contract, which cannot credit a transfer; only ' +
          'window-level cases (paid pro rata to the agents) can slash on EVM',
      });
    }

    await this.vault.assertVaultControl(asset);

    const [owner, treasury] = await Promise.all([
      this.vault.getVaultOwner(asset),
      this.executor.settlementTreasury(asset),
    ]);

    if (addressOf(owner) === addressOf(treasury)) {
      throw SlashErrors.beneficiaryIsTreasury({ address: addressOf(owner) });
    }

    return owner;
  }
}

/**
 * The last CAIP-10 segment — the bare address.
 *
 * Compared on the address rather than the whole identifier because the program
 * compares `Pubkey`s: a treasury written under a different chain id is still
 * the same key to `slash`, and a string comparison would let it through.
 */
function addressOf(account: AccountId): string {
  const segments = account.split(':');
  return segments[segments.length - 1];
}
