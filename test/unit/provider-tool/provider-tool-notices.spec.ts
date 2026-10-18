import { NOTIFICATION_CATALOGUE } from '@modules/notification/constants/notification-catalogue';
import {
  NotificationAggregation,
  NotificationEvent,
  NotificationSeverity,
} from '@modules/notification/ports/notification.port';
import { providerToolNotification } from '@modules/provider-tool/domain/notices';
import {
  DEFAULT_DECLARED_FAILURE_RATE,
  declaredFailureRateOf,
} from '@modules/provider-tool/services/provider-tools.service';
import { handleNotification } from '@modules/toolset/domain/handle-notices';
import {
  REVIEW_REJECT_REASON_CODES,
  ReviewReasonCode,
  reviewReasonCodeFor,
} from '@modules/provider-tool/domain/review';
import { ReviewChecklistItem } from '@modules/provider-tool/services/provider-tool-review.service';

const ORG = '00000000-0000-4000-8000-0000000000aa';
const TOOL = '00000000-0000-4000-8000-0000000000bb';

describe('provider tool notices (T4)', () => {
  it('every event has a catalogue row, and the T4 rows are what the frontend shows', () => {
    for (const event of Object.values(NotificationEvent)) {
      expect(NOTIFICATION_CATALOGUE[event]).toBeDefined();
    }
    expect(NOTIFICATION_CATALOGUE[NotificationEvent.PROVIDER_TOOL_TAKEN_DOWN]).toMatchObject({
      severity: NotificationSeverity.CRITICAL,
      nonSuppressible: true,
    });
    expect(NOTIFICATION_CATALOGUE[NotificationEvent.PROVIDER_TOOL_PROMOTION_INVITED]).toMatchObject(
      { aggregation: NotificationAggregation.ONCE },
    );
    for (const event of [
      'call.refused_repeatedly',
      'provider.slash_decided',
      'provider.slash_executed',
      'provider.slash_reversed',
      'provider_tool.approved',
      'provider_tool.rejected',
      'provider_tool.taken_down',
      'provider_tool.takedown_lifted',
      'provider_tool.promotion_invited',
      'handle.taken_down',
      'handle.takedown_lifted',
    ]) {
      expect(Object.values(NotificationEvent)).toContain(event);
    }
  });

  it('goes to the tool’s own organization, names its tool only', () => {
    const facts = { organizationId: ORG, toolId: TOOL, toolName: 'acme__search_posts' };
    const approved = providerToolNotification({
      ...facts,
      kind: 'APPROVED',
      reviewKind: 'CHANGE',
      semver: '1.1.0',
    });
    expect(approved).toMatchObject({
      organizationId: ORG,
      event: 'provider_tool.approved',
      subjectType: 'provider_tool',
      subjectId: TOOL,
      payload: {
        toolId: TOOL,
        toolName: 'acme__search_posts',
        reviewKind: 'CHANGE',
        semver: '1.1.0',
      },
    });
    const rejected = providerToolNotification({
      ...facts,
      kind: 'REJECTED',
      reviewKind: 'FIRST',
      reasonCode: 'MODEL_INSTRUCTIONS',
      note: 'The summary tells the model what to do.',
    });
    expect(rejected.body).toContain('The summary tells the model what to do.');
    expect(rejected.payload).toMatchObject({ reasonCode: 'MODEL_INSTRUCTIONS' });
    expect(
      providerToolNotification({ ...facts, kind: 'TAKEDOWN_LIFTED', serving: false }).body,
    ).toMatch(/stays removed/);
    const invited = providerToolNotification({
      ...facts,
      kind: 'PROMOTION_INVITED',
      standardToolId: 'std-1',
      standardToolName: 'search_posts',
    });
    expect(invited).toMatchObject({
      event: 'provider_tool.promotion_invited',
      dedupeKey: `std-1:${TOOL}`,
    });
    // Nothing in any payload names another organization or an operator.
    for (const notice of [approved, rejected, invited]) {
      expect(Object.keys(notice.payload ?? {})).not.toEqual(
        expect.arrayContaining(['organizationId', 'operatorId', 'reviewedBy']),
      );
    }
  });
});

describe('review reason codes', () => {
  it('one reject code per §7.6 checklist item', () => {
    expect(REVIEW_REJECT_REASON_CODES).toHaveLength(Object.values(ReviewChecklistItem).length);
  });

  it('approve is APPROVED (the default); reject needs a checklist code', () => {
    expect(reviewReasonCodeFor('APPROVE', undefined)).toEqual({ code: 'APPROVED' });
    expect(reviewReasonCodeFor('APPROVE', ReviewReasonCode.APPROVED)).toEqual({
      code: 'APPROVED',
    });
    expect(reviewReasonCodeFor('APPROVE', ReviewReasonCode.IMPERSONATION)).toHaveProperty(
      'problem',
    );
    expect(reviewReasonCodeFor('REJECT', undefined)).toHaveProperty('problem');
    expect(reviewReasonCodeFor('REJECT', ReviewReasonCode.APPROVED)).toHaveProperty('problem');
    expect(reviewReasonCodeFor('REJECT', ReviewReasonCode.SECRET_INPUTS)).toEqual({
      code: 'SECRET_INPUTS',
    });
  });
});

describe('ReviewDecisionBodyDto.reasonCode', () => {
  const HASH = 'a'.repeat(64);
  const errorsOf = async (body: Record<string, unknown>) => {
    const { plainToInstance } = await import('class-transformer');
    const { validate } = await import('class-validator');
    const { ReviewDecisionBodyDto } = await import('@modules/provider-tool/dto/tool-promotion.dto');
    return (await validate(plainToInstance(ReviewDecisionBodyDto, body))).map((e) => e.property);
  };

  it('accepts the enum or nothing, and refuses free text', async () => {
    expect(await errorsOf({ decision: 'APPROVE', contentHash: HASH })).toEqual([]);
    expect(
      await errorsOf({
        decision: 'REJECT',
        contentHash: HASH,
        reasonCode: 'PRICING_UNCLEAR',
        note: 'x',
      }),
    ).toEqual([]);
    expect(
      await errorsOf({ decision: 'REJECT', contentHash: HASH, reasonCode: 'looks bad', note: 'x' }),
    ).toEqual(['reasonCode']);
  });
});

describe('handle notices', () => {
  it('one per handle, to its owner, without the operator’s note', () => {
    const down = handleNotification({ kind: 'TAKEN_DOWN', organizationId: ORG, handle: 'acme' });
    expect(down).toMatchObject({
      organizationId: ORG,
      event: 'handle.taken_down',
      subjectType: 'handle',
      subjectId: 'acme',
      payload: { handle: 'acme' },
    });
    expect(NOTIFICATION_CATALOGUE[NotificationEvent.HANDLE_TAKEN_DOWN]).toMatchObject({
      severity: NotificationSeverity.CRITICAL,
      nonSuppressible: true,
    });
    expect(
      handleNotification({ kind: 'TAKEDOWN_LIFTED', organizationId: ORG, handle: 'acme' }).event,
    ).toBe('handle.takedown_lifted');
  });
});

describe('prefill failure rate', () => {
  it('the binding’s own rate, or 2% when it reads as nothing; never NaN', () => {
    expect(declaredFailureRateOf('0.05000')).toBe(0.05);
    expect(declaredFailureRateOf(0)).toBe(0);
    for (const value of [null, undefined, '', 'abc', '2', -1]) {
      expect(declaredFailureRateOf(value as never)).toBe(DEFAULT_DECLARED_FAILURE_RATE);
    }
    expect(DEFAULT_DECLARED_FAILURE_RATE).toBe(0.02);
  });
});

describe('TakedownToolBodyDto', () => {
  const errorsOf = async (body: Record<string, unknown>) => {
    const { plainToInstance } = await import('class-transformer');
    const { validate } = await import('class-validator');
    const { TakedownToolBodyDto } = await import('@modules/operator/dto/operator-moderation.dto');
    return (await validate(plainToInstance(TakedownToolBodyDto, body))).map((e) => e.property);
  };
  const base = { reasonCode: 'ABUSE', note: 'impersonates another organization' };

  it('needs a provider-facing reason from the closed list; the public note is optional', async () => {
    expect(await errorsOf({ ...base, publicReasonCode: 'IMPERSONATION' })).toEqual([]);
    expect(
      await errorsOf({ ...base, publicReasonCode: 'LEGAL_REQUEST', publicNote: 'See the email.' }),
    ).toEqual([]);
    expect(await errorsOf(base)).toEqual(['publicReasonCode']);
    expect(await errorsOf({ ...base, publicReasonCode: 'they were rude' })).toEqual([
      'publicReasonCode',
    ]);
    expect(
      await errorsOf({ ...base, publicReasonCode: 'IMPERSONATION', publicNote: 'x'.repeat(501) }),
    ).toEqual(['publicNote']);
  });
});
