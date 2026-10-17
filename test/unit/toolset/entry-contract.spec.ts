import { ToolsetErrorCode } from '@modules/toolset/errors/toolset.errors';
import { entryContractTerms } from '@modules/toolset/services/toolsets.service';
import { contractRequestOf, entryContractOf, selectViewTools } from '@modules/toolset/domain/view';
import {
  Tool,
  ToolContractVersion,
  ToolTier,
  ToolVersionStatus,
} from '@modules/tool/ports/tool.types';

/**
 * Toolset entries and URLs carry the contract's hard constraints (T3): the
 * entry's `tool_version_range` and `require_output_fields`, and a
 * `?tools=name@N` pin.
 */

const versions = [
  {
    version: 1,
    major: 1,
    status: ToolVersionStatus.ACTIVE,
    outputSchema: { properties: { temperatureC: {}, uvIndex: {} } },
  },
  {
    version: 2,
    major: 2,
    status: ToolVersionStatus.ACTIVE,
    outputSchema: { properties: { temperatureC: {} } },
  },
  {
    version: 3,
    major: 3,
    status: ToolVersionStatus.RETIRED,
    outputSchema: { properties: { temperatureC: {} } },
  },
] as never[];

const TOOL_ID = '00000000-0000-4000-8000-000000000001';

async function codeOf(work: () => unknown): Promise<string | undefined> {
  try {
    work();
  } catch (error) {
    return (error as { errorCode?: string }).errorCode;
  }
  return undefined;
}

describe('entryContractTerms', () => {
  it('a new entry gets ^N of the current major; a re-sent one keeps its stored range', () => {
    expect(
      entryContractTerms({ toolId: TOOL_ID }, { currentVersion: 1 } as never, versions, null),
    ).toEqual({ toolVersionRange: '^1', requireOutputFields: [] });
    expect(
      entryContractTerms({ toolId: TOOL_ID }, { currentVersion: 1 } as never, versions, '^2'),
    ).toEqual({ toolVersionRange: '^2', requireOutputFields: [] });
    expect(
      entryContractTerms(
        { toolId: TOOL_ID, toolVersionRange: '^2||^1' },
        { currentVersion: 1 } as never,
        versions,
        null,
      ).toolVersionRange,
    ).toBe('^1 || ^2');
  });

  it('refuses a malformed range, a major with no serving version, and an unknown output', async () => {
    const tool = { currentVersion: 1 } as never;
    expect(
      await codeOf(() =>
        entryContractTerms({ toolId: TOOL_ID, toolVersionRange: 'latest' }, tool, versions, null),
      ),
    ).toBe(ToolsetErrorCode.TOOLSET_INVALID);
    expect(
      await codeOf(() =>
        entryContractTerms({ toolId: TOOL_ID, toolVersionRange: '^3' }, tool, versions, null),
      ),
    ).toBe(ToolsetErrorCode.TOOLSET_INVALID);
    expect(
      await codeOf(() =>
        entryContractTerms(
          { toolId: TOOL_ID, toolVersionRange: '^2', requireOutputFields: ['uvIndex'] },
          tool,
          versions,
          null,
        ),
      ),
    ).toBe(ToolsetErrorCode.TOOLSET_INVALID);
    expect(
      entryContractTerms(
        { toolId: TOOL_ID, requireOutputFields: ['uvIndex', 'uvIndex'] },
        tool,
        versions,
        null,
      ).requireOutputFields,
    ).toEqual(['uvIndex']);
  });
});

function v(major: number, version: number): ToolContractVersion {
  return {
    version,
    semver: `${major}.0.0`,
    major,
    summary: 's',
    description: 'd',
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
  };
}

const weather: Tool = {
  id: TOOL_ID,
  name: 'get_weather',
  description: 'd',
  inputSchema: { type: 'object', properties: {} },
  outputSchema: { type: 'object', properties: {} },
  verificationPolicyId: 'policy-default',
  tier: ToolTier.VERIFIED,
  versions: [v(2, 2), v(1, 1)],
  currentVersion: 1,
};

describe('?tools=name@N and entry ranges in the view', () => {
  const filter = (major: number | null) => ({ tools: [{ name: 'get_weather', major }] }) as never;

  it('keeps a pin to a major that exists and ignores one that does not', () => {
    expect(
      selectViewTools({ baseToolIds: null, filter: filter(2) }, [weather]).tools.map((t) => t.name),
    ).toEqual(['get_weather']);
    expect(selectViewTools({ baseToolIds: null, filter: filter(9) }, [weather])).toEqual({
      tools: [],
      ignoredTools: ['get_weather@9'],
    });
  });

  it('ignores a pin outside the toolset entry’s range', () => {
    const entryContracts = new Map([[TOOL_ID, { range: [1], requireOutputFields: [] }]]);
    expect(
      selectViewTools({ baseToolIds: [TOOL_ID], filter: filter(2), entryContracts }, [weather])
        .ignoredTools,
    ).toEqual(['get_weather@2']);
  });

  it('a call asks for the entry range narrowed by the pin, and the required outputs', () => {
    const entryContracts = new Map([[TOOL_ID, { range: [1, 2], requireOutputFields: ['uv'] }]]);
    expect(contractRequestOf({ entryContracts, filter: filter(2) }, weather)).toEqual({
      range: [2],
      requireOutputFields: ['uv'],
    });
    expect(contractRequestOf({ filter: filter(null) } as never, weather)).toEqual({
      range: null,
      requireOutputFields: [],
    });
    expect(entryContractOf({ toolVersionRange: null, requireOutputFields: [] })).toBeNull();
  });
});
