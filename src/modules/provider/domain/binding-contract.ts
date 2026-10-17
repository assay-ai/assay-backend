import {
  contractVersionsOf,
  currentContractVersion,
  effectiveOutputSchema,
  isServable,
} from '@modules/tool/domain/contract/contract-versions';
import {
  VersionRange,
  formatVersionRange,
  parseVersionRange,
} from '@modules/tool/domain/contract/version-range';
import { checkResponseAgainstSchema } from '@modules/tool/domain/mapping/contract-check';
import { MappingContext, ResponseMappingSpec } from '@modules/tool/domain/mapping/mapping.types';
import { Tool, ToolContractVersion } from '@modules/tool/ports/tool.types';

import { ProviderErrors } from '../errors/provider.errors';

/**
 * What a binding promises about the contract (design spec §7.2, §7.5): the
 * majors it serves and the optional fields it opts in to — checked at save
 * against every major it names.
 */
export interface BindingContractTerms {
  readonly toolVersionRange: string;
  readonly providesOutputFields: readonly string[];
  readonly supportsInputFields: readonly string[];
}

/** The range a new binding gets when it names none: the tool's current major. */
export function defaultBindingRange(tool: Tool): string {
  return `^${currentContractVersion(tool)?.major ?? 1}`;
}

/** The newest servable version of each major in `range`, ascending by major. */
export function versionsForRange(
  tool: Tool,
  range: VersionRange,
): Map<number, ToolContractVersion | null> {
  const versions = contractVersionsOf(tool);
  return new Map(
    [...range]
      .sort((a, b) => a - b)
      .map((major) => [
        major,
        versions.find((version) => version.major === major && isServable(version)) ?? null,
      ]),
  );
}

/**
 * The binding's terms against the contract, or a `PROVIDER_BINDING_CONTRACT_MISMATCH`
 * naming every problem; a response mapping that cannot satisfy a major's
 * core fields plus the declared optional outputs raises the mapping
 * engine's own `TOOL_MAPPING_*` error, as it always has.
 *
 * - every major in the range has a published, servable version;
 * - every declared output is an optional output of some version in range,
 *   and every declared input an optional input;
 * - every declared input is read by the request mapping (never dropped);
 * - the response mapping writes, per major, the core fields and the
 *   declared outputs that major defines.
 *
 * Returns the canonical range.
 */
export function assertBindingContract(
  tool: Tool,
  terms: BindingContractTerms,
  mappings: {
    readonly responseMapping: ResponseMappingSpec;
    readonly requestSelectors: readonly string[];
  },
  context?: MappingContext,
): string {
  const range = parseVersionRange(terms.toolVersionRange);
  if (!range) {
    throw ProviderErrors.bindingContractMismatch({
      problems: [`"${terms.toolVersionRange}" is not a version range (write ^1, or ^1 || ^2)`],
    });
  }

  const byMajor = versionsForRange(tool, range);
  const problems: string[] = [];
  for (const [major, version] of byMajor) {
    if (!version) problems.push(`contract v${major} has no published version to serve`);
  }
  const versions = [...byMajor.values()].filter(
    (version): version is ToolContractVersion => !!version,
  );

  for (const field of unique(terms.providesOutputFields)) {
    if (!versions.some((version) => version.optionalOutputFields.includes(field))) {
      problems.push(
        `"${field}" is not an optional output of the contract in ${formatVersionRange(range)}`,
      );
    }
  }
  for (const field of unique(terms.supportsInputFields)) {
    if (!versions.some((version) => version.optionalInputFields.includes(field))) {
      problems.push(
        `"${field}" is not an optional input of the contract in ${formatVersionRange(range)}`,
      );
    } else if (!readsInput(mappings.requestSelectors, field)) {
      problems.push(`the request mapping never reads "${field}", so it would be dropped`);
    }
  }
  if (problems.length > 0) throw ProviderErrors.bindingContractMismatch({ problems });

  for (const version of versions) {
    checkResponseAgainstSchema(
      mappings.responseMapping,
      effectiveOutputSchema(version, { providesOutputFields: terms.providesOutputFields }),
      context,
    );
  }
  return formatVersionRange(range);
}

/** Whether a request selector reads the top-level argument `field`. */
function readsInput(selectors: readonly string[], field: string): boolean {
  return selectors.some(
    (selector) =>
      selector === `$.${field}` ||
      selector.startsWith(`$.${field}.`) ||
      selector.startsWith(`$.${field}[`) ||
      selector.startsWith(`$['${field}']`) ||
      selector.startsWith(`$["${field}"]`),
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
