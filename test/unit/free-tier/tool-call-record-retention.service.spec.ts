import { ToolCallRecordRetentionService } from '@modules/free-tier/services/tool-call-record-retention.service';

import { DEFAULT_TEST_CONFIG } from './helpers/free-quota-fixtures';

class FakeRecords {
  calls: Array<{ now: Date; limit: number }> = [];
  result: number | Error = 0;

  deleteExpired(now: Date, limit: number): Promise<number> {
    this.calls.push({ now, limit });
    if (this.result instanceof Error) return Promise.reject(this.result);
    return Promise.resolve(this.result);
  }
}

describe('ToolCallRecordRetentionService', () => {
  it('deletes one batch and reports how many rows went', async () => {
    const records = new FakeRecords();
    records.result = 7;
    const service = new ToolCallRecordRetentionService(records as never, DEFAULT_TEST_CONFIG);

    const deleted = await service.sweep(new Date('2026-09-20T00:00:00.000Z'));

    expect(deleted).toBe(7);
    expect(records.calls).toEqual([
      {
        now: new Date('2026-09-20T00:00:00.000Z'),
        limit: DEFAULT_TEST_CONFIG.retentionSweepBatchSize,
      },
    ]);
  });

  it('never throws — a failed sweep returns 0 and waits for the next hour', async () => {
    const records = new FakeRecords();
    records.result = new Error('postgres is unreachable');
    const service = new ToolCallRecordRetentionService(records as never, DEFAULT_TEST_CONFIG);

    await expect(service.sweep()).resolves.toBe(0);
  });
});
