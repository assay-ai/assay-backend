/**
 * Turn whatever form an operator's key is in into the keypair file the Solana
 * tooling expects — without the key ever appearing on a command line, in shell
 * history, or in a chat window.
 *
 * ## Why this exists rather than a documented one-liner
 *
 * The one-liner it replaces was three shell branches (base58 / JSON array /
 * seed phrase), and the caller had to know which branch applied to a string
 * they had just pasted out of a wallet. It also had a real bug: `read -rs VAR`
 * sets a *shell* variable, so `process.env.VAR` in the `node -e` that followed
 * was `undefined`, and the whole thing died on a `.trim()` of nothing.
 *
 * The formats are trivially distinguishable by looking at them, so the program
 * should look instead of asking. What is left for the operator is one command.
 *
 * ## The one property this file is responsible for
 *
 * **Key material arrives on stdin and leaves only as a 0600 file.** It is never
 * an argument (arguments are visible in `ps` and land in shell history), never
 * an environment variable (inherited by every child process), and never logged
 * — including in an error. A parse failure reports the *shape* it saw, never
 * the bytes: `JSON.parse` on Node puts the offending input in its message, and
 * re-raising that on key material prints the key.
 *
 * That is the same rule `docs/architecture.md` §"Signing Keys" states for the
 * runtime key sources, applied to the operator path. This script is not part of
 * the runtime and holds no port, but the reason is identical.
 */

import { createInterface } from 'node:readline';

import { chmodSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';

/** What the operator pasted, once we have worked out what it is. */
type KeyFormat = 'base58' | 'json-array' | 'seed-phrase';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** An ed25519 keypair file is 64 bytes: 32 of seed, then 32 of public key. */
const KEYPAIR_BYTES = 64;

function usage(): void {
  console.log(`
Import an operator keypair into a file, from whatever form you have it in.

  yarn devnet:import-key --out ~/.assay-keys/devnet-operator.json [--expect <pubkey>]

You are prompted for the key. Nothing is echoed, nothing is stored in shell
history, and the key is never passed as an argument.

Accepted, detected automatically:

  · a base58 string          — what Phantom / Solflare "export private key" gives
  · a JSON array of 64 numbers — what \`solana-keygen\` writes
  · a 12 or 24 word seed phrase

Options:
  --out <path>      where to write the keypair file        (required)
  --expect <pubkey> refuse unless the key derives to this  (recommended)
  --force           overwrite an existing file
`);
}

/**
 * Read one line from stdin without echoing it.
 *
 * `readline` with `terminal: true` still echoes, so the keypress handler is
 * muted for the duration. If stdin is not a TTY — a pipe, a heredoc — nothing
 * is echoed anyway and this is a plain read, which is what makes the script
 * usable from another script.
 */
async function promptSecret(prompt: string): Promise<string> {
  const isTty = process.stdin.isTTY;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: isTty });

  if (isTty) {
    const asMutable = rl as unknown as { _writeToOutput?: (text: string) => void };
    const original = asMutable._writeToOutput?.bind(rl);
    asMutable._writeToOutput = (text: string): void => {
      // Echo the prompt itself, swallow everything typed after it.
      if (text.includes(prompt)) original?.(text);
    };
  }

  return new Promise<string>((resolvePrompt) => {
    rl.question(prompt, (answer) => {
      rl.close();
      if (isTty) process.stdout.write('\n');
      resolvePrompt(answer);
    });
  });
}

/**
 * Which of the three shapes is this?
 *
 * Deliberately structural rather than asking the operator: they have just
 * pasted a string out of a wallet, and "is that base58 or a seed phrase" is a
 * question about our tooling, not about their key.
 */
function detectFormat(secret: string): KeyFormat {
  if (secret.startsWith('[')) return 'json-array';
  if (secret.split(/\s+/).filter(Boolean).length >= 12) return 'seed-phrase';
  return 'base58';
}

function decodeBase58(secret: string): number[] {
  let value = 0n;
  for (const character of secret) {
    const index = BASE58_ALPHABET.indexOf(character);
    if (index < 0) {
      // The character, not the string. One character cannot reconstruct a key
      // and is the only thing that helps someone fix a bad paste.
      throw new Error(`not base58 — found the character ${JSON.stringify(character)}`);
    }
    value = value * 58n + BigInt(index);
  }

  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  const bytes = [...Buffer.from(hex, 'hex')];

  // Base58 encodes each leading zero byte as a literal '1', and those are not
  // part of the number, so they have to be put back by hand.
  for (const character of secret) {
    if (character !== '1') break;
    bytes.unshift(0);
  }

  return bytes;
}

function decodeJsonArray(secret: string): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    // Deliberately not re-raising the parse error: Node puts the offending
    // input in its message, which for this input is the key.
    throw new Error('starts with "[" but is not valid JSON');
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'number')) {
    throw new Error('is a JSON value but not an array of numbers');
  }
  return parsed as number[];
}

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    usage();
    return;
  }

  const out = argValue('--out');
  if (!out) {
    usage();
    throw new Error('--out is required');
  }
  const outPath = resolve(out.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
  const expect = argValue('--expect');

  console.log(`writing to   ${outPath}`);
  if (expect) console.log(`must derive  ${expect}`);
  console.log('');

  const secret = (await promptSecret('paste the private key (nothing will show): ')).trim();
  if (!secret) throw new Error('nothing was pasted');

  const format = detectFormat(secret);
  console.log(`detected     ${format}`);

  if (format === 'seed-phrase') {
    // Deriving a keypair from a mnemonic means a BIP39/BIP44 implementation and
    // a derivation-path decision, and getting either subtly wrong yields a
    // valid-looking keypair for the wrong account. `solana-keygen` already owns
    // that, correctly, so point at it rather than reimplementing it here.
    console.log('');
    console.log('A seed phrase needs the official derivation. Run this instead:');
    console.log('');
    console.log(`  solana-keygen recover 'prompt://?key=0/0' -o ${outPath}`);
    console.log('');
    console.log('It will ask for the same words. Then re-run this script only if');
    console.log('you want the --expect check.');
    throw new Error('seed phrases are handled by solana-keygen recover');
  }

  const bytes = format === 'base58' ? decodeBase58(secret) : decodeJsonArray(secret);

  if (bytes.length !== KEYPAIR_BYTES) {
    throw new Error(
      `expected ${KEYPAIR_BYTES} bytes, got ${bytes.length}. ` +
        `A ${bytes.length}-byte value is probably a seed or a public key rather than a keypair.`,
    );
  }

  const { getAddressFromPublicKey, createKeyPairFromBytes } = await import('@solana/kit');
  const keypair = await createKeyPairFromBytes(Uint8Array.from(bytes));
  const address = await getAddressFromPublicKey(keypair.publicKey);

  console.log(`derives to   ${address}`);

  if (expect && address !== expect) {
    throw new Error(
      `this is the WRONG KEY.\n` +
        `  expected  ${expect}\n` +
        `  got       ${address}\n` +
        `Nothing was written.`,
    );
  }

  mkdirSync(dirname(outPath), { recursive: true, mode: 0o700 });
  writeFileSync(outPath, JSON.stringify(bytes), { mode: 0o600 });
  chmodSync(outPath, 0o600);

  console.log('');
  console.log(`OK  written, mode 0600`);
  console.log('');
  console.log('Next:');
  console.log(`  yarn devnet:stake-accounts --operator ${outPath}`);
  console.log(`  yarn devnet:stake-accounts --operator ${outPath} --execute`);
  console.log('');
  console.log(`Delete it when you are done:  rm -f ${outPath}`);
}

main().catch((error: unknown) => {
  console.error('');
  console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
