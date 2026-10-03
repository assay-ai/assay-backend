import { EvidenceBodyRepository } from '@database/postgres/repositories/evidence-body.repository';
import { VerificationRecordRepository } from '@database/postgres/repositories/verification-record.repository';
import {
  DEFAULT_EVIDENCE_RETENTION,
  evidenceRetentionConfigFactory,
} from '@modules/verification/config/evidence-retention.config';
import { EvidenceRetentionService } from '@modules/verification/services/evidence-retention.service';

import type { ConfigService } from '@nestjs/config';

const NOW = new Date('2026-08-21T12:00:00.000Z');

function build(config = DEFAULT_EVIDENCE_RETENTION) {
  const deleteExpired = jest.fn().mockResolvedValue(3);
  const scrubBodiesOlderThan = jest.fn().mockResolvedValue(2);

  const service = new EvidenceRetentionService(
    { deleteExpired } as unknown as EvidenceBodyRepository,
    { scrubBodiesOlderThan } as unknown as VerificationRecordRepository,
    config,
  );

  return { service, deleteExpired, scrubBodiesOlderThan };
}

describe('the evidence retention sweep', () => {
  it('cuts in both places, because the body exists in two', async () => {
    // evidence_bodies holds the sealed copy; verification_records holds the
    // originals from enqueue. Sweeping only the copy leaves the platform
    // holding every request body it ever received.
    const { service, deleteExpired, scrubBodiesOlderThan } = build();

    const result = await service.sweep(NOW);

    expect(deleteExpired).toHaveBeenCalledWith(NOW, DEFAULT_EVIDENCE_RETENTION.sweepBatchSize);
    expect(scrubBodiesOlderThan).toHaveBeenCalledWith(
      new Date('2026-08-18T12:00:00.000Z'),
      DEFAULT_EVIDENCE_RETENTION.sweepBatchSize,
    );
    expect(result).toEqual({ bodiesDeleted: 3, recordsScrubbed: 2 });
  });

  it('scrubs records at now minus the configured window, not at the body deadline', async () => {
    // The body row carries its own `expires_at`, stamped at seal time; the
    // records have no such column, so the cutoff is computed here. The two are
    // the same figure and arrive by different routes.
    const { service, scrubBodiesOlderThan } = build({ bodyRetentionHours: 1, sweepBatchSize: 10 });

    await service.sweep(NOW);

    expect(scrubBodiesOlderThan).toHaveBeenCalledWith(new Date('2026-08-21T11:00:00.000Z'), 10);
  });

  it('still scrubs records when deleting bodies fails', async () => {
    // Two promises to two readers. One failing must not silently cancel the
    // other, and neither may take the scheduler down.
    const { service, scrubBodiesOlderThan } = build();
    const failing = new EvidenceRetentionService(
      { deleteExpired: jest.fn().mockRejectedValue(new Error('lock timeout')) } as never,
      { scrubBodiesOlderThan } as unknown as VerificationRecordRepository,
      DEFAULT_EVIDENCE_RETENTION,
    );

    const result = await failing.sweep(NOW);

    expect(result).toEqual({ bodiesDeleted: 0, recordsScrubbed: 2 });
    expect(scrubBodiesOlderThan).toHaveBeenCalled();
    void service;
  });

  it('reports zero rather than throwing when both halves fail', async () => {
    const service = new EvidenceRetentionService(
      { deleteExpired: jest.fn().mockRejectedValue(new Error('down')) } as never,
      { scrubBodiesOlderThan: jest.fn().mockRejectedValue(new Error('down')) } as never,
      DEFAULT_EVIDENCE_RETENTION,
    );

    await expect(service.sweep(NOW)).resolves.toEqual({ bodiesDeleted: 0, recordsScrubbed: 0 });
  });
});

describe('the retention window is a published figure, not a free parameter', () => {
  const read = (values: Record<string, string | undefined>) =>
    evidenceRetentionConfigFactory({
      get: (key: string) => values[key],
    } as unknown as ConfigService);

  it('defaults to the 72 hours the security model publishes', () => {
    expect(read({})).toEqual(DEFAULT_EVIDENCE_RETENTION);
  });

  it('refuses zero, which would delete a body in the hour it was sealed', () => {
    // The dangerous input: `0` reads like "keep nothing" and would destroy
    // evidence inside the window a dispute is filed in. A deployment that means
    // a short window can say 1.
    expect(read({ EVIDENCE_BODY_RETENTION_HOURS: '0' }).bodyRetentionHours).toBe(72);
    expect(read({ EVIDENCE_BODY_RETENTION_HOURS: '-5' }).bodyRetentionHours).toBe(72);
    expect(read({ EVIDENCE_BODY_RETENTION_HOURS: '' }).bodyRetentionHours).toBe(72);
    expect(read({ EVIDENCE_BODY_RETENTION_HOURS: 'soon' }).bodyRetentionHours).toBe(72);
  });

  it('takes a deliberate override', () => {
    expect(read({ EVIDENCE_BODY_RETENTION_HOURS: ' 24 ' }).bodyRetentionHours).toBe(24);
    expect(read({ EVIDENCE_SWEEP_BATCH_SIZE: '50' }).sweepBatchSize).toBe(50);
  });
});
