/**
 * What the ledger says a buyer's own on-chain escrow must hold, in atomic
 * units: `available + held + pending`, less the held payments already moved
 * into the escrow's on-chain hold (G3.B1: per-call holds and channel buckets),
 * which are out of the escrow balance but still in the ledger's `held`.
 *
 * `pending` is in: a deposit settled and awaiting finality is already in the
 * escrow on chain.
 *
 * The one definition. The reconciler's per-escrow walk compares it with the
 * chain (`ESCROW_MIRROR_DRIFT`), the escrow screen shows the chain's excess
 * over it as uncredited, and the deposit path refuses a credit that would put
 * it above the chain (`DepositCoverageService`). Three copies of this sum
 * drifting apart would let one of them pass what another reports.
 */
export function escrowLedgerClaim(
  buckets: { readonly available: bigint; readonly held: bigint; readonly pending: bigint },
  heldOnChain: bigint,
): bigint {
  return buckets.available + (buckets.held - heldOnChain) + buckets.pending;
}
