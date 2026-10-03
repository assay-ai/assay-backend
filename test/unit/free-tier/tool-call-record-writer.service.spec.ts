import { ResponseClass } from '@modules/tool/domain/classification';
import { PricingMode } from '@modules/tool/ports/tool.types';
import { ToolCallRecordWriter } from '@modules/free-tier/services/tool-call-record-writer.service';
import { TOOL_CALL_RECORD_RETENTION_DAYS } from '@modules/free-tier/constants/free-quota.constants';

import { AGENT_ID, ORGANIZATION_ID, TOOL_ID } from './helpers/free-quota-fixtures';

class FakeInsertRepository {
  readonly inserted: Array<Record<string, unknown>> = [];
  nextError: unknown = null;

  insert(row: Record<string, unknown>): Promise<unknown> {
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      return Promise.reject(error);
    }
    this.inserted.push(row);
    return Promise.resolve({});
  }
}

const BASE_INPUT = {
  organizationId: ORGANIZATION_ID,
  agentId: AGENT_ID,
  callId: '33333333-3333-4333-8333-333333333333',
  toolId: TOOL_ID,
  bindingId: 'binding-1',
  providerId: 'provider-1',
  pricingMode: PricingMode.FREE as const,
  classification: ResponseClass.DATA_RESULT,
  latencyMs: 120,
  requestHash: 'hash-1',
};

describe('ToolCallRecordWriter', () => {
  it('writes verdict: null and an expiry 30 days out', async () => {
    const records = new FakeInsertRepository();
    const writer = new ToolCallRecordWriter(records as never);
    const now = new Date('2026-08-20T10:00:00.000Z');

    await writer.write(BASE_INPUT, now);

    expect(records.inserted).toHaveLength(1);
    const row = records.inserted[0];
    expect(row.verdict).toBeNull();
    expect((row.expiresAt as Date).toISOString()).toBe(
      new Date(
        now.getTime() + TOOL_CALL_RECORD_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
      ).toISOString(),
    );
    expect(row.callId).toBe(BASE_INPUT.callId);
  });

  it('treats a unique-violation on call_id as an idempotent no-op, not an error', async () => {
    const records = new FakeInsertRepository();
    records.nextError = { code: '23505' };
    const writer = new ToolCallRecordWriter(records as never);

    await expect(writer.write(BASE_INPUT)).resolves.toBeUndefined();
    expect(records.inserted).toHaveLength(0);
  });

  it('never throws on an unrelated write failure', async () => {
    const records = new FakeInsertRepository();
    records.nextError = new Error('connection reset');
    const writer = new ToolCallRecordWriter(records as never);

    await expect(writer.write(BASE_INPUT)).resolves.toBeUndefined();
  });
});
