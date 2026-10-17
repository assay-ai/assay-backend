import { Tool } from './tool.types';

/**
 * Where the catalogue reads tool contracts: `tools` and `tool_versions`
 * (design spec §7.5, "Source of truth"). A port so the router's tests and
 * the hand-built harnesses can serve contracts from memory, exactly as the
 * binding half of the catalogue is served from `tool_bindings`.
 *
 * Only served tools come back: a DRAFT tool (nothing published yet) and a
 * REMOVED one are in no catalogue. Each tool carries every published
 * version, its fields taken from `tools.current_version`.
 */
export interface ToolContractsPort {
  listContracts(): Promise<readonly Tool[]>;
  findContract(toolId: string): Promise<Tool | null>;
}

/** DI token for the bound {@link ToolContractsPort}. */
export const TOOL_CONTRACTS = 'TOOL_CONTRACTS';

/**
 * Told when a contract changes (an operator publish, a moved current
 * version, a deprecation, a retirement, the boot seed), so every process's
 * cached contracts and quote index re-read at once.
 */
export interface ToolContractChanges {
  contractsChanged(): Promise<void>;
}

export const TOOL_CONTRACT_CHANGES = 'TOOL_CONTRACT_CHANGES';

/** Contracts held in memory: tests and harnesses. */
export function staticToolContracts(tools: readonly Tool[]): ToolContractsPort {
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  return {
    listContracts: () => Promise.resolve([...byId.values()]),
    findContract: (toolId: string) => Promise.resolve(byId.get(toolId) ?? null),
  };
}
