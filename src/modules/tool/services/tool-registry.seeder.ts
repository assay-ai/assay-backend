import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { ToolRepository } from '@database/postgres/repositories/tool.repository';

import { categoryOf } from '../ports/tool.types';
import { TOOL_CATALOGUE_SNAPSHOT, ToolCatalogueSnapshot } from './in-memory-tool-catalogue';

/**
 * Mirrors the seeded STANDARD tools into `tools` at boot (design spec §11.2:
 * "the seed creates the `tools` rows first").
 *
 * Every process that loads the catalogue runs it; the upsert is one idempotent
 * statement, so two processes booting together agree. A failure fails the
 * boot: without the rows a binding cannot be saved (`fk_tool_bindings_tool`)
 * and a toolset cannot name a tool, and finding that out on the first save
 * would look like a provider-side error.
 */
@Injectable()
export class ToolRegistrySeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(ToolRegistrySeeder.name);

  constructor(
    @Inject(TOOL_CATALOGUE_SNAPSHOT) private readonly snapshot: ToolCatalogueSnapshot,
    private readonly tools: ToolRepository,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.snapshot.tools.length === 0) return;

    await this.tools.upsertSeeded(
      this.snapshot.tools.map((tool) => ({
        id: tool.id,
        name: tool.name,
        category: categoryOf(tool),
        tags: tool.tags ?? [],
      })),
    );
    this.logger.log(`${this.snapshot.tools.length} seeded tools mirrored into tools`);
  }
}
