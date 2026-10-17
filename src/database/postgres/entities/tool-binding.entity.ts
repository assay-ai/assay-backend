import { Column, Entity, Index } from 'typeorm';

import {
  RequestMappingSpec,
  ResponseMappingSpec,
} from '@modules/tool/domain/mapping/mapping.types';

import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * One provider's implementation of one tool, as a row at last.
 *
 * `ToolBinding` was first defined as a type and the table left for later,
 * because the table only makes sense once something writes to it, and the thing
 * that writes to it is a provider in a console.
 *
 * ## `organizationId` **is** the provider id
 *
 * There is no `provider_id` column. `providerId === organizationId` is an
 * equivalence the whole provider surface already rests on —
 * `ProviderProfileService`, `ProviderPayoutsService`, `ProviderEarningsService`
 * and `providers.organization_id`'s own `UNIQUE` — and a second column holding
 * the same value is a second identity that can disagree with the first. The
 * mapper to the domain `ToolBinding` sets `providerId` from it at one place.
 *
 * ## No soft delete
 *
 * A binding is named by every verdict, receipt and dispute that ever routed
 * through it. `WithoutSoftDelete` for the same reason `payment_intents` has
 * none, plus a mechanical one: `deleted_at IS NULL` filtering would hide a row
 * that `uq_tool_bindings_organization_tool` still counts, so the delete a
 * provider *thinks* they did would block the binding they are trying to
 * recreate. Retiring a binding is `SUSPENDED`, which is a state the router
 * already reads.
 *
 * ## Two numbers called version
 *
 * {@link version} (inherited) is TypeORM's optimistic lock. {@link mappingVersion}
 * is the domain's `ToolBinding.version` — which stored revision of the two
 * mappings this is, the number a dispute has to agree on months later. They
 * are unrelated and they move for unrelated reasons; see the migration.
 */
@Entity('tool_bindings')
@Index('idx_tool_bindings_tool_id_status', ['toolId', 'status'])
export class ToolBindingEntity extends OrganizationScopedEntityWithoutSoftDelete {
  /**
   * The tool this implements: `tools.id` (`fk_tool_bindings_tool`). The seeded
   * tools are mirrored into `tools` at boot by `ToolRegistrySeeder`.
   */
  @Column({ name: 'tool_id', type: 'uuid' })
  toolId: string;

  /** The provider's own URL, unchanged. `requestMapping.path` is appended to it. */
  @Column({ name: 'endpoint', type: 'varchar', length: 2048 })
  endpoint: string;

  /**
   * Canonical form only.
   *
   * The shorthand a provider types (`"$.query"`, `"en"`) survives exactly one
   * function call — `normalizeMappingNode` at Save — and what lands here is
   * already resolved, so nothing downstream re-derives whether `"en"` was a
   * path or a constant. See `docs/mapping-format.md` §Shorthand.
   */
  @Column({ name: 'request_mapping', type: 'jsonb' })
  requestMapping: RequestMappingSpec;

  @Column({ name: 'response_mapping', type: 'jsonb' })
  responseMapping: ResponseMappingSpec;

  @Column({ name: 'pricing_mode', type: 'varchar', length: 16 })
  pricingMode: string;

  /** Minor units, as a string — `numeric(78,0)`, like every other money column. */
  @Column({ name: 'price_amount', type: 'numeric', precision: 78, scale: 0 })
  priceAmount: string;

  @Column({ name: 'asset_id', type: 'varchar', length: 256 })
  assetId: string;

  /**
   * CAIP-2. Which chains this binding is offered on.
   *
   * Non-empty, enforced by `chk_tool_bindings_settlement_chains`. The
   * provider's declaration and nothing more — routability on a chain also
   * requires an ACTIVE enrolment there holding stake at or above that chain's
   * minimum, and the router re-reads that rather than trusting this column.
   */
  @Column({ name: 'settlement_chains', type: 'varchar', length: 64, array: true })
  settlementChains: string[];

  @Column({ name: 'free_quota_per_agent', type: 'int', nullable: true })
  freeQuotaPerAgent: number | null;

  /**
   * The most free calls this binding serves per day, across all agents — a call
   * **count**, not money (BUG-R17g-01). `null` is the platform default
   * (`DEFAULT_PROVIDER_DAILY_BUDGET`). The `numeric(78,0)` column is historical;
   * the API bounds the value to a positive int4.
   */
  @Column({ name: 'free_daily_budget', type: 'numeric', precision: 78, scale: 0, nullable: true })
  freeDailyBudget: string | null;

  /** The provider's own declaration, e.g. `0.05` for 5%. Read by the SLA windows. */
  @Column({ name: 'sla_failure_rate', type: 'numeric', precision: 6, scale: 5 })
  slaFailureRate: string;

  @Column({ name: 'timeout_ms', type: 'int' })
  timeoutMs: number;

  /** `DRAFT` | `ACTIVE` | `PAUSED` | `SUSPENDED` — `BindingStatus`. */
  @Column({ name: 'status', type: 'varchar', length: 16, default: 'DRAFT' })
  status: string;

  /**
   * The current revision of the two mappings — the domain's `ToolBinding.version`.
   *
   * Raised by every save that changes a mapping, the endpoint, the price or the
   * timeout. Not raised by a status change: pausing a binding does not change
   * what it maps, and a verdict naming revision 4 must still find revision 4's
   * mappings.
   */
  @Column({ name: 'mapping_version', type: 'int', default: 1 })
  mappingVersion: number;

  /**
   * Which revision is live, or `null` for a binding that has never published.
   *
   * The gap between this and {@link mappingVersion} is the product concept
   * "you have unpublished changes" — and, more importantly, it is what stops a
   * mapping edited *after* a green tester run from reaching traffic: the
   * publish gate requires a passing run at `mappingVersion`, and an edit moves
   * that number out from under the run.
   */
  @Column({ name: 'published_version', type: 'int', nullable: true })
  publishedVersion: number | null;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  /**
   * The provider's declared requests-per-second ceiling, or `null` for none.
   *
   * `null` and `0` are not the same thing: `null` is "no ceiling declared",
   * `0` would be a provider declaring themselves unroutable — and a provider
   * who wants that has {@link status} `PAUSED`.
   *
   * Read by the router to *shed* rather than to fail. A call refused against a
   * declared ceiling is a routing decision taken before the attempt, so it
   * carries a `CeilingKind` and is excluded from availability; the same event
   * without the declaration is an upstream `429` that lands on the provider's
   * own quality profile. That difference is the entire point of the column.
   */
  @Column({ name: 'max_rps', type: 'int', nullable: true })
  maxRps: number | null;

  /**
   * The provider's declared calls-per-day ceiling, or `null` for none.
   *
   * **Not** a "quota". That word is taken in this codebase and means the
   * *agent's* free-tier allowance — {@link freeQuotaPerAgent} and
   * {@link freeDailyBudget}, two fields up. This is the *provider's* own
   * upstream limit, `maxDailyCalls`.
   */
  @Column({ name: 'max_daily_calls', type: 'int', nullable: true })
  maxDailyCalls: number | null;

  /**
   * Who stopped the traffic — set exactly when {@link status} is `PAUSED`.
   *
   * `PAUSED` has two causes with opposite consequences: the provider's own
   * pause takes **no strike and leaves no mark in the quality profile**, while
   * the SLA monitor opening the health circuit is a fault that must be
   * recorded. One status value cannot carry both, and the cause is
   * unrecoverable after the fact, so it is written at the moment of pausing or
   * never.
   *
   * `chk_tool_bindings_pause_attributed` is the biconditional: never a pause
   * without a reason, never a reason on a binding that is serving.
   */
  @Column({ name: 'pause_reason', type: 'varchar', length: 24, nullable: true })
  pauseReason: string | null;

  /**
   * The contract majors this binding serves: `^1`, or `^1 || ^2` (design spec
   * §7.2, §7.5). Each major in it needs a green tester run at the revision
   * being published, and its mapping is checked against that major's
   * contract at save.
   */
  @Column({ name: 'tool_version_range', type: 'varchar', length: 32, default: '^1' })
  toolVersionRange: string;

  /** The contract's optional output fields this binding promises to return. */
  @Column({
    name: 'provides_output_fields',
    type: 'text',
    array: true,
    default: () => `'{}'::text[]`,
  })
  providesOutputFields: string[];

  /** The contract's optional input fields this binding passes on to its endpoint. */
  @Column({
    name: 'supports_input_fields',
    type: 'text',
    array: true,
    default: () => `'{}'::text[]`,
  })
  supportsInputFields: string[];

  /**
   * When the pause began, written alongside {@link pauseReason}.
   *
   * Only the reason is constrained. This is a timestamp for a countdown and a
   * screen, and a stale one left behind by a resume is a display bug; a stale
   * *reason* would be a wrong answer to "why did my traffic stop".
   */
  @Column({ name: 'paused_at', type: 'timestamptz', nullable: true })
  pausedAt: Date | null;
}
