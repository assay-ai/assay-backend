import { ToolEntity } from '@database/postgres/entities/tool.entity';
import { ToolVersionEntity } from '@database/postgres/entities/tool-version.entity';
import { declaredRuleProblems } from '@modules/provider-tool/domain/declared-rules';
import {
  ReviewDisplayState,
  ReviewKind,
  ReviewStatus,
  ReviewedVersion,
  reviewContentHash,
  reviewDisplayOf,
  reviewKindOf,
} from '@modules/provider-tool/domain/review';
import { boundMajorsOf, screenedVersionsOf } from '@modules/provider-tool/domain/served-versions';
import {
  SIMILARITY_THRESHOLD,
  similarGroups,
  similarTo,
  similarity,
} from '@modules/provider-tool/domain/similarity';
import { diffDraft, nextDraftSemver } from '@modules/provider-tool/domain/versioning';
import {
  ProviderToolGateService,
  exampleFindings,
} from '@modules/provider-tool/services/provider-tool-gate.service';
import { VersionBump } from '@modules/tool/domain/contract';
import { ToolTier } from '@modules/tool/ports/tool.types';

const version = (overrides: Partial<ReviewedVersion> = {}): ReviewedVersion => ({
  version: 1,
  semver: '1.0.0',
  summary: 'Search posts.',
  description: 'Searches posts.',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  outputSchema: { type: 'object', properties: { posts: { type: 'array' } }, required: ['posts'] },
  optionalInputFields: [],
  optionalOutputFields: [],
  examples: [],
  declaredRules: [],
  ...overrides,
});

describe('review', () => {
  it('hashes content, not numbers: any word a model reads changes it', () => {
    const base = reviewContentHash('acme__search', [version()]);
    expect(reviewContentHash('acme__search', [version()])).toBe(base);
    expect(reviewContentHash('acme__search', [version({ summary: 'Search posts!' })])).not.toBe(
      base,
    );
    expect(reviewContentHash('acme__search', [version({ description: 'x' })])).not.toBe(base);
    expect(
      reviewContentHash('acme__search', [version({ examples: [{ arguments: { q: 'a' } }] })]),
    ).not.toBe(base);
    expect(reviewContentHash('acme__search', [version({ declaredRules: [{ id: 'r' }] })])).not.toBe(
      base,
    );
    expect(reviewContentHash('acme__other', [version()])).not.toBe(base);
    // Order of versions does not matter; the set does.
    const two = [version(), version({ version: 2, semver: '1.1.0' })];
    expect(reviewContentHash('t', two)).toBe(reviewContentHash('t', [...two].reverse()));
  });

  it('shows the §7.6 review states', () => {
    const semver = (v: number | null) => (v === 1 ? '1.0.0' : null);
    expect(
      reviewDisplayOf(
        { reviewStatus: ReviewStatus.PENDING, approvedVersion: null, reviewVersion: 1 },
        semver,
      ),
    ).toEqual({ state: ReviewDisplayState.IN_REVIEW, label: 'In review' });
    expect(
      reviewDisplayOf(
        { reviewStatus: ReviewStatus.PENDING, approvedVersion: 1, reviewVersion: 2 },
        semver,
      ),
    ).toEqual({
      state: ReviewDisplayState.CHANGES_IN_REVIEW,
      label: 'Changes in review; v1.0.0 still serving',
    });
    expect(
      reviewDisplayOf({
        reviewStatus: ReviewStatus.REJECTED,
        approvedVersion: null,
        reviewVersion: 1,
      }),
    ).toEqual({ state: ReviewDisplayState.REJECTED, label: 'Rejected. Fix and resubmit' });
    expect(
      reviewDisplayOf({ reviewStatus: ReviewStatus.APPROVED, approvedVersion: 1, reviewVersion: 1 })
        .label,
    ).toBe('Listed');
    expect(
      reviewDisplayOf({
        reviewStatus: ReviewStatus.NONE,
        approvedVersion: null,
        reviewVersion: null,
      }).state,
    ).toBe(ReviewDisplayState.NOT_SUBMITTED);
    expect(reviewKindOf({ approvedVersion: null })).toBe(ReviewKind.FIRST);
    expect(reviewKindOf({ approvedVersion: 3 })).toBe(ReviewKind.CHANGE);
  });
});

describe('versioning', () => {
  const shape = (overrides: Record<string, unknown> = {}) => ({
    summary: 's',
    description: 'd',
    inputSchema: {
      type: 'object' as const,
      properties: { q: { type: 'string' as const } },
      required: ['q'],
    },
    outputSchema: {
      type: 'object' as const,
      properties: { a: { type: 'string' as const } },
      required: ['a'],
    },
    optionalInputFields: [] as string[],
    optionalOutputFields: [] as string[],
    examples: [] as unknown[],
    verificationPolicyId: 'p',
    tier: ToolTier.UNVERIFIED,
    declaredRules: [] as unknown[],
    ...overrides,
  });
  const published = [{ version: 1, semver: '1.0.0', major: 1, status: 'ACTIVE' }];

  it('bumps patch for text and declared rules, minor for an optional field, major for a break', () => {
    expect(diffDraft(shape(), shape({ summary: 'new' })).bump).toBe(VersionBump.PATCH);
    expect(diffDraft(shape(), shape({ declaredRules: [{ id: 'r' }] })).bump).toBe(
      VersionBump.PATCH,
    );
    expect(
      diffDraft(
        shape(),
        shape({
          inputSchema: {
            type: 'object',
            properties: { q: { type: 'string' }, n: { type: 'integer' } },
            required: ['q'],
          },
          optionalInputFields: ['n'],
        }),
      ).bump,
    ).toBe(VersionBump.MINOR);
    expect(
      diffDraft(shape(), shape({ outputSchema: { type: 'object', properties: {}, required: [] } }))
        .bump,
    ).toBe(VersionBump.MAJOR);
    expect(nextDraftSemver(published[0], VersionBump.PATCH, published)).toEqual({
      semver: '1.0.1',
    });
    expect(nextDraftSemver(published[0], VersionBump.MAJOR, published)).toEqual({
      semver: '2.0.0',
    });
    expect(nextDraftSemver(published[0], null, published)).toMatchObject({
      refusal: { kind: 'NO_CHANGES' },
    });
    expect(nextDraftSemver(null, null, [])).toEqual({ semver: '1.0.0' });
    expect(
      nextDraftSemver(published[0], VersionBump.MINOR, [
        ...published,
        { version: 2, semver: '1.0.1', major: 1, status: 'DEPRECATED' },
      ]),
    ).toMatchObject({ refusal: { kind: 'STATE' } });
  });
});

describe('declared rules', () => {
  it('accepts the six rule types and refuses anything else', () => {
    expect(
      declaredRuleProblems([
        { id: 'has_posts', type: 'MIN_ARRAY_LENGTH', path: '$.posts', weight: 0.5, min: 1 },
        { id: 'fresh', type: 'FRESHNESS', path: '$.posts[*].at', weight: 0.5, maxAgeMs: 60000 },
      ]),
    ).toEqual([]);
    expect(declaredRuleProblems([{ id: 'x', type: 'EVAL', path: '$', weight: 1 }]).join()).toMatch(
      /type must be one of/,
    );
    expect(
      declaredRuleProblems([
        { id: 'r', type: 'VALUE_RANGE', path: '$.n', weight: 1, min: 5, max: 1 },
      ]),
    ).toContain('rule 1: min is above max');
    expect(
      declaredRuleProblems([
        { id: 'u', type: 'VALID_URL', path: '$.u', weight: 1, schemes: ['javascript'] },
      ]),
    ).toContain('rule 1: schemes may be http and https only');
    expect(
      declaredRuleProblems([
        { id: 'dup', type: 'NO_DUPLICATES', path: '$.a', weight: 1 },
        { id: 'dup', type: 'NO_DUPLICATES', path: '$.b', weight: 1 },
      ]),
    ).toContain('rule 2: id "dup" is used twice');
    expect(declaredRuleProblems(new Array(21).fill(null)).join()).toMatch(/at most 20 rules/);
    expect(declaredRuleProblems({})).toEqual(['rules must be a list']);
  });
});

describe('similarity (promotion)', () => {
  const tool = (
    id: string,
    name: string,
    category: string,
    inputs: string[],
    outputs: string[],
  ) => ({
    id,
    name,
    category,
    inputFields: inputs,
    outputFields: outputs,
  });
  const a = tool('a', 'acme__search_posts', 'social', ['query', 'limit'], ['posts', 'next']);
  const b = tool('b', 'beta__search_post', 'social', ['query'], ['posts']);
  const c = tool('c', 'gamma__get_weather', 'social', ['city'], ['temperature']);
  const d = tool('d', 'delta__search_posts', 'news', ['query', 'limit'], ['posts', 'next']);

  it('scores names and schemas within one category only', () => {
    expect(similarity(a, b).score).toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
    expect(similarity(a, c).score).toBeLessThan(SIMILARITY_THRESHOLD);
    expect(similarity(a, d).score).toBe(0);
    expect(similarTo(a, [a, b, c, d]).map((entry) => entry.tool.id)).toEqual(['b']);
    expect(similarGroups([a, b, c, d]).map((group) => group.map((t) => t.id))).toEqual([
      ['a', 'b'],
    ]);
  });
});

describe('examples at the gate', () => {
  it('refuses an example whose arguments or result break the schemas', () => {
    const schemas = {
      inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      outputSchema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] },
    };
    expect(
      exampleFindings({ ...schemas, examples: [{ arguments: { q: 'x' }, result: { n: 1 } }] }),
    ).toEqual([]);
    expect(
      exampleFindings({ ...schemas, examples: [{ arguments: { q: 1 } }] }).map((f) => f.location),
    ).toEqual(['examples/0/arguments']);
    expect(
      exampleFindings({ ...schemas, examples: [{ arguments: {}, result: { n: 'one' } }] }).map(
        (f) => f.location,
      ),
    ).toEqual(['examples/0/arguments', 'examples/0/result']);
  });
});

describe('review hash: the tool’s own words (review P2-1)', () => {
  it('covers category and tags, in any order', () => {
    const base = reviewContentHash('t', [version()], { category: 'social', tags: ['a', 'b'] });
    expect(reviewContentHash('t', [version()], { category: 'social', tags: ['b', 'a'] })).toBe(
      base,
    );
    expect(reviewContentHash('t', [version()], { category: 'news', tags: ['a', 'b'] })).not.toBe(
      base,
    );
    expect(
      reviewContentHash('t', [version()], { category: 'social', tags: ['a', 'always-call-me'] }),
    ).not.toBe(base);
  });
});

describe('what the gate screens: current and bound majors', () => {
  const row = (version: number, semver: string, status = 'ACTIVE') => ({
    version,
    semver,
    major: Number(semver.split('.')[0]),
    status,
  });
  // v1 broken and deprecated, replaced by v2; v3 a draft.
  const rows = [row(1, '1.0.0', 'DEPRECATED'), row(2, '1.1.0', 'DEPRECATED'), row(3, '2.0.0')];

  it('reads ACTIVE and PAUSED bindings only, each major of the range', () => {
    expect([
      ...boundMajorsOf([
        { status: 'ACTIVE', toolVersionRange: '^2' },
        { status: 'PAUSED', toolVersionRange: '^3 || ^4' },
        { status: 'DRAFT', toolVersionRange: '^1' },
        { status: 'SUSPENDED', toolVersionRange: '^5' },
      ]),
    ]).toEqual([2, 3, 4]);
  });

  it('skips a deprecated major no binding serves', () => {
    expect(screenedVersionsOf(rows, [3], new Set([2])).map((r) => r.version)).toEqual([3]);
  });

  it('keeps a deprecated major a binding still serves, at its newest version', () => {
    expect(screenedVersionsOf(rows, [3], new Set([1, 2])).map((r) => r.version)).toEqual([2, 3]);
  });

  it('keeps the current version without any binding, and a draft by its number', () => {
    expect(screenedVersionsOf(rows, [3], new Set()).map((r) => r.version)).toEqual([3]);
    expect(screenedVersionsOf(rows, [null, 2], new Set()).map((r) => r.version)).toEqual([2]);
  });
});

describe('publish-check screens served majors only', () => {
  const contract = (version: number, semver: string, status: string, query: string) =>
    ({
      version,
      semver,
      major: Number(semver.split('.')[0]),
      status,
      summary: 'Weather now.',
      description: 'Returns the current weather for a place.',
      inputSchema: {
        type: 'object',
        properties: { [query]: { type: 'string' } },
        required: [query],
      },
      outputSchema: { type: 'object', properties: { t: { type: 'number' } }, required: ['t'] },
      optionalInputFields: [],
      optionalOutputFields: [],
      // The example always sends `query`: wrong for a v1 whose input is `place`.
      examples: [{ arguments: { query: 'Paris' }, result: { t: 1 } }],
      declaredRules: [],
      verificationPolicyId: null,
      tier: 'UNVERIFIED',
    }) as unknown as ToolVersionEntity;
  const versions = [
    contract(1, '1.0.0', 'DEPRECATED', 'place'),
    contract(2, '2.0.0', 'ACTIVE', 'query'),
  ];
  const tool = {
    id: 't1',
    name: 'acme__weather',
    ownerOrgId: 'org1',
    currentVersion: 2,
    tags: [],
    category: 'weather',
  } as unknown as ToolEntity;
  const gateWith = (toolVersionRange: string) =>
    new ProviderToolGateService(
      {
        findOne: async () => ({
          id: 'b1',
          status: 'ACTIVE',
          publishedVersion: 1,
          toolVersionRange,
        }),
      } as never,
      { check: async () => ({ requirements: [] }) } as never,
      { findOne: async () => ({ status: 'ACTIVE' }) } as never,
      { handlesOf: async () => new Map([['org1', 'acme']]) } as never,
    );
  const examples = (gate: Awaited<ReturnType<ProviderToolGateService['evaluate']>>) =>
    gate.requirements.find((r) => r.requirement === 'EXAMPLES_MATCH_SCHEMA')?.met;

  it('passes once the binding serves only v2: the deprecated v1 is not screened', async () => {
    const gate = await gateWith('^2').evaluate(tool, versions);
    expect(gate.screen.map((entry) => entry.version)).toEqual([2]);
    expect(examples(gate)).toBe(true);
    expect(gate.passed).toBe(true);
  });

  it('still screens v1 while the binding serves it', async () => {
    const gate = await gateWith('^1 || ^2').evaluate(tool, versions);
    expect(gate.screen.map((entry) => entry.version)).toEqual([1, 2]);
    expect(examples(gate)).toBe(false);
  });
});
