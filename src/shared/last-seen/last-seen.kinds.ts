/**
 * The "last seen" stamps an authenticated request leaves behind, and where
 * each one is stored.
 *
 * Every one of them is observability for a screen (when was this key last
 * used, when did this person last log in, when was this operator last seen),
 * never an input to a decision: nothing expires, refuses or bills on them.
 * That is what lets {@link LastSeenRecorder} buffer them in Redis and write
 * them in batches. `oauth_access_tokens.first_used_at` is NOT one of them: the
 * refresh-reuse check decides on it, so it stays a direct, conditional write
 * in `OAuthAccessTokenMcpSessionSource`.
 */
export enum LastSeenKind {
  /** `agents.last_login_at`, by agent id (a Privy login). */
  AGENT_LOGIN = 'agent-login',
  /** `agent_credentials.last_used_at`, by `organizationId:credentialId` (API key or OAuth grant). */
  CREDENTIAL_USE = 'credential-use',
  /** `operators.last_seen_at`, by operator id. */
  OPERATOR_SEEN = 'operator-seen',
}

export const LAST_SEEN_KINDS: readonly LastSeenKind[] = Object.values(LastSeenKind);

interface LastSeenTarget {
  readonly table: string;
  readonly column: string;
  /** Whether the key is `organizationId:id` and the row is matched on both. */
  readonly organizationScoped: boolean;
}

export const LAST_SEEN_TARGETS: Readonly<Record<LastSeenKind, LastSeenTarget>> = Object.freeze({
  [LastSeenKind.AGENT_LOGIN]: {
    table: 'agents',
    column: 'last_login_at',
    organizationScoped: false,
  },
  [LastSeenKind.CREDENTIAL_USE]: {
    table: 'agent_credentials',
    column: 'last_used_at',
    organizationScoped: true,
  },
  [LastSeenKind.OPERATOR_SEEN]: {
    table: 'operators',
    column: 'last_seen_at',
    organizationScoped: false,
  },
});

/** The Redis hash of stamps not yet written, field = key, value = epoch ms. */
export function pendingKey(kind: LastSeenKind): string {
  return `assay:last-seen:${kind}`;
}

/**
 * The hash one flush run is writing, its own: two overlapping runs never
 * touch each other's. Listed in {@link twinsKey} for as long as it exists.
 */
export function flushingKey(kind: LastSeenKind, runId: string): string {
  return `assay:last-seen:${kind}:flushing:${runId}`;
}

/**
 * The set of a kind's `flushing` hashes not yet written and deleted:
 * {@link LastSeenRecorder.pending} reads every one, and a flush writes any it
 * finds there (a run that failed or died) before taking a new one.
 */
export function twinsKey(kind: LastSeenKind): string {
  return `assay:last-seen:${kind}:twins`;
}

/** The key of a credential stamp. */
export function credentialKey(organizationId: string, credentialId: string): string {
  return `${organizationId}:${credentialId}`;
}

/**
 * One batched `UPDATE` for a kind: every `(key, at)` pair at once, and never
 * moving a column backwards (`GREATEST`), so a late or repeated write is
 * harmless. Returns the SQL and its parameters.
 */
export function batchUpdate(
  kind: LastSeenKind,
  stamps: ReadonlyMap<string, number>,
): { sql: string; params: unknown[] } {
  const { table, column, organizationScoped } = LAST_SEEN_TARGETS[kind];
  const keys = [...stamps.keys()];
  const at = keys.map((key) => new Date(stamps.get(key) as number).toISOString());
  const set = `"${column}" = GREATEST(COALESCE(t."${column}", '-infinity'::timestamptz), v.at)`;

  if (organizationScoped) {
    const organizations = keys.map((key) => key.slice(0, key.indexOf(':')));
    const ids = keys.map((key) => key.slice(key.indexOf(':') + 1));
    return {
      sql:
        `UPDATE "${table}" AS t SET ${set} ` +
        `FROM unnest($1::uuid[], $2::uuid[], $3::timestamptz[]) AS v(organization_id, id, at) ` +
        `WHERE t."id" = v.id AND t."organization_id" = v.organization_id`,
      params: [organizations, ids, at],
    };
  }
  return {
    sql:
      `UPDATE "${table}" AS t SET ${set} ` +
      `FROM unnest($1::uuid[], $2::timestamptz[]) AS v(id, at) WHERE t."id" = v.id`,
    params: [keys, at],
  };
}

/** A key is well-formed for its kind: uuids only, so a bad one never reaches the cast. */
export function isWellFormedKey(kind: LastSeenKind, key: string): boolean {
  const parts = LAST_SEEN_TARGETS[kind].organizationScoped ? key.split(':') : [key];
  const expected = LAST_SEEN_TARGETS[kind].organizationScoped ? 2 : 1;
  return parts.length === expected && parts.every((part) => UUID.test(part));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
