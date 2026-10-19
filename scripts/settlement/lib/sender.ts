/**
 * Sending instructions built by `@assay/settlement-client`.
 *
 * The operator scripts for the settlement program all need the same four
 * things — a keypair loaded off disk as a `TransactionSigner`, a blockhash, a
 * v0 transaction and a confirmation — and none of them should be assembling
 * that by hand any more than they should be assembling instruction data by
 * hand.
 *
 * ## Why not @solana/web3.js
 *
 * The generated client emits `@solana/kit` instructions, and `sendAndConfirm`
 * from web3.js v1 wants `TransactionInstruction`. `scripts/devnet/lib/kit-to-web3.ts`
 * exists to bridge those two for `@sqds/multisig`, which is built on web3.js and
 * gives no choice. Nothing here is in that position, so this stays on one SDK.
 *
 * ## Why confirmation is polled rather than subscribed
 *
 * `sendAndConfirmTransactionFactory` wants an `rpcSubscriptions` — a websocket
 * to the cluster. These scripts run against public devnet from a laptop and, in
 * CI, from a runner that may have outbound websockets closed. A poll on
 * `getSignatureStatuses` needs nothing but the HTTP endpoint already configured,
 * and this is operator tooling where an extra second of latency costs nothing.
 */
import { readFileSync } from 'node:fs';

import {
  Address,
  appendTransactionMessageInstructions,
  Commitment,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  Instruction,
  KeyPairSigner,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { getAssayPaymentErrorMessage, AssayPaymentError } from '@assay/settlement-client';

/** How long to wait for a signature to reach the requested commitment. */
const CONFIRM_TIMEOUT_MS = 60_000;
const CONFIRM_POLL_MS = 500;

export type Sender = ReturnType<typeof createSender>;

export function createSender(rpcUrl: string, commitment: Commitment = 'confirmed') {
  const rpc = createSolanaRpc(rpcUrl);

  async function send(
    instructions: readonly Instruction[],
    feePayer: KeyPairSigner,
  ): Promise<string> {
    const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment }).send();

    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );

    const signed = await signTransactionMessageWithSigners(message);
    const wire = getBase64EncodedWireTransaction(signed);

    // Simulated first, so a program error arrives as its own name rather than as
    // a preflight failure with a hex code in it. The generated error catalog is
    // the whole reason this is worth doing — see `explainProgramError`.
    const simulation = await rpc
      .simulateTransaction(wire, {
        encoding: 'base64',
        commitment,
        replaceRecentBlockhash: true,
        sigVerify: false,
      })
      .send();
    if (simulation.value.err) {
      throw new Error(
        `simulation failed: ${explainProgramError(simulation.value.err)}\n` +
          (simulation.value.logs ?? []).map((line) => `    ${line}`).join('\n'),
      );
    }

    await rpc.sendTransaction(wire, { encoding: 'base64', preflightCommitment: commitment }).send();

    const signature = getSignatureFromTransaction(signed);
    await confirm(signature);
    return signature;
  }

  async function confirm(signature: string): Promise<void> {
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    for (;;) {
      const { value } = await rpc
        .getSignatureStatuses([signature as never], { searchTransactionHistory: false })
        .send();
      const status = value[0];
      if (status?.err) {
        throw new Error(`transaction ${signature} failed: ${explainProgramError(status.err)}`);
      }
      if (
        status?.confirmationStatus === 'confirmed' ||
        status?.confirmationStatus === 'finalized'
      ) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(`transaction ${signature} not confirmed within ${CONFIRM_TIMEOUT_MS}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, CONFIRM_POLL_MS));
    }
  }

  return { rpc, send, confirm };
}

/**
 * Turn `{"InstructionError":[0,{"Custom":6008}]}` into `StatusDoesNotSlash`.
 *
 * The mapping is the generated error catalog, which is the program's own
 * `#[error_code]` enum by way of the IDL. Reading a raw `0x1778` out of a devnet
 * log and going to look it up in `error.rs` is the exact task the typed client
 * exists to delete.
 */
export function explainProgramError(err: unknown): string {
  const custom = extractCustomCode(err);
  if (custom === null) {
    // A `bigint` anywhere in the RPC's error object makes plain `JSON.stringify`
    // throw "Do not know how to serialize a BigInt" — and it then throws from
    // inside the handler that was reporting the *real* failure, replacing a
    // named program error with a message about JSON. `@solana/kit` decodes u64
    // fields as bigint, so this is the common case rather than the exotic one.
    return JSON.stringify(err, (_key, value) => (typeof value === 'bigint' ? `${value}` : value));
  }
  const name = getAssayPaymentErrorMessage(custom as AssayPaymentError);
  return name
    ? `${name} (custom program error ${custom} / 0x${custom.toString(16)})`
    : `custom program error ${custom} / 0x${custom.toString(16)}`;
}

function extractCustomCode(err: unknown): number | null {
  if (!err || typeof err !== 'object') {
    return null;
  }
  const instructionError = (err as { InstructionError?: unknown }).InstructionError;
  if (!Array.isArray(instructionError) || instructionError.length < 2) {
    return null;
  }
  const detail = instructionError[1];
  if (detail && typeof detail === 'object' && typeof (detail as any).Custom === 'number') {
    return (detail as { Custom: number }).Custom;
  }
  return null;
}

/**
 * Load a `solana-keygen` JSON array as a signer.
 *
 * These scripts hold real keys, which is why they are scripts: the settlement
 * program's admin key is deliberately not reachable from the running service —
 * see `docs/architecture.md` §"Signing Keys". Nothing in `src/` may call this.
 */
export async function loadKeypairSigner(path: string): Promise<KeyPairSigner> {
  const bytes = Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]);
  return createKeyPairSignerFromBytes(bytes);
}

/** Convenience for scripts that print an address before they act on it. */
export function shortAddress(value: Address | string): string {
  const text = String(value);
  return `${text.slice(0, 6)}…${text.slice(-4)}`;
}
