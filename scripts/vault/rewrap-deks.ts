/**
 * Re-wraps every credential set's DEK under the active KEK.
 *
 *   CREDENTIAL_VAULT_KEKS='[{"keyId":"k2","key":"<hex>"},{"keyId":"k1","key":"<hex>"}]' \
 *     yarn ts-node -T -r tsconfig-paths/register scripts/vault/rewrap-deks.ts
 *
 * The first listed key is active; every key that still wraps a row must be
 * listed. Only `wrapped_dek`, `dek_iv` and `kek_id` change, the `ciphertext` is
 * untouched. Batches of 500, one transaction per batch. Re-runnable: rows
 * already under the active key are skipped. Prints counts only, never key
 * material, ids or origins. See docs/runbooks/rotate-vault-kek.md.
 */
import { DataSource } from 'typeorm';

import {
  credentialAad,
  rewrapDek,
} from '../../src/modules/provider/credentials/credential-vault.crypto';
import {
  takeVaultKeks,
  VaultKeks,
} from '../../src/modules/provider/credentials/credential-vault.keys';

export const REWRAP_BATCH_SIZE = 500;

export interface RewrapResult {
  rewrapped: number;
  alreadyActive: number;
  /** Rows whose KEK is not loaded, or that failed authentication. Left unchanged. */
  failed: number;
}

interface Row {
  binding_id: string;
  origin: string;
  organization_id: string;
  kek_id: string;
  wrapped_dek: Buffer;
  dek_iv: Buffer;
}

export async function rewrapAllDeks(
  dataSource: DataSource,
  keks: VaultKeks,
  batchSize = REWRAP_BATCH_SIZE,
): Promise<RewrapResult> {
  const active = keks.active;
  if (!active) throw new Error('CREDENTIAL_VAULT_KEKS is not set: there is no active key');

  const [{ count }] = await dataSource.query(
    'SELECT count(*)::int AS count FROM binding_credentials WHERE kek_id = $1',
    [active.keyId],
  );
  const result: RewrapResult = { rewrapped: 0, alreadyActive: Number(count), failed: 0 };

  // Keyset pagination over the rows not yet under the active key. Failed rows
  // stay in that set, so the cursor moves past them instead of re-reading them.
  let after: { bindingId: string; origin: string } | null = null;
  for (;;) {
    const rows: Row[] = await dataSource.query(
      `SELECT binding_id, origin, organization_id, kek_id, wrapped_dek, dek_iv
         FROM binding_credentials
        WHERE kek_id <> $1
          AND ($2::uuid IS NULL OR (binding_id, origin) > ($2::uuid, $3))
        ORDER BY binding_id, origin
        LIMIT $4`,
      [active.keyId, after?.bindingId ?? null, after?.origin ?? null, batchSize],
    );
    if (rows.length === 0) break;

    await dataSource.transaction(async (manager) => {
      for (const row of rows) {
        const from = keks.byId.get(row.kek_id);
        if (!from) {
          result.failed += 1;
          continue;
        }
        let next;
        try {
          next = rewrapDek(
            {
              kekId: row.kek_id,
              wrappedDek: row.wrapped_dek,
              dekIv: row.dek_iv,
              ciphertext: Buffer.alloc(0),
              iv: Buffer.alloc(0),
            },
            from,
            active,
            credentialAad(row.organization_id, row.binding_id, row.origin),
          );
        } catch {
          result.failed += 1;
          continue;
        }
        await manager.query(
          `UPDATE binding_credentials
              SET kek_id = $1, wrapped_dek = $2, dek_iv = $3
            WHERE binding_id = $4 AND origin = $5 AND kek_id = $6`,
          [next.kekId, next.wrappedDek, next.dekIv, row.binding_id, row.origin, row.kek_id],
        );
        result.rewrapped += 1;
      }
    });
    const last = rows[rows.length - 1];
    after = { bindingId: last.binding_id, origin: last.origin };
  }
  return result;
}

async function main(): Promise<void> {
  const keks = takeVaultKeks(process.env);
  // Imported late: it loads .env and builds the DataSource from DATABASE_*.
  const { PostgresDataSource } = await import('../../src/database/postgres/postgres.data-source');
  await PostgresDataSource.initialize();
  try {
    const r = await rewrapAllDeks(PostgresDataSource, keks);
    console.log(
      `rewrap: rewrapped=${r.rewrapped} already_active=${r.alreadyActive} failed=${r.failed}`,
    );
    if (r.failed > 0) process.exitCode = 1;
  } finally {
    await PostgresDataSource.destroy();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    // The message never carries key material: key parsing errors are hand-written.
    console.error(`rewrap failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exit(1);
  });
}
