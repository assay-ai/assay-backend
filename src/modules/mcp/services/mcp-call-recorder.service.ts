import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

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

import { agentPhrase } from '@modules/notification/domain/notice-text';

import { McpScope } from '../ports/mcp-scope';
import { MCP_RATE_LIMITS, McpRateLimiter, refusalKey } from './mcp-rate-limiter.service';
import { McpSession } from '../ports/mcp-session.port';

/** The refusals a refused-call row is written for, and the layer each belongs to. */
const REFUSAL_LAYER: Readonly<Record<string, RefusalLayer>> = Object.freeze({
  [ToolAccessErrorCode.TOOL_NOT_IN_TOOLSET]: RefusalLayer.SERVER,
  [ToolAccessErrorCode.TOOL_REMOVED]: RefusalLayer.SERVER,
  [ToolAccessErrorCode.CONTRACT_VERSION_RETIRED]: RefusalLayer.SERVER,
  [ToolAccessErrorCode.TOOL_NOT_ALLOWED]: RefusalLayer.AGENT_LIMITS,
  [McpErrorCode.MCP_POLICY_AGENT_PAUSED]: RefusalLayer.AGENT_LIMITS,
  [McpErrorCode.MCP_SPEND_LIMIT_EXCEEDED]: RefusalLayer.AGENT_LIMITS,
  [McpErrorCode.MCP_APPROVAL_REQUIRED]: RefusalLayer.AGENT_LIMITS,
  [McpErrorCode.MCP_VELOCITY_LIMIT_EXCEEDED]: RefusalLayer.AGENT_LIMITS,
  [McpErrorCode.MCP_QUOTA_EXCEEDED]: RefusalLayer.SERVER,
  [ToolErrorCode.TOOL_NO_ELIGIBLE_BINDING]: RefusalLayer.SERVER,
  [ToolErrorCode.TOOL_PROVIDER_SLASH_HOLD]: RefusalLayer.SERVER,
  [PaymentErrorCode.PAYMENT_NO_SETTLEABLE_CHAIN]: RefusalLayer.SERVER,
  [PaymentErrorCode.PAYMENT_PRICE_BELOW_MINIMUM]: RefusalLayer.SERVER,
});

/** The same refusal this many times within {@link REPEAT_WINDOW_SECONDS} alerts the owner. */
export const REPEAT_ALERT_THRESHOLD = 5;
export const REPEAT_WINDOW_SECONDS = 60 * 60;

/** What the MCP server adds to a refusal's `_meta["assay/error"]`. */
export interface RefusalNotice {
  /** `null` when the agent is past its per-minute cap: the refusal is counted, not stored. */
  readonly callId: string | null;
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
  private readonly logger = new Logger(McpCallRecorder.name);
  private unwiredWarned = false;

  constructor(
    private readonly records: ToolCallRecordWriter,
    @Optional() private readonly connectUrls?: ConnectUrlsService,
    @Optional() @Inject(MCP_HOST_CONFIG) private readonly host?: McpHostConfig,
    @Optional() private readonly cache?: CacheService,
    @Optional() @Inject(NOTIFICATION_PORT) private readonly notifications?: NotificationPort,
    @Optional() private readonly limiter?: McpRateLimiter,
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

    // Every refusal counts towards the agent's limit; only the first few a
    // minute are stored, so a looping agent cannot grow the table at will.
    const counted = await this.limiter?.take(
      refusalKey(session.agentId),
      MCP_RATE_LIMITS.refusalRowsPerMinute,
    );
    await this.alertOnRepeat(session, toolName, error.errorCode);
    if (counted && !counted.allowed) return { callId: null, fixUrl: null };

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

    return { callId, fixUrl: this.fixUrlOf(error.errorCode, session, callId) };
  }

  /**
   * The owner is told when the same refusal repeats: the fifth one for the
   * same agent, tool and code within an hour is the edge, seen here, where
   * the count is. Best effort — an alert never changes an outcome.
   */
  private async alertOnRepeat(session: McpSession, toolName: string, code: string): Promise<void> {
    if (!this.cache || !this.notifications) {
      this.warnUnwired();
      return;
    }
    // The name is the agent's own input: kept to the characters a tool name
    // can have, and short, before it reaches a key, a title or a body.
    const name = safeToolName(toolName);
    try {
      const key = `assay:refusal-repeat:${session.agentId}:${name}:${code}`;
      const redis = this.cache.getRedisClient();
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, REPEAT_WINDOW_SECONDS);
      if (count !== REPEAT_ALERT_THRESHOLD) return;

      await this.notifications.notify({
        organizationId: session.organizationId,
        event: NotificationEvent.CALL_REFUSED_REPEATEDLY,
        title: `Calls to ${name} keep being refused`,
        body:
          `${agentPhrase(session.label)} was refused ${REPEAT_ALERT_THRESHOLD} times within an hour ` +
          `calling ${name}: ${refusalWords(code)}. Nothing was charged.`,
        subjectType: 'agent',
        subjectId: session.agentId,
        payload: { toolName: name, code },
        dedupeKey: `${session.agentId}:${name}:${code}`,
      });
    } catch (error) {
      // Bookkeeping; the refusal itself already reached the agent.
      this.logger.warn(
        `refusal repeat alert skipped for agent ${session.agentId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Said once: a missing cache or notification port turns the repeat alert off. */
  private warnUnwired(): void {
    if (this.unwiredWarned) return;
    this.unwiredWarned = true;
    const missing = [!this.cache && 'CacheService', !this.notifications && 'NOTIFICATION_PORT']
      .filter(Boolean)
      .join(' and ');
    this.logger.warn(`${missing} not provided: call.refused_repeatedly is never sent`);
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
      return `${web}/spend/calls?call=${encodeURIComponent(callId)}`;
    }
    return null;
  }
}

function layerOf(error: AppError<unknown[]>): RefusalLayer | null {
  if (error.errorCode === ToolAccessErrorCode.NO_PROVIDER_MATCHES_RULES) {
    const details = error.context?.details as { providers?: { source: RuleSource }[] } | undefined;
    return layerOfSource(rejectionLayer(details?.providers ?? []));
  }
  if (error.errorCode === ToolAccessErrorCode.UNSUPPORTED_INPUT_FIELD) {
    const details = error.context?.details as { providers?: { source: RuleSource }[] } | undefined;
    const source = rejectionLayer(details?.providers ?? []);
    return source === RuleSource.AGENT || source === RuleSource.TOOLSET
      ? layerOfSource(source)
      : RefusalLayer.SERVER;
  }
  return REFUSAL_LAYER[error.errorCode] ?? null;
}

/** The refused-call layer a rule source files under: the request and a migration are the server's. */
function layerOfSource(source: RuleSource): RefusalLayer {
  if (source === RuleSource.AGENT) return RefusalLayer.AGENT_LIMITS;
  if (source === RuleSource.TOOLSET) return RefusalLayer.TOOLSET_RULES;
  return RefusalLayer.SERVER;
}

/** A tool name an agent sent, reduced to what a tool name may contain, at most 48 characters. */
export function safeToolName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48);
  return cleaned.length > 0 ? cleaned : 'unnamed';
}

/**
 * Why the calls were refused, in the words a notice uses; the code itself
 * stays in the payload. An unlisted code gets a plain sentence, never the code.
 */
const REFUSAL_WORDS: Readonly<Record<string, string>> = {
  TOOL_NOT_ALLOWED: 'the agent may not use this tool',
  TOOL_NOT_IN_TOOLSET: 'the tool is not in the tool set it calls through',
  TOOL_REMOVED: 'the tool was removed',
  NO_PROVIDER_MATCHES_RULES: "no provider fits the agent's provider limits",
  CONTRACT_VERSION_RETIRED: 'the tool version it asks for is retired',
  MCP_SPEND_LIMIT_EXCEEDED: 'a spending limit was reached',
  MCP_POLICY_AGENT_PAUSED: 'paid calls are paused',
  MCP_VELOCITY_LIMIT_EXCEEDED: 'it called too fast',
  MCP_QUOTA_EXCEEDED: 'its free calls are used up',
  TOOL_ARGUMENTS_INVALID: 'the request did not match the tool',
  TOOL_NO_ELIGIBLE_BINDING: 'no provider can serve the tool right now',
  PAYMENT_INSUFFICIENT_FUNDS: 'the balance is too low',
  PAYMENT_WITHDRAWAL_PENDING: 'a withdrawal is pending',
  PAYMENT_DEBT_OUTSTANDING: 'an unpaid call must be settled first',
  PAYMENT_PRICE_BELOW_MINIMUM: "the provider's price is below the paid-call minimum",
  PAYMENT_VOUCHER_DELEGATE_LIMIT_EXCEEDED: "its payment key's limit was reached",
  PAYMENT_VOUCHER_ESCROW_LIMIT_EXCEEDED: 'the account ceiling was reached',
  PAYMENT_VOUCHER_DELEGATE_NOT_BOUND: 'it has no payment key yet',
  PAYMENT_VOUCHER_DELEGATE_INACTIVE: 'its payment key is not active',
};

export function refusalWords(code: string): string {
  return REFUSAL_WORDS[code] ?? 'the same reason each time';
}
