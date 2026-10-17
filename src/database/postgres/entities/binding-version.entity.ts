import { Column, Entity, Index } from 'typeorm';

import {
  RequestMappingSpec,
  ResponseMappingSpec,
} from '@modules/tool/domain/mapping/mapping.types';

import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * One immutable snapshot per saved revision of a binding.
 *
 * `docs/mapping-format.md` §Versioning states the requirement and the failure
 * it prevents: *"a provider who edits a mapping mid-window and a platform
 * disputing a result have no way to agree on which version produced the
 * response, and the dispute is unwinnable in both directions."* A verdict names
 * `(bindingId, mappingVersion)`; this table is where that name resolves to the
 * actual mappings, months later, after the live row has moved on.
 *
 * **Nothing updates a row here.** The class carries `updatedAt` and `version`
 * only because they come with the shared base; no code path writes them a
 * second time. An editable snapshot would make every verdict's citation a
 * claim nobody can check, which is precisely the property the table exists to
 * provide.
 *
 * The columns duplicate `tool_bindings` on purpose. A snapshot that stored
 * only the mappings and joined the rest would re-read a price, an endpoint and
 * a timeout that have since changed — and the price in force is exactly what a
 * settlement dispute is about.
 */
@Entity('binding_versions')
@Index('idx_binding_versions_binding_id', ['bindingId'])
export class BindingVersionEntity extends OrganizationScopedEntityWithoutSoftDelete {
  @Column({ name: 'binding_id', type: 'uuid' })
  bindingId: string;

  /** The revision this snapshot *is*. Unique per binding. */
  @Column({ name: 'mapping_version', type: 'int' })
  mappingVersion: number;

  @Column({ name: 'tool_id', type: 'varchar', length: 128 })
  toolId: string;

  @Column({ name: 'endpoint', type: 'varchar', length: 2048 })
  endpoint: string;

  @Column({ name: 'request_mapping', type: 'jsonb' })
  requestMapping: RequestMappingSpec;

  @Column({ name: 'response_mapping', type: 'jsonb' })
  responseMapping: ResponseMappingSpec;

  @Column({ name: 'pricing_mode', type: 'varchar', length: 16 })
  pricingMode: string;

  @Column({ name: 'price_amount', type: 'numeric', precision: 78, scale: 0 })
  priceAmount: string;

  @Column({ name: 'asset_id', type: 'varchar', length: 256 })
  assetId: string;

  @Column({ name: 'timeout_ms', type: 'int' })
  timeoutMs: number;

  /** The revision's contract range and declared optional fields (T3). */
  @Column({ name: 'tool_version_range', type: 'varchar', length: 32, default: '^1' })
  toolVersionRange: string;

  @Column({
    name: 'provides_output_fields',
    type: 'text',
    array: true,
    default: () => `'{}'::text[]`,
  })
  providesOutputFields: string[];

  @Column({
    name: 'supports_input_fields',
    type: 'text',
    array: true,
    default: () => `'{}'::text[]`,
  })
  supportsInputFields: string[];

  /** Who saved this revision. A session subject, not a display name. */
  @Column({ name: 'authored_by', type: 'varchar', length: 128 })
  authoredBy: string;

  /**
   * When this revision went live, or `null` for one that never did.
   *
   * A revision can be saved, superseded and never published — that is the
   * normal shape of drafting — so publication is a fact about the snapshot
   * rather than a state of the binding.
   */
  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @Column({ name: 'published_by', type: 'varchar', length: 128, nullable: true })
  publishedBy: string | null;
}
