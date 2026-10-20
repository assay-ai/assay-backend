import { Injectable, Logger } from '@nestjs/common';

import { ToolCallRecordRepository } from '@database/postgres/repositories/tool-call-record.repository';
import { ResponseClass } from '@modules/tool/domain/classification';
import { PricingMode } from '@modules/tool/ports/tool.types';

import { TOOL_CALL_RECORD_RETENTION_DAYS } from '../constants/free-quota.constants';

/** What the relay branch hands over once a free call has finished. */
export interface ToolCallRecordInput {
  readonly organizationId: string;
  readonly agentId: string;
  /** The same id sent as `X-Assay-Call-Id`. Idempotency key for this write. */
  readonly callId: string;
  readonly toolId: string;
  /** `null` only when no candidate survived routing — every binding refused. */
  readonly bindingId: string | null;
  readonly providerId: string | null;
  readonly pricingMode: PricingMode.FREE | PricingMode.FREEMIUM;
  readonly classification: ResponseClass;
  readonly latencyMs: number;
  /** The routed-call hash, same construction as `payment_intents.request_hash`. `null` when unroutable. */
  readonly requestHash: string | null;
  /** Which MCP URL the call came through (design spec §7.8); absent off the MCP path. */
  readonly attribution?: ToolCallAttribution | null;
}

/** The attribution columns `tool_call_records` shares with `payment_intents`. */
export interface ToolCallAttribution {
  readonly endpointKind: string;
  readonly toolsetId: string | null;
  readonly toolsetVersion: number | null;
  readonly endpointHandle: string | null;
  readonly viewFilter: Record<string, unknown> | null;
}

/** A call refused before anything was charged (FR-16). */
export interface RefusedCallRecordInput {
  readonly organizationId: string;
  readonly agentId: string;
  readonly callId: string;
  readonly toolId: string | null;
  readonly toolName: string;
  readonly refusalCode: string;
  readonly refusalLayer: string;
  readonly refusalDetail: Record<string, unknown> | null;
  readonly latencyMs: number;
  readonly attribution: ToolCallAttribution | null;
}

/**
 * Writes what a free call leaves behind instead of a payment intent.
 *
 * ## Not a batched writer
 *
 * The intended design is for the row to be *"written through the same
 * batched writer as ledger entries … because free traffic is expected to be
 * the highest-volume traffic on the platform and a per-row insert would set
 * the cost floor."* No such batched writer exists anywhere in this codebase
 * today — `LedgerJournalService` itself writes per-row — so building one here
 * would be inventing infrastructure attributed to a component that does not
 * exist. This class writes one row per call and is a placeholder for a
 * batched implementation later.
 *
 * ## Never throws
 *
 * Called from the relay branch **after** the agent has already been handed
 * its result — the same timing as `BindingCallCounterService.record` and
 * `FreeQuotaService.consume`. A write that failed loudly here would turn a
 * successful, already-returned free call into a 500 for something that has
 * nothing to do with whether the call succeeded.
 *
 * ## The unique `call_id` makes a retried write idempotent, not an error
 *
 * `uq_tool_call_records_call_id` exists precisely so a retried write cannot
 * double-count one free call against the quota that is the platform's only
 * cost control (`ToolCallRecordEntity`'s own class comment). A `23505` on that
 * index is therefore expected and silent; any other failure is logged.
 */
@Injectable()
export class ToolCallRecordWriter {
  private readonly logger = new Logger(ToolCallRecordWriter.name);

  constructor(private readonly records: ToolCallRecordRepository) {}

  async write(input: ToolCallRecordInput, now: Date = new Date()): Promise<void> {
    const expiresAt = new Date(
      now.getTime() + TOOL_CALL_RECORD_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
    );

    try {
      await this.records.insert({
        organizationId: input.organizationId,
        agentId: input.agentId,
        callId: input.callId,
        toolId: input.toolId,
        bindingId: input.bindingId,
        providerId: input.providerId,
        pricingMode: input.pricingMode,
        classification: input.classification,
        latencyMs: input.latencyMs,
        requestHash: input.requestHash,
        ...attributionColumns(input.attribution ?? null),
        // Free calls are meant to be verified at 1% flat, sampled by a worker
        // that does not exist yet (`VerificationSettlementService.enqueue` is
        // keyed on a payment intent id, and a free call has none). `NULL` is
        // *not checked*, never *passed*.
        verdict: null,
        expiresAt,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        this.logger.debug(
          `call ${input.callId}: tool_call_records row already exists — a retried write, not an error.`,
        );
        return;
      }

      this.logger.error(
        `call ${input.callId}: tool_call_records row not written. The free call already returned to ` +
          `the agent; only its record is missing. ${describe(error)}`,
      );
    }
  }

  /**
   * A refused call's row: no binding, no provider, no pricing mode or
   * classification — nothing reached a provider and nothing was charged. The
   * free-quota counts skip it. Never throws, for the reason `write` does not:
   * the refusal still reaches the agent.
   */
  async writeRefusal(input: RefusedCallRecordInput, now: Date = new Date()): Promise<void> {
    const expiresAt = new Date(
      now.getTime() + TOOL_CALL_RECORD_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
    );
    try {
      await this.records.insert({
        organizationId: input.organizationId,
        agentId: input.agentId,
        callId: input.callId,
        toolId: input.toolId,
        toolName: input.toolName.slice(0, 128),
        bindingId: null,
        providerId: null,
        pricingMode: null,
        classification: null,
        latencyMs: Math.max(0, Math.round(input.latencyMs)),
        requestHash: null,
        verdict: null,
        refusalCode: input.refusalCode,
        refusalLayer: input.refusalLayer,
        refusalDetail: input.refusalDetail,
        ...attributionColumns(input.attribution),
        expiresAt,
      });
    } catch (error) {
      this.logger.error(
        `call ${input.callId}: refused-call record not written (${input.refusalCode}). ${describe(error)}`,
      );
    }
  }
}

/** Postgres `23505`, whatever driver wrapper it arrives inside — same check `stake-monitor.service.ts` uses. */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; driverError?: { code?: string } };
  return candidate.code === '23505' || candidate.driverError?.code === '23505';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function attributionColumns(attribution: ToolCallAttribution | null) {
  return {
    endpointKind: attribution?.endpointKind ?? null,
    toolsetId: attribution?.toolsetId ?? null,
    toolsetVersion: attribution?.toolsetVersion ?? null,
    endpointHandle: attribution?.endpointHandle ?? null,
    viewFilter: attribution?.viewFilter ?? null,
  };
}
