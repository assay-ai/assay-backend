/**
 * The policy lifecycle.
 *
 * ```text
 *   register ──▶ DRAFT ──beginShadow──▶ SHADOW ──promote──▶ ACTIVE
 *                                        ▲   │ gate           │
 *                                        │   └─ refused ──────┘
 *                                 reinstate                   │
 *                                        │                    │
 *                                     WITHDRAWN ◀──withdraw───┘   (and from SHADOW)
 *                                                                  ▲
 *                                                        kill switch, no deploy
 * ```
 *
 * Three properties this class is responsible for, each stated as what it
 * refuses rather than what it does:
 *
 * **It never returns `ACTIVE` for a policy that did not pass the gate.**
 * `resolveForTraffic` derives the lifecycle from the stored column, and the
 * column cannot say `ACTIVE` without a promotion record — a CHECK constraint,
 * not a convention. A policy document that declares itself active is ignored;
 * see `enforces()` in `../domain/aggregation/decision-policy.types.ts`.
 *
 * **It never edits a version.** A change is a new version. Every verdict names
 * the `(policyId, version)` that decided it, and an editable version makes that
 * name a lie the moment somebody fixes a typo.
 *
 * **It reads the kill switch on every resolve.** Synchronously, from a local
 * snapshot — see `../ports/policy-kill-switch.port.ts` for why that is the
 * signature and what the resulting SLA is.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { VerificationPolicyEntity, VerificationPolicyRepository } from '@database/postgres';

import { DecisionPolicy, PolicyLifecycle, validateDecisionPolicy } from '../domain/aggregation';
import { KillRecord, KillScope } from '../domain/lifecycle/kill-switch';
import { PromotionEvidence, evaluatePromotion } from '../domain/lifecycle/promotion';
import { VerificationPolicy } from '../domain/policy.types';
import { VerificationErrors } from '../errors/verification.errors';
import { POLICY_KILL_SWITCH, PolicyKillSwitchPort } from '../ports/policy-kill-switch.port';

/** What the aggregator needs to judge one call. */
export interface ResolvedPolicy {
  readonly decisionPolicy: DecisionPolicy;
  /** The schema and deterministic-rule checks, when this policy runs any locally. */
  readonly verificationPolicy: VerificationPolicy | null;
  /**
   * The lifecycle **as resolved**, which is not always the stored one:
   * a kill switch covering this version resolves it to `WITHDRAWN`.
   */
  readonly lifecycle: PolicyLifecycle;
  /** The withdrawal that downgraded it, when one did. */
  readonly withdrawal: KillRecord | null;
}

export interface RegisterPolicyInput {
  /**
   * The document, without a version — this class assigns it.
   *
   * Assigned rather than accepted so an author cannot re-register `v3` with
   * different clauses and silently change what every verdict naming `v3`
   * means. The unique index would refuse the second write; taking the choice
   * away means nobody has to hit it.
   */
  readonly draft: Omit<DecisionPolicy, 'version'>;
  readonly verificationPolicy?: VerificationPolicy;
  readonly createdBy: string;
  /**
   * `DRAFT` (default) or `SHADOW`. Never `ACTIVE`: that edge is the gate, and
   * a register call that could land on it would be the gate's bypass.
   */
  readonly startIn?: PolicyLifecycle.DRAFT | PolicyLifecycle.SHADOW;
}

@Injectable()
export class DecisionPolicyService {
  private readonly logger = new Logger(DecisionPolicyService.name);

  constructor(
    private readonly policies: VerificationPolicyRepository,
    @Inject(POLICY_KILL_SWITCH) private readonly killSwitch: PolicyKillSwitchPort,
  ) {}

  /**
   * The policy that decides calls for this tool, or `null` if there is none.
   *
   * `null` is a real answer and the caller must handle it: a tool with no
   * policy is unverified, and unverified settles. Inventing a default policy
   * here would be inventing a rule nobody wrote and then striking providers
   * with it.
   */
  async resolveForTraffic(toolId: string): Promise<ResolvedPolicy | null> {
    const row = await this.policies.findServing(toolId);
    if (!row) return null;

    const stored = row.lifecycle as PolicyLifecycle;

    // The live switch first, the durable record second. They are normally the
    // same fact written twice, and the order matters exactly when they are not:
    // `withdraw()` writes Redis before Postgres, so a call arriving between the
    // two must still see the withdrawal. The row is the fallback for the
    // opposite gap — a Redis entry expired or flushed after the row was already
    // moved — and reading it means a withdrawn policy cannot quietly resume
    // enforcing because a cache lost an entry.
    const withdrawal =
      this.killSwitch.isKilled(row.policyId, row.policyVersion) ??
      (stored === PolicyLifecycle.WITHDRAWN ? withdrawalFromRow(row) : null);

    return {
      decisionPolicy: row.decisionDocument as unknown as DecisionPolicy,
      verificationPolicy: (row.verificationDocument as unknown as VerificationPolicy) ?? null,
      lifecycle: withdrawal ? PolicyLifecycle.WITHDRAWN : stored,
      withdrawal,
    };
  }

  /**
   * Registers the next version of a policy. Validated before it is stored.
   *
   * Every method that writes takes an optional `manager`: given, every read
   * and write goes through it, so the change commits or rolls back with the
   * caller's transaction (the operator override log's).
   */
  async register(input: RegisterPolicyInput, manager?: EntityManager): Promise<DecisionPolicy> {
    const version = (await this.policies.latestVersion(input.draft.id, manager)) + 1;
    const decisionPolicy: DecisionPolicy = { ...input.draft, version };

    // Before the write, so a policy that could strike somebody for the wrong
    // reason never reaches a row a resolver could pick up.
    validateDecisionPolicy(decisionPolicy);

    const lifecycle = input.startIn ?? PolicyLifecycle.DRAFT;
    if (lifecycle === PolicyLifecycle.SHADOW) {
      await this.archiveShadowFor(decisionPolicy.toolId, manager);
    }

    const entity = new VerificationPolicyEntity();
    entity.policyId = decisionPolicy.id;
    entity.policyVersion = version;
    entity.toolId = decisionPolicy.toolId;
    entity.lifecycle = lifecycle;
    entity.decisionDocument = decisionPolicy as unknown as Record<string, unknown>;
    entity.verificationDocument =
      (input.verificationPolicy as unknown as Record<string, unknown>) ?? null;
    entity.createdBy = input.createdBy;
    entity.promotedAt = null;
    entity.promotedBy = null;
    entity.promotionEvidence = null;
    entity.withdrawnAt = null;
    entity.withdrawnBy = null;
    entity.withdrawnReason = null;

    await this.policies.on(manager).save(entity);

    this.logger.log(
      `Registered ${decisionPolicy.id} v${version} for tool ${decisionPolicy.toolId} in ${lifecycle}`,
    );
    return decisionPolicy;
  }

  /** `DRAFT` → `SHADOW`. Starts collecting the evidence the gate asks for. */
  async beginShadow(policyId: string, version: number, manager?: EntityManager): Promise<void> {
    const row = await this.require(policyId, version, manager);
    await this.archiveShadowFor(row.toolId, manager);

    const moved = await this.policies.transitionIfInLifecycle(
      policyId,
      version,
      PolicyLifecycle.DRAFT,
      PolicyLifecycle.SHADOW,
      {},
      manager,
    );
    if (moved === 0) {
      throw VerificationErrors.policyTransitionLost({
        policyId,
        version,
        expected: PolicyLifecycle.DRAFT,
      });
    }
  }

  /**
   * The promote gate. `SHADOW` → `ACTIVE`, and the only edge that lets a policy
   * take money.
   *
   * Refuses with every unmet bar at once rather than the first — see
   * `evaluatePromotion`. The evidence is stored on the row whether or not it
   * was enough, because "we tried to promote this on 40 samples" is exactly
   * what an incident review wants and exactly what gets lost otherwise.
   */
  async promote(
    policyId: string,
    version: number,
    evidence: PromotionEvidence,
    manager?: EntityManager,
  ): Promise<void> {
    const row = await this.require(policyId, version, manager);
    const decision = evaluatePromotion(row.lifecycle as PolicyLifecycle, evidence);

    if (!decision.promotable) {
      throw VerificationErrors.policyPromotionRefused({
        policyId,
        version,
        reasons: decision.failures.map((failure) => failure.detail).join(' '),
        failures: decision.failures,
        falsePositiveRate: decision.falsePositiveRate,
      });
    }

    // At most one ACTIVE version per tool, enforced by a partial unique index —
    // so the outgoing one is archived first, in its own statement, rather than
    // discovered as a constraint violation halfway through a promotion.
    await this.archiveActiveFor(row.toolId, manager);

    const moved = await this.policies.transitionIfInLifecycle(
      policyId,
      version,
      PolicyLifecycle.SHADOW,
      PolicyLifecycle.ACTIVE,
      {
        promotedAt: new Date(),
        promotedBy: evidence.approvedBy,
        promotionEvidence: {
          ...evidence,
          falsePositiveRate: decision.falsePositiveRate,
        } as unknown as Record<string, unknown>,
      },
      manager,
    );

    if (moved === 0) {
      throw VerificationErrors.policyTransitionLost({
        policyId,
        version,
        expected: PolicyLifecycle.SHADOW,
      });
    }

    this.logger.warn(
      `Promoted ${policyId} v${version} to ACTIVE — approved by ${evidence.approvedBy}, ` +
        `false-positive rate ${decision.falsePositiveRate ?? 'n/a'}`,
    );
  }

  /**
   * The kill switch, from the operator's side.
   *
   * **Redis first, Postgres second, and the order is the whole design.** The
   * Redis write is what stops the policy being applied, in every process,
   * within the refresh bound; the row is the durable record of why. If the
   * database write fails the policy is still withdrawn everywhere, which is the
   * failure mode to prefer — an incident where the switch worked and the audit
   * row is missing is recoverable, and one where the audit row is perfect and
   * the policy kept slashing people is not.
   *
   * Given a `manager`, the row moves inside the caller's transaction and a
   * failure there is rethrown (a statement that failed has aborted that
   * transaction, so swallowing it would only fail the next one). The switch
   * stays engaged either way. Without one, the row is best effort as before.
   */
  async withdraw(
    policyId: string,
    version: number,
    reason: string,
    actor: string,
    manager?: EntityManager,
  ): Promise<KillRecord> {
    const record = await this.killSwitch.kill(
      { scope: KillScope.POLICY_VERSION, policyId, version },
      reason,
      actor,
    );

    if (manager) {
      if ((await this.withdrawRow(policyId, version, reason, actor, manager)) === 0) {
        throw VerificationErrors.policyTransitionLost({
          policyId,
          version,
          expected: `${PolicyLifecycle.ACTIVE} or ${PolicyLifecycle.SHADOW}`,
        });
      }
      return record;
    }

    try {
      await this.withdrawRow(policyId, version, reason, actor);
    } catch (error) {
      this.logger.error(
        `Kill switch engaged on ${policyId} v${version} but the audit row was not written`,
        error as Error,
      );
    }

    return record;
  }

  /**
   * Puts a withdrawn policy back — into `SHADOW`, never straight into `ACTIVE`.
   *
   * A policy that was pulled has to re-earn enforcement through the gate. That
   * is deliberately inconvenient: the reinstatement of a policy somebody
   * withdrew during an incident is precisely the moment a shortcut looks
   * reasonable and is not. The stored `promotion_evidence` survives on the row,
   * so re-promoting is resubmitting evidence, not regathering it.
   */
  async reinstate(policyId: string, version: number, actor: string): Promise<void> {
    await this.killSwitch.revive({ scope: KillScope.POLICY_VERSION, policyId, version }, actor);
    await this.archiveShadowFor((await this.require(policyId, version)).toolId);

    const moved = await this.policies.transitionIfInLifecycle(
      policyId,
      version,
      PolicyLifecycle.WITHDRAWN,
      PolicyLifecycle.SHADOW,
      { withdrawnAt: null, withdrawnBy: null, withdrawnReason: null },
    );
    if (moved === 0) {
      throw VerificationErrors.policyTransitionLost({
        policyId,
        version,
        expected: PolicyLifecycle.WITHDRAWN,
      });
    }
  }

  /** ACTIVE or SHADOW → WITHDRAWN; the number of rows moved. */
  private async withdrawRow(
    policyId: string,
    version: number,
    reason: string,
    actor: string,
    manager?: EntityManager,
  ): Promise<number> {
    for (const from of [PolicyLifecycle.ACTIVE, PolicyLifecycle.SHADOW]) {
      const moved = await this.policies.transitionIfInLifecycle(
        policyId,
        version,
        from,
        PolicyLifecycle.WITHDRAWN,
        { withdrawnAt: new Date(), withdrawnBy: actor, withdrawnReason: reason },
        manager,
      );
      if (moved > 0) return moved;
    }
    return 0;
  }

  private async require(
    policyId: string,
    version: number,
    manager?: EntityManager,
  ): Promise<VerificationPolicyEntity> {
    const row = await this.policies.findVersion(policyId, version, manager);
    if (!row) {
      throw VerificationErrors.policyVersionNotFound({ policyId, version });
    }
    return row;
  }

  private async archiveActiveFor(toolId: string, manager?: EntityManager): Promise<void> {
    await this.archiveFor(toolId, PolicyLifecycle.ACTIVE, manager);
  }

  private async archiveShadowFor(toolId: string, manager?: EntityManager): Promise<void> {
    await this.archiveFor(toolId, PolicyLifecycle.SHADOW, manager);
  }

  private async archiveFor(
    toolId: string,
    from: PolicyLifecycle,
    manager?: EntityManager,
  ): Promise<void> {
    const current = await this.policies.on(manager).findOne({ where: { toolId, lifecycle: from } });
    if (!current) return;

    await this.policies.transitionIfInLifecycle(
      current.policyId,
      current.policyVersion,
      from,
      PolicyLifecycle.ARCHIVED,
      {},
      manager,
    );
  }
}

/**
 * The stored withdrawal, in the shape the live switch would have produced.
 *
 * One shape for two sources, so nothing downstream — the receipt, the metric,
 * the incident review — has to know whether a withdrawal was learned from Redis
 * or from the row.
 */
function withdrawalFromRow(row: VerificationPolicyEntity): KillRecord {
  return {
    key: `policy:${row.policyId}@${row.policyVersion}`,
    scope: KillScope.POLICY_VERSION,
    policyId: row.policyId,
    version: row.policyVersion,
    reason: row.withdrawnReason ?? 'This policy was withdrawn.',
    actor: row.withdrawnBy ?? 'unknown',
    killedAt: (row.withdrawnAt ?? new Date(0)).toISOString(),
  };
}
