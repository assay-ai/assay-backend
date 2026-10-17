import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import { Injectable, Logger, Optional } from '@nestjs/common';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { JsonObject } from '@modules/tool/domain/mapping';
import { ToolErrorCode } from '@modules/tool/errors/tool.errors';
import { AppError } from '@shared/errors/app-errors';
import { BaseError } from '@shared/errors/base.error';

import { PaymentErrorCode, PaymentErrors } from '@modules/payment/errors/payment.errors';
import { PaymentRail } from '@modules/payment/ports/payment.types';

import {
  X402_ERROR,
  X402_PAYMENT_REQUIRED,
  X402_RAIL,
  X402_RECEIPT,
  X402_VOUCHER,
} from '../constants/mcp.constants';
import { ToolAccessErrorCode } from '@modules/tool/errors/tool-access.errors';

import { McpErrorCode } from '../errors/mcp.errors';
import { McpScope } from '../ports/mcp-scope';
import { McpSession } from '../ports/mcp-session.port';
import { McpCallRecorder, RefusalNotice } from './mcp-call-recorder.service';
import { McpCatalogueService, displayPrice } from './mcp-catalogue.service';
import {
  McpCallOutcome,
  McpPayment,
  McpReceipt,
  McpToolCallService,
} from './mcp-tool-call.service';

/**
 * The MCP protocol surface.
 *
 * One `Server` per request, bound to one resolved session. The transport is
 * stateless by design — the HTTP
 * transport carries nothing between requests but the session token, so the
 * service scales horizontally with no sticky sessions — and a server instance
 * that outlived the request would be a server instance holding one agent's
 * identity while another agent's request arrived on it.
 *
 * Everything above this line is the platform; everything below it is the MCP
 * specification. The split is deliberate: {@link McpToolCallService} returns a
 * platform outcome and knows nothing about `content` blocks or `isError`, and
 * this file knows nothing about holds, classifications or the ledger.
 */
@Injectable()
export class McpServerFactory {
  private readonly logger = new Logger(McpServerFactory.name);

  constructor(
    private readonly catalogue: McpCatalogueService,
    private readonly calls: McpToolCallService,
    // Refused-call rows and the first-call stamp. Optional so a hand-built
    // harness needs none; it never changes an outcome.
    @Optional() private readonly recorder?: McpCallRecorder,
  ) {}

  /**
   * `scope` is what this URL serves and what this caller may use (`McpScope`):
   * `tools/list` returns view ∩ access, and every `tools/call` is checked
   * against both again. Absent only in harnesses that predate URLs.
   */
  create(session: McpSession, scope?: McpScope): Server {
    // The server sends no `notifications/tools/list_changed`: responses are
    // JSON only and there is no stream to send one on (design spec §7.4).
    const server = new Server(
      { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      { capabilities: { tools: { listChanged: false } } },
    );

    // The viewer is passed, not omitted: `x402/freeQuota` is *this agent's*
    // remaining allowance, and a catalogue listed without a viewer publishes no
    // quota at all — which reads to an agent as "this tool has no free tier"
    // rather than as "we did not look".
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = await this.catalogue.listTools(
        {
          organizationId: session.organizationId,
          agentId: session.agentId,
          // Rule 1 of `chooseSettlementChain`: a multi-chain tool is quoted as
          // settling on the chain this agent's own call would take. It narrows nothing.
          chainId: session.chainId,
        },
        scope,
      );
      // An unknown name in `?tools=` is ignored, and said so (§7.4).
      const ignored = scope ? await this.catalogue.ignoredTools(scope) : [];
      return ignored.length > 0 ? { tools, _meta: { [ASSAY_IGNORED_TOOLS]: ignored } } : { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args, _meta: meta } = request.params;
      const startedAt = Date.now();
      void this.recorder?.markFirstCall(session, scope).catch(() => undefined);

      try {
        const outcome = await this.calls.call(
          session,
          name,
          (args ?? {}) as JsonObject,
          paymentOf(meta),
          scope,
        );
        return toCallToolResult(outcome);
      } catch (error) {
        const notice = await this.recorder
          ?.recordRefusal(session, scope, name, error, startedAt)
          .catch(() => null);
        // Everything that can go wrong with a *tool call* is reported inside
        // the result, not as a JSON-RPC error. The distinction the
        // specification draws is between "the protocol failed" and "the tool
        // did not succeed", and an unaffordable call, an unknown tool or bad
        // arguments are all the second: the model that made the call is
        // supposed to read them and decide what to do, and a transport-level
        // error is not something a model gets to see.
        return this.toErrorResult(session, name, error, notice ?? null);
      }
    });

    return server;
  }

  private toErrorResult(
    session: McpSession,
    name: string,
    error: unknown,
    notice: RefusalNotice | null = null,
  ): CallToolResult {
    if (!(error instanceof BaseError)) {
      // Not ours, so nothing about it is safe to describe. `AllExceptionsFilter`
      // would have said `INTERNAL_SERVER_ERROR` and nothing else; this says the
      // same and logs the detail where it belongs.
      this.logger.error(
        `${session.credentialId}: ${name} failed with a non-platform error`,
        error instanceof Error ? error.stack : String(error),
      );
      return errorResult('The tool call failed', {
        code: 'INTERNAL_SERVER_ERROR',
        retryable: true,
      });
    }

    this.logger.warn(`${session.credentialId}: ${name} → ${error.errorCode}: ${error.message}`);

    // The spec's agent-facing refusals (design spec §7.4, "Errors"): the plain
    // message, the fix page and the structured details, on `x402/error`.
    if (SPEC_REFUSAL_CODES.has(error.errorCode)) {
      const context = error instanceof AppError && error.context ? error.context : {};
      return errorResult(error.message, {
        code: error.errorCode,
        message: error.message,
        retryable: false,
        ...(notice?.fixUrl ? { fixUrl: notice.fixUrl } : {}),
        ...(notice ? { callId: notice.callId } : {}),
        ...(context.details ? { details: context.details } : {}),
      });
    }

    return errorResult(error.message, {
      // Spread before `code`/`retryable` so neither can be shadowed by a
      // same-named key a domain's `context` happened to carry.
      //
      // `AppError.context` is what every spend-policy refusal must carry so an
      // agent can recover when a limit is hit mid-task — `resetsAt` for a cap,
      // `retryAfter` for velocity — and until this spread existed it was
      // computed by every domain error factory and then discarded here:
      // `AppError.context`'s own doc comment says as much ("deliberately not
      // in `toJSON()` … this field is for a `catch` block, not for a
      // caller"), and this **is** that catch block, so it is the one place
      // allowed to read it back out onto the wire.
      ...(error instanceof AppError && error.context ? error.context : {}),
      code: error.errorCode,
      retryable: isRetryableFailure(error.errorCode),
    });
  }
}

// ---------------------------------------------------------------------------
// Platform outcome → MCP result
// ---------------------------------------------------------------------------

export const MCP_SERVER_NAME = 'assay';

/** `_meta["assay/ignoredTools"]` on a list: `?tools=` names this URL does not serve. */
export const ASSAY_IGNORED_TOOLS = 'assay/ignoredTools';

/** The codes of design spec §7.4's error table that this phase raises. */
const SPEC_REFUSAL_CODES: ReadonlySet<string> = new Set<string>([
  ToolAccessErrorCode.TOOL_NOT_IN_TOOLSET,
  ToolAccessErrorCode.TOOL_NOT_ALLOWED,
  ToolAccessErrorCode.TOOL_REMOVED,
  ToolAccessErrorCode.NO_PROVIDER_MATCHES_RULES,
]);

/**
 * The request's `_meta` → what the agent said about paying (rail B).
 *
 * Only the envelope is checked here — that `x402/voucher` is an object with a
 * voucher object, a signature string and a provider id. Every field INSIDE the
 * voucher is `VoucherService`'s to judge, against values this server computes
 * itself; checking them twice would mean two definitions of a valid voucher.
 */
function paymentOf(meta: Record<string, unknown> | undefined): McpPayment {
  const railValue = meta?.[X402_RAIL];
  const rail =
    railValue === 'A'
      ? PaymentRail.RAIL_A_PER_CALL
      : railValue === 'B'
        ? PaymentRail.RAIL_B_VOUCHER
        : null;

  const raw = meta?.[X402_VOUCHER];
  if (raw === undefined || raw === null) return { rail, voucher: null };

  const envelope = raw as Record<string, unknown>;
  if (
    typeof raw !== 'object' ||
    typeof envelope.voucher !== 'object' ||
    envelope.voucher === null ||
    typeof envelope.signature !== 'string' ||
    typeof envelope.providerId !== 'string'
  ) {
    throw PaymentErrors.voucherMalformed({
      field: X402_VOUCHER,
      reason: 'expected { voucher: object, signature: string, providerId: string }',
    });
  }

  return {
    rail,
    voucher: {
      signed: { voucher: envelope.voucher as never, signature: envelope.signature },
      providerId: envelope.providerId,
    },
  };
}
export const MCP_SERVER_VERSION = '0.1.0';

function toCallToolResult(outcome: McpCallOutcome): CallToolResult {
  if (outcome.kind === 'ERROR') {
    return errorResult(outcome.message, {
      code: outcome.code,
      retryable: outcome.retryable,
      intentId: outcome.intentId,
      ...outcome.detail,
    });
  }

  return {
    // The text block is the compatibility surface: every MCP client renders it,
    // including the ones that predate `structuredContent`.
    content: [{ type: 'text', text: JSON.stringify(outcome.output) }],
    // The typed surface. Present because the tool publishes an `outputSchema`,
    // and a client that read that schema will validate against this — omitting
    // it makes the SDK reject an otherwise perfectly good result.
    structuredContent: outcome.output as Record<string, unknown>,
    _meta: { [X402_RECEIPT]: receiptPayload(outcome.receipt) },
  };
}

/**
 * The receipt.
 *
 * `status` is the intent's real status rather than a fixed `"verifying"`,
 * because some outcomes are already terminal by the time the agent sees this
 * — printing `verifying` would describe a verification that is not going to
 * happen.
 */
function receiptPayload(receipt: McpReceipt): Record<string, unknown> {
  return {
    intentId: receipt.intentId,
    charged: {
      amount: receipt.charged.amount,
      asset: receipt.charged.asset,
      // The same rendering `tools/list` quoted. An agent that read `$0.01`
      // before the call and `0.010000 USDC` after it has to work out for itself
      // that they are the same number.
      display: displayPrice(receipt.charged),
    },
    // Beside `charged`, not folded into it: before the verdict the price is
    // reserved, and an agent reading "charged" for a call a DATA_FAIL refunds
    // a second later would be reading something that never happened.
    held: {
      amount: receipt.held.amount,
      asset: receipt.held.asset,
      display: displayPrice(receipt.held),
    },
    status: receipt.status,
    toolId: receipt.toolId,
    providerId: receipt.providerId,
    classification: receipt.classification,
    attempts: receipt.attempts,
    // FALLBACK_BEST dropped the toolset entry's provider preferences.
    ...(receipt.fellBack ? { fellBack: true } : {}),
  };
}

/**
 * `_meta[x402/error]`, plus `_meta[x402/paymentRequired]` when the refusal
 * carries a paid way forward.
 *
 * The paid option is promoted to its **own** `_meta` key rather than left
 * nested inside the error, because that is where an agent looks for it — it
 * is the same key the unfunded-wallet path uses, and the whole commercial
 * point of `FREEMIUM` is that hitting the
 * quota and then paying requires no reconfiguration by the agent. An agent
 * that had to know a payment option is sometimes a field of an error object
 * and sometimes a sibling of it would reasonably read neither.
 */
function errorResult(message: string, meta: Record<string, unknown>): CallToolResult {
  const { paymentRequired, ...error } = meta;

  return {
    isError: true,
    content: [{ type: 'text', text: message }],
    _meta: {
      [X402_ERROR]: error,
      ...(paymentRequired ? { [X402_PAYMENT_REQUIRED]: paymentRequired } : {}),
    },
  };
}

/**
 * Whether trying the same call again can plausibly succeed.
 *
 * Without a retryable flag, agents either retry everything — amplifying an
 * outage — or retry nothing, failing on transient errors. So the default is
 * **false**. A code that is not on this list is one nobody has reasoned
 * about, and guessing "retryable" for it is the answer that
 * turns an incident into a stampede.
 *
 * Provider-outcome retryability does not come from here — it comes from
 * `isRetryable()` in the classifier's vocabulary, which is the same answer the router
 * used to decide failover. This table covers only the failures that never
 * reached a classification.
 */
function isRetryableFailure(code: string): boolean {
  return RETRYABLE_CODES.has(code);
}

const RETRYABLE_CODES: ReadonlySet<string> = new Set<string>([
  // Every provider we could reach failed its own infrastructure. A different
  // one may be back, or the same one may have recovered.
  ToolErrorCode.TOOL_ALL_BINDINGS_FAILED,
  // Free-tier quota: it resets.
  McpErrorCode.MCP_QUOTA_EXCEEDED,
  // Velocity — the window it was measured in rolls over on its own, so this
  // one is `retryable: true`, unlike a cap or a pause, which are not — see
  // `McpErrorCode.MCP_VELOCITY_LIMIT_EXCEEDED`.
  McpErrorCode.MCP_VELOCITY_LIMIT_EXCEEDED,
  // The chain state behind a voucher's authority (a delegate's grant) could
  // not be read. Nothing was charged; the read
  // is retried on the next call.
  ChainErrorCode.CHAIN_VOUCHER_AUTHORITY_UNAVAILABLE,
  // The payer is relaying a change that tightens its caps (BUG-D1-07). Nothing
  // was charged and the seq is not spent; the same call passes once the change
  // has landed. The error carries `retryAfter` (seconds).
  PaymentErrorCode.PAYMENT_VOUCHER_ADMISSION_PAUSED,
  // A seq never used but passed by a parallel call of the same payer (final
  // review N-6). Nothing was charged; the call passes with a fresh seq.
  PaymentErrorCode.PAYMENT_VOUCHER_SEQ_STALE,
]);
