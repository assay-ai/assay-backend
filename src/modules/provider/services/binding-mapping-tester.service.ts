import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { BindingTestRunEntity } from '@database/postgres/entities/binding-test-run.entity';
import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { BindingTestRunRepository } from '@database/postgres/repositories/binding-test-run.repository';
import {
  Classification,
  ProviderResponse,
  ResponseBodyKind,
  ResponseClass,
  classifyResponse,
} from '@modules/tool/domain/classification';
import {
  JsonObject,
  JsonValue,
  MappingFault,
  UpstreamRequest,
  mapRequest,
  mappingFaultOf,
} from '@modules/tool/domain/mapping';
import { BINDING_INVOKER, BindingInvokerPort } from '@modules/tool/ports/binding-invoker.port';
import { TOOL_CATALOGUE, ToolCataloguePort } from '@modules/tool/ports/tool-catalogue.port';
import { RequestSignerService } from '@modules/tool/request-auth/request-signer.service';
import {
  BindingAuthMode,
  Tool,
  ToolBinding,
  ToolContractVersion,
} from '@modules/tool/ports/tool.types';
import {
  contractVersionsOf,
  effectiveOutputSchema,
  isServable,
  toolAtVersion,
  versionOf,
} from '@modules/tool/domain/contract/contract-versions';
import { mapServedResponse } from '@modules/tool/domain/contract/served-response';
import { bindingRange } from '@modules/tool/domain/contract/version-range';
import { toToolBinding } from '@modules/tool/services/database-tool-catalogue';
import { PolicyMode, VerificationPolicy } from '@modules/verification/domain/policy.types';
import { RuleOutcome } from '@modules/verification/domain/rules/rule.types';
import { StageResult, VerificationStage, stageRan } from '@modules/verification/domain/stage';
import { creditsProvider, isProviderAtFault } from '@modules/verification/domain/verdict';
import { verify } from '@modules/verification/domain/engine';
import { DecisionPolicyService } from '@modules/verification/services/decision-policy.service';
import { AppError } from '@shared/errors/app-errors';

import { isAssayHeaderName } from '../credentials/credential-rules';
import { BindingTestReportDto } from '../dto/test-tool-binding.dto';
import {
  BINDING_TEST_LAYERS,
  BindingTestLayer,
  BindingTestLayerResult,
  BindingTestLayerStatus,
  BindingTestOutcome,
  BindingTestPolicySource,
  BindingTestReport,
  BindingTestUpstreamView,
  BindingTestVerificationView,
  BindingTestWarning,
  BindingTestWarningCode,
} from '../ports/binding-test.types';
import { ProviderErrors } from '../errors/provider.errors';
import { BindingEditorService } from './binding-editor.service';
import { ProviderEgressLimiter } from './provider-egress-limiter.service';

/** Enough of a body to debug a mapping, not enough to fill a `jsonb` column with a page. */
const RAW_BODY_LIMIT = 32 * 1024;

/** The router's default total deadline (`ROUTER_TOTAL_DEADLINE_MS`); a live call never waits longer. */
const TESTER_MAX_TIMEOUT_MS = 30_000;

/**
 * The mapping tester.
 *
 * > *"The most important screen in the whole console: make a REAL call to the
 * > provider's endpoint in a sandbox, charging nobody, then show three things —
 * > the raw response, the result after mapping, AND WHAT EACH CHECK LAYER thinks
 * > of that result, using exactly the layers production will run. A tester that
 * > shows only the raw response is not enough, and will turn every later failure
 * > into an email argument."*
 *
 * Everything below follows from the last sentence. A tester that showed only
 * the raw body would leave a provider unable to see the difference between "my
 * endpoint is fine and your check is wrong" and "my endpoint returns a field
 * your contract calls required" — and that difference, discovered for the first
 * time on the day money is withheld, is the email argument a tester exists to prevent.
 *
 * ## It runs production's layers, not copies of them
 *
 * ```text
 * mapRequest          the mapping function the invoker itself calls
 * BINDING_INVOKER     the router's invoker, the same instance the router holds
 * classifyResponse    the response classifier, same default policy as the router
 * mapResponse         the mapping engine again, against the tool's own outputSchema
 * verify              the deterministic verification engine, on this tool's stored policy
 * ```
 *
 * Not one of these is re-implemented here. This class sequences them, records
 * what each concluded, and stops at the first that failed — which is also
 * exactly what `ProviderRouterService` does with the same five, and the reason
 * a green tester run means something.
 *
 * ## It costs nobody anything
 *
 * No payment intent, no hold, no ledger entry, no settlement — the tester never
 * touches `payment`, `ledger` or `settlement`, and a test asserts the balances
 * are byte-identical before and after a run. The provider pays for their own
 * upstream compute, which is the same thing a `curl` would cost them.
 *
 * The one trace it leaves is deliberate: the call carries a real
 * `X-Assay-Call-Id` (non-optional on `BindingInvocation`) and the run is
 * recorded against it, so a provider who finds that id in their own access log
 * can resolve it. An id with no record on our side is precisely the
 * reconciliation hole the call id exists to close.
 */
@Injectable()
export class BindingMappingTesterService {
  private readonly logger = new Logger(BindingMappingTesterService.name);

  constructor(
    private readonly editor: BindingEditorService,
    private readonly runs: BindingTestRunRepository,
    @Inject(TOOL_CATALOGUE) private readonly catalogue: ToolCataloguePort,
    @Inject(BINDING_INVOKER) private readonly invoker: BindingInvokerPort,
    private readonly policies: DecisionPolicyService,
    private readonly limiter: ProviderEgressLimiter,
    /** Read only to say whether the request went out signed; never asked to sign. */
    private readonly signer: RequestSignerService,
  ) {}

  /**
   * Bounded by {@link ProviderEgressLimiter}: the run happens in the API
   * process, on a URL the provider typed, so how many may be in flight — and
   * how often one organization may start one — is capped.
   */
  run(
    organizationId: string,
    subject: string,
    bindingId: string,
    input: JsonObject,
    toolVersion?: number,
  ): Promise<BindingTestReportDto> {
    return this.limiter.run(organizationId, () =>
      this.runUnlimited(organizationId, subject, bindingId, input, toolVersion),
    );
  }

  private async runUnlimited(
    organizationId: string,
    subject: string,
    bindingId: string,
    input: JsonObject,
    toolVersion?: number,
  ): Promise<BindingTestReportDto> {
    const row = await this.editor.loadEditable(organizationId, bindingId);
    const catalogued = await this.catalogue.findTool(row.toolId);
    if (!catalogued) {
      throw ProviderErrors.bindingToolUnknown({ toolId: row.toolId });
    }

    // The contract version this run checks the draft against (T3): the one
    // asked for, inside the binding's range, or the newest of its highest
    // major. Publishing needs a green run per major in the range.
    const version = testedVersion(catalogued, row.toolVersionRange ?? '^1', toolVersion);
    const tool = toolAtVersion(catalogued, version);

    const binding = toToolBinding(row);
    const callId = randomUUID();
    const executed = await this.execute(tool, binding, input, callId);
    const report: BindingTestReport = {
      ...executed,
      warnings: await this.authWarnings(tool, binding, row.authMode, input, executed),
    };

    await this.record(organizationId, subject, row, input, report, version.version);

    return {
      ...report,
      mappingVersion: row.mappingVersion,
      toolVersion: version.version,
      toolVersionSemver: version.semver,
      request: report.request && {
        ...report.request,
        headerNames: [...report.request.headerNames],
      },
      layers: report.layers.map((layer) => ({ ...layer })),
      warnings: report.warnings.map((warning) => ({ ...warning })),
      ranAt: new Date(),
    };
  }

  /** Whether this deployment signs provider requests: it has a signing key. */
  private signs(): boolean {
    return this.signer.jwks().keys.length > 0;
  }

  /**
   * Unauthenticated probes, and the warnings they earn. Warnings never change
   * the outcome.
   *
   * "The main run succeeded" is read from `report.upstream.status`: the main
   * upstream answered 2xx (independent of later mapping/verification layers,
   * which judge the body, not the endpoint's authentication). Each probe is
   * sent once, inside the caller's {@link ProviderEgressLimiter} slot, with a
   * fresh call id, omitting what the binding's `auth_mode` says the endpoint
   * should be demanding.
   */
  private async authWarnings(
    tool: Tool,
    binding: ToolBinding,
    authMode: string,
    input: JsonObject,
    report: BindingTestReport,
  ): Promise<BindingTestWarning[]> {
    const status = report.upstream?.status ?? 0;
    if (report.upstream?.transportError || status < 200 || status > 299) return [];

    const warnings: BindingTestWarning[] = [];
    if (authMode === BindingAuthMode.NONE) {
      warnings.push({
        code: BindingTestWarningCode.NO_AUTHENTICATION,
        message: 'Anyone who learns your endpoint URL can call it directly, without paying.',
      });
      return warnings;
    }
    if (authMode === BindingAuthMode.SIGNATURE || authMode === BindingAuthMode.BOTH) {
      if (await this.probeAccepted(tool, binding, input, { signature: true })) {
        warnings.push({
          code: BindingTestWarningCode.ACCEPTS_UNSIGNED,
          message: 'Your endpoint accepted a request without an Assay signature.',
        });
      }
    }
    if (authMode === BindingAuthMode.API_KEY || authMode === BindingAuthMode.BOTH) {
      if (await this.probeAccepted(tool, binding, input, { credentials: true })) {
        warnings.push({
          code: BindingTestWarningCode.ACCEPTS_WITHOUT_CREDENTIALS,
          message: 'Your endpoint accepted a request without your API key.',
        });
      }
    }
    return warnings;
  }

  private async probeAccepted(
    tool: Tool,
    binding: ToolBinding,
    input: JsonObject,
    omit: { credentials?: boolean; signature?: boolean },
  ): Promise<boolean> {
    try {
      const response = await this.invoker.invoke({
        tool,
        binding,
        input,
        callId: randomUUID(),
        timeoutMs: Math.min(binding.timeoutMs, TESTER_MAX_TIMEOUT_MS),
        omit,
      });
      return !response.transportError && response.status >= 200 && response.status <= 299;
    } catch {
      // A probe that could not be made proves nothing; never fail the run.
      // Fixed message only: the error can carry request details.
      this.logger.debug('Unauthenticated probe could not be made');
      return false;
    }
  }

  /**
   * The five layers, in order, stopping at the first failure.
   *
   * Written as a straight sequence rather than a pipeline abstraction: there
   * are five of them, they are not uniform, and the reader who most needs this
   * file is a provider-support engineer comparing it against
   * `ProviderRouterService.attempt` line by line.
   */
  private async execute(
    tool: Tool,
    binding: ToolBinding,
    input: JsonObject,
    callId: string,
  ): Promise<BindingTestReport> {
    const layers = new LayerLog();
    const context = { toolId: tool.id, bindingId: binding.id, providerId: binding.providerId };

    // ---- 1. REQUEST_MAPPING -------------------------------------------------
    // Run here as well as inside the invoker. It is pure and deterministic, so
    // the second evaluation cannot differ from the first; what it buys is the
    // *request view* — a provider staring at a 404 needs to see the URL we
    // built — and a failure reported at this layer rather than as a dial that
    // never happened.
    let upstreamRequest: UpstreamRequest;
    try {
      upstreamRequest = mapRequest(binding.requestMapping, input, {
        inputSchema: tool.inputSchema,
        context,
      });
      layers.passed(BindingTestLayer.REQUEST_MAPPING);
    } catch (error) {
      layers.failed(BindingTestLayer.REQUEST_MAPPING, error);
      return layers.report(callId, { request: null });
    }

    const request = {
      method: upstreamRequest.method,
      url: buildUrl(binding.endpoint, upstreamRequest),
      // Names only — a mapping must never carry a secret, and this report is
      // stored. See `BindingTestRequestView`. The headers Assay adds (call id,
      // signature) are named too, so a provider sees what to verify; stored
      // credential headers are not.
      headerNames: wireHeaderNames(upstreamRequest, this.signs()),
      body: upstreamRequest.body ?? null,
    };

    // ---- 2. UPSTREAM --------------------------------------------------------
    const startedAt = Date.now();
    const response = await this.invoker.invoke({
      tool,
      binding,
      input,
      callId,
      // A binding may declare up to 120 s, but no live call waits longer than
      // the router's total deadline, so neither does a test run.
      timeoutMs: Math.min(binding.timeoutMs, TESTER_MAX_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - startedAt;
    const upstream = toUpstreamView(response, latencyMs);

    if (response.transportError) {
      layers.fail(
        BindingTestLayer.UPSTREAM,
        response.transportError.kind,
        response.transportError.detail ?? 'The endpoint could not be reached.',
        null,
      );
      return layers.report(callId, { request, upstream });
    }
    layers.passed(BindingTestLayer.UPSTREAM);

    // ---- 3. CLASSIFICATION --------------------------------------------------
    // Same call the router makes, defaults and all. The classifier still has no policy
    // storage, so `{ toolId }` is the whole policy in production too — a
    // tester that invented one here would grade a response by rules no live
    // call is judged against.
    const classification = classifyResponse(response, { toolId: tool.id }, { nowMs: Date.now() });

    if (classification.responseClass !== ResponseClass.DATA_RESULT) {
      layers.fail(
        BindingTestLayer.CLASSIFICATION,
        classification.reason,
        `Classified ${classification.responseClass}: ${classification.reason}. ` +
          `A live call would not have reached verification.`,
        null,
      );
      return layers.report(callId, { request, upstream, classification });
    }
    layers.passed(BindingTestLayer.CLASSIFICATION);

    // ---- 4. RESPONSE_MAPPING ------------------------------------------------
    if (response.body.kind !== ResponseBodyKind.JSON) {
      // Unreachable through the classifier's body gate, which sends a
      // non-JSON body to `SYSTEM_ERROR` above. Stated rather than assumed,
      // because the alternative is a `TypeError` in a console screen.
      layers.fail(
        BindingTestLayer.RESPONSE_MAPPING,
        'body_not_json',
        'The response body was not JSON, so there is nothing to map.',
        MappingFault.PROVIDER,
      );
      return layers.report(callId, { request, upstream, classification });
    }

    let mapped: JsonValue;
    try {
      // As a live call maps it: the tested version's core fields, and every
      // optional output this binding declares, which must be there.
      mapped = mapServedResponse(
        binding.responseMapping,
        response.body.value,
        versionOf(tool),
        binding,
        context,
      );
      layers.passed(BindingTestLayer.RESPONSE_MAPPING);
    } catch (error) {
      layers.failed(BindingTestLayer.RESPONSE_MAPPING, error);
      return layers.report(callId, { request, upstream, classification });
    }

    // ---- 5. VERIFICATION ----------------------------------------------------
    const verification = await this.verifyMapped(tool, binding, mapped, input);
    const verdict = verification.verdict;

    if (verdict !== null && isProviderAtFault(verdict)) {
      layers.fail(
        BindingTestLayer.VERIFICATION,
        firstFailingStageCode(verification.stages) ?? verdict,
        firstFailingStageDetail(verification.stages) ?? `Verification returned ${verdict}.`,
        MappingFault.PROVIDER,
      );
    } else if (
      verdict !== null &&
      creditsProvider(verdict) &&
      !evaluatedAnyCheck(verification.stages)
    ) {
      // Every check was skipped: no schema to hold the response against and no
      // rule that applied. The engine still says `PASS` (nothing objected), but
      // nothing was judged either, and `TESTER_PASSED` must not rest on that.
      layers.inconclusive(
        BindingTestLayer.VERIFICATION,
        'no_check_evaluated',
        'Verification evaluated no check: the tool declares no output schema and no ' +
          'verification rule applied to this response.',
      );
    } else if (verdict !== null && creditsProvider(verdict)) {
      layers.passed(BindingTestLayer.VERIFICATION);
    } else {
      // `MISAPPLIED`, `DEGRADED`, `SKIPPED` — never the provider's fault, and
      // never a pass either. A publish gate that read one of these as green
      // would be letting a binding live on a check that did not conclude.
      layers.inconclusive(
        BindingTestLayer.VERIFICATION,
        verdict ?? 'not_evaluated',
        `Verification did not reach a judgement (${verdict ?? 'no verdict'}).`,
      );
    }

    return layers.report(callId, { request, upstream, classification, mapped, verification });
  }

  /**
   * The verification stages, on the policy this tool's live traffic is judged
   * by — or, when there is none, on the tool's own `outputSchema` and said so.
   *
   * `resolveForTraffic` is the aggregator's own resolver, so a policy in
   * `SHADOW`, or one a kill switch has withdrawn, is seen here exactly as a
   * live call would see it.
   */
  private async verifyMapped(
    tool: Tool,
    binding: ToolBinding,
    mapped: JsonValue,
    input: JsonObject,
  ): Promise<BindingTestVerificationView> {
    const resolved = await this.policies.resolveForTraffic(tool.id);
    const stored = resolved?.verificationPolicy ?? null;
    const policy = stored ?? schemaOnlyPolicy(tool);

    const verdict = verify({
      // No payment intent exists — a tester run is not a call anybody paid
      // for. The engine only carries this through onto the verdict.
      intentId: `test:${tool.id}`,
      policy,
      outputSchema: effectiveOutputSchema(versionOf(tool), binding),
      response: mapped,
      request: input,
      evaluatedAt: new Date(),
    });

    return {
      policySource: stored
        ? BindingTestPolicySource.STORED_POLICY
        : BindingTestPolicySource.TOOL_SCHEMA_ONLY,
      policyId: stored ? stored.id : null,
      policyVersion: stored ? stored.version : null,
      stages: verdict.stages,
      verdict: verdict.status,
    };
  }

  private async record(
    organizationId: string,
    subject: string,
    row: ToolBindingEntity,
    input: JsonObject,
    report: BindingTestReport,
    toolVersion: number,
  ): Promise<void> {
    const entity = new BindingTestRunEntity();
    entity.organizationId = organizationId;
    entity.bindingId = row.id;
    entity.mappingVersion = row.mappingVersion;
    entity.toolVersion = toolVersion;
    entity.authMode = row.authMode ?? null;
    entity.callId = report.callId;
    entity.outcome = report.outcome;
    entity.failedLayer = report.failedLayer;
    entity.sampleInput = input;
    entity.report = report;
    entity.ranBy = subject;

    await this.runs.save(entity);
    this.logger.log(
      `Tester run ${report.outcome} for binding ${row.id} revision ${row.mappingVersion}`,
    );
  }
}

/**
 * The contract version a tester run checks against: `requested` when it is a
 * servable version inside the binding's range, else the newest servable
 * version of the range's highest major that has one.
 */
export function testedVersion(tool: Tool, range: string, requested?: number): ToolContractVersion {
  const majors = bindingRange(range);
  const servable = contractVersionsOf(tool).filter(
    (version) => isServable(version) && majors.includes(version.major),
  );
  if (requested !== undefined) {
    const chosen = servable.find((version) => version.version === requested);
    if (!chosen) {
      throw ProviderErrors.bindingContractMismatch({
        problems: [`contract version ${requested} is not a published version in ${range}`],
      });
    }
    return chosen;
  }
  if (servable.length === 0) {
    throw ProviderErrors.bindingContractMismatch({
      problems: [`no published contract version in ${range} to test against`],
    });
  }
  return servable[0];
}

/**
 * Collects one result per layer and enforces the two rules the vocabulary
 * exists for: a layer after a failure is `NOT_REACHED`, and there is exactly
 * one way to say "passed".
 */
class LayerLog {
  private readonly results = new Map<BindingTestLayer, BindingTestLayerResult>();
  private failedLayer: BindingTestLayer | null = null;

  passed(layer: BindingTestLayer): void {
    this.results.set(layer, {
      layer,
      status: BindingTestLayerStatus.PASSED,
      code: null,
      detail: null,
      fault: null,
    });
  }

  fail(layer: BindingTestLayer, code: string, detail: string, fault: MappingFault | null): void {
    this.results.set(layer, { layer, status: BindingTestLayerStatus.FAILED, code, detail, fault });
    this.failedLayer ??= layer;
  }

  inconclusive(layer: BindingTestLayer, code: string, detail: string): void {
    this.results.set(layer, {
      layer,
      status: BindingTestLayerStatus.INCONCLUSIVE,
      code,
      detail,
      fault: null,
    });

    // Recorded as the layer that stopped the run being green, exactly like a
    // failure. `failed_layer` answers "where did this stop", not "whose fault
    // was it" — and `chk_binding_test_runs_failure_is_located` requires an
    // answer whenever the outcome is not `PASSED`.
    this.failedLayer ??= layer;
  }

  /** A thrown `AppError` from the mapping engine, unpacked into a layer result. */
  failed(layer: BindingTestLayer, error: unknown): void {
    const appError = error instanceof AppError ? error : null;
    if (!appError) throw error;

    // The message already carries the pointer — every mapping error factory
    // interpolates it — so it is not appended a second time.
    this.fail(layer, appError.errorCode, appError.message, mappingFaultOf(error));
  }

  report(
    callId: string,
    parts: {
      request?: BindingTestReport['request'];
      upstream?: BindingTestUpstreamView;
      classification?: Classification;
      mapped?: JsonValue;
      verification?: BindingTestVerificationView;
    },
  ): BindingTestReport {
    const layers = BINDING_TEST_LAYERS.map(
      (layer) =>
        this.results.get(layer) ?? {
          layer,
          status: BindingTestLayerStatus.NOT_REACHED,
          code: null,
          detail: 'Checks stop at the first failure.',
          fault: null,
        },
    );

    const green = layers.every((layer) => layer.status === BindingTestLayerStatus.PASSED);

    return {
      callId,
      outcome: green ? BindingTestOutcome.PASSED : BindingTestOutcome.FAILED,
      failedLayer: this.failedLayer,
      layers,
      request: parts.request ?? null,
      upstream: parts.upstream ?? null,
      classification: parts.classification ?? null,
      mapped: parts.mapped ?? null,
      verification: parts.verification ?? null,
      warnings: [],
    };
  }
}

/**
 * The stand-in policy for a tool with none registered.
 *
 * Schema and nothing else: no rules, and a threshold an empty rule set clears
 * (`decideScore` scores 1 when nothing applied). It is **not** presented as a
 * policy — `BindingTestPolicySource.TOOL_SCHEMA_ONLY` says so on the report —
 * because production would settle such a call unverified, which makes this run
 * stricter than production rather than equal to it. Stricter is the right
 * direction for a gate; pretending otherwise is not.
 */
function schemaOnlyPolicy(tool: Tool): VerificationPolicy {
  return {
    id: `tool-schema:${tool.id}`,
    toolId: tool.id,
    version: 0,
    rules: [],
    passThreshold: 1,
    mode: PolicyMode.ACTIVE,
  };
}

function toUpstreamView(response: ProviderResponse, latencyMs: number): BindingTestUpstreamView {
  const raw = rawBodyOf(response);

  return {
    status: response.status,
    latencyMs,
    rawBody: raw === null ? null : raw.slice(0, RAW_BODY_LIMIT),
    rawBodyTruncated: raw !== null && raw.length > RAW_BODY_LIMIT,
    contentType: response.headers?.['content-type'] ?? null,
    transportError: response.transportError
      ? { kind: response.transportError.kind, detail: response.transportError.detail ?? null }
      : null,
  };
}

/**
 * The bytes, as the provider would recognise them.
 *
 * A JSON body is re-serialised rather than carried as an object: the tester's
 * first panel is *the raw response*, and an object in that panel is already an
 * interpretation — it has lost key order, duplicate keys and whatever the
 * provider's serialiser actually emitted.
 */
function rawBodyOf(response: ProviderResponse): string | null {
  switch (response.body.kind) {
    case ResponseBodyKind.JSON:
      return JSON.stringify(response.body.value);
    case ResponseBodyKind.NON_JSON:
      // The bytes exactly as they arrived — an HTML error page is the single
      // most useful thing this panel ever shows a provider.
      return response.body.raw;
    default:
      return null;
  }
}

/**
 * Whether verification actually judged something: a stage that ran (schema,
 * semantic), or at least one deterministic rule that applied. The
 * deterministic stage reports `PASSED` with a score of 1 when no rule applied,
 * so its stage status alone does not say a check was evaluated.
 */
export function evaluatedAnyCheck(stages: readonly StageResult[]): boolean {
  return stages.some((stage) =>
    stage.stage === VerificationStage.DETERMINISTIC_RULES
      ? (stage.rules ?? []).some((rule) => rule.outcome !== RuleOutcome.NOT_APPLICABLE)
      : stageRan(stage.status),
  );
}

function firstFailingStageCode(stages: readonly StageResult[]): string | null {
  return stages.find((stage) => stage.code !== null)?.code ?? null;
}

function firstFailingStageDetail(stages: readonly StageResult[]): string | null {
  return stages.find((stage) => stage.detail !== null && stage.code !== null)?.detail ?? null;
}

/**
 * The header names of the request as it goes on the wire, lower-cased, in
 * `EgressBindingInvoker`'s order: defaults → mapping → `x-assay-call-id` →
 * signature. Stored credential headers are left out on purpose: the view
 * shows what the mapping and Assay add, never what the vault holds (a mapping
 * header that shares a stored header's name is still listed, as the mapping's).
 *
 * Mirrors the invoker's `outboundHeaders` and the signer's output names
 * (`content-digest` only with a body). The tester's own test reads the request
 * the fixture server received and checks every name listed here was sent.
 */
function wireHeaderNames(upstream: UpstreamRequest, signed: boolean): string[] {
  const hasBody = upstream.body !== undefined;
  const signature = signed
    ? [...(hasBody ? ['content-digest'] : []), 'signature-input', 'signature']
    : [];
  const names = ['accept', ...(hasBody ? ['content-type'] : [])];
  for (const name of Object.keys(upstream.headers)) {
    const lower = name.toLowerCase();
    // The invoker drops a mapping header in the platform's namespace, and the
    // signer overwrites one of its own names: each is listed once, in its place.
    if (isAssayHeaderName(lower) || signature.includes(lower) || names.includes(lower)) continue;
    names.push(lower);
  }
  names.push('x-assay-call-id', ...signature);
  return names;
}

/**
 * `binding.endpoint` + the mapped path and query.
 *
 * Duplicated from `EgressBindingInvoker`'s private `buildUrl` rather than
 * exported from it: this copy exists only to *show* a provider the URL, and
 * exporting the invoker's would make a display concern part of the call path's
 * contract. The two are asserted equal by the tester's own test, which reads
 * the URL the fixture server actually received.
 */
function buildUrl(endpoint: string, upstream: UpstreamRequest): string {
  const base = endpoint.replace(/\/+$/, '');
  const path = upstream.path ? `/${upstream.path.replace(/^\/+/, '')}` : '';
  const url = new URL(`${base}${path}`);

  for (const [name, value] of Object.entries(upstream.query)) {
    url.searchParams.set(name, value);
  }

  return url.href;
}
