import { EntityManager } from 'typeorm';

import { ToolsetErrors } from '../errors/toolset.errors';

/**
 * A handle's provider tools (design spec §7.1): named `{handle}__{tool}`, so
 * they move with a rename, and they stop with a takedown.
 */

/** A handle's takedown removes its provider tools; their own status is kept to restore. */
export async function removeHandleTools(
  manager: EntityManager,
  organizationId: string,
  now: Date,
): Promise<void> {
  await manager.query(
    `UPDATE tools
        SET status_before_removal = status, status = 'REMOVED',
            removed_at = $2, removal_reason = 'HANDLE', updated_at = now()
      WHERE owner_org_id = $1 AND kind = 'PROVIDER' AND status <> 'REMOVED'`,
    [organizationId, now],
  );
}

/** A lifted handle takedown restores the tools it removed, and only those. */
export async function restoreHandleTools(
  manager: EntityManager,
  organizationId: string,
): Promise<void> {
  await manager.query(
    `UPDATE tools
        SET status = COALESCE(status_before_removal, 'ACTIVE'),
            removed_at = NULL, removal_reason = NULL, status_before_removal = NULL,
            updated_at = now()
      WHERE owner_org_id = $1 AND kind = 'PROVIDER' AND status = 'REMOVED'
        AND removal_reason = 'HANDLE'`,
    [organizationId],
  );
}

/**
 * Provider tools are named `{handle}__{tool}` (§7.1): a renamed handle
 * renames them. Refused when a name would pass the 48-character cap.
 */
export async function renameHandleTools(
  manager: EntityManager,
  organizationId: string,
  from: string,
  to: string,
): Promise<void> {
  if (from === to) return;
  const prefix = `${from}__`;
  const rows = (await manager.query(
    `SELECT id, name FROM tools
      WHERE owner_org_id = $1 AND kind = 'PROVIDER' AND left(name, length($2)) = $2
      FOR UPDATE`,
    [organizationId, prefix],
  )) as { id: string; name: string }[];
  const tooLong = rows.filter((row) => to.length + 2 + (row.name.length - prefix.length) > 48);
  if (tooLong.length > 0) {
    throw ToolsetErrors.handleInvalid({ reason: 'TOOL_NAME_TOO_LONG' });
  }
  for (const row of rows) {
    await manager.query(`UPDATE tools SET name = $2, updated_at = now() WHERE id = $1`, [
      row.id,
      `${to}__${row.name.slice(prefix.length)}`,
    ]);
  }
}
