import { VERIFIER_SIGNING_KEYS_ENV } from '../signing.constants';
import { VerificationErrors } from '../../errors/verification.errors';

/**
 * One key's material, on its way from `process.env` into a non-extractable
 * `CryptoKey` and nowhere else.
 *
 * Lives for the length of `EnvKeypairSigner`'s constructor. The `seed` buffer is
 * zeroed the moment the key is imported.
 */
export interface EnvSigningKeySource {
  readonly keyId: string;
  /** The 32-byte ed25519 seed. */
  readonly seed: Uint8Array;
  /**
   * The 32 bytes the operator claimed are the public half, when they supplied a
   * 64-byte key. `null` for a bare seed. Checked against the derived public key
   * rather than trusted — see `EnvKeypairSigner`.
   */
  readonly claimedPublicKey: Uint8Array | null;
}

/**
 * Reads the key material out of the environment and **removes it from
 * `process.env`**.
 *
 * ## Why the delete is the point of this function
 *
 * The first check on key custody is to prove that key material appears in no log,
 * no environment dump and no response. Grepping and finding nothing is evidence
 * about the code that exists today; deleting the variable is a property that
 * holds for code nobody has written yet. Every one of these is a real way an
 * environment variable reaches a log file, and all of them read the environment
 * *later* than boot:
 *
 * ```text
 * a crash reporter attaching process.env to a stack trace
 * a /health or /diagnostics handler echoing configuration
 * a child process inheriting the environment
 * console.log(process.env) left in during a debugging session
 * ```
 *
 * After this function returns, all four of them find nothing, because there is
 * nothing there. This is the single highest-leverage line in the env backend,
 * and it is the reason an environment variable is a defensible MVP custody
 * story rather than merely an expedient one.
 *
 * It is also why parsing happens here, once, at boot: a lazy read would mean the
 * variable had to survive, and then none of the above would be true.
 *
 * ## Why the variable is a parameter
 *
 * A second env-held ed25519 key was once added — the exposure authority,
 * which signed `record_exposure` — and it was read through this same function
 * with a different variable name rather than through a second parser that would
 * have had to re-earn all four properties above. That key and the instruction
 * have since been removed. The parameter stays: the next env-held key gets the same
 * treatment for the same reason, and the default keeps every existing caller
 * unchanged.
 */
/**
 * What a variable parsed to, the first time it was taken in this process.
 *
 * ## Why this cache exists, and why it costs nothing
 *
 * The variable is deleted on the first read — that is the whole point — so a
 * *second* consumer in the same process used to get an empty list and no error.
 * That is not hypothetical: `SERVICE_TYPE=all` runs all six bootstraps in one
 * process, and both the worker and the scheduler need the verifier signer. The
 * scheduler happened to initialise second and its signer came up empty, so
 * every slash failed with "No signing key … in the env backend" while the
 * worker's identical signer was fine. Nothing logged a warning; the key was
 * simply gone.
 *
 * Caching the **parsed** result does not widen exposure. The material is
 * already resident in this process the moment the first caller parsed it, and
 * the raw string is still deleted before anything can throw — a debugger
 * dumping `process.env` still finds nothing, which is the property the deletion
 * buys. What changes is only that the second asker gets the same answer as the
 * first instead of silently getting none.
 */
const takenByVariable = new Map<string, readonly unknown[]>();

/**
 * Take one variable's value, delete it, parse it once, and remember the answer.
 *
 * Extracted so the secp256k1 backend's `EVM_VERIFIER_SIGNING_KEYS` gets
 * the *same* deletion, the same take-once cache and the same
 * parse-errors-never-quote-the-input discipline rather than a second parser
 * that has to re-earn all three. There is one cache and one `delete env[…]` in
 * this codebase, and that is the point: a second copy is a second chance to
 * leave a key in the environment.
 *
 * `parse` runs AFTER the deletion and its result is cached only when it
 * returned — a malformed value must fail the same way for the second caller as
 * for the first, not be remembered as valid.
 */
export function takeOnceFromEnv<T>(
  env: NodeJS.ProcessEnv,
  variable: string,
  parse: (raw: string) => readonly T[],
): readonly T[] {
  const alreadyTaken = takenByVariable.get(variable);
  if (alreadyTaken) {
    // Still delete, in case the variable was re-set between calls: a value that
    // reappeared must not survive in the environment either.
    delete env[variable];
    return alreadyTaken as readonly T[];
  }

  const raw = env[variable];

  // Deleted before the first thing that can throw. A malformed value must not
  // be left in the environment because parsing it failed — that is precisely
  // the run where somebody attaches a debugger and dumps the environment.
  delete env[variable];

  const parsed = !raw || raw.trim() === '' ? [] : parse(raw);
  takenByVariable.set(variable, parsed);
  return parsed;
}

/**
 * Forget what was taken. **Tests only.**
 *
 * The cache is per process and a process reads its keys once at boot, so
 * production never needs this. A suite that exercises several malformed and
 * well-formed values in one process does — without it the second case would
 * assert against the first case's answer, which is a green test proving
 * nothing.
 */
export function resetEnvSigningKeyCacheForTests(): void {
  takenByVariable.clear();
}

export function takeEnvSigningKeys(
  env: NodeJS.ProcessEnv,
  variable: string = VERIFIER_SIGNING_KEYS_ENV,
): readonly EnvSigningKeySource[] {
  return takeOnceFromEnv(env, variable, (raw) => {
    const entries = parseEntries(raw, variable);
    const seen = new Set<string>();
    return entries.map((entry, index) => {
      const keyId = readKeyId(entry, index);
      assertKeyIdUnseen(seen, keyId);
      return { keyId, ...readSecret(entry, keyId) };
    });
  });
}

/** A key id resolves to exactly one key, in every variable. */
export function assertKeyIdUnseen(seen: Set<string>, keyId: string): void {
  if (seen.has(keyId)) {
    throw VerificationErrors.signingKeyMaterialInvalid({
      reason: `duplicate keyId "${keyId}" — a key id resolves to exactly one key`,
    });
  }
  seen.add(keyId);
}

// ── Internals ──────────────────────────────────────────────────────────────
//
// Every throw below is `signingKeyMaterialInvalid` with a hand-written reason,
// and no path interpolates the value being parsed. That is not stylistic.
// `JSON.parse` on Node quotes the offending input in its message — so
// `throw new Error(e.message)` on a malformed key would print key material into
// the log line of the boot failure, which is the exact leak this whole file
// exists to prevent. The parse error is caught and replaced, never re-raised.

export function parseEntries(raw: string, variable: string): readonly unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw VerificationErrors.signingKeyMaterialInvalid({
      reason: `${variable} is not valid JSON`,
    });
  }
  if (!Array.isArray(parsed)) {
    throw VerificationErrors.signingKeyMaterialInvalid({
      reason: `${variable} must be a JSON array of { keyId, secretKey }`,
    });
  }
  return parsed;
}

export function readKeyId(entry: unknown, index: number): string {
  const keyId = (entry as { keyId?: unknown })?.keyId;
  if (typeof keyId !== 'string' || keyId.trim() === '') {
    throw VerificationErrors.signingKeyMaterialInvalid({
      reason: `entry ${index} has no keyId`,
    });
  }
  return keyId;
}

function readSecret(
  entry: unknown,
  keyId: string,
): { seed: Uint8Array; claimedPublicKey: Uint8Array | null } {
  const secret = (entry as { secretKey?: unknown })?.secretKey;
  const bytes = toBytes(secret, keyId);

  // 32 is a bare ed25519 seed; 64 is the `solana-keygen` form, seed followed by
  // the public key. Both are shapes an operator actually has in hand, and
  // refusing the common one would get worked around with a conversion step
  // done by hand, at 3am, with the key on a clipboard.
  if (bytes.length === 32) {
    return { seed: bytes, claimedPublicKey: null };
  }
  if (bytes.length === 64) {
    return { seed: bytes.slice(0, 32), claimedPublicKey: bytes.slice(32) };
  }
  throw VerificationErrors.signingKeyMaterialInvalid({
    reason: `key "${keyId}" is ${bytes.length} bytes; expected 32 (seed) or 64 (seed+public)`,
  });
}

function toBytes(secret: unknown, keyId: string): Uint8Array {
  // The `solana-keygen` file format, pasted straight in.
  if (Array.isArray(secret)) {
    if (!secret.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw VerificationErrors.signingKeyMaterialInvalid({
        reason: `key "${keyId}" is an array but not of bytes`,
      });
    }
    return Uint8Array.from(secret as number[]);
  }

  if (typeof secret !== 'string' || secret.trim() === '') {
    throw VerificationErrors.signingKeyMaterialInvalid({
      reason: `key "${keyId}" has no secretKey`,
    });
  }

  // Hex, and deliberately *not* base58. Base58 is the encoding a Solana wallet
  // exports, so accepting it here would be the convenient choice — but it would
  // put a chain-flavoured codec inside the one component that is meant to
  // outlive any particular chain, and `scripts/verifier-key/generate.ts` emits
  // the ready-made line anyway, so no operator ever converts anything by hand.
  const hex = secret.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) {
    throw VerificationErrors.signingKeyMaterialInvalid({
      reason: `key "${keyId}" is not hex — use scripts/verifier-key/generate.ts, which emits it`,
    });
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}
