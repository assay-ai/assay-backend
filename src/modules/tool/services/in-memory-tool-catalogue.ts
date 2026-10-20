import { Inject, Injectable } from '@nestjs/common';

import { assertNoReservedToolNames } from '../domain/reserved-tool-names';
import { ToolCataloguePort } from '../ports/tool-catalogue.port';
import { Tool, ToolBinding } from '../ports/tool.types';

/**
 * The catalogue, held in memory.
 *
 * `Tool` and `ToolBinding` began as types with no entity, no `tool_bindings`
 * table and no migration; the binding editor is what created them, along with
 * `binding_versions`. The router could not wait for that — routing is the thing
 * the MCP server calls — so it runs against a seeded catalogue behind
 * {@link ToolCataloguePort} and changes nothing when the repository is used.
 *
 * The seed is also how the launch catalogue gets in front of a real router
 * before the console exists to author one.
 */
export const TOOL_CATALOGUE_SNAPSHOT = 'TOOL_CATALOGUE_SNAPSHOT';

export interface ToolCatalogueSnapshot {
  readonly tools: readonly Tool[];
  readonly bindings: readonly ToolBinding[];
}

export const EMPTY_TOOL_CATALOGUE: ToolCatalogueSnapshot = Object.freeze({
  tools: Object.freeze([]),
  bindings: Object.freeze([]),
});

@Injectable()
export class InMemoryToolCatalogue implements ToolCataloguePort {
  private readonly tools: ReadonlyMap<string, Tool>;
  private readonly bindingsByTool: ReadonlyMap<string, ToolBinding[]>;

  constructor(@Inject(TOOL_CATALOGUE_SNAPSHOT) snapshot: ToolCatalogueSnapshot) {
    assertNoReservedToolNames(
      snapshot.tools.map((tool) => tool.name),
      'tool catalogue',
    );
    this.tools = new Map(snapshot.tools.map((tool) => [tool.id, tool]));

    const grouped = new Map<string, ToolBinding[]>();
    for (const binding of snapshot.bindings) {
      const existing = grouped.get(binding.toolId);
      if (existing) existing.push(binding);
      else grouped.set(binding.toolId, [binding]);
    }
    this.bindingsByTool = grouped;
  }

  findTool(toolId: string): Promise<Tool | null> {
    return Promise.resolve(this.tools.get(toolId) ?? null);
  }

  listTools(): Promise<readonly Tool[]> {
    return Promise.resolve([...this.tools.values()]);
  }

  findBindings(toolId: string): Promise<readonly ToolBinding[]> {
    return Promise.resolve(this.bindingsByTool.get(toolId) ?? []);
  }

  findBindingsOfProvider(providerId: string): Promise<readonly ToolBinding[]> {
    return Promise.resolve(
      [...this.tools.keys()].flatMap((toolId) =>
        (this.bindingsByTool.get(toolId) ?? []).filter(
          (binding) => binding.providerId === providerId,
        ),
      ),
    );
  }
}
