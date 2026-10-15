import { Column, Entity, Index } from 'typeorm';
import { jsonbSafeTransformer } from './jsonb-safe.transformer';
import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * One call, handed to verification and judged.
 *
 * This row is three things at once, and it is one table rather than three
 * because all three are the same fact at different moments in its life:
 *
 * 1. **The worker's durable inbox.** `docs/adr/0001-bullmq-as-wakeup-mechanism.md`
 *    is explicit that a queue message is a *wakeup signal*, not storage. The
 *    provider's response is the evidence a verdict is derived from; carrying it
 *    only in a BullMQ payload would mean a flushed Redis loses the ability to
 *    judge — and therefore to resolve — every hold in flight. The response is
 *    written here, in the same breath as the intent reaching `VERIFYING`, and
 *    the job carries nothing but an id.
 * 2. **The verdict store.** The aggregator shipped `aggregate()` returning an
 *    `AggregatedVerdict` that was then dropped on the floor: the evidence half
 *    of every judgement — the verifier votes, the tally, the clause that
 *    decided — existed only in memory. The promote gate counts shadow calls and
 *    false positives it has no way to count without this table, which is why
 *    the gate was recorded as procedural rather than mechanical.
 * 3. **The receipt's evidence.** A receipt needs the per-stage rows, the policy
 *    versions and the sample rate for a call that happened weeks ago. A receipt
 *    assembled by re-running verification would be a *new* judgement wearing an
 *    old one's clothes.
 *
 * ## Why the state column is not the intent's status
 *
 * `payment_intents.status` says what the money did. `state` here says what the
 * *worker* did, and the two come apart in exactly the window that matters: an
 * intent is `VERIFYING` both before a verdict exists and after one exists but
 * before the hold was resolved. A worker that died between those two points
 * must be able to tell, on restart, which half of its job is outstanding — and
 * `JUDGED` is that answer. Inferring it from the intent's status would make the
 * crash-resume path guess.
 *
 * Never soft-deleted, like every financial record: this row is the reason a
 * provider was or was not paid.
 */
@Entity('verification_records')
@Index('idx_verification_records_state', ['state', 'createdAt'])
@Index('idx_verification_records_tool', ['organizationId', 'toolId', 'createdAt'])
export class VerificationRecordEntity extends OrganizationScopedEntityWithoutSoftDelete {
  /**
   * The call this judges. Unique — one verdict per intent, forever.
   *
   * The unique index is the idempotency guarantee for enqueueing: a retried
   * `tools/call` that somehow reached `VERIFYING` twice cannot create a second
   * record, so it cannot cause a second settlement.
   */
  @Column({ name: 'intent_id', type: 'uuid' })
  intentId: string;

  @Column({ name: 'tool_id', type: 'uuid' })
  toolId: string;

  /** Null only if the router never named one, which a judged call never is. */
  @Column({ name: 'provider_id', type: 'uuid', nullable: true })
  providerId: string | null;

  /** `PENDING` → `JUDGED` → `SETTLED`. See the class comment. */
  @Column({ name: 'state', type: 'varchar', length: 16 })
  state: string;

  // ── Evidence in ───────────────────────────────────────────────────────────

  /** The agent's arguments. Read by rules gated on the request. */
  @Column({
    name: 'request',
    type: 'jsonb',
    nullable: true,
    // U+0000 and lone surrogates are escaped reversibly — see the transformer.
    transformer: jsonbSafeTransformer,
  })
  request: unknown;

  /** The provider's response **after** the binding's response mapping. */
  @Column({
    name: 'response',
    type: 'jsonb',
    nullable: true,
    // U+0000 and lone surrogates are escaped reversibly — see the transformer.
    transformer: jsonbSafeTransformer,
  })
  response: unknown;

  /** The tool's `outputSchema` as it stood at call time, so a replay is honest. */
  @Column({ name: 'output_schema', type: 'jsonb', nullable: true })
  outputSchema: unknown;

  // ── Evidence out ──────────────────────────────────────────────────────────

  /** One of `VerdictStatus`. Null until judged. */
  @Column({ name: 'verdict_status', type: 'varchar', length: 32, nullable: true })
  verdictStatus: string | null;

  @Column({ name: 'reason_code', type: 'varchar', length: 64, nullable: true })
  reasonCode: string | null;

  @Column({ name: 'reason', type: 'varchar', length: 512, nullable: true })
  reason: string | null;

  /**
   * `0..1`, or null where nothing scored.
   *
   * `double precision`, not `numeric`: this is a probability, never a balance.
   * The one rule about money in this schema — exact decimal arithmetic — does
   * not apply to it, and storing it as `numeric` would suggest it does.
   */
  @Column({ name: 'score', type: 'double precision', nullable: true })
  score: number | null;

  /** What obtaining the evidence cost. An ops number, not a receipt line. */
  @Column({ name: 'cost_usd', type: 'double precision', nullable: true })
  costUsd: number | null;

  /** The `VerificationPolicy` whose checks produced the votes. */
  @Column({ name: 'policy_id', type: 'varchar', length: 128, nullable: true })
  policyId: string | null;

  @Column({ name: 'policy_version', type: 'int', nullable: true })
  policyVersion: number | null;

  /**
   * The `DecisionPolicy` that turned those votes into a status.
   *
   * Both pairs are stored because both change independently, and a dispute that
   * knows only one of them cannot be replayed.
   */
  @Column({ name: 'decision_policy_id', type: 'varchar', length: 128, nullable: true })
  decisionPolicyId: string | null;

  @Column({ name: 'decision_policy_version', type: 'int', nullable: true })
  decisionPolicyVersion: number | null;

  /** One of `PolicyLifecycle` — how a shadow verdict is told from a live one. */
  @Column({ name: 'lifecycle', type: 'varchar', length: 16, nullable: true })
  lifecycle: string | null;

  // ── Sampling ──────────────────────────────────────────────────────────────

  /**
   * The derived semantic sample rate, `0..1`. Published on the receipt.
   *
   * The rate must be visible to the agent, and it is per-call: it derives from
   * this call's platform fee, so two calls on one tool at different prices are
   * sampled at different rates.
   */
  @Column({ name: 'sample_rate', type: 'double precision', nullable: true })
  sampleRate: number | null;

  @Column({ name: 'sampled', type: 'boolean', nullable: true })
  sampled: boolean | null;

  /**
   * The HMAC draw, `0..1`, kept so the selection is reproducible.
   *
   * The sample-selection proof is a proof rather than an assertion only because
   * the draw is `HMAC-SHA256(secret, intentId)` and this column records what it
   * came out as.
   */
  @Column({ name: 'sample_selector', type: 'double precision', nullable: true })
  sampleSelector: number | null;

  /** The published sentence — "1 in 13 calls", verbatim on the receipt. */
  @Column({ name: 'sample_display', type: 'varchar', length: 128, nullable: true })
  sampleDisplay: string | null;

  // ── The working ───────────────────────────────────────────────────────────

  /**
   * All four pipeline stages, in order, as `StageResult[]`.
   *
   * Always four entries once judged. A receipt must never omit a stage — an
   * absent row reads as a tick to anyone scanning a list — so the absence is
   * impossible at the storage layer rather than guarded at each renderer.
   */
  @Column({ name: 'stages', type: 'jsonb', nullable: true, transformer: jsonbSafeTransformer })
  stages: unknown;

  /** Every declared verifier's vote, in declaration order. */
  @Column({ name: 'verifiers', type: 'jsonb', nullable: true, transformer: jsonbSafeTransformer })
  verifiers: unknown;

  /** The quorum arithmetic, so a receipt can show its working. */
  @Column({ name: 'tally', type: 'jsonb', nullable: true, transformer: jsonbSafeTransformer })
  tally: unknown;

  /** Which clause decided, or the `otherwise` default. */
  @Column({ name: 'decided_by', type: 'jsonb', nullable: true, transformer: jsonbSafeTransformer })
  decidedBy: unknown;

  /** The instant the verdict was evaluated at — injected, never `now()`. */
  @Column({ name: 'evaluated_at', type: 'timestamptz', nullable: true })
  evaluatedAt: Date | null;

  // ── Settlement ────────────────────────────────────────────────────────────

  /** `SETTLE` | `REFUND` | `VOID` — the instruction, once the verdict resolved. */
  @Column({ name: 'settlement_outcome', type: 'varchar', length: 16, nullable: true })
  settlementOutcome: string | null;

  /** When the hold was actually resolved. Null while `JUDGED` and unsettled. */
  @Column({ name: 'settled_at', type: 'timestamptz', nullable: true })
  settledAt: Date | null;

  /**
   * How many times a worker has picked this record up.
   *
   * Not a retry budget — BullMQ owns that. It is the signal that a record is
   * being picked up repeatedly and failing, which is what a poison job looks
   * like from the outside.
   */
  @Column({ name: 'attempts', type: 'int', default: 0 })
  attempts: number;

  /** The last failure, so a stuck record explains itself without a log search. */
  @Column({ name: 'last_error', type: 'varchar', length: 512, nullable: true })
  lastError: string | null;
}
