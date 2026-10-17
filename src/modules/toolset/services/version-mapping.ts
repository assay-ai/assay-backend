import { ToolsetVersionEntity } from '@database/postgres/entities/toolset-version.entity';

import { ToolsetSnapshot, readSnapshotEntries } from '../domain/snapshot';
import { ToolsetVersionDto, ToolsetVersionSummaryDto } from '../dto/toolset-publishing.dto';

/** `toolset_versions` rows → snapshots and DTOs. */
export function snapshotOfVersion(row: ToolsetVersionEntity): ToolsetSnapshot {
  return {
    entries: readSnapshotEntries(row.entries),
    discovery: row.discovery,
    searchThreshold: row.searchThreshold,
    pinnedTools: row.pinnedTools,
    name: row.name,
    description: row.description,
    icon: row.icon,
  };
}

export function versionSummaryOf(row: ToolsetVersionEntity): ToolsetVersionSummaryDto {
  return {
    version: row.version,
    publishedAt: new Date(row.publishedAt).toISOString(),
    changelog: row.changelog,
    name: row.name,
    toolCount: row.toolIds.length,
  };
}

export function versionDtoOf(row: ToolsetVersionEntity): ToolsetVersionDto {
  const snapshot = snapshotOfVersion(row);
  return {
    ...versionSummaryOf(row),
    description: row.description,
    icon: row.icon,
    discovery: row.discovery,
    searchThreshold: row.searchThreshold,
    pinnedTools: row.pinnedTools,
    entries: snapshot.entries.map((entry) => ({
      toolId: entry.toolId,
      toolName: entry.toolName,
      providerMode: entry.providerMode,
      providerIds: [...entry.providerIds],
      minTier: entry.minTier,
      maxPrice: entry.maxPrice ? { ...entry.maxPrice } : null,
      minQuality: entry.minQuality,
      onEmpty: entry.onEmpty,
    })),
  };
}
