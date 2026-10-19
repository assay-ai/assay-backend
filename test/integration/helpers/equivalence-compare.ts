import { Response } from 'supertest';
import { DataSource } from 'typeorm';

import { BOTH, Via, World, credentialOf } from './equivalence-fixtures';

/**
 * Runs one equivalence case on both credentials and compares everything.
 *
 * A case is a function of one world and one credential of it. It runs once
 * with the API key and once with the OAuth grant, each in the world given for
 * it, and returns what the caller saw. Both results, and the database rows the
 * runs left behind, are normalised (each world's own ids become placeholders)
 * and must be deep-equal.
 *
 * ## Allowed differences (spec §12.1)
 *
 * - the credential's id: each world's own credential becomes `<credential>`;
 * - the `credential.created` audit entry's `after.issuedVia`, `after.clientId`;
 * - the `agent_credentials.issued_via` and `.oauth_client_id` columns.
 *
 * Dropped here too, each by name:
 *
 * - what spec §6.2 defines per kind of credential and nothing on a call path
 *   reads (§6.4 step 4): an API key's `prefix` and `token_hash`, a grant's
 *   rolling `expires_at` (R-OA-13) and its `oauth_*` token rows
 *   ({@link ISSUANCE_COLUMNS}, {@link ISSUANCE_TABLES});
 * - `credential.revoked`'s `after.issuedVia` and `after.clientId` (R-OA-26),
 *   which the revoke case asserts explicitly first;
 * - every `credential.created` entry: how a world obtained its credentials,
 *   not what a case did; the audit case compares them on their own;
 * - values that are facts about the moment, not the call
 *   ({@link VOLATILE_COLUMNS}, {@link VOLATILE_KEYS}, timestamps, signatures
 *   by each world's own key, fresh ids).
 *
 * Anything else that differs fails the case.
 */

/** `agent_credentials` columns that differ by issuance (§6.2, R-OA-13; §12.1 allowed). */
export const ISSUANCE_COLUMNS = [
  'issued_via',
  'oauth_client_id',
  'prefix',
  'token_hash',
  'expires_at',
] as const;

/** Rows only a grant has: how its secret is held (§6.2). */
export const ISSUANCE_TABLES = [
  'oauth_access_tokens',
  'oauth_refresh_tokens',
  'oauth_authorization_codes',
  'oauth_clients',
] as const;

/**
 * Audit `after` members that name how a credential was issued: allowed on
 * `credential.created` (§12.1). `credential.revoked` carries the same two
 * (R-OA-26: OAuth audit entries name the client id); §12.1 does not list it,
 * so the revoke case asserts that difference explicitly before this drops it.
 */
export const ISSUANCE_AUDIT_FIELDS = ['issuedVia', 'clientId'] as const;
export const ISSUANCE_AUDIT_ACTIONS = ['credential.created', 'credential.revoked'] as const;

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

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const EVM_ADDRESS_RE = /0x[0-9a-fA-F]{40}/g;
/** A 65-byte secp256k1 signature: each world's own key signs, so the bytes differ. */
const SIGNATURE_RE = /0x[0-9a-fA-F]{130}(?![0-9a-fA-F])/g;
/** A whole value that is a Unix time in seconds (voucher and challenge expiries). */
const UNIX_SECONDS_RE = /^1[0-9]{9}$/;

/** Extra values a case knows belong to one run, by placeholder. */
export type Placeholders = Readonly<Record<string, string | null | undefined>>;

/**
 * Turns one run's output into a form comparable with its twin's.
 *
 * Exact values first (the world's ids, its wallet, the run's credential and
 * its sibling, anything the case passes), then what is fresh on every call in
 * any world: other UUIDs (an intent, a call, a challenge), timestamps, and
 * other EVM addresses keep their identity within the run (the first seen is
 * `<address:1>`, and so on) so "the same key twice" still compares.
 */
export function normaliser(
  world: World,
  via: Via,
  extra: Placeholders = {},
  { numbered = true }: { readonly numbered?: boolean } = {},
) {
  const sibling: Via = via === 'key' ? 'grant' : 'key';
  const exact: [string, string][] = [
    [credentialOf(world, via).id, '<credential>'],
    [credentialOf(world, sibling).id, '<sibling-credential>'],
    [world.organizationId, '<organization>'],
    [world.agentId, '<agent>'],
    [world.person.agentId, '<person>'],
  ];
  const addresses = new Map<string, string>([
    [world.wallet.split(':')[2].toLowerCase(), '<wallet>'],
  ]);
  for (const [placeholder, value] of Object.entries(extra)) {
    if (!value) continue;
    const address = /0x[0-9a-fA-F]{40}$/.exec(value)?.[0];
    if (address) addresses.set(address.toLowerCase(), placeholder);
    else exact.push([value, placeholder]);
  }
  // Longest first, so a value that contains another is replaced whole.
  exact.sort((a, b) => b[0].length - a[0].length);

  const uuids = new Map<string, string>();
  const text = (value: string): string => {
    if (UNIX_SECONDS_RE.test(value)) return '<unix-time>';
    let out = value.replace(SIGNATURE_RE, '<signature>');
    for (const [from, to] of exact) out = out.split(from).join(to);
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
    return out.replace(ISO_RE, '<time>');
  };

  const walk = (value: unknown): unknown => {
    if (value === null || value === undefined) return value;
    if (value instanceof Date) return '<time>';
    if (typeof value === 'string') return text(value);
    if (typeof value === 'bigint') return text(value.toString());
    if (typeof value === 'number' && UNIX_SECONDS_RE.test(String(value))) return '<unix-time>';
    if (Buffer.isBuffer(value)) return `<bytes:${value.length}>`;
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as object).sort()) {
        const member = (value as Record<string, unknown>)[key];
        out[text(key)] =
          (VOLATILE_KEYS as readonly string[]).includes(key) && member !== null
            ? '<volatile>'
            : walk(member);
      }
      return out;
    }
    return value;
  };
  return walk;
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

/**
 * Runs `run` once per credential: in one world when `worlds` is one world
 * (stateless cases), each in its own world when it is a pair. Returns both
 * normalised results, the database footprint included when `dataSource` is
 * given.
 */
export async function runTwins<T>(
  worlds: World | Record<Via, World>,
  run: (context: RunContext) => Promise<T>,
  options: {
    readonly dataSource?: DataSource;
    readonly placeholders?: (context: RunContext, result: T) => Placeholders;
  } = {},
): Promise<TwinResult> {
  if (options.dataSource && 'organizationId' in worlds) {
    throw new Error('a footprint needs a world per credential: pass a pair');
  }
  const results: Partial<Record<Via, unknown>> = {};
  for (const via of BOTH) {
    const world = 'organizationId' in worlds ? worlds : worlds[via];
    const credential = credentialOf(world, via);
    const context: RunContext = {
      world,
      via,
      bearer: credential.bearer,
      credentialId: credential.id,
    };
    const result = await run(context);
    const placeholders = options.placeholders?.(context, result);
    const normalised = normaliser(world, via, placeholders)(result);
    if (!options.dataSource) {
      results[via] = normalised;
      continue;
    }
    // Row order and fresh ids are not comparable across worlds: unnumbered
    // placeholders, then rows sorted by content.
    const footprint = normaliser(world, via, placeholders, { numbered: false })(
      await footprintOf(options.dataSource, world, via),
    ) as Record<string, unknown[]>;
    for (const table of Object.keys(footprint)) footprint[table] = sortedRows(footprint[table]);
    results[via] = { result: normalised, footprint };
  }
  return { key: results.key, grant: results.grant };
}

/** {@link runTwins}, then the two must be deep-equal. Returns both, normalised. */
export async function expectEquivalent<T>(
  worlds: World | Record<Via, World>,
  run: (context: RunContext) => Promise<T>,
  options: Parameters<typeof runTwins<T>>[2] = {},
): Promise<TwinResult> {
  const twins = await runTwins(worlds, run, options);
  expect(twins.grant).toStrictEqual(twins.key);
  return twins;
}

/**
 * Every row in the database that belongs to the world's organization, by
 * table, minus what the run's sibling credential owns and what issuance
 * defines per kind (see the file comment). Waits a moment first: last-use
 * stamps, attribution and attempt records are written after the response.
 */
export async function footprintOf(
  dataSource: DataSource,
  world: World,
  via: Via,
): Promise<Record<string, unknown[]>> {
  await new Promise((resolve) => setTimeout(resolve, 250));
  const sibling = credentialOf(world, via === 'key' ? 'grant' : 'key').id;
  const tables = (await dataSource.query(
    `SELECT "table_name" FROM "information_schema"."columns"
      WHERE "table_schema" = 'public' AND "column_name" = 'organization_id'
      ORDER BY "table_name"`,
  )) as { table_name: string }[];

  const footprint: Record<string, unknown[]> = {};
  for (const { table_name: table } of tables) {
    if ((ISSUANCE_TABLES as readonly string[]).includes(table)) continue;
    const rows = (await dataSource.query(`SELECT * FROM "${table}" WHERE "organization_id" = $1`, [
      world.organizationId,
    ])) as Record<string, unknown>[];
    const kept = rows
      .filter((row) => !mentions(row, sibling) && !isFixtureCreation(row))
      .map((row) => withoutVolatile(table, withoutIssuance(table, row)));
    if (kept.length > 0) footprint[table] = kept;
  }
  return footprint;
}

/**
 * A `credential.created` entry: how a world obtained a credential, not what
 * a case did with it. The audit case compares these on their own.
 */
function isFixtureCreation(row: Record<string, unknown>): boolean {
  return row.action === 'credential.created' && row.resource_type === 'agent_credential';
}

function withoutVolatile(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...row };
  for (const column of [...VOLATILE_COLUMNS['*'], ...(VOLATILE_COLUMNS[table] ?? [])]) {
    if (column in copy) copy[column] = copy[column] === null ? null : '<volatile>';
  }
  return copy;
}

/** A row about the sibling credential: its own row, or an entry naming it. */
function mentions(row: Record<string, unknown>, credentialId: string): boolean {
  return (
    row.id === credentialId ||
    row.credential_id === credentialId ||
    row.resource_id === credentialId
  );
}

function withoutIssuance(table: string, row: Record<string, unknown>): Record<string, unknown> {
  if (table === 'agent_credentials') {
    const copy = { ...row };
    for (const column of ISSUANCE_COLUMNS) delete copy[column];
    return copy;
  }
  if (
    table === 'audit_log_entries' &&
    (ISSUANCE_AUDIT_ACTIONS as readonly unknown[]).includes(row.action)
  ) {
    return { ...row, after: withoutIssuanceFields(row.after) };
  }
  return row;
}

function withoutIssuanceFields(after: unknown): unknown {
  if (!after || typeof after !== 'object') return after;
  const copy = { ...(after as Record<string, unknown>) };
  for (const field of ISSUANCE_AUDIT_FIELDS) delete copy[field];
  return copy;
}

/** Sorted by content, so row order (insertion races) never decides equality. */
export function sortedRows(rows: unknown[]): unknown[] {
  return [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
