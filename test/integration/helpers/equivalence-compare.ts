import { createHash } from 'node:crypto';
import { Response } from 'supertest';
import { DataSource } from 'typeorm';

import { BOTH, ProviderStub, Via, World, credentialOf } from './equivalence-fixtures';

/**
 * Runs one equivalence case on both credentials and compares everything.
 *
 * A case is a function of one world and one credential of it. It runs once
 * with the API key and once with the OAuth grant, each in the world given for
 * it, and returns what the caller saw. Both results, every request the
 * provider was sent, and every database row of the world's organization
 * (the other credential's rows included) are normalised and must be
 * deep-equal.
 *
 * ## What normalising keeps and maps
 *
 * - each world's own ids become placeholders: `<credential>` (the run's),
 *   `<sibling-credential>` (the other one), `<organization>`, `<agent>`,
 *   `<person>`, `<wallet>`, plus what a case passes (`<delegate>`, ...);
 * - ids that are the same in every world keep their identity
 *   (`EquivalenceApps.knownIds`: `<tool:paid>`, `<binding:paid>`, `<provider>`,
 *   `<toolset:kit>`, ...), so a wrong reference on one side fails;
 * - what is fresh per call (other uuids, other addresses) keeps its identity
 *   (`<uuid:1>`, ...): within a response, and across the whole footprint once
 *   its rows are put in a content order (see `renumbered`);
 * - a row the run created compares its timestamps as offsets from its own
 *   `created_at`, to the minute (see `withTimeOffsets`).
 *
 * ## Allowed differences (spec §12.1, amended for D1)
 *
 * - the credential's id (above);
 * - the VALUES of `issuedVia`, `clientId`, `replaces` and `expiresAt` in a
 *   `credential.created` entry, and of `issuedVia`, `clientId` in a
 *   `credential.revoked` entry (the shape is the same; the audit and revoke
 *   cases assert the values);
 * - the `agent_credentials` columns that differ by issuance (§6.2, R-OA-13):
 *   `issued_via`, `oauth_client_id`, `token_last4`, `token_hash`, `expires_at`,
 *   and `scopes` (fixed by client kind: a third-party grant holds `tools:call`
 *   alone; the assay-mcp grant's equal a key's, asserted by the session-source
 *   suite);
 *   and the grant's own `oauth_*` token rows ({@link ISSUANCE_COLUMNS},
 *   {@link ISSUANCE_TABLES});
 * - the `credential.created` entries of the world's two fixture credentials,
 *   written before the run (the audit case compares those on their own);
 * - facts about the moment rather than the call: {@link VOLATILE_COLUMNS},
 *   {@link VOLATILE_KEYS}, ISO timestamps in responses and in rows made before
 *   the run, Unix-second expiries
 *   ({@link UNIX_TIME_KEYS}), signatures by each world's own key.
 *
 * Anything else that differs fails the case.
 */

/** `agent_credentials` columns that differ by issuance (§6.2, R-OA-13; §12.1 allowed). */
export const ISSUANCE_COLUMNS = [
  'issued_via',
  'oauth_client_id',
  'token_last4',
  'token_hash',
  'expires_at',
  'scopes',
] as const;

/** Rows only a grant has: how its secret is held (§6.2). */
export const ISSUANCE_TABLES = [
  'oauth_access_tokens',
  'oauth_refresh_tokens',
  'oauth_authorization_codes',
  'oauth_clients',
] as const;

/** Audit `after` members whose VALUES name how a credential was issued (§12.1, R-OA-26). */
export const ISSUANCE_AUDIT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'credential.created': ['issuedVia', 'clientId', 'replaces', 'expiresAt'],
  'credential.revoked': ['issuedVia', 'clientId'],
};

/**
 * Columns whose value is a fact about the moment, not about the call: a
 * measured latency, and the ledger's global entry sequence (shared by every
 * organization, so each world's entries land at different numbers).
 */
export const VOLATILE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  '*': ['latency_ms'],
  ledger_entries: ['seq'],
};

/** Response members that count down a window: equal in meaning, not in milliseconds. */
export const VOLATILE_KEYS = ['retryAfterMs', 'retry-after'] as const;

/** Members that hold a Unix time in seconds (voucher and challenge expiries). */
export const UNIX_TIME_KEYS = [
  'issuedAt',
  'expiresAt',
  'validUntil',
  'voucher_issued_at',
  'voucher_expires_at',
] as const;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const EVM_ADDRESS_RE = /0x[0-9a-fA-F]{40}/g;
/** A 65-byte secp256k1 signature: each world's own key signs, so the bytes differ. */
const SIGNATURE_RE = /0x[0-9a-fA-F]{130}(?![0-9a-fA-F])/g;
const UNIX_SECONDS_RE = /^1[0-9]{9}$/;

/** Extra values a case knows belong to one run, by placeholder. */
export type Placeholders = Readonly<Record<string, string | null | undefined>>;

/**
 * Turns one run's output into a form comparable with its twin's (see the file
 * comment). A case's own placeholders win over the world's: a replacement
 * grant can be `<credential>` while the grant it replaced is `<replaced>`.
 */
export function normaliser(
  world: World,
  via: Via,
  extra: Placeholders = {},
  {
    numbered = true,
    known = new Map(),
  }: { readonly numbered?: boolean; readonly known?: ReadonlyMap<string, string> } = {},
) {
  const sibling: Via = via === 'key' ? 'grant' : 'key';
  const exact = new Map<string, string>();
  const addresses = new Map<string, string>();
  // A payment key's notices name it by its last eight hex characters,
  // upper-cased (`paymentKeyEnding`): the same key in a different form.
  const endings = new Map<string, string>();
  for (const [placeholder, value] of Object.entries(extra)) {
    if (!value) continue;
    const address = /0x[0-9a-fA-F]{40}$/.exec(value)?.[0];
    if (address) {
      addresses.set(address.toLowerCase(), placeholder);
      endings.set(address.slice(-8).toUpperCase(), placeholder.replace(/>$/, ':ending>'));
      // ...and by `keyDigest` (sha256 of the lower-cased address, 16 hex).
      endings.set(
        createHash('sha256').update(address.toLowerCase()).digest('hex').slice(0, 16),
        placeholder.replace(/>$/, ':digest>'),
      );
    } else exact.set(value, placeholder);
  }
  const base: [string, string][] = [
    [credentialOf(world, via).id, '<credential>'],
    [credentialOf(world, sibling).id, '<sibling-credential>'],
    [world.organizationId, '<organization>'],
    [world.agentId, '<agent>'],
    [world.person.agentId, '<person>'],
    ...known,
  ];
  for (const [value, placeholder] of base) if (!exact.has(value)) exact.set(value, placeholder);
  const wallet = world.wallet.split(':')[2].toLowerCase();
  if (!addresses.has(wallet)) addresses.set(wallet, '<wallet>');
  // Longest first, so a value that contains another is replaced whole.
  const replacements = [...exact].sort((a, b) => b[0].length - a[0].length);

  const uuids = new Map<string, string>();
  const text = (value: string): string => {
    let out = value.replace(SIGNATURE_RE, '<signature>');
    for (const [from, to] of replacements) out = out.split(from).join(to);
    out = out.replace(EVM_ADDRESS_RE, (address) => {
      const lower = address.toLowerCase();
      if (!addresses.has(lower)) {
        addresses.set(lower, numbered ? `<address:${addresses.size}>` : '<address>');
      }
      return addresses.get(lower)!;
    });
    out = out.replace(UUID_RE, (uuid) => {
      const lower = uuid.toLowerCase();
      if (!uuids.has(lower)) uuids.set(lower, numbered ? `<uuid:${uuids.size + 1}>` : '<uuid>');
      return uuids.get(lower)!;
    });
    // After the addresses and ids, so an ending never clips a full address.
    for (const [ending, placeholder] of endings) out = out.split(ending).join(placeholder);
    return out.replace(ISO_RE, '<time>');
  };

  const walk = (value: unknown, key?: string): unknown => {
    if (value === null || value === undefined) return value;
    if (key && (VOLATILE_KEYS as readonly string[]).includes(key)) return '<volatile>';
    if (
      key &&
      (UNIX_TIME_KEYS as readonly string[]).includes(key) &&
      UNIX_SECONDS_RE.test(String(value))
    ) {
      return '<unix-time>';
    }
    if (value instanceof Date) return '<time>';
    if (typeof value === 'string') return text(value);
    if (typeof value === 'bigint') return text(value.toString());
    if (Buffer.isBuffer(value)) return `<bytes:${value.length}>`;
    if (Array.isArray(value)) return value.map((item) => walk(item));
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const member of Object.keys(value as object).sort()) {
        out[text(member)] = walk((value as Record<string, unknown>)[member], member);
      }
      return out;
    }
    return value;
  };
  return (value: unknown) => walk(value);
}

export interface ObservedResponse {
  readonly status: number;
  readonly headers: Record<string, unknown>;
  readonly body: any;
  readonly text?: string;
}

/** What an HTTP caller can observe of a response. */
export function observed(response: Response): ObservedResponse {
  const headers: Record<string, unknown> = {};
  for (const name of ['www-authenticate', 'retry-after', 'content-type', 'cache-control']) {
    if (response.headers[name] !== undefined) headers[name] = response.headers[name];
  }
  // A body supertest did not parse (text/plain, HTML) is compared as text.
  const unparsed =
    response.text && response.body && Object.keys(response.body).length === 0
      ? { text: response.text }
      : {};
  return { status: response.status, headers, body: response.body, ...unparsed };
}

export interface RunContext {
  readonly world: World;
  readonly via: Via;
  /** The bearer of the run's credential. */
  readonly bearer: string;
  readonly credentialId: string;
}

export interface TwinResult {
  readonly key: unknown;
  readonly grant: unknown;
}

export interface TwinOptions<T> {
  /** Adds the run's database footprint (pairs only). */
  readonly dataSource?: DataSource;
  /** Adds the requests the run sent to the provider. */
  readonly provider?: ProviderStub;
  /** Ids shared by every world (`EquivalenceApps.knownIds`). */
  readonly knownIds?: ReadonlyMap<string, string>;
  readonly placeholders?: (context: RunContext, result: T) => Placeholders;
}

/**
 * Runs `run` once per credential: each in its own world when `worlds` is a
 * pair, both in one world otherwise (stateless cases; the grant runs first
 * there, so nothing the key warms can serve the grant). Returns both
 * normalised results, with the provider's requests and the footprint when
 * asked for.
 */
export async function runTwins<T>(
  worlds: World | Record<Via, World>,
  run: (context: RunContext) => Promise<T>,
  options: TwinOptions<T> = {},
): Promise<TwinResult> {
  const single = 'organizationId' in worlds;
  if (options.dataSource && single) {
    throw new Error('a footprint needs a world per credential: pass a pair');
  }
  const results: Partial<Record<Via, unknown>> = {};
  for (const via of single ? [...BOTH].reverse() : BOTH) {
    const world = single ? worlds : worlds[via];
    const credential = credentialOf(world, via);
    const context: RunContext = {
      world,
      via,
      bearer: credential.bearer,
      credentialId: credential.id,
    };
    const sent = options.provider?.calls.length ?? 0;
    const runStart = options.dataSource ? await databaseNow(options.dataSource) : null;
    const result = await run(context);
    const placeholders = options.placeholders?.(context, result);
    const outcome: Record<string, unknown> = { result };
    if (options.provider) outcome.providerCalls = options.provider.calls.slice(sent);
    const known = options.knownIds;
    const normalised = normaliser(world, via, placeholders, { known })(outcome) as Record<
      string,
      unknown
    >;
    if (options.dataSource) {
      normalised.footprint = renumbered(
        await settledFootprint(options.dataSource, world, runStart!),
        normaliser(world, via, placeholders, { numbered: false, known }),
        normaliser(world, via, placeholders, { known }),
      );
    }
    results[via] = normalised;
  }
  return { key: results.key, grant: results.grant };
}

/** {@link runTwins}, then the two must be deep-equal. Returns both, normalised. */
export async function expectEquivalent<T>(
  worlds: World | Record<Via, World>,
  run: (context: RunContext) => Promise<T>,
  options: TwinOptions<T> = {},
): Promise<TwinResult> {
  const twins = await runTwins(worlds, run, options);
  expect(twins.grant).toStrictEqual(twins.key);
  return twins;
}

async function databaseNow(dataSource: DataSource): Promise<Date> {
  const [{ now }] = (await dataSource.query(`SELECT now() AS "now"`)) as { now: Date }[];
  return now;
}

/**
 * Rows sorted by their content with fresh ids masked (row order is
 * arbitrary), then normalised again with ONE numbering for the whole
 * footprint, so ids made in this world keep their identity across rows and
 * tables (`<uuid:3>` in a hold names the `<uuid:3>` intent): a row pointing
 * at the wrong row of the same world fails (review M10). Rows equal but for
 * their own ids are ordered by creation time.
 */
function renumbered(
  raw: Record<string, Record<string, unknown>[]>,
  sortKey: (value: unknown) => unknown,
  numbered: (value: unknown) => unknown,
): Record<string, unknown[]> {
  const footprint: Record<string, unknown[]> = {};
  for (const table of Object.keys(raw).sort()) {
    footprint[table] = raw[table]
      .map((row) => ({
        row,
        key: JSON.stringify(sortKey(row)),
        at: row.created_at instanceof Date ? row.created_at.getTime() : 0,
      }))
      .sort((a, b) => a.key.localeCompare(b.key) || a.at - b.at)
      .map(({ row }) => numbered(row));
  }
  return footprint;
}

/**
 * The footprint once writes made after the response (last-use stamps,
 * attribution, attempt records) have landed: two equal snapshots in a row,
 * at most about two seconds.
 */
async function settledFootprint(
  dataSource: DataSource,
  world: World,
  runStart: Date,
): Promise<Record<string, Record<string, unknown>[]>> {
  let last = JSON.stringify(await footprintOf(dataSource, world, runStart));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const next = await footprintOf(dataSource, world, runStart);
    const text = JSON.stringify(next);
    if (text === last) return next;
    last = text;
  }
  throw new Error('the footprint never settled');
}

/**
 * Every row in the database that belongs to the world's organization, by
 * table, both credentials' included, minus what issuance defines per kind
 * (see the file comment).
 */
export async function footprintOf(
  dataSource: DataSource,
  world: World,
  runStart: Date,
): Promise<Record<string, Record<string, unknown>[]>> {
  const fixtures = new Set([world.key.id, world.grant.id]);
  const tables = (await dataSource.query(
    `SELECT "table_name" FROM "information_schema"."columns"
      WHERE "table_schema" = 'public' AND "column_name" = 'organization_id'
      ORDER BY "table_name"`,
  )) as { table_name: string }[];

  const footprint: Record<string, Record<string, unknown>[]> = {};
  for (const { table_name: table } of tables) {
    if ((ISSUANCE_TABLES as readonly string[]).includes(table)) continue;
    const rows = (await dataSource.query(`SELECT * FROM "${table}" WHERE "organization_id" = $1`, [
      world.organizationId,
    ])) as Record<string, unknown>[];
    const kept = rows
      .filter((row) => !isFixtureCreation(row, fixtures))
      .map((row) => withTimeOffsets(withoutVolatile(table, withoutIssuance(table, row)), runStart));
    if (kept.length > 0) footprint[table] = kept;
  }
  return footprint;
}

/**
 * The `credential.created` entry of one of the world's two fixture
 * credentials: how the world was built, not what a case did. A credential a
 * case creates (a re-login, a new key) is kept and compared.
 */
function isFixtureCreation(row: Record<string, unknown>, fixtures: Set<string>): boolean {
  return row.action === 'credential.created' && fixtures.has(row.resource_id as string);
}

/**
 * A row this run created compares each timestamp column as its offset from
 * the row's own `created_at`, to the minute (`<+43200m>`: a 30-day expiry),
 * so a hold or expiry of the wrong length fails (review M1). A row made
 * before the run (the world's fixtures) keeps `<time>` only: when a case
 * touches it depends on how long the case before it took.
 */
function withTimeOffsets(row: Record<string, unknown>, runStart: Date): Record<string, unknown> {
  const created = row.created_at;
  if (!(created instanceof Date) || created.getTime() < runStart.getTime()) return row;
  const copy = { ...row };
  for (const [column, value] of Object.entries(row)) {
    if (column === 'created_at' || !(value instanceof Date)) continue;
    copy[column] = `<+${Math.round((value.getTime() - created.getTime()) / 60_000)}m>`;
  }
  return copy;
}

function withoutVolatile(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...row };
  for (const column of [...VOLATILE_COLUMNS['*'], ...(VOLATILE_COLUMNS[table] ?? [])]) {
    if (column in copy) copy[column] = copy[column] === null ? null : '<volatile>';
  }
  return copy;
}

function withoutIssuance(table: string, row: Record<string, unknown>): Record<string, unknown> {
  if (table === 'agent_credentials') {
    const copy = { ...row };
    for (const column of ISSUANCE_COLUMNS) delete copy[column];
    return copy;
  }
  const fields = table === 'audit_log_entries' ? ISSUANCE_AUDIT_FIELDS[row.action as string] : null;
  if (fields && row.after && typeof row.after === 'object') {
    const after = { ...(row.after as Record<string, unknown>) };
    for (const field of fields) if (field in after) after[field] = '<issuance>';
    return { ...row, after };
  }
  return row;
}
