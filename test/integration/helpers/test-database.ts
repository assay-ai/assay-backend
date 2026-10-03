import { createHash } from 'node:crypto';
import { Client } from 'pg';

import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AssetId } from '@modules/chains/ports/caip.types';

export const USDC_ASSET: AssetId = ASSET_IDS.USDC_SOLANA_MAINNET;
export const USDC_DECIMALS = 6;

/**
 * Concurrency tests fire many simultaneous transactions, each of which holds a
 * connection for the whole of its row lock. A default pool of ten would turn a
 * lock-contention test into a connection-queueing test and hide the thing being
 * measured.
 */
export const TEST_POOL_SIZE = 30;

export function testConnectionOptions() {
  return {
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    username: process.env.DATABASE_USER || 'postgres',
    password: process.env.DATABASE_PASSWORD || 'postgres',
  };
}

/**
 * Creates a test database if it does not exist, and returns its name.
 *
 * A dedicated database rather than the development one: these suites write
 * thousands of journal rows that can never be deleted, and pointing that at
 * `app` would make a developer's local data unusable within a few runs.
 */
export async function ensureTestDatabase(database: string): Promise<string> {
  const connection = testConnectionOptions();

  const admin = new Client({
    host: connection.host,
    port: connection.port,
    user: connection.username,
    password: connection.password,
    database: 'postgres',
  });

  await admin.connect();
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (existing.rowCount === 0) {
      // Identifier, not a value — it cannot be parameterised, so it is quoted.
      await admin.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`);
    }
  } finally {
    await admin.end();
  }

  return database;
}

/**
 * A stable uuid for a human-readable label.
 *
 * `intent_id`, `agent_id` and friends are `uuid` columns, so a test cannot pass
 * `'intent-release-twice'` directly. Hashing the label keeps the test reading
 * in intents and agents rather than in opaque uuids, while still handing the
 * schema the type it declares. Deterministic on purpose: the same label inside
 * one test is the same entity, which is what the uniqueness indexes are there
 * to police.
 */
export function uuidFromLabel(label: string): string {
  const hash = createHash('sha1').update(label).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    ((parseInt(hash.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
}
