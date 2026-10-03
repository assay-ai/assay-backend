import {
  DIRECTIVES,
  TRANSFORM_NAMES,
  inspectRequestMapping,
  inspectResponseMapping,
  normalizeMappingNode,
  validateRequestMapping,
  validateResponseMapping,
} from '@modules/tool/domain/mapping';
import { ToolErrorCode } from '@modules/tool/errors/tool.errors';
import { expectErrorCode } from '../helpers/expect-error-code';

/**
 * Static validation — what a provider hits when they press Save in the binding
 * editor.
 *
 * Everything here is a mistake that can be caught *without a provider
 * response*, and catching it at Save rather than on the first live call is the
 * entire justification for the function existing. A binding published with an
 * unknown transform name costs an agent a request and reads in our dashboard
 * as an outage.
 */
describe('validateRequestMapping / validateResponseMapping — Save-time rejections', () => {
  const REJECTIONS: readonly (readonly [string, unknown])[] = [
    ['a selector that does not start with $ or @', { $path: 'query' }],
    ['a selector with an unclosed bracket', { $path: '$.items[0' }],
    ['a selector with an empty member name', { $path: '$..name' }],
    ['a bracket that is neither an index, a quoted key nor *', { $path: '$.items[abc]' }],
    ['an unknown transform name', { $path: '$.q', $transform: ['upperCase'] }],
    ['an unknown $directive', { $path: '$.q', $lookup: 'table' }],
    ['a projection with no item mapping', { $from: '$.items[*]' }],
    [
      'a projection declaring both $item and sibling keys',
      {
        $from: '$.items[*]',
        $item: { url: '$.link' },
        title: '$.title',
      },
    ],
    ['$path that is not a string', { $path: 42 }],
    ['$from that is not a string', { $from: ['$.items[*]'], $item: { a: '$.b' } }],
    ['a transform step with no name', { $path: '$.q', $transform: [{ args: {} }] }],
    [
      'transform args that are not an object',
      { $path: '$.q', $transform: [{ name: 'trim', args: 'x' }] },
    ],
    ['$onNull outside its vocabulary', { $path: '$.q', $onNull: 'IGNORE' }],
    ['$onEmpty outside its vocabulary', { $from: '$.i[*]', $item: '$.x', $onEmpty: 'MAYBE' }],
    ['a directive node carrying none of $const, $path or $from', { $default: 1 }],
    ['$const combined with another directive', { $const: 'x', $transform: ['trim'] }],
    ['$optional that is not a boolean', { $path: '$.q', $optional: 'yes' }],
    // `DEFAULT` names a fallback that does not exist. Accepting it would leave
    // the engine to invent one, and a policy the author never wrote would
    // start deciding what the agent receives.
    ['$onNull: DEFAULT with no $default to fall back to', { $path: '$.q', $onNull: 'DEFAULT' }],
  ];

  it.each(REJECTIONS)('rejects %s', (_name: string, spec: unknown) => {
    expectErrorCode(() => validateResponseMapping(spec), ToolErrorCode.TOOL_MAPPING_INVALID);
  });

  /**
   * A wildcard reads many values and a scalar site holds one. Taking the first
   * match silently is the guess that makes a mapping right against the sample
   * response a provider tested with and wrong on the second page of results.
   */
  it('rejects [*] at a scalar site and directs the author to $from', () => {
    expectErrorCode(
      () => validateResponseMapping({ url: '$.items[*].link' }),
      ToolErrorCode.TOOL_MAPPING_INVALID,
    );
  });

  it('accepts [*] inside $from, which is where a collection belongs', () => {
    expect(() =>
      validateResponseMapping({ results: { $from: '$.items[*]', url: '$.link' } }),
    ).not.toThrow();
  });

  it('rejects a request mapping with a method the platform does not issue', () => {
    expectErrorCode(
      () => validateRequestMapping({ method: 'DELETE', path: '/v1/x' }),
      ToolErrorCode.TOOL_MAPPING_INVALID,
    );
  });

  it('rejects a nested object in query, which has no wire form', () => {
    expectErrorCode(
      () => validateRequestMapping({ method: 'GET', query: { filter: { min: '$.min' } } }),
      ToolErrorCode.TOOL_MAPPING_INVALID,
    );
  });

  it('validates selectors inside a {$.…} path template', () => {
    expectErrorCode(
      () => validateRequestMapping({ method: 'GET', path: '/v1/cities/{$.city[0}' }),
      ToolErrorCode.TOOL_MAPPING_INVALID,
    );
  });

  it('reports the offending node with a pointer, so the console can highlight it', () => {
    try {
      validateResponseMapping({ results: { $from: '$.items[*]', url: { $path: 'link' } } });
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as Error).message).toContain('Malformed selector');
    }
  });
});

describe('inspect* — the inventory a console renders', () => {
  it('lists every selector the mapping reads, so the tester can show a field list', () => {
    const { selectors } = inspectResponseMapping({
      query: '$.request.q',
      results: {
        $from: '$.data.items[*]',
        url: '$.link',
        publishedAt: { $path: '$.ts', $transform: ['epochSecondsToIso'] },
      },
    });

    expect(selectors).toEqual(['$.request.q', '$.data.items[*]', '$.link', '$.ts']);
  });

  it('lists the transforms in use, deduplicated', () => {
    const { transforms } = inspectResponseMapping({
      a: { $path: '$.a', $transform: ['trim', 'lowercase'] },
      b: { $path: '$.b', $transform: ['trim'] },
    });

    expect([...transforms].sort()).toEqual(['lowercase', 'trim']);
  });

  it('reaches selectors in a request path template, query and body alike', () => {
    const { selectors } = inspectRequestMapping({
      method: 'POST',
      path: '/v1/cities/{$.cityId}/weather',
      query: { units: '$.units' },
      body: { at: '$.timestamp' },
    });

    expect(selectors).toEqual(['$.cityId', '$.units', '$.timestamp']);
  });
});

describe('the format is closed, and closed is the point', () => {
  /**
   * A mapping is stored in a `jsonb` column and executed on every call. It is
   * safe to run only because it cannot contain code — a provider names a
   * transform that already shipped, and nothing else. If this list ever grows
   * an entry that evaluates an expression, that property is gone.
   */
  it('offers a fixed, named transform vocabulary', () => {
    expect(TRANSFORM_NAMES).toEqual([
      'coalesceEmptyToNull',
      'epochMillisToIso',
      'epochSecondsToIso',
      'first',
      'isoDate',
      'join',
      'jsonParse',
      'lowercase',
      'split',
      'toBoolean',
      'toInteger',
      'toNumber',
      'toString',
      'trim',
      'uppercase',
    ]);
  });

  it('reserves exactly the $-prefixed directives it documents', () => {
    expect([...DIRECTIVES]).toEqual([
      '$const',
      '$path',
      '$default',
      '$optional',
      '$onNull',
      '$transform',
      '$from',
      '$item',
      '$onEmpty',
    ]);
  });

  /**
   * The stored form must be unambiguous even though the typed form is not.
   * A provider writes `"en"`; what lands in the column says which of the two
   * readings was taken, so no later consumer has to re-derive it.
   */
  it('resolves the terse shorthand once, at normalisation, and stores the answer', () => {
    expect(normalizeMappingNode('$.query')).toEqual({ $path: '$.query' });
    expect(normalizeMappingNode('en')).toEqual({ $const: 'en' });
    expect(normalizeMappingNode({ $const: '$.not a path' })).toEqual({ $const: '$.not a path' });
    expect(normalizeMappingNode(10)).toEqual({ $const: 10 });
    expect(normalizeMappingNode(['a', 'b'])).toEqual({ $const: ['a', 'b'] });
  });

  it("rewrites the doc's sibling-key projection into the explicit $item form", () => {
    expect(normalizeMappingNode({ $from: '$.data.items[*]', url: '$.link', lang: 'en' })).toEqual({
      $from: '$.data.items[*]',
      $item: { url: { $path: '$.link' }, lang: { $const: 'en' } },
    });
  });

  /**
   * The canonical form is what the binding editor persists, so normalising it again must
   * change nothing. A format that is not idempotent under its own
   * normalisation cannot be round-tripped through an editor.
   */
  it('is idempotent: normalising canonical form returns it unchanged', () => {
    const raw = {
      query: '$.request.q',
      results: { $from: '$.items[*]', url: '$.link', tag: 'web' },
    };
    const once = normalizeMappingNode(raw);
    expect(normalizeMappingNode(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });
});
