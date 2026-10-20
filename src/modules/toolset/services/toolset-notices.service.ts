import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ToolsetVersionRepository } from '@database/postgres/repositories/toolset-sharing.repository';
import { ToolsetRepository } from '@database/postgres/repositories/toolset.repository';
import {
  NOTIFICATION_PORT,
  NotificationEvent,
  NotificationPort,
} from '@modules/notification/ports/notification.port';

import { MCP_HOST_CONFIG, McpHostConfig } from '../config/mcp-host.config';
import { OFFICIAL_HANDLE } from '../domain/handle';
import { ToolsetVisibility, servesPublicPath, versionServes } from '../domain/sharing';
import { SnapshotDiff, diffSnapshots } from '../domain/snapshot';
import { readAllowedToolsets } from '../domain/access';
import { pinReaches } from '../domain/pin';
import { HandlesService } from './handles.service';
import { sharingStateOf } from './sharing-row';
import { TOOLSET_CLOCK, ToolsetClock, systemClock } from './toolset-clock';
import { snapshotOfVersion } from './version-mapping';

/** At most one notice per toolset per organization in this window (§7.13, the digest). */
export const NOTICE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** Calls on an older version within this window make an organization a recipient (FR-17). */
export const NOTICE_LOOKBACK_DAYS = 30;
/** One publish never fans out further than this. */
export const NOTICE_MAX_RECIPIENTS = 5_000;

/**
 * FR-17: when a toolset publishes a new version, the owners of agents that
 * called an older version in the last 30 days are told, with the diff.
 *
 * At most one notice per toolset per organization per 7 days: a recipient
 * notified less than 7 days ago is skipped, and its next notice diffs from
 * the version it last used, so it reads as a digest. Never the publisher's own
 * organization; never a link token (the notice names the version and the
 * public URL when there is one).
 */
@Injectable()
export class ToolsetNoticesService {
  private readonly logger = new Logger(ToolsetNoticesService.name);

  constructor(
    private readonly toolsets: ToolsetRepository,
    private readonly versions: ToolsetVersionRepository,
    private readonly handles: HandlesService,
    @Inject(NOTIFICATION_PORT) private readonly notifications: NotificationPort,
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    @Inject(MCP_HOST_CONFIG) private readonly host: McpHostConfig,
    @Optional() @Inject(TOOLSET_CLOCK) private readonly now: ToolsetClock = systemClock,
  ) {}

  /** Returns how many organizations were notified. */
  async onPublished(toolsetId: string, version: number): Promise<number> {
    const toolset = await this.toolsets.findAnyById(toolsetId);
    const target = await this.versions.findVersion(toolsetId, version);
    if (!toolset || !target || toolset.removedAt) return 0;
    if (toolset.visibility === ToolsetVisibility.PRIVATE) return 0;

    const recipients = (await this.dataSource.query(
      `SELECT organization_id AS "orgId", max(toolset_version) AS "fromVersion"
         FROM (
           SELECT organization_id, toolset_version FROM payment_intents
            WHERE toolset_id = $1 AND toolset_version < $2
              AND created_at > now() - make_interval(days => $3)
           UNION ALL
           SELECT organization_id, toolset_version FROM tool_call_records
            WHERE toolset_id = $1 AND toolset_version < $2 AND refusal_code IS NULL
              AND created_at > now() - make_interval(days => $3)
         ) calls
        WHERE ($4::uuid IS NULL OR organization_id <> $4::uuid)
        GROUP BY organization_id
        LIMIT ${NOTICE_MAX_RECIPIENTS}`,
      [toolsetId, version, NOTICE_LOOKBACK_DAYS, toolset.ownerOrgId],
    )) as { orgId: string; fromVersion: number }[];
    if (recipients.length === 0) return 0;

    // Only organizations that can see the NEW version the way they reach the
    // toolset (review N1): anyone when it serves on the `/@…` URL; otherwise
    // only holders of a pin that still reaches it by a path serving the new
    // version — the same link (a rotated token is a different link) for a
    // version shared by link. A pin taken through `/@…` learns nothing of a
    // version published UNLISTED, and a revoked link holder nothing at all.
    const state = sharingStateOf(toolset);
    const now = this.now();
    if (!(await this.handles.ownerHandleActive(toolset.ownerOrgId))) return 0;
    const listed = servesPublicPath(state, now) && versionServes(target.sharedAs, 'PUBLIC');
    let eligible = recipients;
    if (!listed) {
      const rows = (await this.dataSource.query(
        `SELECT organization_id AS "orgId", allowed_toolsets AS refs FROM spend_policies
          WHERE organization_id = ANY($1::uuid[]) AND allowed_toolsets @> $2::jsonb
         UNION ALL
         SELECT organization_id, allowed_toolsets FROM agent_credentials
          WHERE organization_id = ANY($1::uuid[]) AND allowed_toolsets @> $2::jsonb`,
        [recipients.map((row) => row.orgId), JSON.stringify([{ toolsetId }])],
      )) as { orgId: string; refs: unknown }[];
      const reached = new Set(
        rows
          .filter((row) =>
            readAllowedToolsets(row.refs).some((ref) => {
              if (ref.toolsetId !== toolsetId) return false;
              const path = pinReaches(ref, state, now);
              return path !== null && versionServes(target.sharedAs, path);
            }),
          )
          .map((row) => row.orgId),
      );
      eligible = recipients.filter((row) => reached.has(row.orgId));
    }
    if (eligible.length === 0) return 0;

    const handle =
      toolset.ownerOrgId === null
        ? OFFICIAL_HANDLE
        : ((await this.handles.handlesOf([toolset.ownerOrgId])).get(toolset.ownerOrgId) ?? null);
    const label = handle ? `@${handle}/${toolset.slug}` : toolset.name;
    const url =
      handle && listed ? `${this.host.mcpPublicUrl}/@${handle}/${toolset.slug}@${version}` : null;
    const targetSnapshot = snapshotOfVersion(target);
    const diffs = new Map<number, SnapshotDiff>();

    let sent = 0;
    for (const { orgId, fromVersion } of eligible) {
      const recent = (await this.dataSource.query(
        `SELECT 1 FROM toolset_notice_log
          WHERE org_id = $1 AND toolset_id = $2 AND sent_at > $3 LIMIT 1`,
        [orgId, toolsetId, new Date(this.now().getTime() - NOTICE_INTERVAL_MS)],
      )) as unknown[];
      if (recent.length > 0) continue;

      const inserted = (await this.dataSource.query(
        `INSERT INTO toolset_notice_log (org_id, toolset_id, to_version, sent_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING org_id`,
        [orgId, toolsetId, version, this.now()],
      )) as unknown[];
      if (inserted.length === 0) continue;

      const from = Number(fromVersion);
      let diff = diffs.get(from);
      if (!diff) {
        const old = await this.versions.findVersion(toolsetId, from);
        diff = diffSnapshots(old ? snapshotOfVersion(old) : null, targetSnapshot);
        diffs.set(from, diff);
      }

      await this.notifications.notify({
        organizationId: orgId,
        event: NotificationEvent.TOOLSET_UPDATE_AVAILABLE,
        title: `${label} v${version} is available`,
        body: noticeBody(diff, from, version),
        subjectType: 'toolset',
        subjectId: toolsetId,
        dedupeKey: `${toolsetId}:v${version}`,
        payload: {
          toolsetId,
          handle,
          slug: toolset.slug,
          fromVersion: from,
          toVersion: version,
          mcpUrl: url,
          diff: { ...diff },
        },
      });
      sent += 1;
    }
    this.logger.log(`toolset ${toolsetId} v${version}: ${sent} update notices`);
    return sent;
  }
}

/** One plain paragraph a person reads in the inbox. */
export function noticeBody(diff: SnapshotDiff, from: number, to: number): string {
  const parts: string[] = [];
  if (diff.added.length) parts.push(`Added: ${diff.added.join(', ')}.`);
  if (diff.removed.length) parts.push(`Removed: ${diff.removed.join(', ')}.`);
  if (diff.rulesChanged.length)
    parts.push(`Provider rules changed: ${diff.rulesChanged.join(', ')}.`);
  if (diff.settingsChanged.length)
    parts.push(`Settings changed: ${diff.settingsChanged.join(', ')}.`);
  if (parts.length === 0) parts.push('No tool changes.');
  parts.push(`Your app still uses v${from} until you replace its URL with the v${to} one.`);
  return parts.join(' ');
}
