import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ApprovalMode, OperatorRole, OverrideFamily } from '../domain/override-register';

/**
 * One row of `GET /operator/policies` — the policy-lifecycle reference panel.
 *
 * The console shows four labels — `ACTIVE · slashing live`,
 * `ACTIVE · shadow only`, `SHADOW`, `SHADOW · above gate` — as one string per
 * row. This DTO keeps `state` and `qualifier` separate instead of pre-joining
 * them, for the reason `state`/`qualifier` are two different kinds of fact:
 * `state` is the stored `lifecycle` column, and `qualifier` is derived — see
 * the field's own doc for which half of those four labels that
 * derivation can actually produce today.
 */
export class PolicyLifecycleRowDto {
  @ApiProperty({ description: 'The stable policy id, e.g. `search_web.default`' })
  policyId: string;

  @ApiProperty()
  policyVersion: number;

  @ApiProperty()
  toolId: string;

  @ApiProperty({
    description:
      'One of `PolicyLifecycle` — `DRAFT` | `SHADOW` | `ACTIVE` | `WITHDRAWN` | `ARCHIVED`. The ' +
      'row shown per policy id is the one `VerificationPolicyRepository.findServing` would return: ' +
      'the `ACTIVE` version if one exists, else the newest `SHADOW`, else the newest of whatever ' +
      'remains.',
  })
  state: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Derived, never a stored column. For `ACTIVE` this is always `"slashing live"` — ' +
      '`enforces(lifecycle)` in `decision-policy.types.ts` is unconditionally true for `ACTIVE` and ' +
      'there is no other mechanism in this codebase that can make an `ACTIVE` policy non-enforcing, ' +
      'so an `ACTIVE · shadow only` label has no row that could ever carry it. For ' +
      '`SHADOW` this is always `null`: a `SHADOW · above gate` label would come from ' +
      '`promotionEvidence`, but `DecisionPolicyService.promote()` only ever writes that column in ' +
      'the same statement that moves a row to `ACTIVE` (it throws, before writing, when the gate is ' +
      'not cleared) — so no `SHADOW` row has ever had a false-positive rate recorded against it, ' +
      "despite that method's own docstring saying otherwise. Reported as a doc/code divergence " +
      'rather than worked around here.',
  })
  qualifier: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      '`falsePositives / labelledSamples` from the evidence submitted when this version was ' +
      'promoted (`falsePositiveRateOf` in `promotion.ts`). Null for every `SHADOW` row — see ' +
      '`qualifier` — and for an `ACTIVE` row promoted before this evidence was recorded.',
  })
  falsePositiveRate: number | null;

  @ApiProperty({
    type: [String],
    description:
      'The verifier ids configured to vote on this policy version, from its `decisionDocument`. ' +
      'This is the voting panel, not a tally of votes cast — no table in this schema aggregates ' +
      'per-policy vote counts across calls, so a real tally is not offered under this name.',
  })
  votingVerifierIds: string[];

  @ApiPropertyOptional({
    enum: ['kill', 'promote'],
    nullable: true,
    description:
      'The action word the policy-versions panel renders. `ACTIVE` → `kill` (`P-3`, ' +
      '`policy.killed` — listed in the override register as `implemented: false`; this panel names the action regardless, since it ' +
      'is a read-only description of what the register says an operator may do, not a claim that ' +
      'the route exists). `SHADOW` → `promote`. Every other lifecycle → `null`. A third word, ' +
      '`hold`, is never emitted: distinguishing "ready to promote" from "not enough ' +
      'evidence yet" would need a labelled-sample count, and nothing in this schema tracks human ' +
      'labelling per policy version. Every `SHADOW` row is offered `promote` rather than a guessed ' +
      '`hold`; the promote endpoint itself is what actually evaluates readiness.',
  })
  actionWord: 'kill' | 'promote' | null;
}

/** One row of `GET /operator/verifiers` — the verifier-registry reference panel. */
export class VerifierRegistryRowDto {
  @ApiProperty({ description: 'Our own stable name for the key, e.g. `verifier-2026-08`' })
  verifierId: string;

  @ApiProperty({ description: 'The chain address, truncated for display — e.g. `7xKX…9wZp`' })
  truncatedKey: string;

  @ApiPropertyOptional({
    enum: ['approved', 'revoked'],
    nullable: true,
    description:
      'From the on-chain allowlist, read fresh on every request — not the local lifecycle column, ' +
      'which only says which key this deployment has *chosen*, never whether the chain still ' +
      'accepts it. `null` when the chain could not be read for this key, or when this key has ' +
      'never been registered on chain at all; both are reported as `null` rather than guessed, and ' +
      '`unreadableReason` says which.',
  })
  state: 'approved' | 'revoked' | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Why `state` is null for this row. Null when `state` is not null.',
  })
  unreadableReason: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'When the on-chain registration lapses' })
  expiresAt: string | null;
}

/** One row of `GET /operator/economics` — the economic-parameter panel. */
export class EconomicParameterRowDto {
  @ApiProperty({
    description:
      'Stable key: `takeRate` | `minimumStake` | `penaltySize` | `splitAgent` | ' +
      '`splitPlatform` | `splitProvider`',
  })
  key: string;

  @ApiProperty()
  label: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The value, rendered as the screen would print it. Null — see `note` — when no ' +
      'fixed value exists to report.',
  })
  value: string | null;

  @ApiProperty({
    enum: ['config'],
    description:
      'Always `config` today. None of the six economic parameters are read from the settlement ' +
      'program — contrast `Config.stakeMint` / `Config.unbondingPeriodSeconds`, which are. Kept as ' +
      'a field rather than a class-level comment so a future parameter that does move on chain can ' +
      'say so per row instead of everything silently staying `config` after one of six changes.',
  })
  source: 'config';

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Providers with a negotiated override on this parameter, out of every registered provider. ' +
      'Null — not zero — when no override mechanism exists in the schema for this parameter at ' +
      'all; zero means the mechanism exists and nobody has used it yet. Only `minimumStake` has a ' +
      'mechanism today (`ProviderRoutingState.minimumStakeOverride`).',
  })
  overrideCount: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Set only when `value` is null, explaining why no fixed value could be reported.',
  })
  note: string | null;
}

/** One row of `GET /operator/override-register` — `OVERRIDE_REGISTER`, listed. */
export class OverrideRegisterRowDto {
  @ApiProperty({ description: 'e.g. `S-5`' })
  code: string;

  @ApiProperty({ enum: OverrideFamily })
  family: OverrideFamily;

  @ApiProperty({ description: 'Dotted past tense, e.g. `dispute.decided`' })
  action: string;

  @ApiProperty()
  label: string;

  @ApiProperty({
    enum: OperatorRole,
    isArray: true,
    description: 'Empty means nobody may perform it — see `rolesSatisfy`.',
  })
  roles: OperatorRole[];

  @ApiProperty({ enum: ApprovalMode })
  approval: ApprovalMode;

  @ApiProperty()
  reversible: boolean;

  @ApiProperty({
    description:
      'Whether a code path exists that can cite this code. `false` rows are in this list on ' +
      'purpose — the console renders the register as what an operator *may* do, and a row with no ' +
      'code behind it is exactly the gap this endpoint exists to show.',
  })
  implemented: boolean;
}
