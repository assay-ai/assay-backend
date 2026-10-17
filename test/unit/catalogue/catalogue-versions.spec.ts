import {
  providerDeclarationsOf,
  versionFieldsOf,
} from '@modules/catalogue/services/catalogue.service';
import {
  Tool,
  ToolContractVersion,
  ToolTier,
  ToolVersionStatus,
} from '@modules/tool/ports/tool.types';

function v(overrides: Partial<ToolContractVersion>): ToolContractVersion {
  return {
    version: 1,
    semver: '1.0.0',
    major: 1,
    summary: 'Weather now.',
    description: 'Current weather at a point, in detail.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', properties: {} },
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

describe('catalogue version fields (T3)', () => {
  it('shows the current summary and version, every version with its changelog, and deprecated majors', () => {
    const sunset = new Date('2027-02-01T00:00:00Z');
    const tool: Tool = {
      id: 't',
      name: 'get_weather',
      description: 'Current weather at a point, in detail.',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      verificationPolicyId: 'policy-default',
      tier: ToolTier.VERIFIED,
      currentVersion: 2,
      versions: [
        v({ version: 1, status: ToolVersionStatus.DEPRECATED, sunsetAt: sunset }),
        v({
          version: 2,
          semver: '2.0.0',
          major: 2,
          summary: 'Weather now, v2.',
          changelog: 'Adds feels-like.',
        }),
      ],
      version: v({ version: 2, semver: '2.0.0', major: 2, summary: 'Weather now, v2.' }),
    };

    const fields = versionFieldsOf(tool);
    expect(fields.summary).toBe('Weather now, v2.');
    expect(fields.version).toBe('2.0.0');
    expect(fields.deprecatedMajors).toEqual([1]);
    expect(fields.versions).toEqual([
      expect.objectContaining({ semver: '2.0.0', isCurrent: true, changelog: 'Adds feels-like.' }),
      expect.objectContaining({
        semver: '1.0.0',
        status: 'DEPRECATED',
        sunsetAt: sunset,
        isCurrent: false,
      }),
    ]);
  });

  const deprecatedTool = (over: Partial<Tool> = {}): Tool => ({
    id: 't',
    name: 'get_weather',
    description: 'd',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    verificationPolicyId: 'policy-default',
    tier: ToolTier.VERIFIED,
    currentVersion: 2,
    versions: [
      v({ version: 2, semver: '2.1.0', major: 2 }),
      v({ version: 1, status: ToolVersionStatus.DEPRECATED, sunsetAt: new Date('2027-02-01') }),
    ],
    ...over,
  });

  it('names the replacement of the deprecated majors: this tool at its newer major', () => {
    expect(versionFieldsOf(deprecatedTool())).toMatchObject({
      deprecatedMajors: [1],
      replacementToolId: 't',
      replacementName: 'get_weather',
      replacementMajor: 2,
      replacementVersion: '2.1.0',
    });
  });

  it('names a LISTED replacement tool, and never an unlisted one', () => {
    const tool = deprecatedTool({
      replacementToolId: 'r',
      replacementToolName: 'get_weather_pro',
      replacementToolVersion: { major: 1, semver: '1.0.0' },
    });
    expect(versionFieldsOf(tool, (id) => id === 'r')).toMatchObject({
      replacementToolId: 'r',
      replacementName: 'get_weather_pro',
      replacementMajor: 1,
      replacementVersion: '1.0.0',
    });
    expect(versionFieldsOf(tool, () => false)).toMatchObject({
      replacementToolId: null,
      replacementName: null,
      replacementMajor: null,
      replacementVersion: null,
    });
  });

  it('no deprecated major: no replacement', () => {
    const tool = deprecatedTool({ versions: [v({ version: 2, semver: '2.0.0', major: 2 })] });
    expect(versionFieldsOf(tool)).toMatchObject({ deprecatedMajors: [], replacementToolId: null });
  });
});

describe('catalogue provider declarations (T3)', () => {
  it('lists each listed provider of the tool with its majors and optional fields', () => {
    const binding = (over: Record<string, unknown>) => ({ toolId: 't', ...over });
    const market = {
      bindings: [
        binding({ providerId: 'p1', toolVersionRange: '^1', providesOutputFields: ['uv_index'] }),
        binding({
          providerId: 'p1',
          toolVersionRange: '^2',
          providesOutputFields: ['feels_like', 'uv_index'],
          supportsInputFields: ['units'],
        }),
        binding({ providerId: 'p2' }),
        binding({ providerId: 'p3', toolId: 'other', providesOutputFields: ['x'] }),
        // A binding whose provider is not in the listing (no row) is left out.
        binding({ providerId: 'gone', providesOutputFields: ['secret'] }),
      ],
      rows: new Map([
        ['p1', { legalName: 'Beta Weather' }],
        ['p2', { legalName: 'Acme Weather' }],
        ['p3', { legalName: 'Other' }],
      ]),
    };
    expect(providerDeclarationsOf(market as never, 't')).toEqual([
      {
        providerId: 'p2',
        legalName: 'Acme Weather',
        servedMajors: [1],
        providesOutputFields: [],
        supportsInputFields: [],
      },
      {
        providerId: 'p1',
        legalName: 'Beta Weather',
        servedMajors: [1, 2],
        providesOutputFields: ['feels_like', 'uv_index'],
        supportsInputFields: ['units'],
      },
    ]);
  });
});
