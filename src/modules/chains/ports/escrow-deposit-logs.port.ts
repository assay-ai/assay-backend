import { AccountId, AssetId } from './caip.types';

/** One `Deposited` event into a buyer's escrow, as the chain logged it. */
export interface EscrowDepositLog {
  /** The transaction hash, lower-case `0x…`. */
  readonly txHash: string;
  /** Minor units of the escrow's asset. */
  readonly amount: bigint;
  readonly blockNumber: bigint;
}

/**
 * The deposits into one buyer's escrow over a recent window of blocks, for the
 * reconciler to name a deposit that no deposit intent credited (A2). Read-only.
 *
 * `null` when the asset's chain has no such log (Solana) or no deployment:
 * "not looked" is never an empty list.
 */
export interface EscrowDepositLogsPort {
  depositsTo(asset: AssetId, buyer: AccountId): Promise<readonly EscrowDepositLog[] | null>;
}

export const ESCROW_DEPOSIT_LOGS = 'ESCROW_DEPOSIT_LOGS';
