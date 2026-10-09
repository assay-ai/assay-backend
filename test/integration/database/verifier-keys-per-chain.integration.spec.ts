import { join } from 'path';

import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { CHAIN_IDS } from '@modules/chains/ports/caip.types';

import { ensureTestDatabase, testConnectionOptions } from '../helpers/test-database';

/**
 * The per-chain verifier-key migration, asserted against a real Postgres schema.
 *
 * ## Why this cannot be a unit test
 *
 * The unit suite runs over an in-memory `Map` where CHECK constraints and
 * partial unique indexes do not exist — that is how three maker/checker defects
 * survived 2 850 green tests. Every claim below is a claim about what the
 * *database* refuses, and only a database can be asked.
 *
 * ## The three blockers, each with its positive control beside it
 *
 * 1. `uniq_verifier_signing_keys_active` was `UNIQUE (state) WHERE state =
 *    'ACTIVE'` — a unique index on a constant, so **one ACTIVE row in the whole
 *    table**. Inserting an EVM key would have collided with the Solana one.
 * 2. `chk_verifier_signing_keys_public_key_hex` was `^[0-9a-f]{64}$`. The column
 *    was widened to `varchar(256)` earlier; **the CHECK was not**, so a 130-hex
 *    uncompressed secp256k1 key still could not be stored.
 * 3. `chk_verifier_signing_log_signature_hex` was `^[0-9a-f]{128}$`. A 65-byte
 *    EVM signature is 130 hex, so every EVM signature would have failed to
 *    journal *after* it had already been produced.
 */
describe('verifier keys, one ACTIVE per chain', () => {
  const DATABASE = 'x402_verifier_chain_test';
  const SOLANA = CHAIN_IDS.SOLANA_DEVNET;
  const EVM = CHAIN_IDS.ROBINHOOD_TESTNET;

  /** 32 bytes of ed25519, and 65 of uncompressed secp256k1, as hex. */
  const ED25519_KEY = 'a'.repeat(64);
  const SECP256K1_KEY = `04${'b'.repeat(128)}`;

  let dataSource: DataSource;

  beforeAll(async () => {
    // Dropped first, every run: `ensureTestDatabase` alone would reuse a
    // database built by a migration set that may no longer be on disk, and
    // `runMigrations` would then be a no-op that leaves this suite asserting
    // the OLD schema — green with the new migration deleted, which is the one
    // thing it most has to catch.
    await dropDatabase(DATABASE);
    await ensureTestDatabase(DATABASE);

    dataSource = new DataSource({
      type: 'postgres',
      ...testConnectionOptions(),
      database: DATABASE,
      entities: [],
      migrations: [join(__dirname, '../../../src/database/postgres/migrations/*.ts')],
      synchronize: false,
      migrationsRun: false,
    });
    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'all' });
  }, 300_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  beforeEach(async () => {
    await dataSource.query('delete from verifier_signing_log');
    await dataSource.query('delete from verifier_signing_keys');
  });

  it('admits one ACTIVE key per chain and refuses a second on the SAME chain', async () => {
    await expect(
      insertKey({ keyId: 'verifier-solana-2026-09', chainId: SOLANA, state: 'ACTIVE' }),
    ).resolves.toBeUndefined();

    // The whole point of the migration: a second chain's ACTIVE key must NOT
    // collide with the first's.
    await expect(
      insertKey({
        keyId: 'verifier-evm-2026-09',
        chainId: EVM,
        state: 'ACTIVE',
        publicKey: SECP256K1_KEY,
      }),
    ).resolves.toBeUndefined();

    // And the invariant the old index actually protected must survive — named,
    // so that a test passing because of some OTHER unique constraint (there are
    // two on this table) would not read as this one holding.
    await expect(
      insertKey({ keyId: 'verifier-solana-2026-10', chainId: SOLANA, state: 'ACTIVE' }),
    ).rejects.toThrow(/uniq_verifier_signing_keys_active_per_chain/);
  });

  it('lets a chain hold many non-ACTIVE keys, so a rotation has somewhere to go', async () => {
    // The positive control for the index above: the partial predicate is
    // `WHERE state = 'ACTIVE'`, and an index that ignored the predicate would
    // make this fail — and would make a rotation impossible, since the outgoing
    // key has to stay resolvable through the cutover.
    await insertKey({ keyId: 'a', chainId: SOLANA, state: 'RETIRED' });
    await insertKey({ keyId: 'b', chainId: SOLANA, state: 'REVOKED' });
    await insertKey({ keyId: 'c', chainId: SOLANA, state: 'PENDING' });

    await expect(
      insertKey({ keyId: 'd', chainId: SOLANA, state: 'ACTIVE' }),
    ).resolves.toBeUndefined();
  });

  it('accepts both key shapes and refuses one that is neither', async () => {
    // Ordinarily a migration test asserts the end state. This one asserts the
    // CHECK is doing work: an ed25519-shaped 64-hex key and a secp256k1-shaped
    // 130-hex key both pass, and a 100-hex key — neither shape — does not.
    await expect(
      insertKey({ keyId: 'ed', chainId: SOLANA, state: 'PENDING', publicKey: ED25519_KEY }),
    ).resolves.toBeUndefined();
    await expect(
      insertKey({ keyId: 'ec', chainId: EVM, state: 'PENDING', publicKey: SECP256K1_KEY }),
    ).resolves.toBeUndefined();

    await expect(
      insertKey({ keyId: 'no', chainId: EVM, state: 'PENDING', publicKey: 'a'.repeat(100) }),
    ).rejects.toThrow(/chk_verifier_signing_keys_public_key_hex/);
    // Upper case is not hex here, by the CHECK's own grammar — the column is
    // documented as lower-case and this is what enforces it.
    await expect(
      insertKey({ keyId: 'up', chainId: EVM, state: 'PENDING', publicKey: 'A'.repeat(64) }),
    ).rejects.toThrow(/chk_verifier_signing_keys_public_key_hex/);
  });

  it('refuses a chain_id that is not CAIP-2', async () => {
    // The constraint that would have caught the backfill this migration
    // deliberately does NOT do: `split_part` on a bare base58 address yields
    // `<address>:`, which fits varchar(64) and would have been accepted
    // silently by SET NOT NULL.
    await expect(
      insertKey({
        keyId: 'bad',
        chainId: 'C8LfCLA7ZYwwVpvtkkDf96Af9cNx2pQFMJ4tBArxY3N5:',
        state: 'PENDING',
      }),
    ).rejects.toThrow(/chk_verifier_signing_keys_chain_id/);
    // The positive control: a real chain id on the same path is accepted.
    await expect(
      insertKey({ keyId: 'good', chainId: SOLANA, state: 'PENDING' }),
    ).resolves.toBeUndefined();
  });

  it('journals a 130-hex EVM signature as readily as a 128-hex ed25519 one', async () => {
    await expect(insertLogRow('c'.repeat(128), SOLANA)).resolves.toBeUndefined();
    await expect(insertLogRow('d'.repeat(130), EVM)).resolves.toBeUndefined();
    // Neither shape.
    await expect(insertLogRow('e'.repeat(129), EVM)).rejects.toThrow(
      /chk_verifier_signing_log_signature_hex/,
    );
    // And a refusal still journals: `signature` stays nullable, because a row
    // that records an ATTEMPT has no signature yet and losing it would make a
    // burst of refusals — the actual signal that a key is being abused — look
    // like a quiet week.
    await expect(insertLogRow(null, null)).resolves.toBeUndefined();
  });

  async function insertKey(fields: {
    keyId: string;
    chainId: string;
    state: string;
    publicKey?: string;
  }): Promise<void> {
    await dataSource.query(
      `insert into verifier_signing_keys
         (key_id, backend, backend_ref, public_key, chain_id, state)
       values ($1, 'env', 'env:TEST', $2, $3, $4)`,
      [
        fields.keyId,
        // Unique per key id: `uq_verifier_signing_keys_public_key` exists, and a
        // shared default would make every one of these tests pass or fail for
        // that constraint instead of the one it names.
        fields.publicKey ?? uniqueEd25519Key(fields.keyId),
        fields.chainId,
        fields.state,
      ],
    );
  }

  async function insertLogRow(signature: string | null, chainId: string | null): Promise<void> {
    await dataSource.query(
      `insert into verifier_signing_log
         (key_id, public_key, purpose, requested_by_type, requested_by_id,
          payload_sha256, signature, outcome, chain_id)
       values ('k', $1, 'test', 'service', 'test', $2, $3, $4, $5)`,
      [
        ED25519_KEY,
        'f'.repeat(64),
        signature,
        signature === null ? 'ATTEMPTED' : 'SIGNED',
        chainId,
      ],
    );
  }

  /** 64 lower-case hex characters, deterministic in the key id. */
  function uniqueEd25519Key(keyId: string): string {
    const seed = Buffer.from(keyId).toString('hex');
    return (seed + '0'.repeat(64)).slice(0, 64);
  }

  /** `WITH (FORCE)` because a previous run's pool may still be attached. */
  async function dropDatabase(database: string): Promise<void> {
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
      await admin.query(`DROP DATABASE IF EXISTS "${database.replace(/"/g, '""')}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }
});
