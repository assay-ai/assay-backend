import { chainMetadata } from '@modules/chains/chain-metadata';
import { AssetId, ChainId } from '@modules/chains/ports/caip.types';

import { PaymentErrors } from '../errors/payment.errors';

/**
 * The one asset a deposit may name on a chain — **the chain's declared
 * settlement asset**, and nothing else.
 *
 * ## What this replaced, and why the replacement keeps the property
 *
 * This file used to hold `USDC_BY_CHAIN`, a `Partial<Record<ChainId, AssetId>>`
 * with two Solana rows in it. Its comment defended the table like this:
 *
 * > *"A lookup table rather than 'ends with `/token:` and the registry says
 * > `symbol === 'USDC'`': a chain could plausibly register more than one
 * > USDC-symbol asset during a migration, and this table is what makes 'the one
 * > deposits accept' an explicit, single answer per chain rather than whatever
 * > the registry happens to return first."*
 *
 * That argument is correct, and it is an argument against a **search** — a
 * `registeredAssets().find(...)` over symbol or suffix, which answers with
 * whatever `Object.values` yields first and changes meaning when an unrelated
 * literal moves. It is not an argument against `chainMetadata(chainId)
 * .settlementAsset`, which is *already* an explicit, declared, hand-written,
 * single answer per chain — `chain-metadata.ts` makes exactly the same argument
 * in its own header, having removed exactly that `find` for exactly that
 * reason. The table was a second copy of a fact that already had a home.
 *
 * And the copy had drifted. `eip155:46630` was absent from it, so
 * `POST /deposits` on that chain was refused — before an intent row, before the
 * escrow, before anything — for a chain whose declared settlement asset is
 * registered, pegged, 6 dp and validated at boot. Money-in was dead on the
 * second chain from the day the chain landed, because the table was keyed by
 * chain and nobody extended it.
 *
 * ## What is preserved
 *
 * Every property the old comment was protecting:
 *
 * - **One explicit answer per chain.** `CHAIN_METADATA[chainId].settlementAsset`
 *   is a literal someone typed, one per row.
 * - **No search.** Nothing here filters the registry, reads a symbol, or
 *   inspects an asset id's shape, so a second USDC-symbol asset registered
 *   during a migration cannot become the deposit asset by being registered
 *   first — or at all. `asset-registry.ts` says the same: *"Registering a
 *   second asset on a chain is then a normal thing to do: it simply is not the
 *   settlement asset unless this table says so."*
 * - **A chain with no answer gets no answer.** A chain absent from
 *   `CHAIN_METADATA` throws rather than defaulting — see below.
 *
 * ## What it costs if this ruling is wrong
 *
 * The failure this opens, if it is one, is a chain whose settlement asset is
 * not the asset deposits should accept — i.e. a chain that settles in one token
 * but takes deposits in another. Nothing in this platform is built that way:
 * `ledger`, `reconciliation-job`, `PublicReservesApiModule`, the withdrawal
 * freeze and `balances` are all keyed on *the* asset of a chain, singular
 * (`settlementAssetsOn` exists and `reconciliation-job.spec.ts` asserts it
 * returns exactly one). A deposit in a second asset would credit a ledger that
 * has no account for it. So the cost of being wrong is not a wrong deposit —
 * it is that the day a chain genuinely needs two, this call site has to grow a
 * concept (`depositAsset` beside `settlementAsset` on `ChainMetadata`) rather
 * than a row. That is a visible, typed edit in the file that already declares
 * the fact, not a silent divergence between two tables. The opposite ruling —
 * keeping the table — costs a refused chain every time someone adds one and
 * forgets, which is measured, not hypothetical: it already happened.
 *
 * ## Why an absent chain throws `CHAIN_UNSUPPORTED` and not a payment error
 *
 * `chainMetadata` throws `ChainErrors.unsupportedChain` for a chain with no
 * row, and that error is now what a deposit on such a chain answers —
 * `registeredUsdcFor` used to answer `PAYMENT_DEPOSIT_ASSET_NOT_USDC` with no
 * asset in its context, which told the caller their *asset* was wrong when the
 * caller had supplied no asset at all (the deposit asset is derived, never a
 * request field). "This deployment cannot describe that chain" is the true
 * statement, it is the same answer `assertRailOffered` already gives for the
 * same input, and on a process that booted it is unreachable anyway:
 * `assertChainMetadata` refuses at boot every enabled chain without a row.
 */
export function depositAssetFor(chainId: ChainId): AssetId {
  return chainMetadata(chainId).settlementAsset;
}

/**
 * Refused before anything else happens — called at the very start of
 * `DepositService.createDeposit`, before an intent row exists, so a request for
 * the wrong asset never gets far enough to leave a trace.
 *
 * Still worth asserting even though `DepositsController` derives the asset from
 * the same function two lines earlier and therefore cannot fail it: the
 * controller need not be the only caller of `createDeposit`, and the amount
 * arrives as a `Money` whose asset could be anything a caller put in it.
 */
export function assertDepositAssetIsSettlementAsset(chainId: ChainId, asset: AssetId): void {
  const expected = depositAssetFor(chainId);
  if (asset !== expected) {
    throw PaymentErrors.depositAssetNotSettlementAsset({ chainId, asset, expected });
  }
}
