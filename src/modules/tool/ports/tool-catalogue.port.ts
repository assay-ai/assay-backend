import { RemovedTool } from './tool-contracts.port';
import { Tool, ToolBinding } from './tool.types';

/**
 * Where the router reads the catalogue.
 *
 * A port rather than a repository because `Tool` and `ToolBinding` began as
 * types with no TypeORM entity and no migration, and the binding editor is
 * what later created `tool_bindings` and `binding_versions`. The router ran
 * against an in-memory catalogue first, and it must not have to change when the
 * storage does — hence a port, and hence exactly two methods.
 */
export interface ToolCataloguePort {
  findTool(toolId: string): Promise<Tool | null>;

  /**
   * Every tool in the catalogue.
   *
   * Added for the MCP server: its `tools/list` is a catalogue read, and it
   * is the *first* thing an agent does — before it knows any tool id, so
   * `findTool` cannot serve it. Unfiltered for the same reason `findBindings`
   * is: whether a tool is worth advertising depends on whether anything is
   * routable behind it, which is a question about bindings, providers and stake
   * that this port cannot see and the caller can.
   *
   * It is not paged because the launch catalogue is 24 tools and a page cursor
   * with nothing behind it is an API that has to change twice.
   */
  listTools(): Promise<readonly Tool[]>;

  /**
   * Every binding for the tool, in any state.
   *
   * Filtering is the router's job, not the catalogue's — `filterEligible`
   * rejects `DRAFT`/`PAUSED`/`SUSPENDED` bindings *with a reason*, and a query
   * that returned only the active ones would make "no provider available" and
   * "every provider is paused" indistinguishable on the receipt. That is a
   * distinction someone reads at 3am.
   */
  findBindings(toolId: string): Promise<readonly ToolBinding[]>;

  /** A REMOVED tool by name, for `TOOL_REMOVED` (`ToolContractsPort.findRemovedByName`). */
  findRemovedByName?(name: string): Promise<RemovedTool | null>;
}

/** DI token for the bound {@link ToolCataloguePort}. */
export const TOOL_CATALOGUE = 'TOOL_CATALOGUE';
