import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { ProviderConnectivityCheckRepository } from '@database/postgres/repositories/provider-connectivity-check.repository';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';

import {
  EGRESS_DNS_LOOKUP,
  EgressDnsLookup,
  EgressError,
  EgressFailureKind,
  EgressHttpClient,
  EgressPolicy,
  EgressTrust,
  UNTRUSTED_EGRESS_POLICY,
  isEgressError,
  resolveEgressTarget,
  withLimits,
} from '@shared/network/egress';

import { ConnectivityCheckResultDto, toConnectivityDto } from '../dto/provider-shared.dto';
import { ProviderErrors } from '../errors/provider.errors';
import { ConnectivityOutcome } from '../ports/provider-registration.types';
import { PROVIDER_EGRESS_IPS } from './egress-ips';

/**
 * Time and size budget for the probe itself.
 *
 * This is a console-driven, synchronous "click and wait" call (onboarding
 * step 3), not a queued job — so it has to answer fast enough for a human to
 * sit through, and it never needs more than a handful of response bytes to
 * prove a listener exists. `UNTRUSTED_EGRESS_POLICY`'s defaults (30s total, 5MB
 * cap) are sized for a worker job with retries behind it; this is neither.
 */
const CONNECTIVITY_PROBE_LIMITS = {
  headersTimeoutMs: 8_000,
  bodyTimeoutMs: 5_000,
  totalTimeoutMs: 10_000,
  maxResponseBytes: 64 * 1024,
} as const;

/**
 * The pre-flight policy: same address rules as every other provider-typed URL
 * (`UNTRUSTED_EGRESS_POLICY.trust`), but `https:` only.
 *
 * The egress client deliberately allows both `http:` and `https:` — that
 * decision belongs to the client, which has other callers (Kora, the
 * facilitator) with no such requirement. https-only is a *provider-endpoint*
 * rule, and the connectivity check is what makes it real, so it is narrowed
 * here rather than in the shared policy. `ProviderErrors.insecureEndpoint()`
 * does not and should not exist — the
 * refusal already has a code, `EGRESS_SCHEME_NOT_ALLOWED`, and duplicating the
 * catalog would just be a second name for the same fact.
 */
const HTTPS_ONLY_POLICY: EgressPolicy = Object.freeze({
  trust: EgressTrust.PUBLIC_ONLY,
  allowedProtocols: Object.freeze(['https:']),
  limits: UNTRUSTED_EGRESS_POLICY.limits,
});

/** Refusals that mean "the guard would not let a packet leave" — `BLOCKED`, not `UNREACHABLE`. */
function isGuardRefusal(kind: EgressFailureKind): boolean {
  return (
    kind === EgressFailureKind.SCHEME_NOT_ALLOWED || kind === EgressFailureKind.BLOCKED_ADDRESS
  );
}

interface ProbeOutcome {
  readonly outcome: ConnectivityOutcome;
  readonly statusCode: number | null;
  readonly latencyMs: number | null;
  readonly failureKind: string | null;
  readonly failureCode: string | null;
  readonly detail: string | null;
}

/**
 * Probe a provider's declared endpoint, and record what happened.
 *
 * ## Why the address check runs twice
 *
 * `resolveEgressTarget` is called once here, directly, under
 * {@link HTTPS_ONLY_POLICY}, purely to fail fast and *name the refusal* before
 * `EgressHttpClient` is asked to do anything — a plaintext endpoint or one that
 * resolves to a private address is refused as `BLOCKED` without a socket ever
 * opening. It is called again, independently, inside `EgressHttpClient.request`
 * when the probe proceeds. That is not a seam this class introduces: nothing
 * here resolves once and hands an address to the client — the client always
 * re-resolves and re-pins for itself, exactly as it does for every hop of every
 * other caller. See `resolve-target.ts`'s class comment for why a second
 * lookup, not a cached first one, is the only sound anti-rebinding shape.
 */
@Injectable()
export class ProviderConnectivityService {
  private readonly logger = new Logger(ProviderConnectivityService.name);

  constructor(
    private readonly providers: ProviderRepository,
    private readonly checks: ProviderConnectivityCheckRepository,
    private readonly http: EgressHttpClient,
    @Inject(PROVIDER_EGRESS_IPS) private readonly egressIpList: string[],
    // Unbound in production, exactly like `EgressHttpClient`'s own constructor
    // — see `EGRESS_DNS_LOOKUP`'s doc comment. Reused here rather than
    // reinvented so the pre-flight resolve in {@link probe} can be pointed at a
    // test-controlled zone the same way the dial itself already can.
    @Optional() @Inject(EGRESS_DNS_LOOKUP) private readonly dnsLookup?: EgressDnsLookup,
  ) {}

  /**
   * Probe `endpoint`, or the provider's own saved one when none is given.
   *
   * Resolves rather than throws on `UNREACHABLE` / `BLOCKED` — the failure
   * *is* the payload the console renders (the "Check we can reach it"
   * button). A row is written every time, whatever the outcome; see
   * `ProviderConnectivityCheckEntity`'s class comment for why that argument
   * needs a table rather than a return value.
   */
  async check(organizationId: string, endpoint?: string): Promise<ConnectivityCheckResultDto> {
    const target = endpoint ?? (await this.savedEndpoint(organizationId));
    const egressIps = this.egressIps();

    const probe = await this.probe(target);

    const row = await this.checks.save(
      this.checks.create({
        organizationId,
        endpoint: target,
        outcome: probe.outcome,
        statusCode: probe.statusCode,
        latencyMs: probe.latencyMs,
        failureKind: probe.failureKind,
        failureCode: probe.failureCode,
        detail: probe.detail,
        egressIps,
      }),
    );

    if (probe.outcome !== ConnectivityOutcome.REACHABLE) {
      this.logger.debug(`connectivity check ${probe.outcome} for ${target}: ${probe.detail ?? ''}`);
    }

    return toConnectivityDto(row);
  }

  /**
   * Run the check, and only persist `endpoint` onto the provider row when it
   * came back `REACHABLE`.
   *
   * "Reject dead endpoints on the spot" — a dead endpoint is
   * rejected immediately rather than accepted and discovered later, on a call
   * an agent paid for. So a `BLOCKED` or `UNREACHABLE` result throws
   * `connectivityCheckFailed` with the outcome and the reason attached, and the
   * provider row is left exactly as it was — including, on a re-declare, an
   * older endpoint that still works.
   */
  async declareEndpoint(
    organizationId: string,
    endpoint: string,
  ): Promise<ConnectivityCheckResultDto> {
    const result = await this.check(organizationId, endpoint);

    if (result.outcome !== ConnectivityOutcome.REACHABLE) {
      throw ProviderErrors.connectivityCheckFailed({
        endpoint,
        detail: `${result.outcome}${result.detail ? `: ${result.detail}` : ''}`,
      });
    }

    // `update` is the wrong primitive to trust here, and this line used to
    // trust it. It resolves an `UpdateResult` whether or not the criteria
    // matched anything — so for an organization with no `providers` row (one
    // that never ran registration, or whose row was deleted) the statement
    // matched zero rows, said nothing, and the controller still answered
    // `200 {saved: true}`. The probe genuinely succeeded, so nothing in the
    // response looked wrong: the provider was told their endpoint was stored
    // when it was not.
    //
    // So the row count is read, and `affected` is checked for *falsiness*, not
    // for `0`. TypeORM declares it `number | undefined`, but the runtime is
    // looser than the type: `pg` initialises `Result.rowCount` to `null` and
    // only overwrites it when its command-complete regex matches, so `null`
    // reaches here through a value TypeORM's own `.d.ts` says cannot occur.
    // A guard written against `=== 0` would read both `undefined` and that
    // `null` as success and brick endpoint saves — which a unit test
    // exercising only `0` would never catch.
    //
    // Anyone reaching for `repo.update({ organizationId }, …)` elsewhere in
    // this module faces the same trap: check what it matched, or use a read
    // that can say "no such row".
    const updated = await this.providers.update({ organizationId }, { endpoint });

    if (!updated.affected) {
      throw ProviderErrors.providerNotFound({ providerId: organizationId });
    }

    return result;
  }

  /** The allowlist to publish (the onboarding IP list). See `egress-ips.ts`. */
  egressIps(): string[] {
    return this.egressIpList;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private async savedEndpoint(organizationId: string): Promise<string> {
    const provider = await this.providers.findOneBy({ organizationId });
    if (!provider?.endpoint) {
      throw ProviderErrors.endpointNotDeclared();
    }
    return provider.endpoint;
  }

  /**
   * Resolve-then-dial. Never throws — every {@link EgressError} is folded into
   * a `ProbeOutcome`, which is the whole reason this method exists rather than
   * calling `this.http.request` directly from {@link check}.
   */
  private async probe(endpoint: string): Promise<ProbeOutcome> {
    try {
      await resolveEgressTarget(endpoint, HTTPS_ONLY_POLICY, this.dnsLookup);
    } catch (error) {
      if (!isEgressError(error)) throw error;
      return this.fromError(error, /* latencyMs */ null);
    }

    const startedAt = Date.now();
    try {
      const response = await this.http.request({
        url: endpoint,
        policy: withLimits(UNTRUSTED_EGRESS_POLICY, CONNECTIVITY_PROBE_LIMITS),
      });

      return {
        // Any answer is a pass — see `ConnectivityCheckResult`'s doc comment.
        // A 401 proves DNS, TLS and a listening process, which is all this
        // check claims; grading the provider's auth here would fail every
        // correctly-secured endpoint on the platform.
        outcome: ConnectivityOutcome.REACHABLE,
        statusCode: response.status,
        latencyMs: Date.now() - startedAt,
        failureKind: null,
        failureCode: null,
        detail: null,
      };
    } catch (error) {
      if (!isEgressError(error)) throw error;
      return this.fromError(error, Date.now() - startedAt);
    }
  }

  private fromError(error: EgressError, latencyMs: number | null): ProbeOutcome {
    return {
      outcome: isGuardRefusal(error.kind)
        ? ConnectivityOutcome.BLOCKED
        : ConnectivityOutcome.UNREACHABLE,
      statusCode: null,
      latencyMs,
      failureKind: error.kind,
      failureCode: error.code,
      detail: error.message,
    };
  }
}
