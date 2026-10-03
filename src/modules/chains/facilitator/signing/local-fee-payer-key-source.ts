import { LOCAL_FEE_PAYER_KEYPAIR_ENV } from './signer.constants';

/** ed25519 seed. */
const SEED_BYTES = 32;
/** `solana-keygen`'s format: seed followed by the public half. */
const KEYPAIR_BYTES = 64;

/**
 * Takes the local fee payer's key material out of the environment, and
 * **removes the variable**.
 *
 * ## Why this exists next to `LOCAL_FEE_PAYER_KEYPAIR_PATH`
 *
 * The path form needs a *file*, and a deployment config cannot make one — it can only
 * be mounted as a volume, which is a change to the deployment rather than to
 * configuration. Every other key this platform holds already arrives as a
 * variable and is read by `takeEnvSigningKeys`; the fee payer was the last one
 * that did not, purely because it was written first.
 *
 * Both forms stay supported and the path keeps working unchanged, because a
 * developer's `.env` pointing at `solana-keygen` output is the case this signer
 * was built for.
 *
 * ## The delete is the point
 *
 * Same reasoning as `backends/env-key-source.ts`, which says it at length: a
 * crash reporter, a diagnostics route, a child process and a stray
 * `console.log(process.env)` all read the environment *later* than boot, and
 * all four find nothing once the variable is gone. That is a property which
 * holds for code nobody has written yet, unlike grepping today's code and
 * finding no leak.
 *
 * The variable is deleted even when parsing fails, so a malformed value is not
 * left lying in the environment for the rest of the process's life.
 *
 * ## No error quotes its input
 *
 * `JSON.parse` puts the offending text in its message, so re-raising it on key
 * material prints the key into the boot log. Every throw below names the
 * variable and the expected shape, never the value.
 */
export function takeLocalFeePayerKeypair(env: NodeJS.ProcessEnv = process.env): Uint8Array | null {
  const raw = env[LOCAL_FEE_PAYER_KEYPAIR_ENV];
  if (raw === undefined) {
    return null;
  }

  delete env[LOCAL_FEE_PAYER_KEYPAIR_ENV];

  const trimmed = raw.trim();
  if (trimmed === '') {
    // Unset and "set to empty" mean the same thing to an operator, and a
    // deployment config writes an empty string for a key left blank in the UI.
    return null;
  }

  const bytes = trimmed.startsWith('[') ? fromJsonArray(trimmed) : fromHex(trimmed);

  if (bytes.length !== SEED_BYTES && bytes.length !== KEYPAIR_BYTES) {
    throw new Error(
      `${LOCAL_FEE_PAYER_KEYPAIR_ENV} decoded to ${bytes.length} bytes; ` +
        `expected ${SEED_BYTES} (seed) or ${KEYPAIR_BYTES} (solana-keygen keypair)`,
    );
  }

  return bytes;
}

function fromJsonArray(value: string): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    // Deliberately not re-raising the original: its message embeds the input.
    throw new Error(`${LOCAL_FEE_PAYER_KEYPAIR_ENV} looks like a JSON array but did not parse`);
  }

  if (!Array.isArray(parsed) || !parsed.every(isByte)) {
    throw new Error(`${LOCAL_FEE_PAYER_KEYPAIR_ENV} must be an array of whole numbers 0-255`);
  }

  return Uint8Array.from(parsed as number[]);
}

function fromHex(value: string): Uint8Array {
  const hex = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;

  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`${LOCAL_FEE_PAYER_KEYPAIR_ENV} must be a solana-keygen JSON array or hex`);
  }

  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function isByte(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255;
}
