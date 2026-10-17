import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * One version of a tool's contract: `tool_versions` (design spec §7.2, §7.5).
 *
 * `version` is the row's sequence number within the tool (1, 2, 3 …), the
 * number `tools.current_version` names; `semver` is the contract version a
 * person reads (`1.2.0`). `major` is `semver`'s first part, stored so a range
 * (`^1`) is an indexable comparison (`chk_tool_versions_major` keeps the two
 * in step).
 *
 * The state machine is DRAFT → ACTIVE → DEPRECATED → RETIRED. A DRAFT is the
 * one editable row of a tool (`uq_tool_versions_one_draft`); every other row
 * is immutable apart from its status and sunset.
 */
@Entity('tool_versions')
export class ToolVersionEntity {
  @PrimaryColumn({ name: 'tool_id', type: 'uuid' })
  toolId: string;

  @PrimaryColumn({ name: 'version', type: 'int' })
  version: number;

  @Column({ name: 'semver', type: 'varchar', length: 16 })
  semver: string;

  @Column({ name: 'major', type: 'int' })
  major: number;

  /** The only text sent in `tools/list`. At most 200 characters. */
  @Column({ name: 'summary', type: 'varchar', length: 200 })
  summary: string;

  /** Full documentation: `get_tool` and the catalogue page. */
  @Column({ name: 'description', type: 'text' })
  description: string;

  @Column({ name: 'input_schema', type: 'jsonb' })
  inputSchema: Record<string, unknown>;

  @Column({ name: 'output_schema', type: 'jsonb' })
  outputSchema: Record<string, unknown>;

  @Column({
    name: 'optional_input_fields',
    type: 'text',
    array: true,
    default: () => `'{}'::text[]`,
  })
  optionalInputFields: string[];

  @Column({
    name: 'optional_output_fields',
    type: 'text',
    array: true,
    default: () => `'{}'::text[]`,
  })
  optionalOutputFields: string[];

  /** `[{ title?, arguments, result? }]`. */
  @Column({ name: 'examples', type: 'jsonb', default: () => `'[]'::jsonb` })
  examples: unknown[];

  @Column({ name: 'verification_policy_id', type: 'varchar', length: 64, nullable: true })
  verificationPolicyId: string | null;

  /** `ToolTier`. */
  @Column({ name: 'tier', type: 'varchar', length: 16, nullable: true })
  tier: string | null;

  /** `DRAFT` | `ACTIVE` | `DEPRECATED` | `RETIRED` — `ToolVersionStatus`. */
  @Column({ name: 'status', type: 'varchar', length: 16 })
  status: string;

  @Column({ name: 'sunset_at', type: 'timestamptz', nullable: true })
  sunsetAt: Date | null;

  @Column({ name: 'changelog', type: 'varchar', length: 1000, nullable: true })
  changelog: string | null;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  /** The operator who drafted it; `null` for a seeded version. */
  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy: string | null;

  /** The operator who requested the publish (a second one approved it). */
  @Column({ name: 'published_by', type: 'uuid', nullable: true })
  publishedBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
