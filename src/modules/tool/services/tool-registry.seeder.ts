import { Inject, Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';

import { ToolRepository } from '@database/postgres/repositories/tool.repository';

import { summaryOf } from '../domain/contract/contract-versions';
import { categoryOf } from '../ports/tool.types';
import { TOOL_CONTRACT_CHANGES, ToolContractChanges } from '../ports/tool-contracts.port';
import { TOOL_CATALOGUE_SNAPSHOT, ToolCatalogueSnapshot } from './in-memory-tool-catalogue';

/**
 * Upserts the seeded STANDARD tools and version 1.0.0 of each contract into
 * `tools` and `tool_versions` at boot — for local runs and tests only
 * (design spec §13 D4, §11.2).
 *
 * The database is the source of truth everywhere; in a deployed environment
 * (`NODE_ENV=production`) the seed is not applied at all and contracts come
 * only from the operator editor. Every process that loads the catalogue runs
 * it; the upsert is idempotent, so two processes booting together agree. A
 * failure fails the boot: without the rows a binding cannot be saved
 * (`fk_tool_bindings_tool`) and a toolset cannot name a tool.
 */
@Injectable()
export class ToolRegistrySeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(ToolRegistrySeeder.name);

  constructor(
    @Inject(TOOL_CATALOGUE_SNAPSHOT) private readonly snapshot: ToolCatalogueSnapshot,
    private readonly tools: ToolRepository,
    @Optional() @Inject(TOOL_CONTRACT_CHANGES) private readonly changes?: ToolContractChanges,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.snapshot.tools.length === 0) return;
    if (process.env.NODE_ENV === 'production') {
      this.logger.warn(
        `${this.snapshot.tools.length} seeded tools NOT applied: under NODE_ENV=production the ` +
          'database is the only source of contracts (design spec §13 D4). Unset ' +
          'TOOL_CATALOGUE_SEED_FILE / TOOL_CATALOGUE_SEED_JSON.',
      );
      return;
    }

    await this.tools.upsertSeeded(
      this.snapshot.tools.map((tool) => ({
        id: tool.id,
        name: tool.name,
        category: categoryOf(tool),
        tags: tool.tags ?? [],
        version: {
          summary: (tool as SeededTool).summary ?? summaryOf(tool.description),
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          optionalInputFields: (tool as SeededTool).optionalInputFields ?? [],
          optionalOutputFields: (tool as SeededTool).optionalOutputFields ?? [],
          examples: (tool as SeededTool).examples ?? [],
          verificationPolicyId: tool.verificationPolicyId ?? null,
          tier: tool.tier ?? null,
        },
      })),
    );
    await this.changes?.contractsChanged();
    this.logger.log(`${this.snapshot.tools.length} seeded tools upserted at version 1.0.0`);
  }
}

/** The optional contract fields a seed document may carry beside a tool's own. */
interface SeededTool {
  readonly summary?: string;
  readonly optionalInputFields?: readonly string[];
  readonly optionalOutputFields?: readonly string[];
  readonly examples?: readonly unknown[];
}
