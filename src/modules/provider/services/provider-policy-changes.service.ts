import { Injectable } from '@nestjs/common';

import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { ToolBindingRepository } from '@database/postgres/repositories/tool-binding.repository';
import { VerificationPolicyEntity } from '@database/postgres/entities/verification-policy.entity';
import { VerificationPolicyRepository } from '@database/postgres/repositories/verification-policy.repository';
import { PolicyLifecycle } from '@modules/verification/domain/aggregation/decision-policy.types';

import { diffPolicyDocuments } from '../domain/policy-diff';
import { PolicyChangeBindingDto, PolicyChangeDto } from '../dto/provider-policy-changes.dto';

/**
 * `GET /providers/me/policy-changes` — the notice slice of the policy change
 * centre.
 *
 * What is served: pending versions affecting the provider's bindings,
 * their effective dates, and the diff between the pending version and the one
 * in force. Everything past that — divergence computed on the provider's own
 * traffic, the objection form, running the golden set, auto-pause on version
 * change — is later work and has no producer here.
 *
 * ## The join
 *
 * `verification_policies` is **not** organization-scoped (see the entity's
 * own doc: a policy belongs to a tool, and the tool catalogue is
 * platform-level). There is no direct route from a provider to "policies
 * affecting them" — it has to go through what the provider actually owns:
 *
 * ```text
 * tool_bindings.organization_id = providerId   (providerId == organizationId,
 *                                                the whole provider surface's
 *                                                own equivalence)
 *   → tool_bindings.tool_id
 *     → verification_policies.tool_id
 * ```
 *
 * `tool_bindings` is read with the ordinary organization-scoped `find` — this
 * is the provider looking at their *own* bindings, not a cross-tenant report,
 * so it needs none of `ProviderTrafficService`'s `IS NOT NULL` idiom and is
 * not on the cross-tenant allowlist.
 *
 * Every one of this provider's bindings is considered "affected" by a pending
 * version on its tool, regardless of the binding's own status (`DRAFT`,
 * `PAUSED`, `SUSPENDED` included). A paused binding does not currently take
 * traffic, but it will the moment it resumes, and a provider who paused a
 * binding still needs to know a policy change is coming for it.
 *
 * ## "In force" and "pending"
 *
 * `uq_verification_policies_one_active_per_tool` and
 * `..._one_shadow_per_tool` guarantee at most one row of each per tool, so
 * this is never a coin flip:
 *
 * - **In force** = the tool's `ACTIVE` row, or nothing. `ACTIVE` is the only
 *   lifecycle that `enforces()` (`decision-policy.types.ts`) — a `WITHDRAWN`
 *   row is not "in force" even though `VerificationPolicyRepository.findServing`
 *   would still resolve it for a live call, because a withdrawn policy has
 *   already been told to stop deciding money.
 * - **Pending** = the tool's `SHADOW` row. `DRAFT` is excluded on purpose:
 *   the entity's own doc states that a `DRAFT` policy "is never resolved for
 *   traffic, not even in shadow", so it cannot yet be said to be *pending*
 *   anything a provider is exposed to. A tool with no `SHADOW` row produces no
 *   row in this endpoint's response — nothing pending, nothing to notice.
 *
 * ## The diff
 *
 * Structural, over `decision_document` only — see `diffPolicyDocuments`'s own
 * doc for why not a textual diff, and why `canonicalJson` is the equality
 * oracle rather than the diff mechanism itself. `verification_document` is
 * not diffed by this MVP slice; it is a real gap, not an oversight, and it is
 * named here rather than silently absent so the next reader does not have to
 * rediscover it.
 *
 * ## The effective date gap
 *
 * `verification_policies` has no column recording when a `SHADOW` version is
 * scheduled to take effect, because nothing schedules a promotion — the
 * promote gate is an immediate operator action. `PolicyChangeDto.effectiveDate`
 * is therefore always `null`, on purpose: inventing one (say, from the row's
 * `createdAt`) would put a fabricated date on a screen about a rule that is
 * about to start costing a provider money, which is worse than an admitted
 * absence.
 */
@Injectable()
export class ProviderPolicyChangesService {
  constructor(
    private readonly bindings: ToolBindingRepository,
    private readonly policies: VerificationPolicyRepository,
  ) {}

  async listPolicyChanges(providerId: string): Promise<PolicyChangeDto[]> {
    const bindingRows = await this.bindings.find({ where: { organizationId: providerId } });
    if (bindingRows.length === 0) return [];

    const bindingsByTool = groupByTool(bindingRows);
    const toolIds = [...bindingsByTool.keys()];

    // One pair of single-lookup reads per tool, the same shape
    // `VerificationPolicyRepository.findServing` uses for one tool and
    // `OperatorReferenceService.listVerifiers` uses for N keys: this
    // provider's own tool count is small by construction (it is bounded by
    // how many bindings one provider has authored), so N parallel point
    // reads costs nothing a bulk query would meaningfully save.
    const resolved = await Promise.all(
      toolIds.map(async (toolId) => {
        const [active, shadow] = await Promise.all([
          this.policies.findOne({ where: { toolId, lifecycle: PolicyLifecycle.ACTIVE } }),
          this.policies.findOne({ where: { toolId, lifecycle: PolicyLifecycle.SHADOW } }),
        ]);
        return { toolId, active, shadow };
      }),
    );

    const changes: PolicyChangeDto[] = [];
    for (const { toolId, active, shadow } of resolved) {
      if (!shadow) continue;

      changes.push(toPolicyChangeDto(toolId, active, shadow, bindingsByTool.get(toolId) ?? []));
    }

    // Deterministic order for a screen a human reads top to bottom, same
    // convention `OperatorReferenceService.listPolicies` uses.
    changes.sort((a, b) => a.toolId.localeCompare(b.toolId));
    return changes;
  }
}

function groupByTool(rows: ToolBindingEntity[]): Map<string, ToolBindingEntity[]> {
  const map = new Map<string, ToolBindingEntity[]>();
  for (const row of rows) {
    const group = map.get(row.toolId) ?? [];
    group.push(row);
    map.set(row.toolId, group);
  }
  return map;
}

function toPolicyChangeDto(
  toolId: string,
  active: VerificationPolicyEntity | null,
  shadow: VerificationPolicyEntity,
  bindingsForTool: ToolBindingEntity[],
): PolicyChangeDto {
  return {
    toolId,
    policyId: shadow.policyId,
    pendingVersion: shadow.policyVersion,
    pendingLifecycle: shadow.lifecycle,
    inForcePolicyId: active?.policyId ?? null,
    inForceVersion: active?.policyVersion ?? null,
    effectiveDate: null,
    bindings: bindingsForTool.map(toBindingDto),
    diff: diffPolicyDocuments(active?.decisionDocument ?? null, shadow.decisionDocument),
  };
}

function toBindingDto(row: ToolBindingEntity): PolicyChangeBindingDto {
  return { bindingId: row.id, status: row.status };
}
