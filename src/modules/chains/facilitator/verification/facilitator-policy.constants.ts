import { address, Address } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';

import { CHAIN_IDS, ChainId } from '../../ports/caip.types';

/**
 * The facilitator's static-path policy and the `exact`-SVM scheme spec,
 * expressed as constants rather than folded into rule logic — so a rule file
 * reads as "compare against the policy" and the numbers a reviewer needs to
 * check against the scheme spec are in one place.
 *
 * Deliberately duplicated from (rather than imported from)
 * `src/modules/chains/solana/`: the facilitator is a separate process by design
 * (it isolates the fee-payer key) — it should not gain a build dependency on
 * the API-side chain adapter. `MEMO_PROGRAM_ADDRESS` is a protocol constant
 * (SPL Memo v2's address never changes); duplicating one string is cheaper than
 * the coupling.
 */

/** Token-2022 — not exported by `@solana-program/token` (classic-only package). */
export const TOKEN_2022_PROGRAM_ADDRESS: Address = address(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
);

export const TOKEN_PROGRAM_ADDRESSES: readonly Address[] = [
  TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
];

export const COMPUTE_BUDGET_PROGRAM_ADDRESS: Address = address(
  'ComputeBudget111111111111111111111111111111',
);

/** SPL Memo v2 — matches `solana/solana.constants.ts`'s `MEMO_PROGRAM_ADDRESS`. */
export const MEMO_PROGRAM_ADDRESS: Address = address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

/** Solflare/Phantom assertion instructions, permitted as trailing no-ops. */
export const LIGHTHOUSE_PROGRAM_ADDRESS: Address = address(
  'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95',
);

export const OPTIONAL_TRAILING_PROGRAM_ADDRESSES: readonly Address[] = [
  MEMO_PROGRAM_ADDRESS,
  LIGHTHOUSE_PROGRAM_ADDRESS,
];

/**
 * "The decompiled transaction MUST contain 3 to 7 instructions": 2 Compute
 * Budget + 1 `TransferChecked`, plus up to 4 optional trailing Lighthouse/Memo
 * instructions (Phantom alone contributes 3).
 */
export const MIN_STATIC_INSTRUCTIONS = 3;
export const MAX_STATIC_INSTRUCTIONS = 7;

/**
 * "compute unit price ≤ 5 lamports/CU on the static path" — read literally as
 * the raw `SetComputeUnitPrice` argument, which the chain itself denominates in
 * micro-lamports per CU. At 5 micro-lamports/CU, a maximally-sized static-path
 * transaction (≤1,400,000 CU) costs the fee payer at most 7,000,000
 * micro-lamports (0.000007 SOL) in priority fees — a sane ceiling for a
 * self-hosted facilitator sponsoring calls priced in fractions of a cent. If
 * "5 lamports/CU" instead means 5,000,000 micro-lamports/CU, this is 1,000,000x
 * stricter than required, which is the safe direction to be wrong in
 * for a cap whose entire purpose is bounding fee-payer drain.
 */
export const MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 5n;

/** The network's own hard ceiling — a limit above this can never execute. */
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;

/** The only scheme this facilitator speaks. */
export const SOLANA_EXACT_SCHEME = 'exact';

/** The two networks `GET /supported` advertises kinds for. */
export const SUPPORTED_SVM_NETWORKS: readonly ChainId[] = [
  CHAIN_IDS.SOLANA_MAINNET,
  CHAIN_IDS.SOLANA_DEVNET,
];

/**
 * "Evict entries older than 120 seconds" — twice Solana's ~60–90s blockhash
 * lifetime, so no transaction that could still be valid ages out of the guard
 * that stops it being broadcast twice.
 */
export const DUPLICATE_SETTLEMENT_TTL_SECONDS = 120;
