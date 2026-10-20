/**
 * Persists devnet keypairs to disk so the devnet scripts are idempotent and
 * re-runnable: the second run reuses the same mint authority and the same
 * "user" wallet instead of minting a fresh set of on-chain state every time.
 *
 * Secrets never leave `scripts/devnet/.keys/` (gitignored — see the
 * `.gitignore` in that directory) and never get logged.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Keypair } from '@solana/web3.js';

const KEYS_DIR = join(__dirname, '..', '.keys');

function ensureDir(): void {
  if (!existsSync(KEYS_DIR)) {
    mkdirSync(KEYS_DIR, { recursive: true });
  }
}

/** Loads a web3.js `Keypair` from `<name>.json`, generating and persisting one if absent. */
export function loadOrCreateKeypair(name: string): Keypair {
  ensureDir();
  const path = join(KEYS_DIR, `${name}.json`);

  if (existsSync(path)) {
    const secret = Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')));
    return Keypair.fromSecretKey(secret);
  }

  const keypair = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)));
  return keypair;
}

/** Reads or writes a small piece of persisted state (a mint address, a multisig create_key, …). */
export function loadState<T>(name: string): T | null {
  ensureDir();
  const path = join(KEYS_DIR, `${name}.json`);
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function saveState<T>(name: string, value: T): void {
  ensureDir();
  const path = join(KEYS_DIR, `${name}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

export const KEYSTORE_DIR = KEYS_DIR;
