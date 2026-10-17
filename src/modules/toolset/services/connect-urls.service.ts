import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AgentConnectUrlRepository } from '@database/postgres/repositories/agent-connect-url.repository';
import { ToolsetRepository } from '@database/postgres/repositories/toolset.repository';
import { ToolAccessErrors } from '@modules/tool/errors/tool-access.errors';

import { BoundedTtlCache } from '@shared/utils/bounded-ttl-cache';

import { MCP_HOST_CONFIG, McpHostConfig } from '../config/mcp-host.config';
import {
  EndpointKind,
  McpPathKind,
  ParsedMcpUrl,
  canonicalUrl,
  endpointKindOf,
  parseMcpAbsoluteUrl,
  viewFilterFromRecord,
} from '../domain/mcp-url';

/** "Called recently" — the window the Servers in use list reads (design spec §7.10). */
export const SERVERS_IN_USE_WINDOW_DAYS = 30;

/** One canonical URL an agent has been handed or has called through. */
export interface ServerInUseRow {
  readonly canonicalUrl: string;
  readonly parsed: ParsedMcpUrl;
  readonly endpointKind: EndpointKind;
  readonly toolsetId: string | null;
  readonly serverName: string | null;
  readonly client: string | null;
  /** When the Connect sheet handed it out; `null` when it was only ever called. */
  readonly handedOutAt: Date | null;
  readonly firstCallAt: Date | null;
  readonly lastCallAt: Date | null;
}

interface AttributionGroup {
  endpoint_kind: string;
  toolset_id: string | null;
  toolset_version: number | null;
  view_filter: Record<string, unknown> | null;
  last_call_at: Date;
}

/**
 * `agent_connect_urls` and the URLs an agent actually called through.
 *
 * There is no connection object (design spec §10 L): a URL handed out by the
 * Connect sheet is remembered only for the "Waiting for first call" row, and
 * every other row of Servers in use is derived from the calls' attribution.
 */
@Injectable()
export class ConnectUrlsService {
  /** URLs whose first call this process already stamped; bounded, and re-checked hourly. */
  private readonly firstCallsSeen = new BoundedTtlCache<true>(50_000, 60 * 60 * 1_000);

  constructor(
    private readonly connectUrls: AgentConnectUrlRepository,
    private readonly toolsets: ToolsetRepository,
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    @Inject(MCP_HOST_CONFIG) private readonly host: McpHostConfig,
  ) {}

  /** `url` → its parsed and canonical form, or `URL_NOT_RECOGNISED`. Never fetched. */
  canonicalise(url: string): { parsed: ParsedMcpUrl; canonicalUrl: string } {
    const parsed = parseMcpAbsoluteUrl(url, this.host.mcpPublicUrl);
    if (!parsed) {
      throw ToolAccessErrors.urlNotRecognised({
        reason: `expected an MCP URL on ${this.host.mcpPublicUrl}`,
      });
    }
    return { parsed, canonicalUrl: canonicalUrl(this.host.mcpPublicUrl, parsed) };
  }

  async record(
    organizationId: string,
    agentId: string,
    input: { url: string; serverName: string | null; client: string | null },
  ): Promise<string> {
    const { canonicalUrl: canonical } = this.canonicalise(input.url);
    await this.connectUrls.record({
      organizationId,
      agentId,
      canonicalUrl: canonical,
      serverName: input.serverName,
      client: input.client,
    });
    return canonical;
  }

  /**
   * Stamp the first call through a URL the sheet handed out. Best effort, and
   * at most one write per URL per process: the live first-call check reads it.
   */
  async markFirstCall(organizationId: string, agentId: string, canonical: string): Promise<void> {
    const key = `${agentId}:${canonical}`;
    if (this.firstCallsSeen.has(key)) return;
    try {
      await this.connectUrls.markFirstCall(organizationId, agentId, canonical);
      this.firstCallsSeen.set(key, true);
    } catch {
      // Bookkeeping; a missed stamp leaves the row "waiting" until the next call.
    }
  }

  /** Every URL handed out to the agent or called through in the last 30 days, newest first. */
  async serversInUse(organizationId: string, agentId: string): Promise<ServerInUseRow[]> {
    const since = new Date(Date.now() - SERVERS_IN_USE_WINDOW_DAYS * 24 * 60 * 60 * 1_000);

    const [handedOut, intentGroups, recordGroups] = await Promise.all([
      this.connectUrls.find({ where: { organizationId, agentId } }),
      this.attributionGroups('payment_intents', organizationId, agentId, since),
      this.attributionGroups('tool_call_records', organizationId, agentId, since),
    ]);

    const toolsetIds = [
      ...new Set(
        [...intentGroups, ...recordGroups]
          .map((group) => group.toolset_id)
          .filter((id): id is string => id !== null),
      ),
    ];
    const slugs = new Map(
      (await this.toolsets.findOwnedByIds(organizationId, toolsetIds)).map((toolset) => [
        toolset.id,
        toolset.slug,
      ]),
    );

    const rows = new Map<string, ServerInUseRow>();
    for (const group of [...intentGroups, ...recordGroups]) {
      const parsed = parsedFromAttribution(group, slugs);
      if (!parsed) continue;
      const canonical = canonicalUrl(this.host.mcpPublicUrl, parsed);
      const existing = rows.get(canonical);
      const lastCallAt = new Date(group.last_call_at);
      if (!existing || (existing.lastCallAt && existing.lastCallAt < lastCallAt)) {
        rows.set(canonical, {
          canonicalUrl: canonical,
          parsed,
          endpointKind: group.endpoint_kind as EndpointKind,
          toolsetId: group.toolset_id,
          serverName: null,
          client: null,
          handedOutAt: null,
          firstCallAt: null,
          lastCallAt,
        });
      }
    }

    // A handed-out `/my/{slug}` names its toolset by slug; resolve it once.
    const handedOutSlugs = handedOut.flatMap((row) => {
      const parsed = parseMcpAbsoluteUrl(row.canonicalUrl, this.host.mcpPublicUrl);
      return parsed?.path.kind === McpPathKind.MY_TOOLSET ? [parsed.path.slug] : [];
    });
    const idsBySlug = new Map(
      (await this.toolsets.findOwnedBySlugs(organizationId, handedOutSlugs)).map((toolset) => [
        toolset.slug,
        toolset.id,
      ]),
    );

    for (const row of handedOut) {
      const parsed = parseMcpAbsoluteUrl(row.canonicalUrl, this.host.mcpPublicUrl);
      if (!parsed) continue;
      const called = rows.get(row.canonicalUrl);
      const toolsetId =
        called?.toolsetId ??
        (parsed.path.kind === McpPathKind.MY_TOOLSET
          ? (idsBySlug.get(parsed.path.slug) ?? null)
          : null);
      rows.set(row.canonicalUrl, {
        canonicalUrl: row.canonicalUrl,
        parsed,
        endpointKind: called?.endpointKind ?? endpointKindOf(parsed.path),
        toolsetId,
        serverName: row.serverName,
        client: row.client,
        handedOutAt: row.createdAt,
        firstCallAt: row.firstCallAt,
        lastCallAt: called?.lastCallAt ?? null,
      });
    }

    return [...rows.values()].sort(
      (a, b) => recency(b) - recency(a) || a.canonicalUrl.localeCompare(b.canonicalUrl),
    );
  }

  private attributionGroups(
    table: 'payment_intents' | 'tool_call_records',
    organizationId: string,
    agentId: string,
    since: Date,
  ): Promise<AttributionGroup[]> {
    // A refused call is not a server in use: an agent calling a URL it may not
    // use must not be able to steer "only what's connected" onto it.
    const servedOnly = table === 'tool_call_records' ? 'AND "refusal_code" IS NULL' : '';
    return this.dataSource.query(
      `SELECT "endpoint_kind", "toolset_id", "toolset_version", "view_filter",
              max("created_at") AS "last_call_at"
         FROM "${table}"
        WHERE "organization_id" = $1
          AND "agent_id" = $2
          AND "created_at" >= $3
          AND "endpoint_kind" IS NOT NULL
          ${servedOnly}
        GROUP BY "endpoint_kind", "toolset_id", "toolset_version", "view_filter"`,
      [organizationId, agentId, since],
    );
  }
}

/**
 * A call's attribution → the URL it came through. Only the forms T1 serves
 * can be rebuilt: `/` and the organization's own `/my/{slug}`.
 */
function parsedFromAttribution(
  group: AttributionGroup,
  slugs: ReadonlyMap<string, string>,
): ParsedMcpUrl | null {
  const filter = viewFilterFromRecord(group.view_filter);
  if (group.endpoint_kind === EndpointKind.ROOT) {
    return { path: { kind: McpPathKind.ROOT }, filter };
  }
  if (group.endpoint_kind === EndpointKind.TOOLSET && group.toolset_id) {
    const slug = slugs.get(group.toolset_id);
    if (!slug) return null;
    return {
      path: { kind: McpPathKind.MY_TOOLSET, slug, version: group.toolset_version ?? null },
      filter,
    };
  }
  return null;
}

function recency(row: ServerInUseRow): number {
  return Math.max(row.lastCallAt?.getTime() ?? 0, row.handedOutAt?.getTime() ?? 0);
}
