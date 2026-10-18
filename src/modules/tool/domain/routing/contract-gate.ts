import {
  ContractRequest,
  bindingServesVersion,
  hasOutputField,
  usedOptionalInputs,
} from '../contract/contract-versions';
import { bindingRange } from '../contract/version-range';
import { ToolContractVersion } from '../../ports/tool.types';
import { RoutingCandidate } from './routing.types';
import { RuleRejection, RuleRejectionReason, RuleSource } from './rules';

/**
 * The contract's hard constraints (design spec §7.3, §7.5), applied before
 * the buyer's provider rules:
 *
 * ```text
 * CONTRACT_VERSION_MISMATCH   MIGRATION  the binding's range does not cover the version
 * UNSUPPORTED_INPUT_FIELD     REQUEST    an optional input the arguments use, not supported
 * MISSING_OUTPUT_FIELD        TOOLSET    an output the entry requires, not declared
 * ```
 *
 * Hard: FALLBACK_BEST drops the toolset entry's *preferences* and never these,
 * so a fallback can never serve a version the call may not use, drop an input
 * the agent sent, or return a document without a field the entry requires.
 *
 * Like every rule rejection, none of these is a provider-quality event: no
 * circuit breaker, no `ProviderStats`, no strike, nothing on the provider's
 * console as a routing rejection. The router reports them only in the
 * refusal it returns.
 */
export function applyContractGate(
  candidates: readonly RoutingCandidate[],
  version: ToolContractVersion,
  request: ContractRequest,
): { readonly kept: readonly RoutingCandidate[]; readonly rejected: readonly RuleRejection[] } {
  const usedInputs = usedOptionalInputs(version, request.argumentNames);
  const kept: RoutingCandidate[] = [];
  const rejected: RuleRejection[] = [];

  for (const candidate of candidates) {
    const verdict = evaluateContract(candidate, version, request, usedInputs);
    if (verdict) rejected.push({ candidate, ...verdict });
    else kept.push(candidate);
  }
  return { kept, rejected };
}

function evaluateContract(
  candidate: RoutingCandidate,
  version: ToolContractVersion,
  request: ContractRequest,
  usedInputs: readonly string[],
): Omit<RuleRejection, 'candidate'> | null {
  const { binding } = candidate;

  if (!bindingServesVersion(binding, version)) {
    return {
      reason: RuleRejectionReason.CONTRACT_VERSION_MISMATCH,
      source: RuleSource.MIGRATION,
      detail:
        `binding ${binding.id} serves ${binding.toolVersionRange ?? '^1'}, ` +
        `not contract v${version.semver}`,
      servedMajors: bindingRange(binding.toolVersionRange),
      requestedMajor: version.major,
      requestedRange: request.range ? [...request.range] : null,
    };
  }

  const supported = binding.supportsInputFields ?? [];
  const unsupported = usedInputs.filter((field) => !supported.includes(field));
  if (unsupported.length > 0) {
    return {
      reason: RuleRejectionReason.UNSUPPORTED_INPUT_FIELD,
      source: RuleSource.REQUEST,
      detail: `binding ${binding.id} does not support ${unsupported.join(', ')}`,
      fields: unsupported,
    };
  }

  const provided = binding.providesOutputFields ?? [];
  const missing = request.requireOutputFields.filter(
    (field) =>
      !hasOutputField(version, field) ||
      (version.optionalOutputFields.includes(field) && !provided.includes(field)),
  );
  if (missing.length > 0) {
    return {
      reason: RuleRejectionReason.MISSING_OUTPUT_FIELD,
      source: RuleSource.TOOLSET,
      detail: `binding ${binding.id} does not return ${missing.join(', ')}`,
      fields: missing,
    };
  }

  return null;
}
