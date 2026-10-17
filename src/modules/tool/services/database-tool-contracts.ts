import { Injectable, Logger, Optional } from '@nestjs/common';
import { In, Not } from 'typeorm';

import { ToolEntity } from '@database/postgres/entities/tool.entity';
import { ToolVersionEntity } from '@database/postgres/entities/tool-version.entity';
import { ToolRepository } from '@database/postgres/repositories/tool.repository';
import { ToolVersionRepository } from '@database/postgres/repositories/tool-version.repository';
import { CacheService } from '@shared/cache/redis-cache/cache.service';
import { readEpoch } from '@shared/cache/redis-cache/epoch-counter';

import { toolAtVersion } from '../domain/contract/contract-versions';
import { compareSemverText } from '../domain/contract/semver';
import { JsonSchema } from '../domain/mapping/schema-validator';
import { ToolContractChanges, ToolContractsPort } from '../ports/tool-contracts.port';
import {
  Tool,
  ToolContractVersion,
  ToolExample,
  ToolStatus,
  ToolTier,
  ToolVersionStatus,
  ToolVisibility,
} from '../ports/tool.types';
import { QuoteIndexService } from './quote-index.service';

/** Contracts are re-read at least this often, whatever the epoch says. */
export const TOOL_CONTRACTS_MAX_AGE_MS = 30_000;

/** Bumped on every contract write, by any process. */
export const TOOL_CONTRACTS_EPOCH_KEY = 'assay:tool-contracts:epoch';

/** The verification policy of a version that names none. */
export const DEFAULT_VERIFICATION_POLICY_ID = 'policy-default';

interface Snapshot {
  readonly tools: ReadonlyMap<string, Tool>;
  readonly loadedAt: number;
  readonly epoch: string | null;
}

/**
 * Tool contracts from `tools` and `tool_versions`: the source of truth
 * (design spec §7.5, §13 D4).
 *
 * The whole served catalogue is read in two statements and held in memory,
 * reloaded when it is older than {@link TOOL_CONTRACTS_MAX_AGE_MS} or when
 * another process bumped the epoch (an operator publish, a moved current
 * version, a deprecation). A call reads contracts here too, so a contract
 * change reaches calls within that bound everywhere and at once in the
 * process that made it.
 */
@Injectable()
export class DatabaseToolContracts implements ToolContractsPort {
  private readonly logger = new Logger(DatabaseToolContracts.name);
  private snapshot: Snapshot | null = null;
  private loading: Promise<Snapshot> | null = null;

  constructor(
    private readonly toolRows: ToolRepository,
    private readonly versionRows: ToolVersionRepository,
    @Optional() private readonly cache?: CacheService,
  ) {}

  async listContracts(): Promise<readonly Tool[]> {
    return [...(await this.current()).tools.values()];
  }

  async findContract(toolId: string): Promise<Tool | null> {
    return (await this.current()).tools.get(toolId) ?? null;
  }

  /** Drop the in-memory copy; the next read reloads. */
  invalidate(): void {
    this.snapshot = null;
  }

  /** Tell every process that a contract changed. Best effort on the shared half. */
  async bumpEpoch(): Promise<void> {
    try {
      await this.cache?.getRedisClient().incr(TOOL_CONTRACTS_EPOCH_KEY);
    } catch (error) {
      this.logger.warn(`tool contracts epoch not bumped — ${describe(error)}`);
    }
    this.invalidate();
  }

  private async current(): Promise<Snapshot> {
    const epoch = await this.readEpoch();
    const held = this.snapshot;
    if (held && held.epoch === epoch && Date.now() - held.loadedAt < TOOL_CONTRACTS_MAX_AGE_MS) {
      return held;
    }
    if (!this.loading) {
      this.loading = this.load(epoch).finally(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  private async load(epoch: string | null): Promise<Snapshot> {
    const rows = await this.toolRows.find({
      where: { status: Not(In([ToolStatus.DRAFT, ToolStatus.REMOVED])) },
    });
    const versions =
      rows.length === 0
        ? []
        : await this.versionRows.find({
            where: {
              toolId: In(rows.map((row) => row.id)),
              status: Not(ToolVersionStatus.DRAFT),
            },
          });
    const snapshot: Snapshot = {
      tools: buildTools(rows, versions),
      loadedAt: Date.now(),
      epoch,
    };
    this.snapshot = snapshot;
    return snapshot;
  }

  private async readEpoch(): Promise<string | null> {
    if (!this.cache) return null;
    try {
      return await readEpoch(this.cache.getRedisClient(), TOOL_CONTRACTS_EPOCH_KEY);
    } catch {
      return null;
    }
  }
}

/**
 * The change signal: every process re-reads its contracts and its quote
 * index, which caches each tool beside its candidates.
 */
@Injectable()
export class ToolContractChangesService implements ToolContractChanges {
  constructor(
    private readonly contracts: DatabaseToolContracts,
    @Optional() private readonly quotes?: QuoteIndexService,
  ) {}

  async contractsChanged(): Promise<void> {
    await this.contracts.bumpEpoch();
    await this.quotes?.bumpEpoch();
  }
}

/** The served tools: each with every published version, at its current one. */
export function buildTools(
  rows: readonly ToolEntity[],
  versions: readonly ToolVersionEntity[],
): ReadonlyMap<string, Tool> {
  const byTool = new Map<string, ToolContractVersion[]>();
  for (const row of versions) {
    if (row.status === ToolVersionStatus.DRAFT) continue;
    const list = byTool.get(row.toolId) ?? [];
    list.push(toContractVersion(row));
    byTool.set(row.toolId, list);
  }
  const names = new Map(rows.map((row) => [row.id, row.name]));

  const tools = new Map<string, Tool>();
  for (const row of rows) {
    const served = (byTool.get(row.id) ?? []).sort((a, b) => compareSemverText(b.semver, a.semver));
    if (served.length === 0) continue;
    const current =
      served.find((version) => version.version === row.currentVersion) ??
      served.find((version) => version.status === ToolVersionStatus.ACTIVE) ??
      served[0];
    const base: Tool = {
      id: row.id,
      name: row.name,
      description: current.description,
      inputSchema: current.inputSchema,
      outputSchema: current.outputSchema,
      verificationPolicyId: current.verificationPolicyId,
      tier: current.tier,
      category: row.category,
      tags: [...(row.tags ?? [])],
      visibility: row.visibility as ToolVisibility,
      status: row.status as ToolStatus,
      currentVersion: row.currentVersion,
      versions: served,
      replacementToolName: row.replacementToolId
        ? (names.get(row.replacementToolId) ?? null)
        : null,
    };
    tools.set(row.id, toolAtVersion(base, current));
  }
  return tools;
}

export function toContractVersion(row: ToolVersionEntity): ToolContractVersion {
  return {
    version: row.version,
    semver: row.semver,
    major: row.major,
    summary: row.summary,
    description: row.description,
    inputSchema: row.inputSchema as JsonSchema,
    outputSchema: row.outputSchema as JsonSchema,
    optionalInputFields: [...(row.optionalInputFields ?? [])],
    optionalOutputFields: [...(row.optionalOutputFields ?? [])],
    examples: (Array.isArray(row.examples) ? row.examples : []) as ToolExample[],
    verificationPolicyId: row.verificationPolicyId ?? DEFAULT_VERIFICATION_POLICY_ID,
    tier: (row.tier as ToolTier | null) ?? ToolTier.UNVERIFIED,
    status: row.status as ToolVersionStatus,
    sunsetAt: row.sunsetAt ?? null,
    changelog: row.changelog ?? null,
    publishedAt: row.publishedAt ?? null,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
