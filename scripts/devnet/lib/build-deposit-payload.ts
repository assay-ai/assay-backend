/**
 * Builds the x402 `exact` deposit payload exactly as a real client would:
 * ComputeBudget limit, ComputeBudget price, `TransferChecked` (user ATA ->
 * vault ATA), SPL Memo = deposit intent id, fee payer slot left unsigned for
 * the facilitator.
 *
 * **Legacy transaction, not v0.** A client signing a `VersionedTransaction`
 * is the natural design, and that is what this script built until the
 * self-hosted facilitator landed: Kora 1.0.3's
 * `signAndSendTransaction` deserializes with
 * `bincode::deserialize::<solana_sdk::transaction::Transaction>`, which is
 * **legacy-only** — a v0 message passes our own `/verify` and then fails
 * inside Kora with a bincode error, confirmed by hand against the running
 * node (identical payload settles as `version: 'legacy'`, fails as
 * `version: 0`). The `exact` scheme itself has no opinion on transaction
 * version; this is Kora's current deserializer, not a protocol constraint —
 * whoever next bumps the facilitator's Kora version should re-check whether
 * v0 works before "modernising" this back.
 */
import {
  Address,
  address,
  appendTransactionMessageInstructions,
  blockhash as toBlockhash,
  compileTransaction,
  createSignerFromKeyPair,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  KeyPairSigner,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from '@solana-program/compute-budget';
import { getAddMemoInstruction } from '@solana-program/memo';
import { getTransferCheckedInstruction } from '@solana-program/token';

/**
 * Where the transaction's blockhash lifetime comes from — and the two callers
 * genuinely need different answers.
 *
 * A caller driving `DepositService` **in process** is handed no blockhash,
 * so it fetches one (`{ rpcUrl }`).
 *
 * Anything driving `POST /api/v1/deposits` over HTTP is **given** one on the
 * response (`SolanaDepositRequirementsDto.blockhash` + `lastValidBlockHeight`) and
 * must sign over exactly that (`{ blockhash, lastValidBlockHeight }`). That DTO
 * exists for this: the blockhash deliberately does not ride on
 * `PaymentRequirements`, because `settleDeposit` rebuilds those a second time
 * and a blockhash on that chain-neutral type would be re-fetched at settle time
 * and silently differ from the one the buyer signed. Re-fetching here would
 * reintroduce exactly that divergence one layer down, and would also put the
 * transaction on a lifetime the intent's own `expiresAt` was not derived from.
 *
 * A union rather than an optional field, so neither caller can supply both and
 * neither can supply neither.
 */
export type DepositLifetime =
  | { readonly rpcUrl: string }
  | { readonly blockhash: string; readonly lastValidBlockHeight: bigint };

export interface BuildDepositPayloadInput {
  readonly lifetime: DepositLifetime;
  readonly userSigner: KeyPairSigner;
  readonly userAta: Address;
  readonly vaultAta: Address;
  readonly mint: Address;
  readonly decimals: number;
  readonly amountAtomic: bigint;
  readonly feePayer: Address;
  readonly memo: string;
}

export interface BuiltDepositPayload {
  readonly transactionBase64: string;
  readonly computeUnitLimit: number;
  readonly computeUnitPriceMicroLamports: bigint;
}

const COMPUTE_UNIT_LIMIT = 30_000;
// The facilitator design caps the *static* path at "≤5 lamports/CU" without
// saying what happens above zero on this particular facilitator's policy; empirically, against the live devnet
// facilitator, `1_000` microLamports/CU was rejected as
// `invalid_exact_svm_payload_compute_budget` and `1` was accepted. Kept
// deliberately minimal — a deposit has no reason to bid for priority.
const COMPUTE_UNIT_PRICE_MICROLAMPORTS = 1n;

/**
 * The blockhash lifetime, either as given or fetched — see {@link DepositLifetime}.
 *
 * `toBlockhash()` is a checked coercion, not a cast: a server that answered
 * with an empty string or a truncated hash would otherwise reach
 * `compileTransaction` and fail as an encoding error naming nothing.
 */
async function resolveLifetime(lifetime: DepositLifetime) {
  if ('rpcUrl' in lifetime) {
    const rpc = createSolanaRpc(lifetime.rpcUrl);
    const { value } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    return value;
  }
  return {
    blockhash: toBlockhash(lifetime.blockhash),
    lastValidBlockHeight: lifetime.lastValidBlockHeight,
  };
}

export async function buildDepositPayload(
  input: BuildDepositPayloadInput,
): Promise<BuiltDepositPayload> {
  const latestBlockhash = await resolveLifetime(input.lifetime);

  const computeLimitIx = getSetComputeUnitLimitInstruction({ units: COMPUTE_UNIT_LIMIT });
  const computePriceIx = getSetComputeUnitPriceInstruction({
    microLamports: COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  });
  const transferIx = getTransferCheckedInstruction({
    source: input.userAta,
    mint: input.mint,
    destination: input.vaultAta,
    authority: input.userSigner,
    amount: input.amountAtomic,
    decimals: input.decimals,
  });
  const memoIx = getAddMemoInstruction({ memo: input.memo });

  // `pipe()`, not sequential `let message = f(message)` reassignment: kit's
  // transaction-message builders each return a distinct, more-refined type
  // (adding a fee payer, then a lifetime, then instructions), and assigning
  // each result back onto one `let`-declared variable only compiles against
  // that variable's *first* inferred type. `pipe` threads the value through
  // without ever needing to name an intermediate type.
  const message = pipe(
    createTransactionMessage({ version: 'legacy' }),
    (m) => setTransactionMessageFeePayer(input.feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions([computeLimitIx, computePriceIx, transferIx, memoIx], m),
  );

  const compiled = compileTransaction(message);
  // Only the user's key signs here — the fee payer's signature slot stays
  // zeroed, exactly as `extra.feePayer` in the `402` response advertises it
  // must, so the facilitator has a slot to fill.
  const signed = await partiallySignTransaction([input.userSigner.keyPair], compiled);

  return {
    transactionBase64: getBase64EncodedWireTransaction(signed),
    computeUnitLimit: COMPUTE_UNIT_LIMIT,
    computeUnitPriceMicroLamports: COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  };
}

export { createSignerFromKeyPair, address };
