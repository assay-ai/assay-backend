import { AccountId } from '@modules/chains/ports/caip.types';

/**
 * The bounded `withdraw` gas grant, as the settlement domain sees it.
 *
 * ## Why the vocabulary lives here and not in `chains/evm/`
 *
 * `EvmGasGrantService` built this originally and had **no production caller**: the
 * grant existed and the withdraw route did not consult it, so a buyer holding
 * USDG and no ETH on `eip155:46630` still had no exit. Joining the two means
 * `WithdrawalService` — a settlement service — has to name the outcome, and
 * `settlement/` may not import from `chains/evm/` (the chains-port convention,
 * and the same arrangement `ESCROW_INTENT_BUILDER` already has: the port is
 * declared by the domain that needs the fact, the implementation lives behind
 * the chain boundary).
 *
 * So {@link GasGrantRefusal} and {@link GasGrantOutcome} moved here from
 * `evm-gas-grant.service.ts`, which **re-exports both** — every existing
 * importer of those two names is untouched, and there is still exactly one
 * declaration of each. A parallel settlement-side enum plus a translation table
 * was the alternative, and it is the worse one: a mapping is a place a new
 * refusal reason can be silently dropped into a default arm, and this is the
 * vocabulary a buyer is told why their money is stuck in.
 *
 * ## `null` is a fourth answer, and it is not a refusal
 *
 * `grantWithdrawGas` answers `null` for a chain where the question does not
 * arise — Solana, where `withdraw` is signed and paid for by the buyer out of
 * SOL they already hold, and no grant has ever existed. That is materially
 * different from `REFUSED`, which means the grant applies to this chain and
 * this buyer did not get one; a console that collapsed the two would print an
 * EVM apology on a Solana withdrawal.
 */

/**
 * Why a grant was not made. Every one of the eight is a control firing, not an
 * error — see `EvmGasGrantService`'s class comment for which one is the bound.
 */
export enum GasGrantRefusal {
  /** This address has been funded once already. The whole bound. */
  ALREADY_GRANTED = 'ALREADY_GRANTED',
  /** No standing withdrawal, or one that has not matured. */
  NO_MATURED_WITHDRAWAL = 'NO_MATURED_WITHDRAWAL',
  /** The buyer's own ETH already covers one `withdraw`. */
  BUYER_HAS_GAS = 'BUYER_HAS_GAS',
  /** One `withdraw` would cost more than `EVM_RELAYER_GAS_GRANT_MAX_WEI`. */
  ABOVE_PER_GRANT_CAP = 'ABOVE_PER_GRANT_CAP',
  /** The last 24 hours of grants plus this one exceed the daily cap. */
  DAILY_CAP_REACHED = 'DAILY_CAP_REACHED',
  /** Granting would leave the relayer under its own float floor. */
  RELAYER_FLOAT_LOW = 'RELAYER_FLOAT_LOW',
  /** The transfer was sent and the chain refused it. Nothing was funded. */
  TRANSFER_FAILED = 'TRANSFER_FAILED',
  /**
   * The address has code — a contract, or an EIP-7702-delegated EOA. The grant
   * is a bare 21 000-gas transfer, which such an account can make revert every
   * time, and a reverted grant writes no row: it could be asked for again and
   * again, each one burning the relayer's gas (review 2026-10-15 P-7).
   */
  ACCOUNT_HAS_CODE = 'ACCOUNT_HAS_CODE',
  /**
   * Another process holds the durable reservation for this address right now.
   *
   * **Not `ALREADY_GRANTED`**, and the difference is the whole point: nothing
   * has been granted, the once-ever budget is intact, and the correct thing for
   * the caller to do is ask again in a moment. Reporting the permanent refusal
   * for a transient one would tell a buyer their single chance is spent.
   */
  GRANT_IN_FLIGHT = 'GRANT_IN_FLIGHT',
}

/** What the grant itself can answer. */
export type GasGrantOutcome =
  | { readonly kind: 'GRANTED'; readonly hash: string; readonly wei: bigint }
  | { readonly kind: 'REFUSED'; readonly reason: GasGrantRefusal };

/**
 * What the **caller** can end up holding, which is one state wider.
 *
 * `UNAVAILABLE` is not a refusal and cannot be produced by the grant: it is
 * `WithdrawalService` reporting that consulting the grant threw. The withdrawal
 * itself is unaffected — the bytes were already built — and that asymmetry is
 * the point. A buyer's exit does not depend on the platform's cooperation
 * (`WithdrawalService`'s own class comment), so a broken faucet must not turn a
 * good withdrawal into a 500. Folding it into `REFUSED` would make an outage
 * indistinguishable from a control firing, in the one direction where the
 * difference matters: a refusal is the system working.
 */
export type WithdrawGasGrant = GasGrantOutcome | { readonly kind: 'UNAVAILABLE' };

export const WITHDRAW_GAS_GRANT = 'WITHDRAW_GAS_GRANT';

export interface WithdrawGasGrantPort {
  /**
   * Fund exactly one `withdraw` for this buyer, once ever, or say why not.
   *
   * `account` is the account being withdrawn from and the account that gets
   * paid — never two values. `EvmGasGrantService` sends to the account it was
   * asked about, and `EscrowController` takes that account from the session and
   * never from the request body; between them there is no input on this path
   * that names a recipient. That is the binding threat model's requirement
   * (*a full leak of every env-held private key must not lose user money*):
   * the relayer key is what a leak takes, and everything it can do through this
   * port is send ETH to a buyer's own address.
   *
   * `null` when this chain has no gas grant — see the file header.
   */
  grantWithdrawGas(organizationId: string, account: AccountId): Promise<GasGrantOutcome | null>;
}
