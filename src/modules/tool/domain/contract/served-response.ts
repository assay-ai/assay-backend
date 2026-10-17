import { ToolErrors } from '../../errors/tool.errors';
import {
  JsonObject,
  JsonValue,
  MappingContext,
  MappingDirection,
  MappingFault,
  MappingNode,
  ResponseMappingSpec,
} from '../mapping/mapping.types';
import { isObjectNode, isPathNode } from '../mapping/normalize';
import { mapResponse } from '../mapping/response-mapper';
import { ToolBinding, ToolContractVersion } from '../../ports/tool.types';

/**
 * A provider's response mapped into the contract at one version, holding the
 * binding to every optional output it declares (design spec §7.5, "At call
 * time, a declared field that is missing counts as a DATA_FAIL").
 *
 * The core contract is checked exactly as before (`mapResponse`). A declared
 * optional field is then the provider's promise: its selector is read as
 * `$optional`, so an upstream that left it out does not look like our mapping
 * pointing at nothing (`PLATFORM`, fail over), and its absence — or a `null`
 * — is a `PROVIDER` fault: the payload broke the promise, the call is a
 * contract violation, and it is never failed over to someone else as if the
 * provider had been down.
 */
export function mapServedResponse(
  spec: ResponseMappingSpec,
  upstream: JsonValue,
  version: Pick<ToolContractVersion, 'outputSchema' | 'optionalOutputFields'>,
  binding: Pick<ToolBinding, 'providesOutputFields'>,
  context?: MappingContext,
): JsonValue {
  const declared = declaredOutputs(version, binding);
  const document = mapResponse(
    declared.length > 0 ? optionalised(spec, declared) : spec,
    upstream,
    {
      outputSchema: version.outputSchema,
      context,
    },
  );

  for (const field of declared) {
    const value = (document as JsonObject)[field];
    if (value === undefined || value === null) {
      throw ToolErrors.mappingRequiredFieldMissing({
        pointer: `/${field}`,
        field,
        detail: 'a declared optional output is missing from the response',
        direction: MappingDirection.RESPONSE,
        fault: MappingFault.PROVIDER,
        ...context,
      });
    }
  }
  return document;
}

/** The optional outputs of `version` that `binding` declares it returns. */
export function declaredOutputs(
  version: Pick<ToolContractVersion, 'optionalOutputFields'>,
  binding: Pick<ToolBinding, 'providesOutputFields'>,
): readonly string[] {
  return (binding.providesOutputFields ?? []).filter((field) =>
    version.optionalOutputFields.includes(field),
  );
}

/** The mapping with each declared field's top-level selector read as `$optional`. */
function optionalised(spec: ResponseMappingSpec, declared: readonly string[]): ResponseMappingSpec {
  if (!isObjectNode(spec as MappingNode)) return spec;
  const node = { ...(spec as Record<string, MappingNode>) };
  for (const field of declared) {
    const child = node[field];
    if (child !== undefined && isPathNode(child) && child.$optional !== true) {
      node[field] = { ...child, $optional: true };
    }
  }
  return node as ResponseMappingSpec;
}
