/**
 * `@assay/settlement-client` — the typed client for the assay settlement program.
 *
 * Everything under `./generated` is Codama output rendered from
 * `idl/assay_payment.json`, which is itself rendered from the program source. Do
 * not hand-edit it: `yarn client:check` re-renders and fails on any difference,
 * so an edit here is a red pipeline rather than a silent divergence.
 *
 * ## What the backend gets from this
 *
 * - `getProposeSlashInstruction(...)`, `getExecuteSlashInstruction(...)` and
 *   the other sixteen — account order, signer/writable flags, the eight-byte
 *   discriminator and Borsh argument encoding all come from the IDL.
 * - `fetchVerifierKey(...)`, `getProviderStakeDecoder()` and friends — account
 *   layouts likewise.
 * - `findStakePda(...)`, `findVerifierKeyPda(...)`, … — seeds taken from the
 *   program's own `#[account(seeds = …)]`, not retyped.
 * - `ASSAY_PAYMENT_ERROR__*` and `getAssayPaymentErrorMessage(code)` — the
 *   program's error catalog, so a failed simulation reads as
 *   `StatusDoesNotSlash` rather than as `custom program error: 0x1783`.
 *
 * The point of routing all of it through here is stated in
 * `docs/architecture.md` §"Signing Keys": a hand-built instruction encodes a
 * copy of the program's interface that nothing checks, and the first thing it
 * costs you is a slash written to the wrong account.
 *
 * ## What this package deliberately does NOT do
 *
 * It does not sign, and it does not send. Every builder returns an
 * `Instruction`; assembling, signing and submitting a transaction stays with the
 * caller, behind `SignerPort` / `FeePayerSignerPort`. A client that held a
 * keypair would be a second place private key material lives.
 */
export * from './generated';

/**
 * The one PDA finder the generator leaves out. See `record-pdas.ts` — the gap
 * is a nested `arg` seed path (and, for two instructions, an `account` seed
 * path) that `@codama/renderers-js` does not resolve, and the seeds are
 * checked against the IDL by a test rather than trusted.
 */
export * from './record-pdas';

/**
 * The bytes a verifier signs for `propose_slash`. Not in the IDL — it is not an
 * instruction and not an account — so it is hand-written, in exactly one place,
 * and checked by the chain refusing a wrong encoding outright. See
 * `attestation-message.ts`.
 */
export * from './attestation-message';

/**
 * The bytes a **buyer** signs. Also not in the IDL, also hand-written in exactly
 * one place, and also checked by the chain refusing a wrong encoding outright.
 * See `voucher-message.ts` for why its `programAddress` has no default.
 */
export * from './voucher-message';

/**
 * The program id compiled into the client, re-exported under a name that says
 * where it came from.
 *
 * It is `declare_id!()` from `lib.rs` by way of the IDL's `address` field, which
 * is the address `anchor deploy` targets and the address the on-chain PDA
 * derivations assume. A deployment to some *other* address — a localnet with a
 * fresh program keypair, say — must pass `{ programAddress }` to every builder
 * and every `find*Pda` call; it must not edit this.
 */
export { ASSAY_PAYMENT_PROGRAM_ADDRESS as SETTLEMENT_PROGRAM_ADDRESS } from './generated/programs';

/**
 * The two `#[constant]` delays. Codama renders no constants, so these are
 * retyped in one place and checked against the IDL by a spec. See
 * `program-constants.ts`.
 */
export * from './program-constants';
