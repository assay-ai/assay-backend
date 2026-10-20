/**
 * OAuth scopes (spec §6.3.4).
 *
 * `assay:agent` is always granted; `offline_access` is kept when asked for;
 * every other scope is dropped (not refused). The result is space-delimited,
 * in this fixed order, so equal requests store equal strings.
 */
export const SCOPE_AGENT = 'assay:agent';
export const SCOPE_OFFLINE_ACCESS = 'offline_access';

export function normaliseScope(raw: string | null | undefined): string {
  const requested = typeof raw === 'string' ? raw.split(' ') : [];
  return requested.includes(SCOPE_OFFLINE_ACCESS)
    ? `${SCOPE_AGENT} ${SCOPE_OFFLINE_ACCESS}`
    : SCOPE_AGENT;
}
