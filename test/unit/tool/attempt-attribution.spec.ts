import { Logger } from '@nestjs/common';

import {
  BindingAttemptInput,
  BindingAttemptRepository,
} from '@database/postgres/repositories/binding-attempt.repository';
import {
  ClassificationReason,
  ResponseClass,
} from '@modules/tool/domain/classification/classification.types';
import {
  AttemptAttributionInput,
  AttemptNotCountedReason,
  attributeAttempt,
} from '@modules/tool/domain/routing/attempt-attribution';
import {
  BindingAttemptRecorder,
  ObservedAttempt,
} from '@modules/tool/services/binding-attempt-recorder.service';

import { buildBinding } from './helpers/routing-fixtures';

/**
 * Which attempts count toward a binding's observed stats (backlog G1.1).
 *
 * The stats move traffic, so the rule is "only what the provider caused, on
 * traffic somebody paid for". The cases below are the ones a well-meaning
 * simplification would get wrong — in the direction that costs an honest
 * provider traffic, or in the one that lets a hanging provider keep it.
 */
describe('attributeAttempt', () => {
  function attempt(overrides: Partial<AttemptAttributionInput> = {}): AttemptAttributionInput {
    return {
      responseClass: ResponseClass.DATA_RESULT,
      reason: ClassificationReason.OK,
      providerId: 'org-provider',
      buyerOrganizationId: 'org-buyer',
      callClass: 'PAID',
      elapsedMs: 240.4,
      timeoutMs: 5_000,
      maxBudgetMs: 5_000,
      ...overrides,
    };
  }

  const timeout = (overrides: Partial<AttemptAttributionInput>) =>
    attributeAttempt(
      attempt({
        responseClass: ResponseClass.SYSTEM_ERROR,
        reason: ClassificationReason.TRANSPORT_TIMEOUT,
        ...overrides,
      }),
    );

  it('counts a data result as available, with its latency', () => {
    expect(attributeAttempt(attempt())).toEqual({ counted: true, available: true, latencyMs: 240 });
  });

  it('counts a data result whose data was bad as AVAILABLE — quality is a separate number', () => {
    expect(
      attributeAttempt(attempt({ reason: ClassificationReason.MAPPING_FAULT_PROVIDER })),
    ).toEqual(expect.objectContaining({ counted: true, available: true }));
  });

  it('never counts a client error against the provider', () => {
    for (const reason of [
      ClassificationReason.REQUEST_REJECTED,
      ClassificationReason.MAPPING_FAULT_AGENT,
    ]) {
      expect(
        attributeAttempt(attempt({ responseClass: ResponseClass.REQUEST_ERROR, reason })),
      ).toEqual({ counted: false, why: AttemptNotCountedReason.REQUEST_ERROR });
    }
  });

  it('counts a timeout at the full budget as unavailable, AND as a latency sample', () => {
    expect(timeout({ elapsedMs: 5_003 })).toEqual({
      counted: true,
      available: false,
      latencyMs: 5_003,
    });
  });

  it('counts a timeout on a binding that declares more than the whole request may take', () => {
    // A 120 s binding behind a 30 s request deadline: the first attempt gets
    // 30 s minus the few ms spent selecting it, and that IS the full budget.
    expect(timeout({ timeoutMs: 29_996, maxBudgetMs: 30_000 }).counted).toBe(true);
  });

  it('does not count a timeout on a budget earlier attempts had already spent', () => {
    expect(timeout({ timeoutMs: 1_200, maxBudgetMs: 5_000 })).toEqual({
      counted: false,
      why: AttemptNotCountedReason.BUDGET_CUT_SHORT,
    });
  });

  it('counts other recognised provider-side system errors as unavailable, without a latency', () => {
    for (const reason of [
      ClassificationReason.UPSTREAM_SERVER_ERROR,
      ClassificationReason.UPSTREAM_RATE_LIMITED,
      ClassificationReason.TRANSPORT_CONNECTION_REFUSED,
      ClassificationReason.BODY_NOT_JSON,
    ]) {
      expect(
        attributeAttempt(attempt({ responseClass: ResponseClass.SYSTEM_ERROR, reason })),
      ).toEqual({ counted: true, available: false, latencyMs: null });
    }
  });

  it('does not count our own mapping fault, or a throw nobody recognised', () => {
    expect(
      attributeAttempt(
        attempt({
          responseClass: ResponseClass.SYSTEM_ERROR,
          reason: ClassificationReason.MAPPING_FAULT_PLATFORM,
        }),
      ),
    ).toEqual({ counted: false, why: AttemptNotCountedReason.PLATFORM_FAULT });
    expect(
      attributeAttempt(
        attempt({
          responseClass: ResponseClass.SYSTEM_ERROR,
          reason: ClassificationReason.TRANSPORT_UNKNOWN,
        }),
      ),
    ).toEqual({ counted: false, why: AttemptNotCountedReason.UNRECOGNISED_FAILURE });
  });

  it('does not count a call Assay could not prepare (vault unavailable)', () => {
    expect(
      attributeAttempt(
        attempt({
          responseClass: ResponseClass.SYSTEM_ERROR,
          reason: ClassificationReason.PLATFORM_UNAVAILABLE,
        }),
      ),
    ).toEqual({ counted: false, why: AttemptNotCountedReason.PLATFORM_FAULT });
  });

  it('excludes a self-call, whatever its outcome', () => {
    for (const responseClass of [ResponseClass.DATA_RESULT, ResponseClass.SYSTEM_ERROR]) {
      expect(
        attributeAttempt(attempt({ responseClass, buyerOrganizationId: 'org-provider' })),
      ).toEqual({ counted: false, why: AttemptNotCountedReason.SELF_CALL });
    }
  });

  it('counts only paid traffic — a free call costs the caller nothing to repeat', () => {
    for (const callClass of ['FREE', undefined] as const) {
      expect(attributeAttempt(attempt({ callClass }))).toEqual({
        counted: false,
        why: AttemptNotCountedReason.NOT_PAID,
      });
    }
  });

  it('does not count an attempt whose buyer was not named — the per-buyer cap needs one', () => {
    expect(attributeAttempt(attempt({ buyerOrganizationId: undefined }))).toEqual({
      counted: false,
      why: AttemptNotCountedReason.NO_BUYER,
    });
  });
});

describe('BindingAttemptRecorder', () => {
  const binding = buildBinding('org-provider', { timeoutMs: 5_000 });

  function observed(overrides: Partial<ObservedAttempt> = {}): ObservedAttempt {
    return {
      binding,
      classification: {
        responseClass: ResponseClass.SYSTEM_ERROR,
        reason: ClassificationReason.UPSTREAM_SERVER_ERROR,
        retryAfterMs: null,
      },
      elapsedMs: 80,
      timeoutMs: 5_000,
      maxBudgetMs: 5_000,
      callClass: 'PAID',
      buyerOrganizationId: 'org-buyer',
      ...overrides,
    };
  }

  function build(
    options = { capacity: 100, batchSize: 10, flushIntervalMs: 60_000 },
    appendMany = jest.fn(async (_rows: readonly BindingAttemptInput[]) => undefined),
  ) {
    return {
      appendMany,
      recorder: new BindingAttemptRecorder(
        { appendMany } as unknown as BindingAttemptRepository,
        options,
      ),
    };
  }

  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('buffers a counted attempt and writes it on flush, with its buyer', async () => {
    const { appendMany, recorder } = build();
    recorder.record(observed());
    expect(appendMany).not.toHaveBeenCalled();

    await recorder.flush();

    expect(appendMany).toHaveBeenCalledWith([
      {
        bindingId: binding.id,
        providerId: 'org-provider',
        buyerOrganizationId: 'org-buyer',
        callClass: 'PAID',
        available: false,
        latencyMs: null,
        reason: ClassificationReason.UPSTREAM_SERVER_ERROR,
      },
    ]);
  });

  it('writes nothing for an attempt that does not count', async () => {
    const { appendMany, recorder } = build();
    recorder.record(observed({ buyerOrganizationId: 'org-provider' }));
    recorder.record(observed({ callClass: 'FREE' }));
    await recorder.flush();
    expect(appendMany).not.toHaveBeenCalled();
  });

  it('writes in batches — one INSERT per batch, not one per attempt', async () => {
    const { appendMany, recorder } = build({
      capacity: 100,
      batchSize: 10,
      flushIntervalMs: 60_000,
    });
    for (let i = 0; i < 25; i += 1) recorder.record(observed());
    await recorder.flush();
    expect(appendMany.mock.calls.map(([rows]) => rows.length)).toEqual([10, 10, 5]);
  });

  it('drops and counts rows once the buffer is full, without blocking the caller', async () => {
    let release!: () => void;
    const appendMany = jest.fn(
      (_rows: readonly BindingAttemptInput[]) =>
        new Promise<undefined>((resolve) => (release = () => resolve(undefined))),
    );
    const { recorder } = build({ capacity: 3, batchSize: 3, flushIntervalMs: 60_000 }, appendMany);

    // The third row fills a batch and starts a flush that the database holds.
    for (let i = 0; i < 3; i += 1) recorder.record(observed());
    // Three more fill the buffer again; the next two have nowhere to go.
    for (let i = 0; i < 5; i += 1) recorder.record(observed());

    expect(recorder.dropped).toBe(2);
    // The held batch lands, and the waiting flush writes the second one.
    release();
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await recorder.flush();
    expect(appendMany).toHaveBeenCalledTimes(2);
  });

  it('drops and counts a batch the database refuses, and never throws', async () => {
    const { recorder } = build(
      undefined,
      jest.fn(async (_rows: readonly BindingAttemptInput[]): Promise<undefined> => {
        throw new Error('connection terminated');
      }),
    );
    recorder.record(observed());
    recorder.record(observed());
    await expect(recorder.flush()).resolves.toBeUndefined();
    expect(recorder.dropped).toBe(2);
  });

  it('flushes on its interval, and what is left on module shutdown', async () => {
    jest.useFakeTimers();
    try {
      const { appendMany, recorder } = build({
        capacity: 100,
        batchSize: 50,
        flushIntervalMs: 1_000,
      });
      recorder.record(observed());
      await jest.advanceTimersByTimeAsync(1_000);
      expect(appendMany).toHaveBeenCalledTimes(1);

      recorder.record(observed());
      await recorder.onModuleDestroy();
      expect(appendMany).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
