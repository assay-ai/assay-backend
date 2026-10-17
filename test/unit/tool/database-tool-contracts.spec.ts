import { ToolVersionEntity } from '@database/postgres/entities/tool-version.entity';
import { ToolEntity } from '@database/postgres/entities/tool.entity';
import { DatabaseToolContracts, buildTools } from '@modules/tool/services/database-tool-contracts';

/**
 * Contracts from `tools` and `tool_versions` (design spec §7.5): only served
 * tools, every published version, the fields of the current one.
 */
function toolRow(overrides: Partial<ToolEntity>): ToolEntity {
  return {
    id: 't1',
    name: 'get_example',
    kind: 'STANDARD',
    ownerOrgId: null,
    category: 'misc',
    tags: ['example'],
    visibility: 'LISTED',
    reviewStatus: null,
    reviewNote: null,
    status: 'ACTIVE',
    currentVersion: 2,
    replacementToolId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as ToolEntity;
}

function versionRow(overrides: Partial<ToolVersionEntity>): ToolVersionEntity {
  return {
    toolId: 't1',
    version: 1,
    semver: '1.0.0',
    major: 1,
    summary: 'One.',
    description: 'Version one.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', properties: {} },
    optionalInputFields: [],
    optionalOutputFields: [],
    examples: [],
    verificationPolicyId: null,
    tier: null,
    status: 'ACTIVE',
    sunsetAt: null,
    changelog: null,
    publishedAt: new Date(0),
    createdBy: null,
    publishedBy: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as ToolVersionEntity;
}

describe('buildTools', () => {
  it('serves every published version, newest first, at the current one; never a draft', () => {
    const tools = buildTools(
      [toolRow({}), toolRow({ id: 'r', name: 'get_replacement', currentVersion: 1 })],
      [
        versionRow({}),
        versionRow({ version: 2, semver: '1.1.0', summary: 'One point one.' }),
        versionRow({ version: 3, semver: '2.0.0', major: 2, status: 'DRAFT', publishedAt: null }),
        versionRow({ toolId: 'r', summary: 'Replacement.' }),
      ],
    );
    const tool = tools.get('t1')!;
    expect(tool.versions?.map((version) => version.semver)).toEqual(['1.1.0', '1.0.0']);
    expect(tool.version?.semver).toBe('1.1.0');
    expect(tool.description).toBe('Version one.');
    expect(tool.version?.summary).toBe('One point one.');
    // The defaults a stored version with no policy or tier reads as.
    expect(tool.verificationPolicyId).toBe('policy-default');
    expect(tool.tier).toBe('UNVERIFIED');
  });

  it('names the replacement tool, and leaves out a tool with no published version', () => {
    const tools = buildTools(
      [
        toolRow({ replacementToolId: 'r' }),
        toolRow({ id: 'r', name: 'get_replacement' }),
        toolRow({ id: 'd', name: 'get_draft' }),
      ],
      [versionRow({}), versionRow({ toolId: 'r' })],
    );
    expect(tools.get('t1')?.replacementToolName).toBe('get_replacement');
    expect(tools.has('d')).toBe(false);
  });
});

describe('DatabaseToolContracts', () => {
  it('reads served tools once and serves them from memory until invalidated', async () => {
    let reads = 0;
    const contracts = new DatabaseToolContracts(
      {
        find: async () => {
          reads += 1;
          return [toolRow({})];
        },
      } as never,
      { find: async () => [versionRow({ version: 2, semver: '1.1.0' })] } as never,
    );
    expect((await contracts.listContracts()).map((tool) => tool.name)).toEqual(['get_example']);
    expect(await contracts.findContract('t1')).not.toBeNull();
    expect(reads).toBe(1);
    contracts.invalidate();
    await contracts.findContract('t1');
    expect(reads).toBe(2);
  });
});
