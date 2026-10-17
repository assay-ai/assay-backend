import { ToolsetEntity } from '@database/postgres/entities/toolset.entity';

import { ListingStatus, SharingState, ToolsetVisibility } from '../domain/sharing';

/** A `toolsets` row's sharing columns as the state machine reads them. */
export function sharingStateOf(row: ToolsetEntity): SharingState {
  return {
    visibility: row.visibility as ToolsetVisibility,
    listingStatus: (row.listingStatus as ListingStatus | null) ?? null,
    graceVisibility: (row.graceVisibility as SharingState['graceVisibility']) ?? null,
    graceUntil: row.graceUntil ? new Date(row.graceUntil) : null,
    unlistedToken: row.unlistedToken ?? null,
    removedAt: row.removedAt ? new Date(row.removedAt) : null,
    deletedAt: row.deletedAt ? new Date(row.deletedAt) : null,
    delistedAt: row.delistedAt ? new Date(row.delistedAt) : null,
    firstSharedAt: row.firstSharedAt ? new Date(row.firstSharedAt) : null,
  };
}

/** The columns to write for a state the machine returned. */
export function sharingPatchOf(state: SharingState): Partial<ToolsetEntity> {
  return {
    visibility: state.visibility,
    listingStatus: state.listingStatus,
    graceVisibility: state.graceVisibility,
    graceUntil: state.graceUntil,
    unlistedToken: state.unlistedToken,
    removedAt: state.removedAt,
    deletedAt: state.deletedAt,
    delistedAt: state.delistedAt,
    firstSharedAt: state.firstSharedAt,
  };
}
