import { EntityManager, In, MoreThanOrEqual } from 'typeorm';

import { ToolEntity } from '@database/postgres/entities/tool.entity';
import { ToolsetEntryEntity } from '@database/postgres/entities/toolset-entry.entity';
import { ToolsetVersionEntity } from '@database/postgres/entities/toolset-version.entity';
import { ToolsetEntity } from '@database/postgres/entities/toolset.entity';

import { SharingState, ToolsetVisibility, isShared } from '../domain/sharing';
import { SnapshotDiff, ToolsetSnapshot, changelogOf, diffSnapshots } from '../domain/snapshot';
import { ToolsetErrors } from '../errors/toolset.errors';
import { sharingPatchOf } from './sharing-row';
import { snapshotOfVersion } from './version-mapping';

/**
 * The steps every publish of a toolset shares, whoever owns it: the owner's
 * Share dialog (`ToolsetPublishingService`) and the platform's official sets
 * (`OfficialToolsetsService`). Each runs on the caller's transaction.
 */

/** Limits of design spec §7.13 for publishing and copies. */
export const PUBLISHING_LIMITS = Object.freeze({
  versionsPerToolsetPerDay: 10,
  copiesPerOrgPerDay: 50,
});

/** The Draft as the next version would freeze it: entries in order, with each tool's name. */
export async function snapshotOfDraft(
  manager: EntityManager,
  toolset: ToolsetEntity,
): Promise<ToolsetSnapshot> {
  const rows = await manager.find(ToolsetEntryEntity, {
    where: { toolsetId: toolset.id },
    order: { position: 'ASC' },
  });
  const ids = rows.map((row) => row.toolId);
  const names = new Map(
    (ids.length ? await manager.find(ToolEntity, { where: { id: In(ids) } }) : []).map((tool) => [
      tool.id,
      tool.name,
    ]),
  );
  return {
    entries: rows.map((row) => ({
      toolId: row.toolId,
      toolName: names.get(row.toolId) ?? '',
      providerMode: row.providerMode,
      providerIds: [...row.providerIds],
      minTier: row.minTier,
      maxPrice:
        row.maxPriceAmount !== null && row.maxPriceAssetId && row.maxPriceDecimals !== null
          ? {
              amount: row.maxPriceAmount,
              asset: row.maxPriceAssetId,
              decimals: row.maxPriceDecimals,
            }
          : null,
      minQuality: row.minQuality === null ? null : Number(row.minQuality),
      toolVersionRange: row.toolVersionRange ?? null,
      requireOutputFields: [...row.requireOutputFields],
      onEmpty: row.onEmpty,
    })),
    discovery: toolset.discovery,
    searchThreshold: toolset.searchThreshold,
    pinnedTools: [...toolset.pinnedTools],
    name: toolset.name,
    description: toolset.description,
    icon: toolset.icon,
  };
}

/** At most {@link PUBLISHING_LIMITS.versionsPerToolsetPerDay} versions per UTC day (429 beyond). */
export async function assertVersionBudget(
  manager: EntityManager,
  toolsetId: string,
  now: Date,
): Promise<void> {
  const today = await manager.count(ToolsetVersionEntity, {
    where: { toolsetId, publishedAt: MoreThanOrEqual(startOfUtcDay(now)) },
  });
  if (today >= PUBLISHING_LIMITS.versionsPerToolsetPerDay) {
    throw ToolsetErrors.limitExceeded({
      limit: 'versionsPerToolsetPerDay',
      max: PUBLISHING_LIMITS.versionsPerToolsetPerDay,
    });
  }
}

/** The version a publish would diff against: the newest one, whatever it was shared as. */
export async function latestVersionSnapshot(
  manager: EntityManager,
  toolset: Pick<ToolsetEntity, 'id' | 'latestVersion'>,
): Promise<ToolsetSnapshot | null> {
  if (!toolset.latestVersion) return null;
  const row = await manager.findOne(ToolsetVersionEntity, {
    where: { toolsetId: toolset.id, version: toolset.latestVersion },
  });
  return row ? snapshotOfVersion(row) : null;
}

/**
 * Insert the next version, an immutable copy of `snapshot`, and write the
 * sharing state the machine returned onto the row.
 */
export async function writeNextVersion(
  manager: EntityManager,
  input: {
    readonly toolset: ToolsetEntity;
    readonly snapshot: ToolsetSnapshot;
    readonly next: SharingState;
    readonly changelog?: string | null;
    readonly now: Date;
  },
): Promise<{ version: number; changelog: string; diff: SnapshotDiff }> {
  const { toolset, snapshot, next, now } = input;
  const previous = await latestVersionSnapshot(manager, toolset);
  const diff = diffSnapshots(previous, snapshot);
  const version = (toolset.latestVersion ?? 0) + 1;
  const changelog = input.changelog?.trim() || changelogOf(diff, previous === null);

  await manager.insert(ToolsetVersionEntity, {
    toolsetId: toolset.id,
    version,
    entries: snapshot.entries as unknown as object,
    toolIds: snapshot.entries.map((entry) => entry.toolId),
    discovery: snapshot.discovery,
    searchThreshold: snapshot.searchThreshold,
    pinnedTools: [...snapshot.pinnedTools],
    name: snapshot.name,
    description: snapshot.description,
    icon: snapshot.icon,
    changelog,
    sharedAs: next.visibility,
    publishedAt: now,
  });
  await manager.update(
    ToolsetEntity,
    { id: toolset.id },
    {
      ...sharingPatchOf(next),
      latestVersion: version,
      lastSharedVersion: isShared(next) ? version : toolset.lastSharedVersion,
      lastPublicVersion:
        next.visibility === ToolsetVisibility.PUBLIC ? version : toolset.lastPublicVersion,
      updatedAt: now,
    },
  );
  return { version, changelog, diff };
}

export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
