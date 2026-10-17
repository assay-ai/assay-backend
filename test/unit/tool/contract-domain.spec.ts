import {
  ContractChangeKind,
  ContractRefusal,
  ContractShape,
  VersionBump,
  bumpSemver,
  candidateVersions,
  compareSemverText,
  contractProblems,
  currentContractVersion,
  deprecationOf,
  diffContracts,
  effectiveOutputSchema,
  formatVersionRange,
  intersectRanges,
  mapServedResponse,
  parseSemver,
  parseVersionRange,
  replacementOf,
  summaryOf,
  usedOptionalInputs,
} from '@modules/tool/domain/contract';
import { ToolErrorCode } from '@modules/tool/errors/tool.errors';
import {
  Tool,
  ToolContractVersion,
  ToolStatus,
  ToolTier,
  ToolVersionStatus,
} from '@modules/tool/ports/tool.types';

const SHAPE: ContractShape = {
  summary: 'Current temperature at a point.',
  description: 'Current temperature at a latitude and longitude.',
  inputSchema: {
    type: 'object',
    properties: { latitude: { type: 'number' }, longitude: { type: 'number' } },
    required: ['latitude', 'longitude'],
  },
  outputSchema: {
    type: 'object',
    properties: { temperatureC: { type: 'number', description: 'Celsius' } },
    required: ['temperatureC'],
  },
  optionalInputFields: [],
  optionalOutputFields: [],
  examples: [],
  verificationPolicyId: 'policy-default',
  tier: 'VERIFIED',
};

function withOutput(
  properties: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): ContractShape {
  return {
    ...SHAPE,
    outputSchema: { type: 'object', properties: properties as never, required },
    optionalOutputFields: optional,
  };
}

describe('semver and ranges', () => {
  it('parses, compares and bumps three-part versions only', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver('1.2')).toBeNull();
    expect(parseSemver('01.2.3')).toBeNull();
    expect(parseSemver('1.2.3-rc1')).toBeNull();
    expect(compareSemverText('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(bumpSemver({ major: 1, minor: 2, patch: 3 }, VersionBump.PATCH)).toEqual({
      major: 1,
      minor: 2,
      patch: 4,
    });
    expect(bumpSemver({ major: 1, minor: 2, patch: 3 }, VersionBump.MINOR)).toEqual({
      major: 1,
      minor: 3,
      patch: 0,
    });
    expect(bumpSemver({ major: 1, minor: 2, patch: 3 }, VersionBump.MAJOR)).toEqual({
      major: 2,
      minor: 0,
      patch: 0,
    });
    expect(bumpSemver(null, VersionBump.MAJOR)).toEqual({ major: 1, minor: 0, patch: 0 });
  });

  it('reads a range as a set of majors and refuses anything else', () => {
    expect(parseVersionRange('^1')).toEqual([1]);
    expect(parseVersionRange('^2 || ^1')).toEqual([1, 2]);
    expect(parseVersionRange('^2||^1')).toEqual([1, 2]);
    expect(parseVersionRange('^0')).toBeNull();
    expect(parseVersionRange('>=1')).toBeNull();
    expect(parseVersionRange('^1.2')).toBeNull();
    expect(parseVersionRange(null)).toBeNull();
    expect(formatVersionRange([2, 1, 2])).toBe('^1 || ^2');
    expect(intersectRanges([1, 2], [2, 3])).toEqual([2]);
    expect(intersectRanges(null, [2])).toEqual([2]);
    expect(intersectRanges([1], null)).toEqual([1]);
  });
});

describe('diff and bump rules (§7.5)', () => {
  it('no change is no bump', () => {
    expect(diffContracts(SHAPE, SHAPE)).toEqual({ bump: null, changes: [] });
  });

  it('summary, description, examples and annotations only: PATCH', () => {
    const after: ContractShape = {
      ...SHAPE,
      summary: 'Temperature now.',
      description: 'Updated text.',
      examples: [{ arguments: { latitude: 1, longitude: 2 } }],
      outputSchema: {
        type: 'object',
        properties: { temperatureC: { type: 'number', description: 'Degrees Celsius' } },
        required: ['temperatureC'],
      },
    };
    const diff = diffContracts(SHAPE, after);
    expect(diff.bump).toBe(VersionBump.PATCH);
    expect(diff.changes.every((change) => change.kind === ContractChangeKind.DOCS_CHANGED)).toBe(
      true,
    );
  });

  it('a field named "title" is a field, not an annotation', () => {
    const before = withOutput({ title: { type: 'string' } }, ['title']);
    const after = withOutput({ title: { type: 'number' } }, ['title']);
    expect(diffContracts(before, after).bump).toBe(VersionBump.MAJOR);
  });

  it('adding an optional input or output field: MINOR', () => {
    const output = withOutput(
      { temperatureC: { type: 'number', description: 'Celsius' }, uvIndex: { type: 'number' } },
      ['temperatureC'],
      ['uvIndex'],
    );
    expect(diffContracts(SHAPE, output)).toMatchObject({
      bump: VersionBump.MINOR,
      changes: [
        { kind: ContractChangeKind.FIELD_ADDED_OPTIONAL, side: 'output', field: 'uvIndex' },
      ],
    });

    const input: ContractShape = {
      ...SHAPE,
      inputSchema: {
        ...SHAPE.inputSchema,
        properties: { ...SHAPE.inputSchema.properties, units: { type: 'string' } },
      },
      optionalInputFields: ['units'],
    };
    expect(diffContracts(SHAPE, input).bump).toBe(VersionBump.MINOR);
  });

  it('a verification policy or tier change is MINOR, never a silent patch', () => {
    expect(diffContracts(SHAPE, { ...SHAPE, tier: 'GUARANTEED' }).bump).toBe(VersionBump.MINOR);
  });

  it('promoting, demoting, removing, renaming, adding core, changing a type: MAJOR', () => {
    const optional = withOutput(
      { temperatureC: { type: 'number' }, uvIndex: { type: 'number' } },
      ['temperatureC'],
      ['uvIndex'],
    );
    const promoted = withOutput({ temperatureC: { type: 'number' }, uvIndex: { type: 'number' } }, [
      'temperatureC',
      'uvIndex',
    ]);
    expect(diffContracts(optional, promoted)).toMatchObject({ bump: VersionBump.MAJOR });
    expect(diffContracts(optional, promoted).changes.map((c) => c.kind)).toContain(
      ContractChangeKind.FIELD_PROMOTED,
    );
    expect(diffContracts(promoted, optional).changes.map((c) => c.kind)).toContain(
      ContractChangeKind.FIELD_DEMOTED,
    );

    const removed = withOutput({}, []);
    expect(diffContracts(SHAPE, removed).changes[0]).toMatchObject({
      kind: ContractChangeKind.FIELD_REMOVED,
      bump: VersionBump.MAJOR,
    });

    const renamed = withOutput({ tempC: { type: 'number' } }, ['tempC']);
    expect(
      diffContracts(SHAPE, renamed)
        .changes.map((c) => c.kind)
        .sort(),
    ).toEqual([ContractChangeKind.FIELD_ADDED_CORE, ContractChangeKind.FIELD_REMOVED].sort());

    const retyped = withOutput({ temperatureC: { type: 'string' } }, ['temperatureC']);
    expect(diffContracts(SHAPE, retyped).changes).toEqual([
      expect.objectContaining({ kind: ContractChangeKind.TYPE_CHANGED, bump: VersionBump.MAJOR }),
    ]);

    const coreAdded = withOutput(
      { temperatureC: { type: 'number', description: 'Celsius' }, feelsLike: { type: 'number' } },
      ['temperatureC'],
    );
    expect(diffContracts(SHAPE, coreAdded).bump).toBe(VersionBump.MAJOR);

    const strict: ContractShape = {
      ...SHAPE,
      outputSchema: { ...SHAPE.outputSchema, additionalProperties: false },
    };
    expect(diffContracts(SHAPE, strict).changes[0].kind).toBe(ContractChangeKind.SCHEMA_CHANGED);
  });

  it('the bump is the largest change', () => {
    const after = { ...withOutput({}, []), summary: 'other' };
    expect(diffContracts(SHAPE, after).bump).toBe(VersionBump.MAJOR);
  });
});

describe('contract shape checks', () => {
  it('accepts a valid contract', () => {
    expect(contractProblems(SHAPE)).toEqual([]);
  });

  it('refuses what cannot be a contract', () => {
    const problems = contractProblems({
      ...SHAPE,
      summary: `${'x'.repeat(201)}`,
      description: '',
      outputSchema: { type: 'object', properties: { a: { type: 'number' } }, required: ['a', 'b'] },
      optionalOutputFields: ['a', 'missing'],
      examples: [{}, 'nope'],
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        'summary is longer than 200 characters',
        'description is empty',
        'output schema requires "b", which it does not define',
        'optional output field "a" cannot also be required',
        'optional output field "missing" is not in the output schema',
        'example 1 has no arguments object',
        'example 2 is not an object',
      ]),
    );
    expect(contractProblems({ ...SHAPE, summary: 'two\nlines' })).toContain(
      'summary must be one line of plain text',
    );
  });
});

function v(overrides: Partial<ToolContractVersion>): ToolContractVersion {
  return {
    version: 1,
    semver: '1.0.0',
    major: 1,
    summary: SHAPE.summary,
    description: SHAPE.description,
    inputSchema: SHAPE.inputSchema,
    outputSchema: SHAPE.outputSchema,
    optionalInputFields: [],
    optionalOutputFields: [],
    examples: [],
    verificationPolicyId: 'policy-default',
    tier: ToolTier.VERIFIED,
    status: ToolVersionStatus.ACTIVE,
    sunsetAt: null,
    changelog: null,
    publishedAt: null,
    ...overrides,
  };
}

function tool(versions: ToolContractVersion[], currentVersion: number | null): Tool {
  return {
    id: 't',
    name: 'get_weather',
    description: SHAPE.description,
    inputSchema: SHAPE.inputSchema,
    outputSchema: SHAPE.outputSchema,
    verificationPolicyId: 'policy-default',
    tier: ToolTier.VERIFIED,
    versions,
    currentVersion,
  };
}

describe('candidate versions (§7.3)', () => {
  const sunset = new Date('2027-02-01T00:00:00Z');
  const v100 = v({});
  const v110 = v({ version: 2, semver: '1.1.0' });
  const v200 = v({ version: 3, semver: '2.0.0', major: 2 });
  const deprecated = { ...v100, status: ToolVersionStatus.DEPRECATED, sunsetAt: sunset };

  it('unpinned: the current major at or below current_version, then lower majors', () => {
    const result = candidateVersions(tool([v200, v110, v100], 2), {
      range: null,
      requireOutputFields: [],
    });
    expect(result.versions.map((x) => x.semver)).toEqual(['1.1.0', '1.0.0']);

    const moved = candidateVersions(tool([v200, v110, v100], 3), {
      range: null,
      requireOutputFields: [],
    });
    expect(moved.versions.map((x) => x.semver)).toEqual(['2.0.0', '1.1.0', '1.0.0']);
  });

  it('a range: its servable versions only, newest first; DEPRECATED still serves', () => {
    const result = candidateVersions(tool([v200, v110, deprecated], 3), {
      range: [1],
      requireOutputFields: [],
    });
    expect(result.versions.map((x) => x.semver)).toEqual(['1.1.0', '1.0.0']);
  });

  it('an exact version pin, if still servable', () => {
    expect(
      candidateVersions(tool([v200, v110, v100], 2), {
        range: null,
        requireOutputFields: [],
        version: 1,
      }).versions.map((x) => x.semver),
    ).toEqual(['1.0.0']);
  });

  it('RETIRED when every version in range is retired; NO_VERSION when none exists', () => {
    const retired = { ...v100, status: ToolVersionStatus.RETIRED, sunsetAt: sunset };
    expect(
      candidateVersions(tool([v200, retired], 3), { range: [1], requireOutputFields: [] }),
    ).toEqual({ versions: [], refusal: ContractRefusal.RETIRED });
    expect(
      candidateVersions(tool([v200], 3), { range: [7], requireOutputFields: [] }).refusal,
    ).toBe(ContractRefusal.NO_VERSION);
    expect(
      candidateVersions(
        { ...tool([v100], 1), status: ToolStatus.RETIRED },
        {
          range: null,
          requireOutputFields: [],
        },
      ).refusal,
    ).toBe(ContractRefusal.RETIRED);
  });

  it('never serves an older version that would drop an input a newer one defines', () => {
    const withUnits = v({
      version: 2,
      semver: '1.1.0',
      inputSchema: {
        type: 'object',
        properties: { ...SHAPE.inputSchema.properties, units: { type: 'string' } },
      },
      optionalInputFields: ['units'],
    });
    const result = candidateVersions(tool([withUnits, v100], 2), {
      range: null,
      requireOutputFields: [],
      argumentNames: ['latitude', 'units'],
    });
    expect(result.versions.map((x) => x.semver)).toEqual(['1.1.0']);
    expect(usedOptionalInputs(withUnits, ['latitude', 'units'])).toEqual(['units']);
  });

  it('an argument only an older major defines never pushes an unpinned call down to it', () => {
    const old = v({
      inputSchema: {
        type: 'object',
        properties: { ...SHAPE.inputSchema.properties, legacy: { type: 'string' } },
      },
    });
    const result = candidateVersions(tool([v200, old], 3), {
      range: null,
      requireOutputFields: [],
      argumentNames: ['latitude', 'legacy'],
    });
    expect(result.versions.map((x) => x.semver)).toEqual(['2.0.0', '1.0.0']);
  });

  it('current version, deprecation meta and replacement', () => {
    const t = tool([v200, deprecated], 3);
    expect(currentContractVersion(t)?.semver).toBe('2.0.0');
    expect(deprecationOf(deprecated, replacementOf(t, deprecated))).toEqual({
      sunsetAt: sunset.toISOString(),
      replacement: 'get_weather@2 (v2.0.0)',
    });
    expect(deprecationOf(v200, null)).toBeNull();
    expect(replacementOf({ ...t, replacementToolName: 'get_weather_v2' }, deprecated)).toBe(
      'get_weather_v2',
    );
  });
});

describe('declared optional outputs', () => {
  const version = v({
    outputSchema: {
      type: 'object',
      properties: { temperatureC: { type: 'number' }, uvIndex: { type: 'number' } },
      required: ['temperatureC'],
    },
    optionalOutputFields: ['uvIndex'],
  });
  const spec = { temperatureC: { $path: '$.t' }, uvIndex: { $path: '$.uv' } };

  it('requires what the binding declares, in the schema verification judges against', () => {
    expect(effectiveOutputSchema(version, { providesOutputFields: ['uvIndex'] }).required).toEqual([
      'temperatureC',
      'uvIndex',
    ]);
    expect(effectiveOutputSchema(version, { providesOutputFields: [] })).toBe(version.outputSchema);
  });

  it('maps a present declared field, and a missing one is the provider’s fault', () => {
    expect(
      mapServedResponse(spec, { t: 20, uv: 3 }, version, { providesOutputFields: ['uvIndex'] }),
    ).toEqual({ temperatureC: 20, uvIndex: 3 });

    let error: unknown;
    try {
      mapServedResponse(spec, { t: 20 }, version, { providesOutputFields: ['uvIndex'] });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      errorCode: ToolErrorCode.TOOL_MAPPING_REQUIRED_FIELD_MISSING,
      context: { fault: 'PROVIDER', field: 'uvIndex' },
    });
  });

  it('summaries are whole sentences up to 200 characters', () => {
    expect(summaryOf('Short.')).toBe('Short.');
    expect(summaryOf(`${'A sentence. '.repeat(30)}`).length).toBeLessThanOrEqual(200);
  });
});
