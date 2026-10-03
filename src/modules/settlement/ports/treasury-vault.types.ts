import { AccountId, AssetId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';

/**
 * One proof-of-reserves check: `vault_balance ≥ Σ liabilities`.
 *
 * Only ever returned when the inequality holds — a breach is
 * `SETTLEMENT_RESERVES_BREACH`, not a field on this type a caller could
 * forget to check.
 */
export interface ProofOfReserves {
  readonly asset: AssetId;
  readonly vault: AccountId;
  readonly vaultBalance: Money;
  /** `Σ (available + held + pending)` across every organization's ledger balance in `asset`. */
  readonly liabilities: Money;
  /** `vaultBalance − liabilities`. The ceiling on what could be withdrawn right now. */
  readonly surplus: Money;
  /** How many organizations contributed to `liabilities` — an audit figure, not a filter. */
  readonly organizations: number;
  readonly checkedAt: Date;
}
