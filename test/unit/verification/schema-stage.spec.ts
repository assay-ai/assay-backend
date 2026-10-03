/**
 * `runSchemaStage` (stage 1).
 *
 * Follows the case-matrix style of `test/unit/tool/response-classification.spec.ts`
 * where it fits, but the load-bearing behaviour here is one specific branch —
 * a missing required field on the *response* side must never strike a
 * provider — so that case gets its own describe block asserting all the way
 * through `VERDICT_CONSEQUENCE` rather than stopping at the stage status.
 */
import { JsonSchema } from '@modules/tool/domain/mapping';
import {
  EmptyResultDisposition,
  PolicyMode,
  VerificationPolicy,
} from '@modules/verification/domain/policy.types';
import { ConditionOperator } from '@modules/verification/domain/rules/rule.types';
import { StageInput, StageStatus, VerificationStage } from '@modules/verification/domain/stage';
import { runSchemaStage } from '@modules/verification/domain/stages/schema-stage';
import { VERDICT_CONSEQUENCE, VerdictStatus } from '@modules/verification/domain/verdict';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EVALUATED_AT = new Date('2026-01-01T00:00:00.000Z');

function input(response: unknown): StageInput {
  return { response: response as StageInput['response'], evaluatedAt: EVALUATED_AT };
}

/**
 * The stage reads the policy for one thing only: what an empty collection
 * means. Everything else here is decided by the schema alone.
 */
function policy(overrides: Partial<VerificationPolicy> = {}): VerificationPolicy {
  return {
    id: 'vp_search_web',
    toolId: 'search_web',
    version: 1,
    rules: [],
    passThreshold: 0.7,
    mode: PolicyMode.ACTIVE,
    ...overrides,
  };
}

const POLICY = policy();

/**
 * `search_web`-shaped: an array of results, each with a `url` and a `title`.
 *
 * Deliberately has NO `minItems` on the `results` collection. Whether a zero-
 * length result set is a real answer is stage 2's call (`MIN_ARRAY_LENGTH`,
 * `EMPTY_CONFIRMED` / `EMPTY_UNVERIFIED`) — this schema exists to test type
 * and required-field violations without also tripping the empty-collection
 * path, which belongs to the other agent's stage.
 */
const TOOL_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['url', 'title'],
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
        },
      },
    },
  },
};

/** The same shape, but `results` itself is required to be non-empty. */
const MIN_ITEMS_SCHEMA: JsonSchema = {
  ...TOOL_SCHEMA,
  properties: {
    results: { ...TOOL_SCHEMA.properties!.results, minItems: 1 },
  },
};

const WELL_FORMED_RESPONSE = {
  results: [
    { url: 'https://example.com/a', title: 'A' },
    { url: 'https://example.com/b', title: 'B' },
  ],
};

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('runSchemaStage — passing and inapplicable', () => {
  it('passes a well-formed response against a real tool-shaped schema', () => {
    const evaluation = runSchemaStage(POLICY, input(WELL_FORMED_RESPONSE), TOOL_SCHEMA);

    expect(evaluation.result.status).toBe(StageStatus.PASSED);
    expect(evaluation.result.score).toBe(1);
    expect(evaluation.result.code).toBeNull();
    expect(evaluation.decidedVerdict).toBeNull();
  });

  it('is NOT_APPLICABLE — never PASSED, with a null score — when the tool declares no schema', () => {
    const evaluation = runSchemaStage(POLICY, input(WELL_FORMED_RESPONSE), undefined);

    expect(evaluation.result.status).toBe(StageStatus.NOT_APPLICABLE);
    expect(evaluation.result.status).not.toBe(StageStatus.PASSED);
    expect(evaluation.result.score).toBeNull();
    expect(evaluation.result.code).toBe('no_schema_declared');
    expect(evaluation.decidedVerdict).toBeNull();
  });
});

describe('runSchemaStage — provider data violations (FAILED)', () => {
  it('fails a type mismatch and decides FAIL', () => {
    const badResponse = {
      results: [{ url: 'https://example.com/a', title: 42 }],
    };

    const evaluation = runSchemaStage(POLICY, input(badResponse), TOOL_SCHEMA);

    expect(evaluation.result.status).toBe(StageStatus.FAILED);
    expect(evaluation.result.score).toBe(0);
    expect(evaluation.result.code).toBe('type_mismatch');
    expect(evaluation.decidedVerdict).toBe(VerdictStatus.FAIL);
  });

  it('fails a minItems violation with a non-empty but too-short array', () => {
    // minItems: 1 with exactly zero elements is the empty-collection case
    // (tested separately below); require 2 so a single, non-empty element
    // still violates it.
    const requireTwo: JsonSchema = {
      ...TOOL_SCHEMA,
      properties: { results: { ...TOOL_SCHEMA.properties!.results, minItems: 2 } },
    };
    const shortResponse = { results: [{ url: 'https://example.com/a', title: 'A' }] };

    const evaluation = runSchemaStage(POLICY, input(shortResponse), requireTwo);

    expect(evaluation.result.status).toBe(StageStatus.FAILED);
    expect(evaluation.decidedVerdict).toBe(VerdictStatus.FAIL);
  });
});

/**
 * An empty collection against `minItems` is the one schema violation this
 * stage does not get to call a failure on its own authority.
 *
 * `minItems: 1` on a tool's output schema and a `MIN_ARRAY_LENGTH` rule in the
 * policy are two spellings of the same requirement, and a policy author who
 * writes the empty-result story correctly must not be overruled by the layer
 * above them — least of all invisibly. So both routes land in the same
 * `decideEmptyResult`, and these three cases mirror the deterministic stage's
 * exactly.
 */
describe('runSchemaStage — an empty collection defers to the empty-result policy', () => {
  it('passes unconfirmed when the policy says nothing about empties', () => {
    const evaluation = runSchemaStage(POLICY, input({ results: [] }), MIN_ITEMS_SCHEMA);

    expect(evaluation.decidedVerdict).toBe(VerdictStatus.EMPTY_UNVERIFIED);
    expect(evaluation.result.status).toBe(StageStatus.PASSED);
    expect(evaluation.result.code).toBe('empty_result_unverified');
    // The whole point: not a strike, not slashable, and the provider is paid.
    const consequence = VERDICT_CONSEQUENCE[evaluation.decidedVerdict!];
    expect(consequence.strike).toBe(false);
    expect(consequence.slashable).toBe(false);
    expect(consequence.settle).toBe(true);
  });

  it('passes confirmed when the response corroborates the emptiness', () => {
    const evaluation = runSchemaStage(
      policy({
        emptyResult: {
          evidence: [{ path: '$.totalResults', operator: ConditionOperator.EQUALS, value: 0 }],
        },
      }),
      input({ results: [], totalResults: 0 }),
      MIN_ITEMS_SCHEMA,
    );

    expect(evaluation.decidedVerdict).toBe(VerdictStatus.EMPTY_CONFIRMED);
    expect(evaluation.result.status).toBe(StageStatus.PASSED);
  });

  it('fails only where the tool declares an empty answer impossible', () => {
    const evaluation = runSchemaStage(
      policy({ emptyResult: { whenUncorroborated: EmptyResultDisposition.FAIL } }),
      input({ results: [] }),
      MIN_ITEMS_SCHEMA,
    );

    expect(evaluation.result.status).toBe(StageStatus.FAILED);
    expect(evaluation.decidedVerdict).toBe(VerdictStatus.FAIL);
  });

  it('names where the empty collection was found, so a receipt can point at it', () => {
    const evaluation = runSchemaStage(POLICY, input({ results: [] }), MIN_ITEMS_SCHEMA);
    expect(evaluation.result.detail).toContain('/results');
  });
});

describe('runSchemaStage — the load-bearing case: a missing required field on the response', () => {
  it('is MISAPPLIED, not FAILED, and settles as no strike / not slashable', () => {
    // `results` is required at the root but absent entirely — the mapping
    // never produced it. On the response side that is the mapping engine's
    // `faultForMissing` attributing PLATFORM, not PROVIDER: the field's
    // absence is our mapping's gap, not evidence the provider misbehaved.
    const evaluation = runSchemaStage(POLICY, input({}), TOOL_SCHEMA);

    expect(evaluation.result.status).toBe(StageStatus.MISAPPLIED);
    expect(evaluation.result.status).not.toBe(StageStatus.FAILED);
    expect(evaluation.result.score).toBeNull();
    expect(evaluation.result.code).toBe('required_field_missing');
    expect(evaluation.decidedVerdict).toBe(VerdictStatus.MISAPPLIED);

    const consequence = VERDICT_CONSEQUENCE[evaluation.decidedVerdict!];
    expect(consequence.strike).toBe(false);
    expect(consequence.slashable).toBe(false);
    expect(consequence.settle).toBe(false);
  });

  it('is also MISAPPLIED for a required field missing on a nested element', () => {
    const evaluation = runSchemaStage(
      POLICY,
      input({ results: [{ url: 'https://example.com/a' }] }),
      TOOL_SCHEMA,
    );

    expect(evaluation.result.status).toBe(StageStatus.MISAPPLIED);
    expect(evaluation.decidedVerdict).toBe(VerdictStatus.MISAPPLIED);
    expect(VERDICT_CONSEQUENCE[VerdictStatus.MISAPPLIED].slashable).toBe(false);
  });
});

describe('runSchemaStage — stage identity', () => {
  it('every returned StageResult.stage is VerificationStage.SCHEMA', () => {
    const cases = [
      runSchemaStage(POLICY, input(WELL_FORMED_RESPONSE), TOOL_SCHEMA),
      runSchemaStage(POLICY, input(WELL_FORMED_RESPONSE), undefined),
      runSchemaStage(
        POLICY,
        input({ results: [{ url: 'https://example.com/a', title: 42 }] }),
        TOOL_SCHEMA,
      ),
      runSchemaStage(POLICY, input({}), TOOL_SCHEMA),
    ];

    for (const evaluation of cases) {
      expect(evaluation.result.stage).toBe(VerificationStage.SCHEMA);
    }
  });
});

describe('runSchemaStage — containment of non-AppError failures', () => {
  it('never throws out of runSchemaStage; a hostile schema is contained as MISAPPLIED', () => {
    // A `properties` entry that is not a schema object at all — the
    // validator will try to read `.type` / `.properties` off it and, for a
    // sufficiently hostile value, misbehave in a way that is not one of the
    // catalogued `TOOL_MAPPING_*` `AppError`s. Whatever it throws, it must
    // never escape `runSchemaStage`, and it must never read as a provider
    // strike.
    const hostileSchema = {
      type: 'object',
      required: ['results'],
      properties: {
        // A getter that throws when read reproduces "the validator itself
        // blew up" without relying on any particular internal shape.
        get results() {
          throw new RangeError('hostile schema exploded');
        },
      },
    } as unknown as JsonSchema;

    let evaluation;
    expect(() => {
      evaluation = runSchemaStage(POLICY, input({ results: [] }), hostileSchema);
    }).not.toThrow();

    expect(evaluation!.result.status).toBe(StageStatus.MISAPPLIED);
    expect(evaluation!.result.code).toBe('schema_stage_error');
    expect(evaluation!.decidedVerdict).toBe(VerdictStatus.MISAPPLIED);
    expect(VERDICT_CONSEQUENCE[VerdictStatus.MISAPPLIED].slashable).toBe(false);
  });
});
