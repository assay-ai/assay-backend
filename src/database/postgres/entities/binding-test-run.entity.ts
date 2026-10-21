import { Column, Entity, Index } from 'typeorm';

import { BindingTestReport } from '@modules/provider/ports/binding-test.types';
import { JsonObject } from '@modules/tool/domain/mapping/mapping.types';

import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * What the mapping tester saw, kept.
 *
 * Three callers, and the third is the reason this is a table rather than a
 * response body:
 *
 * 1. **The console** shows the last run beside the editor.
 * 2. **The publish gate** requires a `PASSED` run *at the binding's current
 *    `mapping_version`*. Storing the revision with the run is what closes the
 *    test-then-edit hole: an edit raises `mapping_version` and the green run no
 *    longer refers to what is about to be published.
 * 3. **A provider reconciling their own logs.** The tester dials their endpoint
 *    for real and sends a real `X-Assay-Call-Id`. A sandbox run deliberately
 *    creates no `payment_intents` row — it must never touch money — so this
 *    table is the only record on our side that a call with that id happened,
 *    and `uq_binding_test_runs_call_id` makes it resolvable.
 *
 * Nothing here is charged, held or settled. That is asserted by a test that
 * reads every ledger balance before and after a run, not by this comment.
 */
@Entity('binding_test_runs')
@Index('idx_binding_test_runs_binding_revision', ['bindingId', 'mappingVersion', 'createdAt'])
export class BindingTestRunEntity extends OrganizationScopedEntityWithoutSoftDelete {
  @Column({ name: 'binding_id', type: 'uuid' })
  bindingId: string;

  /** Which revision of the mappings this run exercised. See the class comment. */
  @Column({ name: 'mapping_version', type: 'int' })
  mappingVersion: number;

  /**
   * The contract version (`tool_versions.version`) the run was checked
   * against; `null` on a run recorded before contracts had versions. The
   * publish gate wants a green run per major in the binding's range.
   */
  @Column({ name: 'tool_version', type: 'int', nullable: true })
  toolVersion: number | null;

  /**
   * The binding's `auth_mode` when the run was made. A run counts only for
   * that mode (the mode changes the call); `null` on a run recorded before
   * the column, which then counts only at its own revision.
   */
  @Column({ name: 'auth_mode', type: 'varchar', length: 16, nullable: true })
  authMode: string | null;

  /** The id sent upstream as `X-Assay-Call-Id`. Unique platform-wide. */
  @Column({ name: 'call_id', type: 'uuid' })
  callId: string;

  /** `PASSED` | `FAILED` — `BindingTestOutcome`. */
  @Column({ name: 'outcome', type: 'varchar', length: 16 })
  outcome: string;

  /**
   * Which layer stopped the run being green, `null` on a pass —
   * `BindingTestLayer`. "Stopped it" rather than "failed": a verification
   * layer that could not conclude (`MISAPPLIED`, `DEGRADED`) is nobody's
   * fault and still ends the run here.
   *
   * A column rather than a field dug out of {@link report}, because "how many
   * runs died at the upstream layer this week" is a question an operator asks
   * about a whole table, and a `jsonb` path is not something to answer it with.
   */
  @Column({ name: 'failed_layer', type: 'varchar', length: 24, nullable: true })
  failedLayer: string | null;

  /** The tool arguments the run was made with. Replayable, deliberately. */
  @Column({ name: 'sample_input', type: 'jsonb' })
  sampleInput: JsonObject;

  /** The whole layer-by-layer report, exactly as the console rendered it. */
  @Column({ name: 'report', type: 'jsonb' })
  report: BindingTestReport;

  /** The session subject who pressed Run. */
  @Column({ name: 'ran_by', type: 'varchar', length: 128 })
  ranBy: string;
}
