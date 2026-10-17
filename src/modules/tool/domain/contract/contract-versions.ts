import { JsonSchema } from '../mapping/schema-validator';
import {
  Tool,
  ToolBinding,
  ToolContractVersion,
  ToolStatus,
  ToolVersionStatus,
} from '../../ports/tool.types';
import { compareSemverText } from './semver';
import { VersionRange, bindingRange, rangeCovers } from './version-range';

/**
 * A tool's contract versions, as routing and the catalogue read them (design
 * spec §7.3 "Contract version", §7.5). Pure.
 */

/** `tool_versions.summary`'s cap: the only text `tools/list` sends (§7.4). */
export const SUMMARY_MAX_LENGTH = 200;

/** A deprecated version runs at least this long before it retires (§7.5). */
export const MIN_SUNSET_DAYS = 90;
export const MIN_SUNSET_MS = MIN_SUNSET_DAYS * 24 * 60 * 60 * 1000;

/** What a call asks of the contract, beside the provider rules. */
export interface ContractRequest {
  /**
   * The majors this call may use: the toolset entry's `tool_version_range`
   * intersected with a `?tools=name@N` pin. `null` on a URL with neither:
   * the default major (`tools.current_version`'s), falling back to lower
   * majors that still have an eligible binding.
   */
  readonly range: VersionRange | null;
  /** The entry's `require_output_fields`: only bindings that return them. */
  readonly requireOutputFields: readonly string[];
  /**
   * The call's argument names, when there is a call. The optional inputs
   * among them route only to bindings that support them; a listing has none.
   */
  readonly argumentNames?: readonly string[];
  /**
   * One exact version (`tool_versions.version`), set by the call path from
   * its quote so the route serves the contract the arguments were checked
   * against and the hold was priced from. Still bounded by `range`.
   */
  readonly version?: number;
}

export const NO_CONTRACT_REQUEST: ContractRequest = Object.freeze({
  range: null,
  requireOutputFields: [],
});

/** Statuses a call can be served at. */
export function isServable(version: Pick<ToolContractVersion, 'status'>): boolean {
  return (
    version.status === ToolVersionStatus.ACTIVE || version.status === ToolVersionStatus.DEPRECATED
  );
}

/** `description` cut to a summary: the first sentence that fits, else a hard cut. */
export function summaryOf(description: string): string {
  const text = description.replace(/\s+/g, ' ').trim();
  if (text.length <= SUMMARY_MAX_LENGTH) return text;
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [];
  let summary = '';
  for (const sentence of sentences) {
    if ((summary + sentence).trim().length > SUMMARY_MAX_LENGTH) break;
    summary += sentence;
  }
  summary = summary.trim();
  return summary.length > 0 ? summary : `${text.slice(0, SUMMARY_MAX_LENGTH - 1).trimEnd()}…`;
}

/** The one version a tool built without versions has: its own fields, 1.0.0. */
export function implicitVersion(tool: Tool): ToolContractVersion {
  return {
    version: 1,
    semver: '1.0.0',
    major: 1,
    summary: summaryOf(tool.description),
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    optionalInputFields: [],
    optionalOutputFields: [],
    examples: [],
    verificationPolicyId: tool.verificationPolicyId,
    tier: tool.tier,
    status: ToolVersionStatus.ACTIVE,
    sunsetAt: null,
    changelog: null,
    publishedAt: null,
  };
}

/** Every published version of `tool`, newest first. */
export function contractVersionsOf(tool: Tool): readonly ToolContractVersion[] {
  const versions =
    tool.versions && tool.versions.length > 0 ? tool.versions : [implicitVersion(tool)];
  return [...versions].sort((a, b) => compareSemverText(b.semver, a.semver));
}

/**
 * The version unpinned URLs default to: `tools.current_version`, or the
 * newest servable version when none is set.
 */
export function currentContractVersion(tool: Tool): ToolContractVersion | null {
  const versions = contractVersionsOf(tool);
  if (tool.currentVersion != null) {
    const current = versions.find((version) => version.version === tool.currentVersion);
    if (current) return current;
  }
  return versions.find(isServable) ?? versions[0] ?? null;
}

/** `tool` with every contract field taken from `version`. */
export function toolAtVersion(tool: Tool, version: ToolContractVersion): Tool {
  return {
    ...tool,
    description: version.description,
    inputSchema: version.inputSchema,
    outputSchema: version.outputSchema,
    verificationPolicyId: version.verificationPolicyId,
    tier: version.tier,
    version,
  };
}

/** The version of `tool` these fields come from (its own, or 1.0.0). */
export function versionOf(tool: Tool): ToolContractVersion {
  return tool.version ?? currentContractVersion(tool) ?? implicitVersion(tool);
}

/** Why no version can serve a call. */
export enum ContractRefusal {
  /** Every version the call may use is RETIRED (or the tool is). */
  RETIRED = 'RETIRED',
  /** No version the call may use exists at all. */
  NO_VERSION = 'NO_VERSION',
}

/**
 * The versions a call may be served at, most preferred first (§7.3):
 *
 * - an exact `version` (the call path's pin from its quote), if it is still
 *   servable and inside the range;
 * - a `range`: its servable versions, newest first;
 * - no range: the current major, at or below `tools.current_version` (a newer
 *   minor or major moves unpinned URLs only when `current_version` moves), then
 *   every lower major that is not retired, newest first.
 */
export function candidateVersions(
  tool: Tool,
  request: ContractRequest,
): { readonly versions: readonly ToolContractVersion[]; readonly refusal: ContractRefusal | null } {
  if (tool.status === ToolStatus.RETIRED) {
    return { versions: [], refusal: ContractRefusal.RETIRED };
  }
  const all = contractVersionsOf(tool);
  const inRange = request.range
    ? all.filter((version) => rangeCovers(request.range as VersionRange, version.major))
    : all;

  let versions: ToolContractVersion[];
  if (request.version !== undefined) {
    versions = inRange.filter(
      (version) => version.version === request.version && isServable(version),
    );
  } else if (request.range) {
    versions = inRange.filter(isServable);
  } else {
    const current = currentContractVersion(tool);
    versions = current
      ? all.filter(
          (version) =>
            isServable(version) &&
            (version.major < current.major ||
              (version.major === current.major &&
                compareSemverText(version.semver, current.semver) <= 0)),
        )
      : [];
  }

  if (versions.length > 0) return { versions: fittingArguments(versions, request), refusal: null };
  return {
    versions,
    refusal: inRange.length > 0 ? ContractRefusal.RETIRED : ContractRefusal.NO_VERSION,
  };
}

/**
 * The candidate versions that define every argument the call uses that any of
 * them defines: an input a newer minor added is never served by an older
 * version that would ignore it (§7.5, "never dropped silently"). An argument
 * no candidate defines is left to the schema check, as before versions.
 */
function fittingArguments(
  versions: readonly ToolContractVersion[],
  request: ContractRequest,
): readonly ToolContractVersion[] {
  const names = request.argumentNames ?? [];
  if (names.length === 0 || versions.length < 2) return versions;
  const defines = (version: ToolContractVersion, name: string) =>
    Object.prototype.hasOwnProperty.call(version.inputSchema.properties ?? {}, name);
  const known = names.filter((name) => versions.some((version) => defines(version, name)));
  const fitting = versions.filter((version) => known.every((name) => defines(version, name)));
  return fitting.length > 0 ? fitting : [versions[0]];
}

/**
 * The output schema one binding is held to at `version`: the contract's, with
 * every optional field the binding declares made required. A declared field
 * that comes back missing is then the same provider contract violation as a
 * missing core field (§7.5 "At call time, a declared field that is missing
 * counts as a DATA_FAIL").
 */
export function effectiveOutputSchema(
  version: Pick<ToolContractVersion, 'outputSchema' | 'optionalOutputFields'>,
  binding: Pick<ToolBinding, 'providesOutputFields'>,
): JsonSchema {
  const declared = (binding.providesOutputFields ?? []).filter((field) =>
    version.optionalOutputFields.includes(field),
  );
  if (declared.length === 0) return version.outputSchema;
  const required = [...new Set([...(version.outputSchema.required ?? []), ...declared])];
  return { ...version.outputSchema, required };
}

/** The optional inputs of `version` among a call's argument names. */
export function usedOptionalInputs(
  version: Pick<ToolContractVersion, 'optionalInputFields'>,
  argumentNames: readonly string[] | undefined,
): readonly string[] {
  if (!argumentNames || argumentNames.length === 0) return [];
  return version.optionalInputFields.filter((field) => argumentNames.includes(field));
}

/** Whether `field` is an output this version can return at all (core or optional). */
export function hasOutputField(
  version: Pick<ToolContractVersion, 'outputSchema'>,
  field: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(version.outputSchema.properties ?? {}, field);
}

/** Whether `binding`'s range covers `version`'s major. */
export function bindingServesVersion(
  binding: Pick<ToolBinding, 'toolVersionRange'>,
  version: Pick<ToolContractVersion, 'major'>,
): boolean {
  return rangeCovers(bindingRange(binding.toolVersionRange), version.major);
}

/** The deprecation `_meta["assay/deprecated"]` value of a version, or `null`. */
export function deprecationOf(
  version: Pick<ToolContractVersion, 'status' | 'sunsetAt'>,
  replacement: string | null,
): { readonly sunsetAt: string; readonly replacement: string | null } | null {
  if (version.status !== ToolVersionStatus.DEPRECATED || !version.sunsetAt) return null;
  return { sunsetAt: version.sunsetAt.toISOString(), replacement };
}

/**
 * What replaces `tool` at `version`: the replacement tool when one is named,
 * else the current version when it is newer, else `null`.
 */
export function replacementOf(
  tool: Tool,
  version: Pick<ToolContractVersion, 'major'>,
): string | null {
  if (tool.replacementToolName) return tool.replacementToolName;
  const current = currentContractVersion(tool);
  if (current && current.major !== version.major && isServable(current)) {
    return `${tool.name}@${current.major} (v${current.semver})`;
  }
  const newer = contractVersionsOf(tool).find(
    (candidate) => candidate.major > version.major && isServable(candidate),
  );
  return newer ? `${tool.name}@${newer.major} (v${newer.semver})` : null;
}
