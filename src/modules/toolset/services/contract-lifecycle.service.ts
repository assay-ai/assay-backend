import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import {
  NOTIFICATION_PORT,
  NotificationEvent,
  NotificationPort,
} from '@modules/notification/ports/notification.port';
import {
  TOOL_CONTRACT_CHANGES,
  ToolContractChanges,
} from '@modules/tool/ports/tool-contracts.port';

import { TOOLSET_CLOCK, ToolsetClock, systemClock } from './toolset-clock';

/** Calls in this window make an organization a buyer of the tool (as FR-17). */
export const CONTRACT_NOTICE_LOOKBACK_DAYS = 30;
/** One deprecation or retirement never fans out further than this. */
export const CONTRACT_NOTICE_MAX_RECIPIENTS = 5_000;

/** What a notice is about: one major of one tool. */
export interface ContractNoticeSubject {
  readonly toolId: string;
  readonly toolName: string;
  readonly major: number;
  readonly sunsetAt: Date;
  /** What to use instead, as `replacementOf` names it. */
  readonly replacement: string | null;
}

/**
 * Deprecation and retirement of contract majors (design spec §7.5):
 *
 * - **Deprecated**: the affected buyers and providers are told, once per
 *   tool major, with the sunset date and the replacement.
 * - **Retired**: at `sunset_at` every DEPRECATED version becomes RETIRED, the
 *   contract caches re-read at once, and the same organizations are told.
 *   Calls that can only use it then get `CONTRACT_VERSION_RETIRED`.
 *
 * Affected organizations: a provider with a binding whose range covers the
 * major; a buyer that called the tool in the last 30 days or whose toolset
 * Draft routes the tool to that major. Calls carry no contract version, so a
 * recent buyer is told even if its calls used another major — the notice
 * says which major retires, and pinned URLs are what it concerns.
 */
@Injectable()
export class ContractLifecycleService {
  private readonly logger = new Logger(ContractLifecycleService.name);

  constructor(
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    @Inject(NOTIFICATION_PORT) private readonly notifications: NotificationPort,
    @Optional() @Inject(TOOL_CONTRACT_CHANGES) private readonly changes?: ToolContractChanges,
    @Optional() @Inject(TOOLSET_CLOCK) private readonly now: ToolsetClock = systemClock,
  ) {}

  /** Tells the affected organizations a major was deprecated; returns how many. */
  async notifyDeprecated(subject: ContractNoticeSubject): Promise<number> {
    const sunset = subject.sunsetAt.toISOString().slice(0, 10);
    return this.notifyAffected(subject, {
      event: NotificationEvent.TOOL_VERSION_DEPRECATED,
      dedupe: 'deprecated',
      title: `${subject.toolName} v${subject.major} is deprecated`,
      body:
        `Version ${subject.major} of ${subject.toolName} stops serving on ${sunset} (UTC).` +
        (subject.replacement ? ` Use ${subject.replacement}.` : '') +
        ' Calls pinned to it, and bindings that serve only it, need to move before then.',
    });
  }

  /**
   * Retires every DEPRECATED version whose sunset has passed. Returns how
   * many versions retired; the contract caches re-read when any did.
   */
  async retireDue(): Promise<number> {
    const now = this.now();
    const rows = (await this.dataSource.query(
      `UPDATE "tool_versions" v
          SET "status" = 'RETIRED', "updated_at" = now()
         FROM "tools" t
        WHERE t."id" = v."tool_id"
          AND v."status" = 'DEPRECATED' AND v."sunset_at" <= $1
        RETURNING v."tool_id" AS "toolId", v."major" AS "major", v."sunset_at" AS "sunsetAt",
                  t."name" AS "toolName"`,
      [now],
    )) as unknown;
    const retired = (Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows) as {
      toolId: string;
      major: number;
      sunsetAt: Date;
      toolName: string;
    }[];
    if (!Array.isArray(retired) || retired.length === 0) return 0;

    await this.changes?.contractsChanged();
    const majors = new Map<string, (typeof retired)[number]>();
    for (const row of retired) majors.set(`${row.toolId}:${row.major}`, row);
    for (const row of majors.values()) {
      await this.notifyAffected(
        {
          toolId: row.toolId,
          toolName: row.toolName,
          major: Number(row.major),
          sunsetAt: new Date(row.sunsetAt),
          replacement: await this.replacementName(row.toolId, Number(row.major)),
        },
        {
          event: NotificationEvent.TOOL_VERSION_RETIRED,
          dedupe: 'retired',
          title: `${row.toolName} v${row.major} was retired`,
          body:
            `Version ${row.major} of ${row.toolName} no longer serves calls; calls that can ` +
            `only use it are refused with CONTRACT_VERSION_RETIRED.`,
        },
      ).catch((error: unknown) => {
        this.logger.warn(
          `retirement notices for ${row.toolId} v${row.major} failed: ${describe(error)}`,
        );
      });
    }
    this.logger.log(`${retired.length} contract versions retired at their sunset`);
    return retired.length;
  }

  private async notifyAffected(
    subject: ContractNoticeSubject,
    notice: { event: NotificationEvent; dedupe: string; title: string; body: string },
  ): Promise<number> {
    const recipients = (await this.dataSource.query(
      `SELECT org_id AS "orgId", bool_or(provider) AS "provider" FROM (
         SELECT organization_id AS org_id, true AS provider FROM tool_bindings
          WHERE tool_id = $1
            AND $2 = ANY (string_to_array(replace(replace(tool_version_range, '^', ''), ' ', ''), '||')::int[])
         UNION ALL
         SELECT organization_id, false FROM payment_intents
          WHERE tool_id = $1 AND created_at > now() - make_interval(days => $3)
         UNION ALL
         SELECT organization_id, false FROM tool_call_records
          WHERE tool_id = $1 AND refusal_code IS NULL
            AND created_at > now() - make_interval(days => $3)
         UNION ALL
         SELECT t.owner_org_id, false FROM toolset_entries e
           JOIN toolsets t ON t.id = e.toolset_id
          WHERE e.tool_id = $1 AND t.owner_org_id IS NOT NULL AND t.deleted_at IS NULL
            AND $2 = ANY (string_to_array(replace(replace(coalesce(e.tool_version_range, ''), '^', ''), ' ', ''), '||')::int[])
       ) affected
       WHERE org_id IS NOT NULL
       GROUP BY org_id
       LIMIT ${CONTRACT_NOTICE_MAX_RECIPIENTS}`,
      [subject.toolId, subject.major, CONTRACT_NOTICE_LOOKBACK_DAYS],
    )) as { orgId: string; provider: boolean }[];

    let sent = 0;
    for (const { orgId, provider } of recipients) {
      await this.notifications.notify({
        organizationId: orgId,
        event: notice.event,
        title: notice.title,
        body: notice.body,
        subjectType: 'tool',
        subjectId: subject.toolId,
        dedupeKey: `${subject.toolId}:v${subject.major}:${notice.dedupe}`,
        payload: {
          toolId: subject.toolId,
          toolName: subject.toolName,
          major: subject.major,
          sunsetAt: subject.sunsetAt.toISOString(),
          replacement: subject.replacement,
          role: provider ? 'PROVIDER' : 'BUYER',
        },
      });
      sent += 1;
    }
    this.logger.log(`${subject.toolName} v${subject.major}: ${sent} ${notice.event} notices`);
    return sent;
  }

  /** The replacement a retirement notice names: the replacement tool, or the newest other major. */
  private async replacementName(toolId: string, major: number): Promise<string | null> {
    const [row] = (await this.dataSource.query(
      `SELECT r.name AS "replacement",
              (SELECT v.semver FROM tool_versions v
                WHERE v.tool_id = t.id AND v.major > $2 AND v.status IN ('ACTIVE', 'DEPRECATED')
                ORDER BY v.major DESC, v.version DESC LIMIT 1) AS "newer",
              t.name AS "name"
         FROM tools t LEFT JOIN tools r ON r.id = t.replacement_tool_id
        WHERE t.id = $1`,
      [toolId, major],
    )) as { replacement: string | null; newer: string | null; name: string }[];
    if (!row) return null;
    if (row.replacement) return row.replacement;
    return row.newer ? `${row.name}@${row.newer.split('.')[0]} (v${row.newer})` : null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
