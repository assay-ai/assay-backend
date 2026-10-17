import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';

import { McpErrorCode } from '@modules/mcp/errors/mcp.errors';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import { ToolCallRecordWriter } from '@modules/free-tier/services/tool-call-record-writer.service';
import { RuleSource, rejectionLayer } from '@modules/tool/domain/routing';
import { ToolAccessErrorCode } from '@modules/tool/errors/tool-access.errors';
import { ToolErrorCode } from '@modules/tool/errors/tool.errors';
import { MCP_HOST_CONFIG, McpHostConfig } from '@modules/toolset/config/mcp-host.config';
import { RefusalLayer } from '@modules/toolset/domain/attribution';
import { ConnectUrlsService } from '@modules/toolset/services/connect-urls.service';
import {
  NOTIFICATION_PORT,
  NotificationEvent,
  NotificationPort,
} from '@modules/notification/ports/notification.port';
import { CacheService } from '@shared/cache/redis-cache/cache.service';
import { AppError } from '@shared/errors/app-errors';

import { McpScope } from '../ports/mcp-scope';
import { McpSession } from '../ports/mcp-session.port';

/** The refusals a refused-call row is written for, and the layer each belongs to. */
const REFUSAL_LAYER: Readonly<Record<string, RefusalLayer>> = Object.freeze({
  [ToolAccessErrorCode.TOOL_NOT_IN_TOOLSET]: RefusalLayer.SERVER,
  [ToolAccessErrorCode.TOOL_REMOVED]: RefusalLayer.SERVER,
  [ToolAccessErrorCode.TOOL_NOT_ALLOWED]: RefusalLayer.AGENT_LIMITS,
  [McpErrorCode.MCP_POLICY_AGENT_PAUSED]: RefusalLayer.AGENT_LIMITS,
  [McpErrorCode.MCP_SPEND_LIMIT_EXCEEDED]: RefusalLayer.AGENT_LIMITS,
  [McpErrorCode.MCP_APPROVAL_REQUIRED]: RefusalLayer.AGENT_LIMITS,
  [McpErrorCode.MCP_VELOCITY_LIMIT_EXCEEDED]: RefusalLayer.AGENT_LIMITS,
  [McpErrorCode.MCP_QUOTA_EXCEEDED]: RefusalLayer.SERVER,
  [ToolErrorCode.TOOL_NO_ELIGIBLE_BINDING]: RefusalLayer.SERVER,
  [ToolErrorCode.TOOL_PROVIDER_SLASH_HOLD]: RefusalLayer.SERVER,
  [PaymentErrorCode.PAYMENT_NO_SETTLEABLE_CHAIN]: RefusalLayer.SERVER,
});

/** The same refusal this many times within {@link REPEAT_WINDOW_SECONDS} alerts the owner. */
export const REPEAT_ALERT_THRESHOLD = 5;
export const REPEAT_WINDOW_SECONDS = 60 * 60;

/** What the MCP server adds to a refusal's `_meta["x402/error"]`. */
export interface RefusalNotice {
  readonly callId: string;
  readonly fixUrl: string | null;
}

/**
 * The bookkeeping around an MCP call that must never change its outcome:
 * the refused-call row (FR-16) and the first-call stamp on a URL the Connect
 * sheet handed out.
 *
 * A refusal is recorded only when nothing else recorded the call — no
 * intent was created (an error carrying an `intentId` has its payment record)
 * — and only for the refusals the refused-call view explains.
 */
@Injectable()
export class McpCallRecorder {
  constructor(
    private readonly records: ToolCallRecordWriter,
    @Optional() private readonly connectUrls?: ConnectUrlsService,
    @Optional() @Inject(MCP_HOST_CONFIG) private readonly host?: McpHostConfig,
    @Optional() private readonly cache?: CacheService,
    @Optional() @Inject(NOTIFICATION_PORT) private readonly notifications?: NotificationPort,
  ) {}

  /** Records `error` as a refused call when it is one; returns what the agent is told. */
  async recordRefusal(
    session: McpSession,
    scope: McpScope | undefined,
    toolName: string,
    error: unknown,
    startedAt: number,
  ): Promise<RefusalNotice | null> {
    if (!(error instanceof AppError)) return null;
    const layer = layerOf(error);
    if (!layer || error.context?.intentId) return null;

    const callId = randomUUID();
    const details = (error.context?.details as Record<string, unknown> | undefined) ?? null;
    await this.records.writeRefusal({
      organizationId: session.organizationId,
      agentId: session.agentId,
      callId,
      toolId: (details?.toolId as string | undefined) ?? null,
      toolName,
      refusalCode: error.errorCode,
      refusalLayer: layer,
      refusalDetail: details,
      latencyMs: Date.now() - startedAt,
      attribution: scope?.attribution ?? null,
    });
    await this.alertOnRepeat(session, toolName, error.errorCode);

    return { callId, fixUrl: this.fixUrlOf(error.errorCode, session, callId) };
  }

  /**
   * The owner is told when the same refusal repeats: the fifth one for the
   * same agent, tool and code within an hour is the edge, seen here, where
   * the count is. Best effort — an alert never changes an outcome.
   */
  private async alertOnRepeat(session: McpSession, toolName: string, code: string): Promise<void> {
    if (!this.cache || !this.notifications) return;
    try {
      const key = `assay:refusal-repeat:${session.agentId}:${toolName}:${code}`;
      const redis = this.cache.getRedisClient();
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, REPEAT_WINDOW_SECONDS);
      if (count !== REPEAT_ALERT_THRESHOLD) return;

      await this.notifications.notify({
        organizationId: session.organizationId,
        event: NotificationEvent.CALL_REFUSED_REPEATEDLY,
        title: `Calls to ${toolName} keep being refused`,
        body:
          `Agent ${session.agentId} was refused ${REPEAT_ALERT_THRESHOLD} times within an hour ` +
          `calling ${toolName} (${code}). Nothing was charged.`,
        subjectType: 'agent',
        subjectId: session.agentId,
        payload: { toolName, code },
        dedupeKey: `${session.agentId}:${toolName}:${code}`,
      });
    } catch {
      // Bookkeeping; the refusal itself already reached the agent.
    }
  }

  async markFirstCall(session: McpSession, scope: McpScope | undefined): Promise<void> {
    if (!scope || !this.connectUrls) return;
    await this.connectUrls.markFirstCall(
      session.organizationId,
      session.agentId,
      scope.view.canonicalUrl,
    );
  }

  /** The web page that fixes the refusal: the agent's access, or the refused call. */
  private fixUrlOf(code: string, session: McpSession, callId: string): string | null {
    const web = this.host?.webAppUrl;
    if (!web) return null;
    if (code === ToolAccessErrorCode.TOOL_NOT_ALLOWED) {
      return `${web}/agents?agent=${encodeURIComponent(session.agentId)}#access`;
    }
    if (code === ToolAccessErrorCode.NO_PROVIDER_MATCHES_RULES) {
      return `${web}/calls?call=${encodeURIComponent(callId)}`;
    }
    return null;
  }
}

function layerOf(error: AppError<unknown[]>): RefusalLayer | null {
  if (error.errorCode === ToolAccessErrorCode.NO_PROVIDER_MATCHES_RULES) {
    const details = error.context?.details as { providers?: { source: RuleSource }[] } | undefined;
    return rejectionLayer(details?.providers ?? []) === RuleSource.AGENT
      ? RefusalLayer.AGENT_LIMITS
      : RefusalLayer.TOOLSET_RULES;
  }
  return REFUSAL_LAYER[error.errorCode] ?? null;
}
