import { ToolErrors } from '../../errors/tool.errors';
import { isValidPath, parsePath } from './json-path';
import {
  MappingContext,
  MappingNode,
  ObjectNode,
  RequestMappingSpec,
  ResponseMappingSpec,
} from './mapping.types';
import {
  NormalizeError,
  isConstNode,
  isFromNode,
  isPathNode,
  normalizeRequestMapping,
  normalizeResponseMapping,
  normalizeTransformStep,
} from './normalize';
import { isKnownTransform } from './transforms';

/**
 * Static validation — everything that can be known about a mapping without
 * running it (consumed by the binding editor and the publish gate).
 *
 * This is the function a provider hits when they press Save. It has to reject
 * a malformed selector, an unknown transform and a projection with no item
 * mapping *there*, with a pointer at the offending node — because the
 * alternative is discovering it on the first real call, where the same mistake
 * costs an agent a request and shows up in a dashboard as our outage.
 *
 * Deliberately separate from execution, and deliberately unable to tell you
 * whether a mapping is *correct*. Only a real response can do that, which is
 * what the mapping tester is for. This function answers a narrower
 * question — is this spec well-formed — and answers it completely.
 */

/** A well-formed mapping, plus what a console needs to show about it. */
export interface MappingValidationResult<T> {
  readonly spec: T;
  /** Every selector the mapping reads, in document order. Powers the tester's field list. */
  readonly selectors: readonly string[];
  /** Every transform used, deduplicated. */
  readonly transforms: readonly string[];
}

/**
 * Validates and returns the canonical spec — the form the console persists.
 *
 * Throws `TOOL_MAPPING_INVALID` with a pointer at the offending node.
 */
export function validateRequestMapping(raw: unknown, context?: MappingContext): RequestMappingSpec {
  return inspectRequestMapping(raw, context).spec;
}

export function validateResponseMapping(
  raw: unknown,
  context?: MappingContext,
): ResponseMappingSpec {
  return inspectResponseMapping(raw, context).spec;
}

/**
 * The same validation, plus the inventory a console needs: every selector the
 * mapping reads and every transform it uses. The mapping tester renders
 * this as the field list a provider ticks through against a sample response.
 */
export function inspectRequestMapping(
  raw: unknown,
  context?: MappingContext,
): MappingValidationResult<RequestMappingSpec> {
  const spec = normalize(() => normalizeRequestMapping(raw), context);
  const found = new Finder(context);

  if (spec.path) {
    for (const selector of extractPathTemplateSelectors(spec.path)) {
      found.selector(selector, `/path`, { allowWildcard: false });
    }
  }

  visitFlat(spec.query, '/query', found);
  visitFlat(spec.headers, '/headers', found);
  if (spec.body) found.node(spec.body, '/body');

  return { spec, selectors: found.selectors, transforms: found.transforms };
}

export function inspectResponseMapping(
  raw: unknown,
  context?: MappingContext,
): MappingValidationResult<ResponseMappingSpec> {
  const spec = normalize(() => normalizeResponseMapping(raw), context);
  const found = new Finder(context);
  found.node(spec, '');
  return { spec, selectors: found.selectors, transforms: found.transforms };
}

/**
 * Normalisation failures are spec failures, so they arrive as
 * `TOOL_MAPPING_INVALID` like every other one. A provider pressing Save should
 * not receive two different error shapes depending on which half of the
 * pipeline caught their typo.
 */
function normalize<T>(run: () => T, context?: MappingContext): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof NormalizeError) {
      throw ToolErrors.mappingInvalid({
        detail: error.message,
        pointer: error.pointer || '/',
        ...context,
      });
    }
    throw error;
  }
}

function visitFlat(node: ObjectNode | undefined, pointer: string, found: Finder): void {
  if (!node) return;
  for (const [key, child] of Object.entries(node)) {
    found.node(child, `${pointer}/${key}`);
  }
}

/** Collects selectors and transforms while checking each one it passes. */
class Finder {
  readonly selectors: string[] = [];
  private readonly seenTransforms = new Set<string>();

  constructor(private readonly context?: MappingContext) {}

  get transforms(): readonly string[] {
    return [...this.seenTransforms];
  }

  node(node: MappingNode, pointer: string): void {
    if (isConstNode(node)) return;

    if (isPathNode(node)) {
      // A wildcard reads many values; a scalar site can hold one. Silently
      // taking the first match is the kind of guess that makes a mapping
      // right in the test fixture and wrong on the second page of results.
      this.selector(node.$path, pointer, { allowWildcard: false });
      for (const [index, step] of (node.$transform ?? []).entries()) {
        this.transform(step, `${pointer}/$transform/${index}`);
      }
      return;
    }

    if (isFromNode(node)) {
      this.selector(node.$from, pointer, { allowWildcard: true });
      this.node(node.$item, `${pointer}/$item`);
      return;
    }

    for (const [key, child] of Object.entries(node)) {
      this.node(child, `${pointer}/${key}`);
    }
  }

  selector(selector: string, pointer: string, options: { allowWildcard: boolean }): void {
    if (!isValidPath(selector)) {
      throw ToolErrors.mappingInvalid({
        detail: `Malformed selector "${selector}"`,
        pointer: pointer || '/',
        ...this.context,
      });
    }

    if (!options.allowWildcard && parsePath(selector).hasWildcard) {
      throw ToolErrors.mappingInvalid({
        detail: `Selector "${selector}" uses [*], which reads many values; use $from to project a collection`,
        pointer: pointer || '/',
        ...this.context,
      });
    }

    this.selectors.push(selector);
  }

  transform(step: unknown, pointer: string): void {
    const normalized = normalize(() => normalizeTransformStep(step, pointer), this.context);

    if (!isKnownTransform(normalized.name)) {
      throw ToolErrors.mappingInvalid({
        detail: `Unknown transform "${normalized.name}"`,
        pointer: pointer || '/',
        ...this.context,
      });
    }

    this.seenTransforms.add(normalized.name);
  }
}

const PATH_TEMPLATE = /\{(\$[^}]*)\}/g;

/** Pulls `{$.selector}` segments out of a path template. */
export function extractPathTemplateSelectors(template: string): readonly string[] {
  return [...template.matchAll(PATH_TEMPLATE)].map((match) => match[1]);
}
