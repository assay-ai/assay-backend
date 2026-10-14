import { Classification } from '@modules/tool/domain/classification/classification.types';
import { JsonObject, JsonValue, MappingFault } from '@modules/tool/domain/mapping/mapping.types';
import { StageResult } from '@modules/verification/domain/stage';
import { VerdictStatus } from '@modules/verification/domain/verdict';

/**
 * What the mapping tester reports.
 *
 * The requirement: *"show three things — the
 * raw response, the result after mapping, **and what each check layer thinks of
 * that result**, using exactly the layers production will run"* — and then the
 * sentence that says why: *"a tester that shows only the raw response is not
 * enough, and will turn every later failure into an email argument."*
 *
 * So the report is not a pass/fail. It is one row per layer a real call passes
 * through, in production order, each saying what that layer concluded:
 *
 * ```text
 * 1. REQUEST_MAPPING   mapRequest         tool input → the provider's shape
 * 2. UPSTREAM          the real socket    status, latency, transport failure
 * 3. CLASSIFICATION    classifyResponse   DATA_RESULT | SYSTEM_ERROR | REQUEST_ERROR
 * 4. RESPONSE_MAPPING  mapResponse        native JSON → the tool's outputSchema
 * 5. VERIFICATION      verify             the four stages, and the verdict
 * ```
 *
 * The vocabulary deliberately mirrors `VerificationStage`'s: a layer after a
 * failure is `NOT_REACHED`, never `PASSED` and never omitted. A provider
 * reading a tester result that omitted the verification row would conclude
 * verification was happy with a response it never saw — the same
 * misunderstanding `stage.ts` exists to prevent, one layer further out.
 */
export enum BindingTestLayer {
  REQUEST_MAPPING = 'REQUEST_MAPPING',
  UPSTREAM = 'UPSTREAM',
  CLASSIFICATION = 'CLASSIFICATION',
  RESPONSE_MAPPING = 'RESPONSE_MAPPING',
  VERIFICATION = 'VERIFICATION',
}

/** Layer order. One result per entry, always, in this order. */
export const BINDING_TEST_LAYERS: readonly BindingTestLayer[] = Object.freeze([
  BindingTestLayer.REQUEST_MAPPING,
  BindingTestLayer.UPSTREAM,
  BindingTestLayer.CLASSIFICATION,
  BindingTestLayer.RESPONSE_MAPPING,
  BindingTestLayer.VERIFICATION,
]);

export enum BindingTestLayerStatus {
  /** The layer ran and was satisfied. The only value that may be drawn as a tick. */
  PASSED = 'PASSED',
  /** The layer ran and was not satisfied. Stops the run. */
  FAILED = 'FAILED',
  /** An earlier layer failed. **Nothing is known about this one.** */
  NOT_REACHED = 'NOT_REACHED',
  /**
   * The layer ran and had nothing to judge by — no stored verification policy,
   * a tool with no `outputSchema`.
   *
   * Not a pass. A publish gate that treated it as one would let a binding go
   * live on the strength of a check that never happened.
   */
  INCONCLUSIVE = 'INCONCLUSIVE',
}

export interface BindingTestLayerResult {
  readonly layer: BindingTestLayer;
  readonly status: BindingTestLayerStatus;
  /** Stable machine-readable reason — an error code, a classification reason. `null` on a pass. */
  readonly code: string | null;
  /** One human sentence with the specifics, including the mapping pointer where there is one. */
  readonly detail: string | null;
  /**
   * Who the platform believes is at fault, where the layer has an opinion.
   *
   * Carried through unchanged from the mapping engine rather than re-derived:
   * `PLATFORM` for a selector that resolves to nothing, `PROVIDER` for a
   * selector that resolves onto wrong data. A provider staring at a red tester
   * needs to know which of those two it is before they start editing.
   */
  readonly fault: MappingFault | null;
}

/** The request the mapping produced, as it went on the wire. */
export interface BindingTestRequestView {
  readonly method: string;
  readonly url: string;
  /**
   * Header **names** only.
   *
   * `docs/mapping-format.md` is explicit that a secret never belongs in a
   * mapping, and this report is persisted in a `jsonb` column that support
   * staff and a future dispute both read. Names are enough to debug a mapping;
   * values would make the column a place credentials accumulate on the day
   * somebody ignores the rule.
   */
  readonly headerNames: readonly string[];
  readonly body: JsonValue | null;
}

/** What actually came back, before anything interpreted it. */
export interface BindingTestUpstreamView {
  readonly status: number;
  readonly latencyMs: number;
  /** The raw bytes, truncated. The tester's first of three panels. */
  readonly rawBody: string | null;
  readonly rawBodyTruncated: boolean;
  readonly contentType: string | null;
  /** Set when no status was ever received — a timeout, a refused connection, a TLS failure. */
  readonly transportError: { readonly kind: string; readonly detail: string | null } | null;
}

export interface BindingTestVerificationView {
  /**
   * Which policy judged this — and, when none is stored, that fact stated
   * rather than hidden behind a default that looks like a policy.
   */
  readonly policySource: BindingTestPolicySource;
  readonly policyId: string | null;
  readonly policyVersion: number | null;
  readonly stages: readonly StageResult[];
  readonly verdict: VerdictStatus | null;
}

export enum BindingTestPolicySource {
  /** The policy this tool's traffic is actually judged by today. */
  STORED_POLICY = 'STORED_POLICY',
  /**
   * No policy is registered for this tool, so the run judged the response
   * against the tool's own `outputSchema` alone.
   *
   * Honest rather than convenient: production settles such a call *unverified*
   * (`VerificationAggregatorService.decide` returns `null` on no policy), so
   * this run is stricter than production, and the label is what stops a
   * provider reading it as "verification passed".
   */
  TOOL_SCHEMA_ONLY = 'TOOL_SCHEMA_ONLY',
}

export enum BindingTestOutcome {
  PASSED = 'PASSED',
  FAILED = 'FAILED',
}

/**
 * One tester run, whole.
 *
 * Stored on `binding_test_runs.report` and returned to the console unchanged,
 * so what a provider saw and what the publish gate read are the same document.
 */
export interface BindingTestReport {
  /** The `X-Assay-Call-Id` this run sent upstream. Real, and unique. */
  readonly callId: string;
  readonly outcome: BindingTestOutcome;
  /** Which layer stopped it, or `null` when every layer passed. */
  readonly failedLayer: BindingTestLayer | null;
  readonly layers: readonly BindingTestLayerResult[];
  readonly request: BindingTestRequestView | null;
  readonly upstream: BindingTestUpstreamView | null;
  readonly classification: Classification | null;
  /** The second panel: the document the response mapping produced. */
  readonly mapped: JsonValue | null;
  readonly verification: BindingTestVerificationView | null;
}

/** What the console posts to run a test. */
export interface BindingTestRequestInput {
  /** The tool arguments to call with, validated against the tool's `inputSchema` first. */
  readonly input: JsonObject;
}
