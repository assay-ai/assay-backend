/**
 * An agent's key health, from its credentials alone — the facts the dashboard
 * derives today from `GET /agents/:agentId/credentials` (`agentReadiness`,
 * Get started, Connect, the Agents card), worked out once on the server so a
 * screen can read them off `GET /agents?include=health`.
 *
 * Pure: credentials and an instant in, figures out. Nothing here reads the
 * chain — whether the payer authorised a bound key is `/escrow/delegates`.
 *
 * The dashboard uses two meanings of "live" and both are kept, under their own
 * names, rather than one chosen for it: the readiness line counts a key past
 * its `expiresAt` as gone (`credentialIsLive`), while Get started and Connect
 * look at `revokedAt` only.
 */

/** The credential fields health is computed from. */
export interface HealthCredential {
  readonly revokedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly delegateAccount: string | null;
}

export interface AgentHealth {
  readonly evaluatedAt: string;
  readonly liveKeyCount: number;
  readonly unrevokedKeyCount: number;
  readonly keyBound: boolean;
  readonly boundKeyCount: number;
  readonly firstCallSeen: boolean;
  readonly lastUsedAt: string | null;
  readonly earliestLastUsedAt: string | null;
  readonly lastUsedAtAnyKey: string | null;
}

/** Not revoked, and not past its expiry at `nowMs` — the readiness line's "live". */
export function credentialIsLive(credential: HealthCredential, nowMs: number): boolean {
  return !credential.revokedAt && (!credential.expiresAt || credential.expiresAt.getTime() > nowMs);
}

export function agentHealth(credentials: readonly HealthCredential[], now: Date): AgentHealth {
  const nowMs = now.getTime();
  const live = credentials.filter((credential) => credentialIsLive(credential, nowMs));
  const unrevoked = credentials.filter((credential) => !credential.revokedAt);
  const bound = live.filter((credential) => credential.delegateAccount);

  return {
    evaluatedAt: now.toISOString(),
    liveKeyCount: live.length,
    unrevokedKeyCount: unrevoked.length,
    keyBound: bound.length > 0,
    boundKeyCount: bound.length,
    firstCallSeen: unrevoked.some((credential) => credential.lastUsedAt !== null),
    lastUsedAt: latest(live),
    earliestLastUsedAt: earliest(unrevoked),
    lastUsedAtAnyKey: latest(credentials),
  };
}

function usedAt(credentials: readonly HealthCredential[]): number[] {
  return credentials
    .map((credential) => credential.lastUsedAt?.getTime())
    .filter((at): at is number => at !== undefined && Number.isFinite(at));
}

function latest(credentials: readonly HealthCredential[]): string | null {
  const times = usedAt(credentials);
  return times.length === 0 ? null : new Date(Math.max(...times)).toISOString();
}

function earliest(credentials: readonly HealthCredential[]): string | null {
  const times = usedAt(credentials);
  return times.length === 0 ? null : new Date(Math.min(...times)).toISOString();
}
