import { AccountId, AssetId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';

/**
 * One buyer's `BuyerEscrow` account, as last read from the chain.
 *
 * Everything here comes out of the same `getAccountInfo` — decoding a
 * `BuyerEscrow` costs the same whether one field is read or ten, so the whole
 * struct is carried rather than trimmed to what `EscrowSpendGateService`
 * alone needs. `VoucherService`'s withdrawal-pending check and self-heal
 * are two other callers; `EscrowAccountService`, which
 * publishes the buyer's own brake (`max_per_window` / `spent_in_window`), is
 * why the struct grew to the full account rather than staying trimmed to what
 * those two needed.
 */
export interface EscrowChainBalance {
  /** `escrow_ata.amount` — what the escrow actually holds. */
  readonly balance: Money;
  /** `BuyerEscrow.seq_high` — the highest sequence number ever redeemed. */
  readonly seqHigh: bigint;
  /** `BuyerEscrow.withdraw_requested`. `0` means no request stands. */
  readonly withdrawRequested: bigint;
  /** Unix seconds. `BuyerEscrow.withdraw_available_at`, frozen at request time. */
  readonly withdrawAvailableAt: number;
  /** `BuyerEscrow.max_voucher_amount`. `0` refuses every voucher — not "unlimited". */
  readonly maxVoucherAmount: bigint;
  /** `BuyerEscrow.max_per_window`. `0` refuses every voucher — not "unlimited". */
  readonly maxPerWindow: bigint;
  /** `BuyerEscrow.spent_in_window` — drained continuously on chain, read lazily here too. */
  readonly spentInWindow: bigint;
  /** Unix seconds, `0` until the first redemption. `BuyerEscrow.window_started_at`. */
  readonly windowStartedAt: number;
  /** The moment THIS reading was taken from the chain — never the moment it was served from cache. */
  readonly observedAt: Date;
  /**
   * The escrow's lifetime counters, where the chain keeps all three (eip155:
   * `totalFunded`, `totalRedeemed`, `totalWithdrawn`). The contract keeps
   * `totalFunded == balance + totalRedeemed + totalWithdrawn` per escrow, so a
   * screen can show "deposited − spent − withdrawn = balance" from one read
   * and no platform arithmetic. Absent or `null` where the chain has no
   * money-in counter (Solana). Display only: nothing decides on it.
   */
  readonly lifetime?: EscrowLifetimeTotals | null;
}

/** Atomic units, as the chain keeps them. See {@link EscrowChainBalance.lifetime}. */
export interface EscrowLifetimeTotals {
  readonly funded: bigint;
  readonly redeemed: bigint;
  readonly withdrawn: bigint;
}

/**
 * Reads a buyer's on-chain escrow.
 *
 * `read` is `null` when no escrow account exists for `account` — a first-class
 * answer (`PAYMENT_ESCROW_NOT_OPEN`), never a balance of zero. It **throws**
 * when the chain cannot be read and no reading is fresh enough to still be
 * spent against — see the implementation's class comment for the fail-closed
 * argument that makes this the one balance read in this codebase that
 * never degrades to a mirror.
 */
export interface EscrowBalanceReaderPort {
  read(account: AccountId, asset: AssetId): Promise<EscrowChainBalance | null>;

  /** Batched, for the reconciler. Absent accounts are absent from the map. */
  readMany(
    accounts: readonly AccountId[],
    asset: AssetId,
  ): Promise<ReadonlyMap<AccountId, EscrowChainBalance>>;

  /** Pure PDA derivation — no RPC. */
  escrowAddresses(
    account: AccountId,
    asset: AssetId,
  ): Promise<{ readonly escrowPda: AccountId; readonly escrowTokenAccount: AccountId }>;
}

export const ESCROW_BALANCE_READER = 'ESCROW_BALANCE_READER';
