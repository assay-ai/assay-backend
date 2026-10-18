import { EntityManager } from 'typeorm';

import { ToolsetErrors } from '../errors/toolset.errors';

/** Serialises every claim, rename and reassignment of one handle. */
export async function lockHandle(manager: EntityManager, handle: string): Promise<void> {
  await manager.query(`SELECT pg_advisory_xact_lock(hashtext('handle:' || $1))`, [handle]);
}

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
 * The tool may serve under its owner: the organization's current handle is
 * ACTIVE and the tool is still named `{handle}__…` under it. A tool whose
 * handle was frozen, renamed away from it or reassigned may not.
 */
const SERVES_UNDER_OWNER = `EXISTS (
  SELECT 1 FROM organizations o
   WHERE o.id = t.owner_org_id AND o.handle IS NOT NULL AND o.handle_status = 'ACTIVE'
     AND left(t.name, length(o.handle) + 2) = o.handle || '__')`;

/**
 * A lifted handle takedown, or a handle that became ACTIVE: the reason is
 * cleared on every tool that may serve under its owner's handle again, and
 * such a tool comes back unless its own takedown stands. A tool that may not
 * serve keeps the reason, so the check holds (a REMOVED tool always has one)
 * and a later lift picks it up. One statement per row, so the check never
 * sees a removal without a reason.
 */
export async function restoreHandleTools(
  manager: EntityManager,
  organizationId: string,
): Promise<void> {
  await manager.query(
    `UPDATE tools t
        SET handle_removed_at = NULL,
            status = CASE WHEN t.taken_down_at IS NULL
                          THEN COALESCE(t.status_before_removal, 'ACTIVE') ELSE t.status END,
            removed_at = CASE WHEN t.taken_down_at IS NULL THEN NULL ELSE t.removed_at END,
            status_before_removal = CASE WHEN t.taken_down_at IS NULL THEN NULL
                                         ELSE t.status_before_removal END,
            updated_at = now()
      WHERE t.owner_org_id = $1 AND t.kind = 'PROVIDER' AND t.handle_removed_at IS NOT NULL
        AND ${SERVES_UNDER_OWNER}`,
    [organizationId],
  );
}

/**
 * A lifted takedown of one tool: it comes back when it may serve under its
 * owner's handle — an ACTIVE handle has no takedown standing, so a handle
 * reason left on it is cleared too. When it may not, the lifted reason
 * becomes a handle reason, which a later handle lift clears.
 */
export async function restoreTakenDownTool(manager: EntityManager, toolId: string): Promise<void> {
  // The owner's handle, then its row, then the tool — a handle takedown's
  // order — so one landing meanwhile is seen, and neither deadlocks.
  const [tool] = (await manager.query(
    `SELECT owner_org_id AS "ownerOrgId" FROM tools WHERE id = $1`,
    [toolId],
  )) as { ownerOrgId: string | null }[];
  if (tool?.ownerOrgId) await lockOwner(manager, tool.ownerOrgId);
  await manager.query(
    `UPDATE tools t
        SET taken_down_at = NULL,
            handle_removed_at = CASE WHEN ${SERVES_UNDER_OWNER} THEN NULL
                                     ELSE COALESCE(t.handle_removed_at, now()) END,
            status = CASE WHEN ${SERVES_UNDER_OWNER}
                          THEN COALESCE(t.status_before_removal, 'ACTIVE') ELSE t.status END,
            removed_at = CASE WHEN ${SERVES_UNDER_OWNER} THEN NULL ELSE t.removed_at END,
            status_before_removal = CASE WHEN ${SERVES_UNDER_OWNER} THEN NULL
                                         ELSE t.status_before_removal END,
            updated_at = now()
      WHERE t.id = $1 AND t.kind = 'PROVIDER' AND t.taken_down_at IS NOT NULL`,
    [toolId],
  );
}

/**
 * Locks an organization's current handle and then its row, so a takedown,
 * rename or reassignment of the handle is either done or waits.
 */
async function lockOwner(manager: EntityManager, organizationId: string): Promise<void> {
  const [org] = (await manager.query(`SELECT handle FROM organizations WHERE id = $1`, [
    organizationId,
  ])) as { handle: string | null }[];
  if (org?.handle) await lockHandle(manager, org.handle);
  await manager.query(`SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE`, [organizationId]);
}

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
 * renames them. Refused when a name would pass the 48-character cap. A
 * review in flight is void, as on a takedown: its content hash covers the
 * name, so it could never be decided.
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
    await manager.query(
      `UPDATE tools
          SET name = $2,
              review_status = CASE WHEN review_status = 'PENDING'
                                   THEN CASE WHEN approved_version IS NULL THEN 'NONE' ELSE 'APPROVED' END
                                   ELSE review_status END,
              review_content_hash = NULL,
              updated_at = now()
        WHERE id = $1`,
      [row.id, `${to}__${row.name.slice(prefix.length)}`],
    );
  }
}
