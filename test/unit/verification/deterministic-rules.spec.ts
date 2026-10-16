/**
 * The deterministic-rules stage.
 *
 * Two layers are under test, deliberately kept apart:
 *
 * - `evaluateRule` — one rule against one input, in isolation. This is where
 *   the six rule types' pass/fail/misapplied semantics live, and where a
 *   change to one type's logic shows up as a change to exactly one test.
 * - `runDeterministicStage` — the aggregate: the empty-result branch,
 *   misapplication outranking failure, and the weighted score. This is where
 *   `decidedVerdict` and `VERDICT_CONSEQUENCE` matter, because that pairing is
 *   the whole reason `MISAPPLIED` and `EMPTY_CONFIRMED`/`EMPTY_UNVERIFIED`
 *   exist (`verdict.ts`) — a status a reviewer cannot trace to "does this
 *   strike the provider" is not actually tested.
 */
import { conditionHolds } from '@modules/verification/domain/rules/condition';
import { evaluateRule } from '@modules/verification/domain/rules/evaluate-rules';
import {
  ConditionOperator,
  ConditionSource,
  FreshnessRule,
  MinArrayLengthRule,
  NoDuplicatesRule,
  RequiredFieldsRule,
  RuleOutcome,
  ValidUrlRule,
  ValueRangeRule,
  VerificationRule,
  VerificationRuleType,
} from '@modules/verification/domain/rules/rule.types';
import {
  EmptyResultDisposition,
  PolicyMode,
  VerificationPolicy,
} from '@modules/verification/domain/policy.types';
import { runDeterministicStage } from '@modules/verification/domain/stages/deterministic-stage';
import { StageInput, StageStatus, VerificationStage } from '@modules/verification/domain/stage';
import { VERDICT_CONSEQUENCE, VerdictStatus } from '@modules/verification/domain/verdict';
import { JsonValue } from '@modules/tool/domain/mapping/mapping.types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Fixed instant, deliberately far from wall-clock "now" — proves no `Date.now()` read. */
const EVALUATED_AT = new Date('2020-06-15T12:00:00.000Z');

function input(response: JsonValue, overrides: Partial<StageInput> = {}): StageInput {
  return { response, evaluatedAt: EVALUATED_AT, ...overrides };
}

function policy(
  rules: readonly VerificationRule[],
  overrides: Partial<VerificationPolicy> = {},
): VerificationPolicy {
  return {
    id: 'policy-1',
    toolId: 'search_web',
    version: 1,
    rules,
    passThreshold: 0.7,
    mode: PolicyMode.ACTIVE,
    ...overrides,
  };
}

function minArrayLength(overrides: Partial<MinArrayLengthRule> = {}): MinArrayLengthRule {
  return {
    id: 'min-results',
    type: VerificationRuleType.MIN_ARRAY_LENGTH,
    path: '$.results',
    weight: 1,
    min: 1,
    ...overrides,
  };
}

function requiredFields(overrides: Partial<RequiredFieldsRule> = {}): RequiredFieldsRule {
  return {
    id: 'required-fields',
    type: VerificationRuleType.REQUIRED_FIELDS,
    path: '$.results[*]',
    weight: 1,
    fields: ['title', 'url'],
    ...overrides,
  };
}

function freshness(overrides: Partial<FreshnessRule> = {}): FreshnessRule {
  return {
    id: 'freshness',
    type: VerificationRuleType.FRESHNESS,
    path: '$.publishedAt',
    weight: 1,
    maxAgeMs: 60 * 60 * 1000, // 1h
    ...overrides,
  };
}

function valueRange(overrides: Partial<ValueRangeRule> = {}): ValueRangeRule {
  return {
    id: 'value-range',
    type: VerificationRuleType.VALUE_RANGE,
    path: '$.score',
    weight: 1,
    min: 0,
    max: 100,
    ...overrides,
  };
}

function validUrl(overrides: Partial<ValidUrlRule> = {}): ValidUrlRule {
  return {
    id: 'valid-url',
    type: VerificationRuleType.VALID_URL,
    path: '$.results[*].url',
    weight: 1,
    ...overrides,
  };
}

function noDuplicates(overrides: Partial<NoDuplicatesRule> = {}): NoDuplicatesRule {
  return {
    id: 'no-duplicates',
    type: VerificationRuleType.NO_DUPLICATES,
    path: '$.results[*].id',
    weight: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// One rule type, one passing case, one failing case — an explicit acceptance
// criterion, so each row below is its own `it` rather than a shared table.
// ---------------------------------------------------------------------------

describe('MIN_ARRAY_LENGTH', () => {
  it('passes when the collection meets the minimum', () => {
    const rule = minArrayLength({ min: 1 });
    const result = evaluateRule(rule, input({ results: [{ title: 'a' }] }));
    expect(result.outcome).toBe(RuleOutcome.PASSED);
  });

  it('fails when the collection is non-empty but short of the minimum', () => {
    const rule = minArrayLength({ min: 3 });
    const result = evaluateRule(rule, input({ results: [{ title: 'a' }] }));
    expect(result.outcome).toBe(RuleOutcome.FAILED);
    expect(result.code).toBe('insufficient_results');
    expect(result.detail).toBe('1 results returned, the minimum is 3');
  });
});

describe('REQUIRED_FIELDS', () => {
  it('passes when every element carries every field, non-null', () => {
    const rule = requiredFields({ fields: ['title', 'url'] });
    const result = evaluateRule(
      rule,
      input({ results: [{ title: 'a', url: 'https://example.com' }] }),
    );
    expect(result.outcome).toBe(RuleOutcome.PASSED);
  });

  it('fails when a required field is missing', () => {
    const rule = requiredFields({ fields: ['title', 'url'] });
    const result = evaluateRule(rule, input({ results: [{ title: 'a' }] }));
    expect(result.outcome).toBe(RuleOutcome.FAILED);
    expect(result.code).toBe('missing_field');
    expect(result.pointer).toBe('/results/0/url');
  });

  it('fails on an explicit null unless allowNull is set', () => {
    const rule = requiredFields({ fields: ['url'] });
    const result = evaluateRule(rule, input({ results: [{ url: null }] }));
    expect(result.outcome).toBe(RuleOutcome.FAILED);
    expect(result.code).toBe('null_field');
  });

  it('treats null as present when allowNull is set', () => {
    const rule = requiredFields({ fields: ['url'], allowNull: true });
    const result = evaluateRule(rule, input({ results: [{ url: null }] }));
    expect(result.outcome).toBe(RuleOutcome.PASSED);
  });
});

describe('FRESHNESS', () => {
  it('passes when the timestamp is within maxAgeMs of evaluatedAt', () => {
    const rule = freshness({ maxAgeMs: 60 * 60 * 1000 });
    const thirtyMinutesBefore = new Date(EVALUATED_AT.getTime() - 30 * 60 * 1000).toISOString();
    const result = evaluateRule(rule, input({ publishedAt: thirtyMinutesBefore }));
    expect(result.outcome).toBe(RuleOutcome.PASSED);
  });

  it('fails when the timestamp is older than maxAgeMs', () => {
    const rule = freshness({ maxAgeMs: 60 * 60 * 1000 });
    const twoHoursBefore = new Date(EVALUATED_AT.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const result = evaluateRule(rule, input({ publishedAt: twoHoursBefore }));
    expect(result.outcome).toBe(RuleOutcome.FAILED);
    expect(result.code).toBe('stale_timestamp');
  });

  it('is computed from the injected evaluatedAt, not the wall clock', () => {
    // EVALUATED_AT is 2020-06-15; real "now" is years later. A rule reading
    // `Date.now()` would report this timestamp as wildly stale; reading
    // `input.evaluatedAt` reports it as 1 hour old and passes a 2 hour budget.
    const rule = freshness({ maxAgeMs: 2 * 60 * 60 * 1000 });
    const oneHourBefore = new Date(EVALUATED_AT.getTime() - 60 * 60 * 1000).toISOString();
    const result = evaluateRule(rule, input({ publishedAt: oneHourBefore }));
    expect(result.outcome).toBe(RuleOutcome.PASSED);
  });

  it('accepts a timestamp in the future within futureToleranceMs', () => {
    const rule = freshness({ maxAgeMs: 60 * 60 * 1000, futureToleranceMs: 5000 });
    const twoSecondsAhead = new Date(EVALUATED_AT.getTime() + 2000).toISOString();
    const result = evaluateRule(rule, input({ publishedAt: twoSecondsAhead }));
    expect(result.outcome).toBe(RuleOutcome.PASSED);
  });

  it('fails a timestamp further in the future than futureToleranceMs', () => {
    const rule = freshness({ maxAgeMs: 60 * 60 * 1000, futureToleranceMs: 1000 });
    const tenSecondsAhead = new Date(EVALUATED_AT.getTime() + 10_000).toISOString();
    const result = evaluateRule(rule, input({ publishedAt: tenSecondsAhead }));
    expect(result.outcome).toBe(RuleOutcome.FAILED);
    expect(result.code).toBe('future_timestamp');
  });

  it('accepts an epoch-milliseconds number as well as an ISO string', () => {
    const rule = freshness({ maxAgeMs: 60 * 60 * 1000 });
    const result = evaluateRule(rule, input({ publishedAt: EVALUATED_AT.getTime() - 1000 }));
    expect(result.outcome).toBe(RuleOutcome.PASSED);
  });

  describe('FRESHNESS timestamp parsing across host timezones', () => {
    const ORIGINAL_TZ = process.env.TZ;
    afterEach(() => {
      process.env.TZ = ORIGINAL_TZ;
    });

    /**
     * The defect this pins: ECMA-262 reads a date-*time* with no zone
     * designator as LOCAL, so an honest provider was judged stale by exactly
     * the server's own offset. A date-*only* form is already UTC per the same
     * specification and must NOT be touched — the catalogue's
     * `get_usd_eur_rate` binding maps `publishedFor` to Frankfurter's
     * `$.date`, which is that form.
     */
    const AT = new Date('2026-08-24T00:05:00.000Z');
    const rule = freshness({ path: '$.observedAt', maxAgeMs: 60 * 60 * 1000 });

    it.each([
      ['offset-less date-time, T separator', '2026-08-24T00:00'],
      ['offset-less date-time, space separator', '2026-08-24 00:00'],
      ['offset-less date-time with seconds', '2026-08-24T00:00:00'],
      ['offset-less date-time with millis', '2026-08-24T00:00:00.000'],
      ['date-only', '2026-08-24'],
      ['explicit Z', '2026-08-24T00:00:00Z'],
    ])('passes for %s on a host not in UTC', (_label, observedAt) => {
      process.env.TZ = 'Pacific/Kiritimati';
      const result = evaluateRule(rule, input({ observedAt }, { evaluatedAt: AT }));
      expect(result.outcome).toBe(RuleOutcome.PASSED);
    });

    it('still honours a real offset rather than assuming UTC', () => {
      process.env.TZ = 'UTC';
      // Midnight at +05:30 is 18:30 the previous day UTC — 5h35m before `AT`,
      // past the one-hour ceiling. Assuming UTC everywhere would pass this.
      const result = evaluateRule(
        rule,
        input({ observedAt: '2026-08-24T00:00:00+05:30' }, { evaluatedAt: AT }),
      );
      expect(result.outcome).toBe(RuleOutcome.FAILED);
    });

    it('still refuses a value that is not a timestamp', () => {
      process.env.TZ = 'Pacific/Kiritimati';
      const result = evaluateRule(rule, input({ observedAt: 'iso8601' }, { evaluatedAt: AT }));
      expect(result.outcome).toBe(RuleOutcome.MISAPPLIED);
    });
  });
});

describe('VALUE_RANGE', () => {
  it('passes when the value lies inside the inclusive band', () => {
    const rule = valueRange({ min: 0, max: 100 });
    const result = evaluateRule(rule, input({ score: 50 }));
    expect(result.outcome).toBe(RuleOutcome.PASSED);
  });

  it('fails when the value lies outside the band', () => {
    const rule = valueRange({ min: 0, max: 100 });
    const result = evaluateRule(rule, input({ score: 150 }));
    expect(result.outcome).toBe(RuleOutcome.FAILED);
    expect(result.code).toBe('out_of_range');
  });
});

describe('VALID_URL', () => {
  it('passes a well-formed URL with an allowed scheme', () => {
    const rule = validUrl();
    const result = evaluateRule(rule, input({ results: [{ url: 'https://example.com/a' }] }));
    expect(result.outcome).toBe(RuleOutcome.PASSED);
  });

  it('fails a string that does not parse as a URL', () => {
    const rule = validUrl();
    const result = evaluateRule(rule, input({ results: [{ url: 'not a url' }] }));
    expect(result.outcome).toBe(RuleOutcome.FAILED);
    expect(result.code).toBe('invalid_url');
  });

  it('fails a URL whose scheme is not on the allow-list', () => {
    const rule = validUrl({ schemes: ['https'] });
    const result = evaluateRule(rule, input({ results: [{ url: 'ftp://example.com/a' }] }));
    expect(result.outcome).toBe(RuleOutcome.FAILED);
    expect(result.code).toBe('disallowed_scheme');
  });
});

describe('NO_DUPLICATES', () => {
  it('passes when every resolved value is distinct', () => {
    const rule = noDuplicates();
    const result = evaluateRule(rule, input({ results: [{ id: 'a' }, { id: 'b' }] }));
    expect(result.outcome).toBe(RuleOutcome.PASSED);
  });

  it('fails when a value repeats', () => {
    const rule = noDuplicates();
    const result = evaluateRule(rule, input({ results: [{ id: 'a' }, { id: 'a' }] }));
    expect(result.outcome).toBe(RuleOutcome.FAILED);
    expect(result.code).toBe('duplicate_values');
  });

  it('compares case-insensitively when caseInsensitive is set', () => {
    const rule = noDuplicates({ caseInsensitive: true });
    const result = evaluateRule(rule, input({ results: [{ id: 'Abc' }, { id: 'abc' }] }));
    expect(result.outcome).toBe(RuleOutcome.FAILED);
  });

  it('is not applicable with fewer than two values', () => {
    const rule = noDuplicates();
    const result = evaluateRule(rule, input({ results: [{ id: 'a' }] }));
    expect(result.outcome).toBe(RuleOutcome.NOT_APPLICABLE);
  });
});

// ---------------------------------------------------------------------------
// The empty-result branch
// ---------------------------------------------------------------------------

describe('empty-result disposition', () => {
  const EMPTY_BODY = { results: [], totalResults: 0 };

  it('confirms the empty result when the policy names corroborating evidence and it holds', () => {
    const p = policy([minArrayLength({ min: 1 })], {
      emptyResult: {
        evidence: [{ path: '$.totalResults', operator: ConditionOperator.EQUALS, value: 0 }],
      },
    });

    const evaluation = runDeterministicStage(p, input(EMPTY_BODY));

    expect(evaluation.decidedVerdict).toBe(VerdictStatus.EMPTY_CONFIRMED);
    expect(evaluation.result.status).toBe(StageStatus.PASSED);
    expect(evaluation.result.score).toBe(1);
    expect(evaluation.decidedVerdict).not.toBe(VerdictStatus.FAIL);

    const consequence = VERDICT_CONSEQUENCE[evaluation.decidedVerdict as VerdictStatus];
    expect(consequence.strike).toBe(false);
    expect(consequence.slashable).toBe(false);
    expect(consequence.settle).toBe(true);
  });

  it('passes unverified when the policy names no emptyResult block at all', () => {
    const p = policy([minArrayLength({ min: 1 })]);

    const evaluation = runDeterministicStage(p, input(EMPTY_BODY));

    expect(evaluation.decidedVerdict).toBe(VerdictStatus.EMPTY_UNVERIFIED);
    expect(evaluation.result.status).toBe(StageStatus.PASSED);
    expect(evaluation.decidedVerdict).not.toBe(VerdictStatus.FAIL);

    const consequence = VERDICT_CONSEQUENCE[evaluation.decidedVerdict as VerdictStatus];
    expect(consequence.strike).toBe(false);
    expect(consequence.slashable).toBe(false);
    expect(consequence.settle).toBe(true);
  });

  it('fails when the policy declares an empty answer impossible for this tool', () => {
    const p = policy([minArrayLength({ min: 1 })], {
      emptyResult: { whenUncorroborated: EmptyResultDisposition.FAIL },
    });

    const evaluation = runDeterministicStage(p, input(EMPTY_BODY));

    expect(evaluation.decidedVerdict).toBe(VerdictStatus.FAIL);
    expect(evaluation.result.status).toBe(StageStatus.FAILED);
    expect(VERDICT_CONSEQUENCE[VerdictStatus.FAIL].strike).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MISAPPLIED — the policy's fault, never the provider's
// ---------------------------------------------------------------------------

describe('MISAPPLIED', () => {
  it('a FRESHNESS rule pointed at a non-timestamp voids the call with no strike', () => {
    const p = policy([freshness({ path: '$.flag', maxAgeMs: 1000 })]);
    const evaluation = runDeterministicStage(p, input({ flag: true }));

    expect(evaluation.result.status).toBe(StageStatus.MISAPPLIED);
    expect(evaluation.result.code).toBe('not_a_timestamp');
    expect(evaluation.decidedVerdict).toBe(VerdictStatus.MISAPPLIED);
    expect(VERDICT_CONSEQUENCE[VerdictStatus.MISAPPLIED].strike).toBe(false);
  });

  it('a rule whose selector resolves to nothing voids the call with no strike', () => {
    const p = policy([requiredFields({ path: '$.missingBranch[*]', fields: ['url'] })]);
    const evaluation = runDeterministicStage(p, input({ results: [] }));

    expect(evaluation.result.status).toBe(StageStatus.MISAPPLIED);
    expect(evaluation.result.code).toBe('path_not_found');
    expect(evaluation.decidedVerdict).toBe(VerdictStatus.MISAPPLIED);
    expect(VERDICT_CONSEQUENCE[VerdictStatus.MISAPPLIED].strike).toBe(false);
  });

  it('a rule gated off by appliesWhen is NOT_APPLICABLE, not MISAPPLIED and not FAILED', () => {
    const rule = freshness({
      path: '$.flag',
      maxAgeMs: 1000,
      appliesWhen: { path: '$.mode', operator: ConditionOperator.EQUALS, value: 'strict' },
    });

    const result = evaluateRule(rule, input({ flag: true, mode: 'lenient' }));

    expect(result.outcome).toBe(RuleOutcome.NOT_APPLICABLE);
    expect(result.outcome).not.toBe(RuleOutcome.MISAPPLIED);
    expect(result.outcome).not.toBe(RuleOutcome.FAILED);
    expect(result.code).toBe('gated_off');
  });
});

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

describe('scoring', () => {
  it('excludes an inapplicable rule from the denominator, so it cannot lower the score', () => {
    const gated = requiredFields({
      path: '$.optionalBranch[*]',
      fields: ['url'],
      appliesWhen: { path: '$.mode', operator: ConditionOperator.EQUALS, value: 'strict' },
    });
    const passing = valueRange({ min: 0, max: 100 });

    const p = policy([gated, passing], { passThreshold: 0.7 });
    const evaluation = runDeterministicStage(p, input({ mode: 'lenient', score: 50 }));

    expect(evaluation.result.score).toBe(1);
    expect(evaluation.result.status).toBe(StageStatus.PASSED);
    expect(evaluation.decidedVerdict).toBeNull();
  });

  it('fails below the threshold and reports the first failed rule', () => {
    const p = policy([valueRange({ min: 0, max: 100 })], { passThreshold: 0.7 });
    const evaluation = runDeterministicStage(p, input({ score: 999 }));

    expect(evaluation.result.status).toBe(StageStatus.FAILED);
    expect(evaluation.result.score).toBe(0);
    expect(evaluation.result.code).toBe('out_of_range');
    expect(evaluation.decidedVerdict).toBe(VerdictStatus.FAIL);
  });
});

// ---------------------------------------------------------------------------
// Misapplication outranks failure
// ---------------------------------------------------------------------------

describe('misapplication outranks failure', () => {
  it('reports MISAPPLIED, not FAILED, when both occur in the same stage', () => {
    const misapplying = freshness({ path: '$.flag', maxAgeMs: 1000 });
    const failing = valueRange({ min: 0, max: 100 });

    const p = policy([misapplying, failing], { passThreshold: 0.7 });
    const evaluation = runDeterministicStage(p, input({ flag: true, score: 999 }));

    expect(evaluation.result.status).toBe(StageStatus.MISAPPLIED);
    expect(evaluation.decidedVerdict).toBe(VerdictStatus.MISAPPLIED);
    expect(evaluation.result.status).not.toBe(StageStatus.FAILED);

    // Both rules' individual outcomes are still on the receipt.
    expect(evaluation.result.rules?.find((r) => r.ruleId === misapplying.id)?.outcome).toBe(
      RuleOutcome.MISAPPLIED,
    );
    expect(evaluation.result.rules?.find((r) => r.ruleId === failing.id)?.outcome).toBe(
      RuleOutcome.FAILED,
    );
  });
});

// ---------------------------------------------------------------------------
// Stage plumbing
// ---------------------------------------------------------------------------

describe('runDeterministicStage plumbing', () => {
  it('always names DETERMINISTIC_RULES as the stage', () => {
    const p = policy([valueRange({ min: 0, max: 100 })]);
    const evaluation = runDeterministicStage(p, input({ score: 50 }));
    expect(evaluation.result.stage).toBe(VerificationStage.DETERMINISTIC_RULES);
  });
});

// ---------------------------------------------------------------------------
// conditionHolds — the gate and the evidence share one evaluator
// ---------------------------------------------------------------------------

describe('conditionHolds', () => {
  it('never throws on a malformed selector, and resolves to false', () => {
    expect(() =>
      conditionHolds({ path: 'not-a-selector', operator: ConditionOperator.EXISTS }, input({})),
    ).not.toThrow();
    expect(
      conditionHolds({ path: 'not-a-selector', operator: ConditionOperator.EXISTS }, input({})),
    ).toBe(false);
  });

  it('resolves to false when the condition reads an absent request document', () => {
    const holds = conditionHolds(
      { path: '$.query', operator: ConditionOperator.EXISTS, source: ConditionSource.REQUEST },
      input({}, { request: undefined }),
    );
    expect(holds).toBe(false);
  });
});
