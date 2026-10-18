import { Injectable } from '@nestjs/common';

import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { ToolEntity } from '@database/postgres/entities/tool.entity';
import { ToolVersionEntity } from '@database/postgres/entities/tool-version.entity';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { ToolBindingRepository } from '@database/postgres/repositories/tool-binding.repository';
import { BindingPublishService } from '@modules/provider/services/binding-publish.service';
import { ProviderStatus } from '@modules/provider/ports/provider.types';
import { ScreenFinding, screenContract } from '@modules/tool/domain/contract/schema-screen';
import { MappingDirection, MappingFault } from '@modules/tool/domain/mapping/mapping.types';
import { JsonSchema, validateAgainstSchema } from '@modules/tool/domain/mapping/schema-validator';
import { parseProviderToolName } from '@modules/tool/domain/provider-tool-name';
import { BindingStatus } from '@modules/tool/ports/tool.types';
import { HandlesService } from '@modules/toolset/services/handles.service';

import { declaredRuleProblems } from '../domain/declared-rules';
import { servedVersionsOf } from '../domain/served-versions';
import {
  ProviderToolGateDto,
  ProviderToolGateRequirementDto,
  ProviderToolScreenDto,
  ScreenFindingDto,
} from '../dto/provider-tools.dto';

export enum GateRequirement {
  PROVIDER_ACTIVE = 'PROVIDER_ACTIVE',
  HANDLE_ACTIVE = 'HANDLE_ACTIVE',
  PUBLISHED_VERSION = 'PUBLISHED_VERSION',
  BINDING_PUBLISHED = 'BINDING_PUBLISHED',
  SCHEMA_SCREEN = 'SCHEMA_SCREEN',
  EXAMPLES_MATCH_SCHEMA = 'EXAMPLES_MATCH_SCHEMA',
}

/**
 * The provider tool publish gate (design spec §7.6), needed for UNLISTED,
 * for a review, and for every version that reaches a non-private tool:
 *
 * ```text
 * PROVIDER_ACTIVE              a registered provider in good standing
 * HANDLE_ACTIVE                the name's handle is the organization's own, active public name
 * PUBLISHED_VERSION            something to serve
 * BINDING_PUBLISHED            the provider's own binding — the only implementation — is live
 * TESTER_RUN, TESTER_PASSED,   the binding publish gate, as is: a test run against the real
 * PAYOUT_ACCOUNT,              endpoint at this revision, a proved payee and stake at the
 * STAKE_AT_MINIMUM_…           floor on every chain it settles on
 * SCHEMA_SCREEN                caps, instruction patterns, secret inputs, hidden characters, refs
 * EXAMPLES_MATCH_SCHEMA        every example's arguments and result match the schemas
 * ```
 *
 * The binding half is `BindingPublishService.check` itself, not a copy, so
 * a tool can never pass a gate its own binding would fail.
 */
@Injectable()
export class ProviderToolGateService {
  constructor(
    private readonly bindings: ToolBindingRepository,
    private readonly publisher: BindingPublishService,
    private readonly providers: ProviderRepository,
    private readonly handles: HandlesService,
  ) {}

  /** The provider's own binding of its tool, or `null`. */
  async bindingOf(tool: Pick<ToolEntity, 'id' | 'ownerOrgId'>): Promise<ToolBindingEntity | null> {
    if (!tool.ownerOrgId) return null;
    return this.bindings.findOne({
      where: { organizationId: tool.ownerOrgId, toolId: tool.id },
    });
  }

  /**
   * The checklist for `tool`, screening every version it would serve and,
   * when given, the draft about to be submitted.
   */
  async evaluate(
    tool: ToolEntity,
    versions: readonly ToolVersionEntity[],
    draft: ToolVersionEntity | null = null,
  ): Promise<ProviderToolGateDto> {
    const organizationId = tool.ownerOrgId as string;
    const requirements: ProviderToolGateRequirementDto[] = [];
    const push = (requirement: string, met: boolean, code: string | null, detail: string | null) =>
      requirements.push({ requirement, met, code: met ? null : code, detail: met ? null : detail });

    const provider = await this.providers.findOne({ where: { organizationId } });
    push(
      GateRequirement.PROVIDER_ACTIVE,
      !!provider && provider.status === ProviderStatus.ACTIVE,
      provider ? 'provider_not_active' : 'provider_not_registered',
      provider
        ? `Your provider account is ${provider.status}.`
        : 'Register as a provider before publishing your own API.',
    );

    const handle = (await this.handles.handlesOf([organizationId])).get(organizationId) ?? null;
    const prefix = parseProviderToolName(tool.name)?.handle ?? null;
    push(
      GateRequirement.HANDLE_ACTIVE,
      handle !== null && handle === prefix,
      handle ? 'handle_mismatch' : 'handle_inactive',
      handle
        ? `The tool is named under "${prefix}", and your public name is "${handle}".`
        : 'Your organization has no active public name.',
    );

    // What a call can be served at: the newest version of each major.
    const servable = servedVersionsOf(versions);
    push(
      GateRequirement.PUBLISHED_VERSION,
      servable.length > 0 || draft !== null,
      'no_published_version',
      'Publish a version first (POST …/versions/:version/publish).',
    );

    const binding = await this.bindingOf(tool);
    const live =
      !!binding && binding.publishedVersion != null && binding.status === BindingStatus.ACTIVE;
    push(
      GateRequirement.BINDING_PUBLISHED,
      live,
      binding ? 'binding_not_live' : 'no_binding',
      binding
        ? `Your binding is ${binding.status}${binding.publishedVersion == null ? ' and was never published' : ''}; publish it and keep it active.`
        : 'Create, test and publish your binding of this tool (POST /providers/me/tool-bindings).',
    );
    if (binding) {
      try {
        const check = await this.publisher.check(organizationId, binding.id);
        for (const item of check.requirements) {
          push(item.requirement, item.met, item.code, item.detail);
        }
      } catch (error) {
        push(
          'TESTER_RUN',
          false,
          'binding_not_checkable',
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    // With a draft, what the tool would serve once it is published: the
    // draft replaces the newest version of its major, so a version it
    // supersedes never blocks the fix that supersedes it.
    const screened = draft
      ? servedVersionsOf([
          ...versions.filter((version) => version.version !== draft.version),
          { ...draft, status: 'ACTIVE' } as ToolVersionEntity,
        ]).map((version) => (version.version === draft.version ? draft : version))
      : servable;
    const screen: ProviderToolScreenDto[] = screened.map((version) => ({
      version: version.version,
      semver: version.semver,
      findings: screenVersion(version),
    }));
    const screenFindings = screen.flatMap((entry) =>
      entry.findings.filter((finding) => finding.code !== 'EXAMPLE_MISMATCH'),
    );
    const exampleFindings = screen.flatMap((entry) =>
      entry.findings.filter((finding) => finding.code === 'EXAMPLE_MISMATCH'),
    );
    push(
      GateRequirement.SCHEMA_SCREEN,
      screenFindings.length === 0,
      'schema_screen_failed',
      `${screenFindings.length} finding(s): ${screenFindings
        .slice(0, 3)
        .map((finding) => `${finding.location}: ${finding.detail}`)
        .join('; ')}`,
    );
    push(
      GateRequirement.EXAMPLES_MATCH_SCHEMA,
      exampleFindings.length === 0,
      'example_mismatch',
      exampleFindings
        .slice(0, 3)
        .map((finding) => `${finding.location}: ${finding.detail}`)
        .join('; '),
    );

    return {
      passed: requirements.every((requirement) => requirement.met),
      requirements,
      screen,
    };
  }
}

/** The schema screen, the declared rules and the examples of one version. */
export function screenVersion(version: ToolVersionEntity): ScreenFindingDto[] {
  const shape = {
    summary: version.summary,
    description: version.description,
    inputSchema: version.inputSchema as JsonSchema,
    outputSchema: version.outputSchema as JsonSchema,
    optionalInputFields: version.optionalInputFields ?? [],
    optionalOutputFields: version.optionalOutputFields ?? [],
    examples: version.examples ?? [],
    verificationPolicyId: version.verificationPolicyId,
    tier: version.tier,
  };
  const findings: ScreenFindingDto[] = screenContract(shape).findings.map(
    (finding: ScreenFinding) => ({
      ...finding,
    }),
  );
  for (const problem of declaredRuleProblems(version.declaredRules ?? [])) {
    findings.push({ code: 'RULES_INVALID', location: 'rules', detail: problem });
  }
  findings.push(...exampleFindings(version));
  return findings;
}

/** Every example's arguments against the input schema, and its result against the output schema. */
export function exampleFindings(
  version: Pick<ToolVersionEntity, 'examples' | 'inputSchema' | 'outputSchema'>,
): ScreenFindingDto[] {
  const out: ScreenFindingDto[] = [];
  const examples = Array.isArray(version.examples) ? version.examples : [];
  examples.forEach((raw, index) => {
    const example = (raw ?? {}) as { arguments?: unknown; result?: unknown };
    const check = (value: unknown, schema: unknown, direction: MappingDirection, part: string) => {
      try {
        validateAgainstSchema(value as never, schema as JsonSchema, {
          direction,
          fault: MappingFault.PLATFORM,
        });
        requiredPresent(value, schema as JsonSchema);
      } catch (error) {
        out.push({
          code: 'EXAMPLE_MISMATCH',
          location: `examples/${index}/${part}`,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    };
    check(example.arguments, version.inputSchema, MappingDirection.REQUEST, 'arguments');
    if (example.result !== undefined) {
      check(example.result, version.outputSchema, MappingDirection.RESPONSE, 'result');
    }
  });
  return out;
}

/** The top-level `required` fields are present: the validator leaves absence to its caller. */
function requiredPresent(value: unknown, schema: JsonSchema): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const name of schema?.required ?? []) {
    if (!(name in (value as Record<string, unknown>))) {
      throw new Error(`required field "${name}" is missing`);
    }
  }
}
