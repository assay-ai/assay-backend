import { versionFieldsOf } from '@modules/catalogue/services/catalogue.service';
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
});
