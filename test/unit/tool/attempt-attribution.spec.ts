import { Logger } from '@nestjs/common';

import { BindingAttemptRepository } from '@database/postgres/repositories/binding-attempt.repository';
import {
  ClassificationReason,
  ResponseClass,
} from '@modules/tool/domain/classification/classification.types';
import {
  AttemptAttributionInput,
  AttemptNotCountedReason,
  attributeAttempt,
} from '@modules/tool/domain/routing/attempt-attribution';
import { BindingAttemptRecorder } from '@modules/tool/services/binding-attempt-recorder.service';

import { buildBinding } from './helpers/routing-fixtures';

/**
 * Which attempts count toward a binding's observed stats (backlog G1.1).
 *
 * The stats move traffic, so the rule is "only what the provider caused". The
 * cases below are the ones a well-meaning simplification would get wrong in
 * the direction that costs an honest provider traffic.
 */
describe('attributeAttempt', () => {
  function attempt(overrides: Partial<AttemptAttributionInput> = {}): AttemptAttributionInput {
    return {
      responseClass: ResponseClass.DATA_RESULT,
      reason: ClassificationReason.OK,
      providerId: 'org-provider',
      buyerOrganizationId: 'org-buyer',
      elapsedMs: 240.4,
      timeoutMs: 5_000,
      bindingTimeoutMs: 5_000,
      ...overrides,
    };
  }

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

  it('counts a timeout at the binding’s own budget as unavailable, AND as a latency sample', () => {
    expect(
      attributeAttempt(
        attempt({
          responseClass: ResponseClass.SYSTEM_ERROR,
          reason: ClassificationReason.TRANSPORT_TIMEOUT,
          elapsedMs: 5_003,
        }),
      ),
    ).toEqual({ counted: true, available: false, latencyMs: 5_003 });
  });

  it('does not count a timeout on a budget the request had already cut short', () => {
    expect(
      attributeAttempt(
        attempt({
          responseClass: ResponseClass.SYSTEM_ERROR,
          reason: ClassificationReason.TRANSPORT_TIMEOUT,
          timeoutMs: 1_200,
          bindingTimeoutMs: 5_000,
        }),
      ),
    ).toEqual({ counted: false, why: AttemptNotCountedReason.BUDGET_CUT_SHORT });
  });

  it('counts other provider-side system errors as unavailable, without a latency', () => {
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

  it('does not count our own mapping fault against the provider', () => {
    expect(
      attributeAttempt(
        attempt({
          responseClass: ResponseClass.SYSTEM_ERROR,
          reason: ClassificationReason.MAPPING_FAULT_PLATFORM,
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

  it('counts an attempt whose buyer was not named as an ordinary one', () => {
    expect(attributeAttempt(attempt({ buyerOrganizationId: undefined })).counted).toBe(true);
  });
});

describe('BindingAttemptRecorder', () => {
  const binding = buildBinding('org-provider', { timeoutMs: 5_000 });

  function recorder(append = jest.fn(async () => undefined)) {
    return {
      append,
      recorder: new BindingAttemptRecorder({ append } as unknown as BindingAttemptRepository),
    };
  }

  it('writes a counted attempt with its availability, latency, reason and call class', async () => {
    const { append, recorder: subject } = recorder();
    await subject.record({
      binding,
      classification: {
        responseClass: ResponseClass.SYSTEM_ERROR,
        reason: ClassificationReason.UPSTREAM_SERVER_ERROR,
        retryAfterMs: null,
      },
      elapsedMs: 80,
      timeoutMs: 5_000,
      callClass: 'PAID',
      buyerOrganizationId: 'org-buyer',
    });
    expect(append).toHaveBeenCalledWith({
      bindingId: binding.id,
      providerId: 'org-provider',
      callClass: 'PAID',
      available: false,
      latencyMs: null,
      reason: ClassificationReason.UPSTREAM_SERVER_ERROR,
    });
  });

  it('writes nothing for an attempt that does not count', async () => {
    const { append, recorder: subject } = recorder();
    await subject.record({
      binding,
      classification: {
        responseClass: ResponseClass.DATA_RESULT,
        reason: ClassificationReason.OK,
        retryAfterMs: null,
      },
      elapsedMs: 80,
      timeoutMs: 5_000,
      buyerOrganizationId: 'org-provider',
    });
    expect(append).not.toHaveBeenCalled();
  });

  it('never throws — a lost observation must not fail the call', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { recorder: subject } = recorder(
      jest.fn(async () => {
        throw new Error('connection terminated');
      }),
    );
    await expect(
      subject.record({
        binding,
        classification: {
          responseClass: ResponseClass.DATA_RESULT,
          reason: ClassificationReason.OK,
          retryAfterMs: null,
        },
        elapsedMs: 80,
        timeoutMs: 5_000,
      }),
    ).resolves.toBeUndefined();
    jest.restoreAllMocks();
  });
});
