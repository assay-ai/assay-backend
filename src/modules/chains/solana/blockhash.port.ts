/**
 * A recent Solana blockhash — **a Solana port, in the Solana directory**.
 *
 * ## Why it is here and not in `payment/`
 *
 * It used to be declared by `payment/ports/blockhash.types.ts` and injected
 * straight into `DepositsController`, which made a chain primitive a domain
 * concept and put an RPC read in an HTTP handler. Its own header already
 * admitted the problem — *"a blockhash is not a chain-neutral concept"* — and
 * The conclusion: `BlockhashReaderPort` stays a Solana port under
 * `chains/solana/` and **nothing outside this directory names it.**
 *
 * That last sentence is a gate, not a wish:
 * `test/unit/architecture/blockhash-stays-in-solana.spec.ts` scans `src/`,
 * `test/` and `scripts/` for the name, and `eslint.config.mjs` refuses the
 * import outside `src/modules/chains/**`. Two locks because they cover
 * different trees — ESLint does not lint `scripts/`, and the source scan does
 * not understand a re-export.
 *
 * ## Why it is still a port at all, inside one directory
 *
 * Because `SolanaDepositRequirementsBuilder` is a unit with a test, and the
 * one thing it does that needs the network is this read. The port is what lets
 * that test exist without an RPC.
 *
 * ## Why it is not a method on `ChainAdapterPort`
 *
 * A blockhash is SVM's replay protection and transaction lifetime in one; the
 * EVM equivalent is a nonce plus a deadline, neither fetched the same way nor
 * consumed the same way. On the chain-neutral adapter it would be a method
 * named after one chain's primitive that every other adapter implements by
 * faking — and the first one to return `null` turns a port contract into a
 * suggestion. The `UnsignedChainTransaction` union exists so the SVM-shaped
 * need can stay SVM-shaped.
 *
 * ## Why the deposit blockhash does not travel on `PaymentRequirements`
 *
 * `DepositService.settleDeposit` rebuilds the x402 requirements a **second**
 * time before calling `facilitator.verify`. A blockhash carried on that
 * structure would be re-fetched at settle time and would differ from the one
 * the buyer signed against — silently, and only for the transactions slow
 * enough for it to matter. It rides on the `POST /deposits` response instead,
 * which is built once and never rebuilt.
 */

/** A blockhash and the height it dies at. */
export interface BlockhashReading {
  /** The hash a transaction must be built against. */
  readonly blockhash: string;
  /**
   * The last block height at which {@link blockhash} is still valid.
   *
   * A `bigint`, because it is a `u64` and JSON has no such number. Whoever
   * serialises it is responsible for making it a decimal **string** — a
   * `bigint` reaching `JSON.stringify` throws.
   */
  readonly lastValidBlockHeight: bigint;
}

export interface BlockhashReaderPort {
  /**
   * The most recent blockhash the chain will accept, at `confirmed`.
   *
   * **Throws** when the chain cannot be read; there is no empty reading. A
   * caller that got a value it could not use would hand the browser a
   * transaction lifetime that has already expired, and the failure would then
   * surface as a rejected signature the buyer has no way to interpret.
   */
  getLatestBlockhash(): Promise<BlockhashReading>;
}

/** DI token for the bound {@link BlockhashReaderPort}. Bound and consumed inside `chains/solana/` only. */
export const BLOCKHASH_READER = 'BLOCKHASH_READER';
