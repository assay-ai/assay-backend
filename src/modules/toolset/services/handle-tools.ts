import { EntityManager } from 'typeorm';

import { ToolsetErrors } from '../errors/toolset.errors';

/**
 * A handle's provider tools (design spec §7.1): named `{handle}__{tool}`, so
 * they move with a rename, and they stop with a takedown.
 */

/**
 * A handle's takedown removes its provider tools, every one of them — one
 * already taken down on its own too, so the two reasons stand apart and
 * lifting one never brings a tool back while the other stands.
 */
export async function removeHandleTools(
  manager: EntityManager,
  organizationId: string,
  now: Date,
): Promise<void> {
  await manager.query(
    `UPDATE tools
        SET status_before_removal = CASE WHEN status = 'REMOVED' THEN status_before_removal
                                         ELSE status END,
            status = 'REMOVED',
            removed_at = COALESCE(removed_at, $2),
            handle_removed_at = $2,
            -- A review in flight is void: nothing taken down can be approved.
            review_status = CASE WHEN review_status = 'PENDING'
                                 THEN CASE WHEN approved_version IS NULL THEN 'NONE' ELSE 'APPROVED' END
                                 ELSE review_status END,
            review_content_hash = NULL,
            updated_at = now()
      WHERE owner_org_id = $1 AND kind = 'PROVIDER' AND handle_removed_at IS NULL`,
    [organizationId, now],
  );
}

/**
 * A lifted handle takedown: its reason is cleared, and a tool serves again
 * only when no takedown of its own stands and it is still named under the
 * organization's current, active handle.
 */
export async function restoreHandleTools(
  manager: EntityManager,
  organizationId: string,
): Promise<void> {
  await manager.query(
    `UPDATE tools SET handle_removed_at = NULL, updated_at = now()
      WHERE owner_org_id = $1 AND kind = 'PROVIDER' AND handle_removed_at IS NOT NULL`,
    [organizationId],
  );
  await restoreWhereClear(manager, `t.owner_org_id = $1`, [organizationId]);
}

/** A lifted takedown of one tool: restored only under the same conditions. */
export async function restoreTakenDownTool(manager: EntityManager, toolId: string): Promise<void> {
  await manager.query(
    `UPDATE tools SET taken_down_at = NULL, updated_at = now()
      WHERE id = $1 AND kind = 'PROVIDER' AND taken_down_at IS NOT NULL`,
    [toolId],
  );
  await restoreWhereClear(manager, `t.id = $1`, [toolId]);
}

/**
 * REMOVED provider tools with no standing reason come back — but only those
 * named `{handle}__…` under their owner's current ACTIVE handle. A tool
 * whose handle was frozen, renamed away from it or reassigned stays removed.
 */
async function restoreWhereClear(
  manager: EntityManager,
  where: string,
  params: unknown[],
): Promise<void> {
  await manager.query(
    `UPDATE tools t
        SET status = COALESCE(t.status_before_removal, 'ACTIVE'),
            removed_at = NULL, status_before_removal = NULL, updated_at = now()
       FROM organizations o
      WHERE ${where} AND t.kind = 'PROVIDER' AND t.status = 'REMOVED'
        AND t.taken_down_at IS NULL AND t.handle_removed_at IS NULL
        AND o.id = t.owner_org_id AND o.handle IS NOT NULL AND o.handle_status = 'ACTIVE'
        AND left(t.name, length(o.handle) + 2) = o.handle || '__'`,
    params,
  );
}

/** The handle prefix a reassigned handle's old tools are renamed to: never claimable. */
export const TOMBSTONE_HANDLE_RE = /^removed-[0-9a-f]{8}$/;

/**
 * A reassigned handle moves to another organization; the old holder's
 * `{handle}__…` tools stay removed and are renamed `removed-{id}__…`, so the
 * names are free for the new holder and can never pass for the brand's.
 */
export async function tombstoneHandleTools(
  manager: EntityManager,
  organizationId: string,
  handle: string,
): Promise<void> {
  const prefix = `${handle}__`;
  const rows = (await manager.query(
    `SELECT id, name FROM tools
      WHERE owner_org_id = $1 AND kind = 'PROVIDER' AND left(name, length($2)) = $2
      FOR UPDATE`,
    [organizationId, prefix],
  )) as { id: string; name: string }[];
  for (const row of rows) {
    const tomb = `removed-${row.id.replace(/-/g, '').slice(0, 8)}`;
    const local = row.name.slice(prefix.length).slice(0, 48 - tomb.length - 2);
    await manager.query(
      `UPDATE tools
          SET name = $2,
              status_before_removal = CASE WHEN status = 'REMOVED' THEN status_before_removal
                                           ELSE status END,
              status = 'REMOVED', removed_at = COALESCE(removed_at, now()),
              handle_removed_at = COALESCE(handle_removed_at, now()),
              review_status = CASE WHEN review_status = 'PENDING'
                                   THEN CASE WHEN approved_version IS NULL THEN 'NONE' ELSE 'APPROVED' END
                                   ELSE review_status END,
              review_content_hash = NULL,
              updated_at = now()
        WHERE id = $1`,
      [row.id, `${tomb}__${local}`],
    );
  }
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
