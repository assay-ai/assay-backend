import { takeOnceFromEnv } from '@modules/verification/signing/backends/env-key-source';

import { Kek } from './credential-vault.crypto';

export const CREDENTIAL_VAULT_KEKS_ENV = 'CREDENTIAL_VAULT_KEKS';

/** DI token for the loaded key set: `{ active, byId }`. */
export const CREDENTIAL_VAULT_KEKS = Symbol('CREDENTIAL_VAULT_KEKS');

export interface VaultKeks {
  /** The first listed key; encrypts new sets. `null` when the variable is unset. */
  active: Kek | null;
  byId: ReadonlyMap<string, Kek>;
}

const MAX_KEY_ID_LENGTH = 64; // binding_credentials.kek_id is varchar(64)

// Every message below is hand-written. None interpolates the value being parsed:
// JSON.parse errors quote their input, so they are caught and replaced.
function parseKeks(raw: string): readonly Kek[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${CREDENTIAL_VAULT_KEKS_ENV} is not valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${CREDENTIAL_VAULT_KEKS_ENV} must be a JSON array of { keyId, key }`);
  }
  const seen = new Set<string>();
  return parsed.map((entry: unknown, index: number): Kek => {
    const { keyId, key } = (entry ?? {}) as { keyId?: unknown; key?: unknown };
    if (typeof keyId !== 'string' || keyId.trim() === '' || keyId.length > MAX_KEY_ID_LENGTH) {
      throw new Error(`${CREDENTIAL_VAULT_KEKS_ENV} entry ${index} has no valid keyId`);
    }
    if (seen.has(keyId)) {
      throw new Error(`${CREDENTIAL_VAULT_KEKS_ENV} has a duplicate keyId at entry ${index}`);
    }
    seen.add(keyId);
    if (typeof key !== 'string' || !/^[0-9a-fA-F]{64}$/.test(key)) {
      throw new Error(
        `${CREDENTIAL_VAULT_KEKS_ENV} entry ${index} key must be 64 hex characters (32 bytes)`,
      );
    }
    return { keyId, key: Buffer.from(key, 'hex') };
  });
}

/** Reads the KEKs once and removes the variable from `env`. The first entry is active. */
export function takeVaultKeks(env: NodeJS.ProcessEnv): VaultKeks {
  const keks = takeOnceFromEnv<Kek>(env, CREDENTIAL_VAULT_KEKS_ENV, parseKeks);
  return {
    active: keks[0] ?? null,
    byId: new Map(keks.map((k) => [k.keyId, k])),
  };
}
