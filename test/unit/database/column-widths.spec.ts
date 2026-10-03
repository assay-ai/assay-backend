import { readFileSync } from 'fs';
import { join } from 'path';

import { AgentEntity } from '@database/postgres/entities/agent.entity';
import { BuyerEscrowEntity } from '@database/postgres/entities/buyer-escrow.entity';
import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import { SlashProposalEntity } from '@database/postgres/entities/slash-proposal.entity';
import { VerifierSigningKeyEntity } from '@database/postgres/entities/verifier-signing-key.entity';
import { VerifierSigningLogEntryEntity } from '@database/postgres/entities/verifier-signing-log-entry.entity';
import { CAIP_BOUNDS, CAIP_MAX_LENGTHS, isAccountId } from '@modules/chains/ports/caip.types';
import { getMetadataArgsStorage } from 'typeorm';

/**
 * Every column that holds a signature, a public key or an account id is
 * wide enough for the widest encoding either chain produces.
 *
 * ## The numbers, and why 256
 *
 * | thing | encoding | characters |
 * |---|---|---|
 * | ed25519 signature | base58, 64 bytes | 88 |
 * | ed25519 signature | hex, 64 bytes | 128 |
 * | secp256k1 signature | `0x` + hex, 65 bytes | **132** |
 * | ed25519 public key | hex, 32 bytes | 64 |
 * | secp256k1 public key | `0x` + hex, 65 bytes uncompressed | **132** |
 * | CAIP-10 account id | this codebase's own grammar | **170** |
 *
 * 170 is the binding number and it is not written down here — it is
 * `CAIP_MAX_LENGTHS.accountId`, derived from the bounds `caip.types.ts` builds
 * its own regexes from. `varchar(160)` on `agents.primary_account_id`
 * therefore REJECTED an account id that `isAccountId()` accepts.
 *
 * ## What this file asserts, and why it is not the entity alone
 *
 * An earlier version of this spec read TypeORM's decorator metadata and
 * nothing else. It passed with the migration file **deleted**, with the
 * migration writing 160, and with the entity still declaring
 * `@Column({ name: 'escrow_pda' })` — because none of those three touch a
 * decorator's `length`. It proved the entities had been edited and called that
 * a schema guard.
 *
 * So the migration is now a *source*, parsed out of the file, and every claim
 * below is a two-sided pin:
 *
 * - the entity's declared width equals the required number, **and** equals the width
 *   the migration's `up()` writes for that exact column,
 * - the entity's `@Column({ name })` is the migration's rename **target**, and
 *   is never one of its rename sources,
 * - the width each column had *before* is read out of the migration's own
 *   `down()`, not typed in by hand,
 * - `down()` is the exact inverse of `up()`, statement for statement.
 *
 * `test/integration/database/column-widths.integration.spec.ts` closes the last
 * gap by reading `information_schema` on the live database. This file exists
 * separately because it needs no Docker and so runs everywhere.
 */

// ---------------------------------------------------------------------------
// The migration, as a source of truth rather than an assumption
// ---------------------------------------------------------------------------

const MIGRATION_PATH = join(
  __dirname,
  '../../../src/database/postgres/migrations/1759300000000-widen-signature-and-account-columns.ts',
);

interface ColumnRef {
  readonly table: string;
  readonly column: string;
}

interface Rename extends ColumnRef {
  readonly to: string;
}

interface ParsedMigration {
  /** `table.column` → the width this half of the migration sets. */
  readonly widths: ReadonlyMap<string, number>;
  readonly renames: readonly Rename[];
}

const key = (table: string, column: string): string => `${table}.${column}`;

/**
 * Pulls every `ALTER COLUMN … TYPE character varying(n)` and every
 * `RENAME COLUMN … TO …` out of one method body.
 *
 * Deliberately a parser over the file rather than a second hand-written list:
 * a list would have to be kept in step with the migration by the same person
 * who forgot to keep the migration in step with the entity.
 */
function parseBody(body: string): ParsedMigration {
  const widths = new Map<string, number>();
  const renames: Rename[] = [];

  // Each `ALTER TABLE "t"` opens a statement that runs until the next one.
  const statements = body.split(/ALTER TABLE\s+/).slice(1);

  for (const statement of statements) {
    const table = /^"([a-z_]+)"/.exec(statement)?.[1];
    if (!table) continue;

    for (const [, column, width] of statement.matchAll(
      /ALTER COLUMN\s+"([a-z_]+)"\s+TYPE character varying\((\d+)\)/g,
    )) {
      widths.set(key(table, column), Number(width));
    }

    for (const [, from, to] of statement.matchAll(
      /RENAME COLUMN\s+"([a-z_]+)"\s+TO\s+"([a-z_]+)"/g,
    )) {
      renames.push({ table, column: from, to });
    }
  }

  return { widths, renames };
}

function parseMigration(): { up: ParsedMigration; down: ParsedMigration } {
  // `readFileSync` throwing ENOENT is the point: delete the migration and this
  // suite goes red at load, which is what the metadata-only version did not do.
  const source = readFileSync(MIGRATION_PATH, 'utf8');
  const downAt = source.indexOf('public async down(');
  const upAt = source.indexOf('public async up(');

  if (upAt < 0 || downAt < 0 || downAt < upAt) {
    throw new Error(`${MIGRATION_PATH} has no up()/down() pair in that order`);
  }

  return {
    up: parseBody(source.slice(upAt, downAt)),
    down: parseBody(source.slice(downAt)),
  };
}

// ---------------------------------------------------------------------------
// The entities, read the way a query is built
// ---------------------------------------------------------------------------

/** An entity class, as `getMetadataArgsStorage()` stores it in `column.target`. */
type EntityClass = { new (...args: never[]): object; readonly name: string };

const tableOf = (target: EntityClass): string => {
  const table = getMetadataArgsStorage().tables.find((t) => t.target === target);
  if (!table?.name) throw new Error(`no @Entity(name) for ${target.name}`);
  return table.name;
};

const columnOf = (target: EntityClass, propertyName: string) => {
  const column = getMetadataArgsStorage().columns.find(
    (c) => c.target === target && c.propertyName === propertyName,
  );
  if (!column) throw new Error(`no column metadata for ${target.name}.${propertyName}`);
  if (!column.options.name) {
    throw new Error(`${target.name}.${propertyName} declares no explicit column name`);
  }
  return { name: column.options.name, length: column.options.length as number | undefined };
};

/**
 * Every column the multichain widening migration widens, named by the entity
 * property a query is built from and the width it requires. The column *name* is not listed: it comes off
 * the entity, and agreeing with the migration is one of the assertions.
 */
const WIDENED: ReadonlyArray<{
  readonly label: string;
  readonly target: EntityClass;
  readonly property: string;
  readonly required: number;
}> = [
  // A voucher signature. secp256k1 needs 132; it held base58's 88 in 128.
  {
    label: 'PaymentIntentEntity.voucherSignature',
    target: PaymentIntentEntity,
    property: 'voucherSignature',
    required: 256,
  },
  // Chain transaction signatures. Widened for uniformity.
  {
    label: 'SlashProposalEntity.chainProposalSignature',
    target: SlashProposalEntity,
    property: 'chainProposalSignature',
    required: 256,
  },
  {
    label: 'SlashProposalEntity.executionSignature',
    target: SlashProposalEntity,
    property: 'executionSignature',
    required: 256,
  },
  {
    label: 'SlashProposalEntity.reversalSignature',
    target: SlashProposalEntity,
    property: 'reversalSignature',
    required: 256,
  },
  // Not in the original widening list, and the ones that actually overflow: hex-encoded key
  // material sized exactly to ed25519.
  {
    label: 'VerifierSigningKeyEntity.publicKey',
    target: VerifierSigningKeyEntity,
    property: 'publicKey',
    required: 256,
  },
  {
    label: 'VerifierSigningKeyEntity.chainAddress',
    target: VerifierSigningKeyEntity,
    property: 'chainAddress',
    required: 256,
  },
  {
    label: 'VerifierSigningLogEntryEntity.publicKey',
    target: VerifierSigningLogEntryEntity,
    property: 'publicKey',
    required: 256,
  },
  {
    label: 'VerifierSigningLogEntryEntity.signature',
    target: VerifierSigningLogEntryEntity,
    property: 'signature',
    required: 256,
  },
  // CAIP-10 now, not bare base58.
  {
    label: 'BuyerEscrowEntity.escrowAccountId',
    target: BuyerEscrowEntity,
    property: 'escrowAccountId',
    required: 256,
  },
  {
    label: 'BuyerEscrowEntity.escrowAssetAccountId',
    target: BuyerEscrowEntity,
    property: 'escrowAssetAccountId',
    required: 256,
  },
  // 160 < 170. A legal CAIP-10 does not fit.
  {
    label: 'AgentEntity.primaryAccountId',
    target: AgentEntity,
    property: 'primaryAccountId',
    required: 256,
  },
  // CAIP-2 maxes at 41, so 64 was never a defect — but it is the only chain_id
  // in the schema that is not 128, and an inconsistency in a width is a
  // question every future reader has to answer again.
  { label: 'AgentEntity.chainId', target: AgentEntity, property: 'chainId', required: 128 },
];

describe('signature, key and account-id column widths', () => {
  const migration = parseMigration();

  describe('the entity declares the required width', () => {
    it.each(WIDENED.map((c) => [c.label, c] as const))('%s', (_label, column) => {
      expect(columnOf(column.target, column.property).length).toBe(column.required);
    });
  });

  describe('the migration writes the width the entity declares, for that exact column', () => {
    // The half the metadata-only version was missing entirely. An entity edited
    // without a migration, a migration that widens to 160, and a migration
    // deleted outright all fail here and pass above.
    it.each(WIDENED.map((c) => [c.label, c] as const))('%s', (_label, column) => {
      const { name, length } = columnOf(column.target, column.property);
      expect(migration.up.widths.get(key(tableOf(column.target), name))).toBe(length);
    });
  });

  describe('the rename, asserted on COLUMN names because that is what was renamed', () => {
    const RENAMED = [
      { from: 'escrow_pda', to: 'escrow_account_id' },
      { from: 'escrow_token_account', to: 'escrow_asset_account_id' },
    ];

    it('the migration renames both buyer_escrows columns', () => {
      expect(migration.up.renames).toEqual(
        RENAMED.map((r) => ({ table: 'buyer_escrows', column: r.from, to: r.to })),
      );
    });

    it('the entity names the migration’s rename TARGETS, not its sources', () => {
      // The earlier version asserted PROPERTY names, so an entity that kept the
      // property `escrowAccountId` while declaring
      // `@Column({ name: 'escrow_pda' })` — which is exactly "the RENAME was
      // dropped" — passed every case in the file.
      const declared = getMetadataArgsStorage()
        .columns.filter((c) => c.target === BuyerEscrowEntity)
        .map((c) => c.options.name);

      for (const { from, to } of RENAMED) {
        expect(declared).toContain(to);
        expect(declared).not.toContain(from);
      }
    });

    it('no entity property answers to the old PDA-shaped names either', () => {
      const properties = getMetadataArgsStorage()
        .columns.filter((c) => c.target === BuyerEscrowEntity)
        .map((c) => c.propertyName);

      expect(properties).not.toContain('escrowPda');
      expect(properties).not.toContain('escrowTokenAccount');
    });
  });

  describe('down() is the exact inverse of up()', () => {
    it('reverses every rename, in the opposite direction', () => {
      expect([...migration.down.renames].reverse()).toEqual(
        migration.up.renames.map((r) => ({ table: r.table, column: r.to, to: r.column })),
      );
    });

    it('restores a width for every column up() widened', () => {
      // Keyed on the post-rename name in both halves: `down()` narrows before
      // it renames back, so both maps speak the new names.
      expect([...migration.down.widths.keys()].sort()).toEqual(
        [...migration.up.widths.keys()].sort(),
      );
    });

    it('narrows every one of them', () => {
      for (const [column, before] of migration.down.widths) {
        expect(before).toBeLessThan(migration.up.widths.get(column) as number);
      }
    });
  });

  /**
   * The widths above are numbers compared to numbers. These cases build the
   * **actual longest legal value** of each kind and assert two things about
   * every column that will hold one:
   *
   * - it fits the width the migration writes — as an *equality* against the
   *   declared width, not a `<=` bound, because a bound is satisfied by any
   *   width at all above the fixture, and
   * - it did **not** fit the width the column had before, read out of the
   *   migration's own `down()` rather than typed in.
   */
  describe('the longest legal value of each kind, against the old width and the new', () => {
    const hex = (bytes: number): string => 'a'.repeat(bytes * 2);

    /** secp256k1 `r || s || v`, 65 bytes, `0x`-prefixed hex. 132 characters. */
    const SECP256K1_SIGNATURE = `0x${hex(65)}`;

    /** secp256k1 uncompressed public key, 65 bytes, `0x`-prefixed hex. 132. */
    const SECP256K1_PUBLIC_KEY = `0x${hex(65)}`;

    /**
     * A CAIP-10 account id at the grammar's ceiling, **derived from the grammar
     * itself**. Hand-copying `170` would let `caip.types.ts` widen its bounds
     * while this fixture — and therefore every column claim below — silently
     * kept testing the old ceiling.
     */
    const MAX_ACCOUNT_ID = [
      'e'.repeat(CAIP_BOUNDS.namespace.max),
      '1'.repeat(CAIP_BOUNDS.reference.max),
      'A'.repeat(CAIP_BOUNDS.address.max),
    ].join(':');

    it('the maximal values are the lengths this task was sized from', () => {
      expect(SECP256K1_SIGNATURE).toHaveLength(132);
      expect(SECP256K1_PUBLIC_KEY).toHaveLength(132);
      expect(MAX_ACCOUNT_ID).toHaveLength(CAIP_MAX_LENGTHS.accountId);
      expect(CAIP_MAX_LENGTHS.accountId).toBe(170);
      // Legal, and maximal: one more character of address is not.
      expect(isAccountId(MAX_ACCOUNT_ID)).toBe(true);
      expect(isAccountId(`${MAX_ACCOUNT_ID}A`)).toBe(false);
    });

    const CASES: ReadonlyArray<{
      label: string;
      target: EntityClass;
      property: string;
      value: string;
    }> = [
      {
        label: 'PaymentIntentEntity.voucherSignature',
        target: PaymentIntentEntity,
        property: 'voucherSignature',
        value: SECP256K1_SIGNATURE,
      },
      {
        label: 'SlashProposalEntity.chainProposalSignature',
        target: SlashProposalEntity,
        property: 'chainProposalSignature',
        value: SECP256K1_SIGNATURE,
      },
      {
        label: 'SlashProposalEntity.executionSignature',
        target: SlashProposalEntity,
        property: 'executionSignature',
        value: SECP256K1_SIGNATURE,
      },
      {
        label: 'SlashProposalEntity.reversalSignature',
        target: SlashProposalEntity,
        property: 'reversalSignature',
        value: SECP256K1_SIGNATURE,
      },
      {
        label: 'VerifierSigningKeyEntity.publicKey',
        target: VerifierSigningKeyEntity,
        property: 'publicKey',
        value: SECP256K1_PUBLIC_KEY,
      },
      {
        label: 'VerifierSigningLogEntryEntity.publicKey',
        target: VerifierSigningLogEntryEntity,
        property: 'publicKey',
        value: SECP256K1_PUBLIC_KEY,
      },
      {
        label: 'VerifierSigningLogEntryEntity.signature',
        target: VerifierSigningLogEntryEntity,
        property: 'signature',
        value: SECP256K1_SIGNATURE,
      },
      {
        label: 'VerifierSigningKeyEntity.chainAddress',
        target: VerifierSigningKeyEntity,
        property: 'chainAddress',
        value: MAX_ACCOUNT_ID,
      },
      {
        label: 'BuyerEscrowEntity.escrowAccountId',
        target: BuyerEscrowEntity,
        property: 'escrowAccountId',
        value: MAX_ACCOUNT_ID,
      },
      {
        label: 'BuyerEscrowEntity.escrowAssetAccountId',
        target: BuyerEscrowEntity,
        property: 'escrowAssetAccountId',
        value: MAX_ACCOUNT_ID,
      },
      {
        label: 'AgentEntity.primaryAccountId',
        target: AgentEntity,
        property: 'primaryAccountId',
        value: MAX_ACCOUNT_ID,
      },
    ];

    it.each(CASES.map((c) => [c.label, c] as const))(
      '%s holds it now, and the width it had before could not',
      (_label, testCase) => {
        const { name, length } = columnOf(testCase.target, testCase.property);
        const column = key(tableOf(testCase.target), name);

        const now = migration.up.widths.get(column);
        const before = migration.down.widths.get(column);
        expect(now).toBe(length);
        expect(before).toBeDefined();

        // Pinned, not bounded: `length` is exactly what the migration writes,
        // and the fixture has to fit inside it.
        expect(testCase.value.length).toBeLessThanOrEqual(now as number);
        // And Postgres would have raised `value too long` before this task.
        expect(testCase.value.length).toBeGreaterThan(before as number);
      },
    );
  });
});
