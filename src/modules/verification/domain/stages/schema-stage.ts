/**
 * Stage 1 of the verification pipeline: does the response have the
 * shape the tool contract promises?
 *
 * ~0.1ms — cheap
 * enough to run on every call, unsampled, and cheap enough to run *first*, so
 * a response with the wrong shape never reaches a rule, a cross-check or a
 * model call that would have been pure spend on an answer whose fate was
 * already decided.
 *
 * This is not a second schema validator. `validateAgainstSchema` is
 * the one JSON Schema subset this system enforces, on both sides of a
 * binding; this file is a thin wrapper that runs it over the *response* side
 * and turns its one failure mode — a thrown `AppError` — into a
 * {@link StageEvaluation}.
 *
 * The wrapper still earns its keep, because `validateAgainstSchema` was built
 * for the mapping boundary, where a violation is either the agent's
 * fault or the provider's. Verification adds a third possibility mapping
 * never had to express: a violation that is *our own* mistake — a mapping
 * that asked the provider for something it never promised. The split below
 * exists to keep that mistake off a provider's stake.
 */

import {
  JsonSchema,
  MappingDirection,
  MappingFault,
  mappingFaultOf,
  validateAgainstSchema,
} from '@modules/tool/domain/mapping';
import { ToolErrorCode } from '@modules/tool/errors/tool.errors';
import { AppError } from '@shared/errors/app-errors';

import { VerificationPolicy } from '../policy.types';
import { decideEmptyResult } from '../rules/empty-result';
import { StageEvaluation, StageInput, StageStatus, VerificationStage } from '../stage';
import { VerdictStatus } from '../verdict';

/**
 * Runs the schema stage over `input.response` against `schema`.
 *
 * Pure: no clock, no I/O — `StageInput` already forbids both. `schema` is
 * passed in rather than looked up, so a disputed call re-evaluates
 * against exactly the schema the tool carried at the time, not whatever it
 * carries today.
 */
export function runSchemaStage(
  policy: VerificationPolicy,
  input: StageInput,
  schema: JsonSchema | undefined,
): StageEvaluation {
  if (!schema) {
    // No declared shape means nothing was checked. This must not be PASSED —
    // a receipt that ticks a check that never ran is the exact lie
    // `stage.ts`'s vocabulary exists to prevent — and it must not be
    // NOT_REACHED either, because the stage *did* run; it just had nothing
    // to hold the response against. NOT_APPLICABLE is the honest word for
    // "reached, and there was nothing here to learn".
    return evaluation({
      status: StageStatus.NOT_APPLICABLE,
      code: 'no_schema_declared',
      detail: 'This tool declares no output schema, so the schema stage has nothing to check.',
    });
  }

  try {
    validateAgainstSchema(input.response, schema, {
      direction: MappingDirection.RESPONSE,
      fault: MappingFault.PROVIDER,
    });
  } catch (error) {
    return evaluateViolation(error, policy, input);
  }

  return evaluation({ status: StageStatus.PASSED, code: null, detail: null, score: 1 });
}

function evaluateViolation(
  error: unknown,
  policy: VerificationPolicy,
  input: StageInput,
): StageEvaluation {
  if (!(error instanceof AppError)) {
    // A validator bug, or an input hostile enough to break something the
    // validator relies on, is not evidence about the provider. Our crash is
    // never a provider's strike, so this is MISAPPLIED rather than a rethrow
    // — a stage that can throw out of the pipeline is a stage where one bad
    // response can take down the engine for every call behind it.
    return evaluation({
      status: StageStatus.MISAPPLIED,
      code: 'schema_stage_error',
      detail:
        error instanceof Error
          ? error.message
          : 'The schema stage failed unexpectedly and could not judge this response.',
      decidedVerdict: VerdictStatus.MISAPPLIED,
    });
  }

  // Every `TOOL_MAPPING_*` message built by `schema-validator.ts` already
  // interpolates `pointer` into its text (see `tool.errors.ts`), so the
  // pointer is not repeated here — `error.message` already names it, and
  // duplicating it in `detail` would just print the same fact twice.
  const code = deriveCode(error.errorCode);
  const fault = mappingFaultOf(error);

  if (error.errorCode === ToolErrorCode.TOOL_MAPPING_EMPTY_COLLECTION) {
    // `minItems` on a tool's output schema is how a tool says "an answer with
    // no results does not satisfy this contract" — and an empty answer is
    // precisely the thing the verdict vocabulary forbids resolving to a strike
    // on the schema stage's own authority. The tool's empty-result policy
    // decides, which is the same decision the deterministic stage would reach
    // for the same body (`rules/empty-result.ts`). Failing here instead would
    // overrule a correctly-written policy from the layer above it, where its
    // author could never see it happening.
    const decision = decideEmptyResult(policy, input, pointerOf(error));
    return evaluation({
      status: decision.status,
      code: decision.code,
      detail: decision.detail,
      score: decision.score,
      decidedVerdict: decision.verdict,
    });
  }

  if (fault === MappingFault.PROVIDER) {
    // The selector resolved and the data at that site was wrong — a type
    // mismatch, an explicit null where the contract requires a value, or an
    // empty collection at a required site. The mapping asked for the right
    // thing and the provider's payload did not honour the contract it
    // published. This is the only branch of this stage that can strike.
    return evaluation({
      status: StageStatus.FAILED,
      code,
      detail: error.message,
      score: 0,
      decidedVerdict: VerdictStatus.FAIL,
    });
  }

  // Every other fault — `PLATFORM`, `AGENT`, or none recognised at all — is
  // MISAPPLIED. The three are not equally likely, but they get the same
  // outcome:
  //
  // `PLATFORM` is the load-bearing case, and the one worth explaining.
  // `validateAgainstSchema`'s `faultForMissing` attributes a *missing
  // required field on the response side* to `PLATFORM`, not `PROVIDER` —
  // because `direction: RESPONSE` means the field's absence is structural,
  // not data, and structure on the response side comes from our own
  // mapping, not the provider's payload. A field the mapping never asked the
  // provider for cannot be the provider's omission. Failing a provider for a
  // gap in our own mapping is exactly the false positive the verdict
  // vocabulary exists to stop ("stop the obviously-wrong FAIL").
  //
  // `AGENT` should be structurally unreachable from this call site — this
  // stage always validates with `fault: PROVIDER` and `direction: RESPONSE`,
  // and neither of those ever re-derives `AGENT` inside the validator — and
  // no recognised fault at all means `mappingFaultOf` could not read one
  // back from the error, which happens if something other than
  // `validateAgainstSchema` ever throws through this path. Both cases are
  // ambiguity, not evidence, and every ambiguity here resolves toward the
  // outcome that cannot cost a provider money.
  return evaluation({
    status: StageStatus.MISAPPLIED,
    code,
    detail: error.message,
    decidedVerdict: VerdictStatus.MISAPPLIED,
  });
}

/**
 * `TOOL_MAPPING_EMPTY_COLLECTION` → `empty_collection`.
 *
 * Stable and value-free, per `StageResult.code`'s contract: metrics group by
 * this, so it can never carry a pointer, a field name, or anything else that
 * varies per call. Stripping the shared `TOOL_MAPPING_` prefix and
 * lower-casing what remains is enough — the mapping error catalogue
 * is closed, and every member already reads as a reason once the noun every
 * caller in this file already knows is dropped.
 */
function deriveCode(errorCode: string): string {
  return errorCode.replace(/^TOOL_MAPPING_/, '').toLowerCase();
}

/** The JSON pointer the violation was found at, when the error carried one. */
function pointerOf(error: AppError): string | null {
  const pointer = error.context?.pointer;
  return typeof pointer === 'string' ? pointer : null;
}

interface EvaluationArgs {
  readonly status: StageStatus;
  readonly code: string | null;
  readonly detail: string | null;
  readonly score?: number | null;
  readonly decidedVerdict?: VerdictStatus | null;
}

/**
 * Builds the `{ result, decidedVerdict }` shape every branch above returns,
 * so the "score defaults to `null`, verdict defaults to `null`" rule
 * (`stage.ts`) is written once rather than at each call site.
 */
function evaluation(args: EvaluationArgs): StageEvaluation {
  return {
    result: {
      stage: VerificationStage.SCHEMA,
      status: args.status,
      code: args.code,
      detail: args.detail,
      score: args.score ?? null,
    },
    decidedVerdict: args.decidedVerdict ?? null,
  };
}
