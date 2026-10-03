import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * `GET /providers/me/policy-changes` — the notice slice only.
 *
 * Deliberately excludes the later parts of the policy change centre: divergence
 * computed against this provider's own traffic ("14 of your last 1,000 verified
 * calls change verdict"), the objection form, running the golden set,
 * auto-pause on version change. None of those have a producer here — see
 * `ProviderPolicyChangesService`'s own doc for exactly what this DTO answers
 * instead.
 */
export class PolicyDiffEntryDto {
  @ApiProperty({
    // NEVER write a `$` immediately followed by a backtick in any Swagger
    // description. swagger-ui-express splices the OpenAPI document into
    // swagger-ui-init.js with String.replace(), where `$` + backtick is the
    // "everything before the match" substitution pattern. One such pair here
    // spliced the head of the template into the middle of a JSON string,
    // and /api/docs died with "Invalid or unexpected token" — the whole page
    // blank, not just this field. The `$.` in the example below is safe; a
    // bare ``$`` in prose is not.
    description:
      'JSONPath-style locator within decision_document, e.g. `$.verifiers[0].verifierId` — the same ' +
      'path grammar `canonicalJson` uses in its own errors',
  })
  path: string;

  @ApiProperty({ enum: ['added', 'removed', 'changed'] })
  changeType: 'added' | 'removed' | 'changed';

  @ApiPropertyOptional({
    type: Object,
    nullable: true,
    description: 'The in-force value at this path. Absent when changeType is "added".',
  })
  before: unknown;

  @ApiPropertyOptional({
    type: Object,
    nullable: true,
    description: 'The pending value at this path. Absent when changeType is "removed".',
  })
  after: unknown;
}

export class PolicyChangeBindingDto {
  @ApiProperty({ description: "This provider's own binding id for the affected tool" })
  bindingId: string;

  @ApiProperty({ description: 'BindingStatus at read time — DRAFT | ACTIVE | PAUSED | SUSPENDED' })
  status: string;
}

/** One row: one tool this provider has bound, with a `SHADOW` version pending on it. */
export class PolicyChangeDto {
  @ApiProperty({ description: "The catalogue tool id this provider's binding(s) implement" })
  toolId: string;

  @ApiProperty({ description: 'The pending (SHADOW) version’s own policy_id' })
  policyId: string;

  @ApiProperty({ description: 'The pending version number' })
  pendingVersion: number;

  @ApiProperty({
    enum: ['DRAFT', 'SHADOW', 'ACTIVE', 'WITHDRAWN', 'ARCHIVED'],
    description: 'Always SHADOW at this MVP slice — see the service doc for why',
  })
  pendingLifecycle: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'policy_id of the version currently ACTIVE for this tool, or null if none has ever been promoted',
  })
  inForcePolicyId: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The version number currently ACTIVE (enforcing, economic) for this tool, or null',
  })
  inForceVersion: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Always null. `verification_policies` has no column recording when a SHADOW version is ' +
      'scheduled to take effect — promotion is an immediate operator action (the promote ' +
      'gate), not a scheduled one. Reported as an absent value rather than inferred from, say, ' +
      "the row's createdAt, which is when the version was authored, not when it will bind.",
  })
  effectiveDate: string | null;

  @ApiProperty({
    type: [PolicyChangeBindingDto],
    description: "This provider's own bindings on this tool — never another provider's",
  })
  bindings: PolicyChangeBindingDto[];

  @ApiProperty({
    type: [PolicyDiffEntryDto],
    description:
      'Structural diff of decision_document only, in-force → pending (verification_document is ' +
      'not diffed by this endpoint). When there is no in-force version, every path in the ' +
      'pending document reports as "added".',
  })
  diff: PolicyDiffEntryDto[];
}
