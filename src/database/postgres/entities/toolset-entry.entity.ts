import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * One tool of a toolset's Draft, with its provider rule (design spec §7.2,
 * FR-4). Ordered by {@link position}; `/my/{slug}` serves these rows live.
 */
@Entity('toolset_entries')
export class ToolsetEntryEntity {
  @PrimaryColumn({ name: 'toolset_id', type: 'uuid' })
  toolsetId: string;

  @PrimaryColumn({ name: 'position', type: 'int' })
  position: number;

  @Column({ name: 'tool_id', type: 'uuid' })
  toolId: string;

  /** T3: the contract major range this entry serves. */
  @Column({ name: 'tool_version_range', type: 'varchar', length: 32, nullable: true })
  toolVersionRange: string | null;

  /** `BEST` | `ONLY` | `EXCLUDE` — `ProviderMode`. */
  @Column({ name: 'provider_mode', type: 'varchar', length: 8, default: 'BEST' })
  providerMode: string;

  @Column({ name: 'provider_ids', type: 'uuid', array: true, default: () => `'{}'::uuid[]` })
  providerIds: string[];

  /** `ProviderTier`. */
  @Column({ name: 'min_tier', type: 'varchar', length: 16, nullable: true })
  minTier: string | null;

  /** Atomic units of {@link maxPriceAssetId}. */
  @Column({ name: 'max_price_amount', type: 'numeric', precision: 78, scale: 0, nullable: true })
  maxPriceAmount: string | null;

  @Column({ name: 'max_price_asset_id', type: 'varchar', length: 256, nullable: true })
  maxPriceAssetId: string | null;

  @Column({ name: 'max_price_decimals', type: 'int', nullable: true })
  maxPriceDecimals: number | null;

  /** 0..1. Stored; no effect until backlog G1.1. */
  @Column({ name: 'min_quality', type: 'numeric', precision: 4, scale: 3, nullable: true })
  minQuality: string | null;

  /** T3. */
  @Column({
    name: 'require_output_fields',
    type: 'text',
    array: true,
    default: () => `'{}'::text[]`,
  })
  requireOutputFields: string[];

  /** `FAIL` | `FALLBACK_BEST` — `OnEmpty`. */
  @Column({ name: 'on_empty', type: 'varchar', length: 16, default: 'FAIL' })
  onEmpty: string;
}
