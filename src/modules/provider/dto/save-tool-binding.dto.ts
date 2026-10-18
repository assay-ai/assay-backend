import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { CHAIN_ID_RE } from '@modules/chains/ports/caip.types';
import { BindingAuthMode, PricingMode } from '@modules/tool/ports/tool.types';
import { bindingEndpointProtocols } from '@shared/network/egress/egress.policy';

import { ToolBindingDetailDto } from './get-tool-bindings.dto';

/** `https` only under `NODE_ENV=production` — see `bindingEndpointProtocols`. */
const BINDING_ENDPOINT_SCHEMES = bindingEndpointProtocols().map((p) => p.replace(/:$/, ''));

/** `free_quota_per_agent` is an `int` column; anything above would be a 500 at the insert. */
const INT4_MAX = 2_147_483_647;

/**
 * `POST` / `PATCH /providers/me/tool-bindings` — the binding editor.
 *
 * What `class-validator` checks here is deliberately shallow: the two mappings
 * arrive as `IsObject` and nothing more. Their real validation is
 * `validateRequestMapping` / `validateResponseMapping` — the same functions the
 * router runs against — and those produce `TOOL_MAPPING_INVALID` with a
 * **pointer at the offending node**, which is the only kind of message a
 * provider can act on while looking at a mapping editor. Re-expressing a
 * fraction of that as decorators would give two answers to one question and
 * make the shallower one arrive first.
 */
export class SaveToolBindingBodyDto {
  @ApiProperty({
    description: 'The tool being implemented, from the catalogue. Immutable after creation.',
    example: 'search_web',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  toolId: string;

  @ApiProperty({
    description: "The provider's own URL, unchanged. `requestMapping.path` is appended to it.",
    example: 'https://api.vesseldata.example/v2',
  })
  @IsUrl({ require_protocol: true, protocols: BINDING_ENDPOINT_SCHEMES })
  @MaxLength(2048)
  endpoint: string;

  @ApiProperty({
    description: 'Tool input → the shape this endpoint already accepts. See docs/mapping-format.md',
    example: { method: 'POST', path: '/search', body: { q: '$.query' } },
  })
  @IsObject()
  requestMapping: Record<string, unknown>;

  @ApiProperty({
    description: "This endpoint's native response → the tool's outputSchema.",
    example: { results: { $from: '$.data.items[*]', url: '$.link', title: '$.title' } },
  })
  @IsObject()
  responseMapping: Record<string, unknown>;

  @ApiProperty({ enum: PricingMode })
  @IsIn(Object.values(PricingMode))
  pricingMode: PricingMode;

  /**
   * Required, with no default (D10): the provider says how their endpoint
   * authenticates calls. A silent `NONE` made the least safe choice for them.
   */
  @ApiProperty({
    enum: BindingAuthMode,
    description: 'How the endpoint authenticates calls. Required: there is no default.',
  })
  @IsEnum(BindingAuthMode)
  authMode: BindingAuthMode;

  /**
   * Minor units, as digits.
   *
   * A string, not a number: a price is money, and money crosses this boundary
   * as an integer string everywhere else in the API for the reason
   * `MoneyUtil` exists — `0.1 + 0.2` is not a thing a settlement may depend on.
   */
  @ApiProperty({ description: 'Price per call, in the asset’s minor units.', example: '2000' })
  @Matches(/^\d+$/, { message: 'priceAmount must be an integer in minor units' })
  @MaxLength(78)
  priceAmount: string;

  @ApiProperty({ example: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9...' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  assetId: string;

  /**
   * The chains this binding is offered on. CAIP-2, never empty.
   *
   * *"One tool binding may serve both chains ... the endpoint is one HTTPS
   * service; only the settlement is chain-bound."* So this is not derivable
   * from {@link assetId}: a provider enrolled on two chains may still choose to
   * offer one particular tool on one of them, and that choice has nowhere else
   * to live.
   *
   * **`@ArrayNotEmpty`, and the row says the same thing.** An empty list is a
   * binding offered nowhere, which is a binding that routes nowhere while
   * looking perfectly healthy in a console — a silent unroutability with no
   * screen that explains it. `chk_tool_bindings_settlement_chains` refuses it
   * at the row as well, because a DTO only guards the requests that come
   * through this DTO.
   *
   * **Declaration, not evidence.** Naming a chain here does not put stake on
   * it. The write-time gate that checks the provider is actually enrolled and
   * collateralised there is separate, and the router re-checks it on every
   * decision rather than trusting what was true at save time.
   */
  @ApiProperty({
    isArray: true,
    type: String,
    minItems: 1,
    description:
      'CAIP-2 chain ids this binding is offered on. At least one. A declaration ' +
      'of intent — routability on a chain still requires an enrolment there ' +
      'holding stake, re-checked on every routing decision.',
    example: ['solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @Matches(CHAIN_ID_RE, {
    each: true,
    message: 'each settlementChains entry must be a CAIP-2 chain id, e.g. solana:EtWT… or eip155:1',
  })
  settlementChains: string[];

  @ApiPropertyOptional({ nullable: true, description: 'Free calls per agent, `FREEMIUM` only.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(INT4_MAX)
  freeQuotaPerAgent?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: INT4_MAX,
    example: 5000,
    description:
      'The most free calls this binding serves per day, across all agents (a call count, ' +
      'not money). `FREEMIUM` and `FREE` only. Resets at 00:00 UTC. `null` means the ' +
      'platform default. `freeQuotaPerAgent` caps each agent; this caps the binding.',
  })
  @IsOptional()
  @IsInt({ message: 'freeDailyBudget must be a whole number of free calls per day' })
  @Min(1)
  @Max(INT4_MAX)
  freeDailyBudget?: number | null;

  @ApiProperty({ description: 'The failure rate this provider declares, e.g. 0.05 for 5%.' })
  @IsNumber()
  @Min(0)
  @Max(1)
  slaFailureRate: number;

  @ApiProperty({ description: 'Per-call budget. The router may shorten it, never lengthen it.' })
  @IsInt()
  @Min(1)
  @Max(120_000)
  timeoutMs: number;

  /**
   * The provider's own declared ceilings.
   *
   * The ceiling is *self-declared* — maxRps, daily quota and timeout are
   * ceilings the provider declares itself — so it belongs on the body a
   * provider sends, not only in the column the router reads. Reaching one sheds
   * traffic to another provider; it is not an error, not a strike and not in
   * the quality profile, which is the entire reason for declaring it rather
   * than answering `429`.
   *
   * **`@Min(1)`, so zero is refused.** Zero is not a small ceiling, it is
   * "declared unroutable", and a provider who wants that has the pause button,
   * which says so on the row and in their console. Leaving `0` reachable here
   * would give the same outcome a second spelling that no screen explains.
   *
   * `null` clears a ceiling and `undefined` leaves it alone — `@IsOptional()`
   * skips both, so the two stay distinguishable in the service, exactly as
   * `freeQuotaPerAgent` above already relies on.
   *
   * The third ceiling, **timeout**, is {@link timeoutMs} and is already
   * here. It is not duplicated, and unlike these two it *is* versioned: a
   * different deadline changes what served a call.
   */
  @ApiPropertyOptional({
    example: '^1',
    maxLength: 32,
    description:
      'The contract majors this binding serves: `^1`, or `^1 || ^2`. Defaults to the ' +
      "tool's current major. Each major needs a green tester run before publishing.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^\^\d{1,4}(\s*\|\|\s*\^\d{1,4})*$/, {
    message: 'toolVersionRange must be a range of majors, e.g. ^1 or ^1 || ^2',
  })
  toolVersionRange?: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['uv_index'],
    description:
      "The contract's optional output fields this binding returns. Routing sends calls " +
      'that require one only here, and a declared field missing from a response is a ' +
      'contract violation.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  providesOutputFields?: string[];

  @ApiPropertyOptional({
    type: [String],
    example: ['units'],
    description:
      "The contract's optional input fields this binding passes to its endpoint. A call " +
      'that uses one is routed only to bindings that support it.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  supportsInputFields?: string[];

  @ApiPropertyOptional({
    nullable: true,
    minimum: 1,
    description:
      'Requests per second this endpoint will take. Reaching it sheds traffic ' +
      'to another provider instead of pushing a call at you. Null for no ceiling.',
    example: 25,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxRps?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    minimum: 1,
    description:
      'Calls per UTC day this endpoint will take. Not a "quota" — that word ' +
      'means the agent’s free-tier allowance. Null for no ceiling.',
    example: 100000,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxDailyCalls?: number | null;
}

/**
 * An edit. Every field optional except the one that is missing entirely:
 * `toolId`.
 *
 * A binding *is* one provider's implementation of one tool, so moving it to
 * another tool would silently re-point every verdict, receipt and dispute that
 * already names it. That is a new binding, and saying so costs the provider one
 * click and saves an unwinnable dispute.
 */
export class UpdateToolBindingBodyDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_protocol: true, protocols: BINDING_ENDPOINT_SCHEMES })
  @MaxLength(2048)
  endpoint?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  requestMapping?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  responseMapping?: Record<string, unknown>;

  @ApiPropertyOptional({ enum: PricingMode })
  @IsOptional()
  @IsIn(Object.values(PricingMode))
  pricingMode?: PricingMode;

  @ApiPropertyOptional({ enum: BindingAuthMode })
  @IsOptional()
  @IsEnum(BindingAuthMode)
  authMode?: BindingAuthMode;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^\d+$/, { message: 'priceAmount must be an integer in minor units' })
  @MaxLength(78)
  priceAmount?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(256)
  assetId?: string;

  /**
   * See {@link SaveToolBindingBodyDto.settlementChains}.
   *
   * `undefined` leaves the list alone; there is deliberately no way to clear
   * it. `null` is not accepted and `[]` is refused by `@ArrayNotEmpty` — a
   * provider who wants to stop serving pauses the binding, which says so on the
   * row and in their console, rather than emptying a list nothing reports on.
   */
  @ApiPropertyOptional({ isArray: true, type: String, minItems: 1 })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @Matches(CHAIN_ID_RE, {
    each: true,
    message: 'each settlementChains entry must be a CAIP-2 chain id, e.g. solana:EtWT… or eip155:1',
  })
  settlementChains?: string[];

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(INT4_MAX)
  freeQuotaPerAgent?: number | null;

  /** See {@link SaveToolBindingBodyDto.freeDailyBudget}. `null` clears it back to the default. */
  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 1, maximum: INT4_MAX })
  @IsOptional()
  @IsInt({ message: 'freeDailyBudget must be a whole number of free calls per day' })
  @Min(1)
  @Max(INT4_MAX)
  freeDailyBudget?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  slaFailureRate?: number;

  @ApiPropertyOptional({
    example: '^1',
    maxLength: 32,
    description:
      'The contract majors this binding serves: `^1`, or `^1 || ^2`. Defaults to the ' +
      "tool's current major. Each major needs a green tester run before publishing.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^\^\d{1,4}(\s*\|\|\s*\^\d{1,4})*$/, {
    message: 'toolVersionRange must be a range of majors, e.g. ^1 or ^1 || ^2',
  })
  toolVersionRange?: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['uv_index'],
    description:
      "The contract's optional output fields this binding returns. Routing sends calls " +
      'that require one only here, and a declared field missing from a response is a ' +
      'contract violation.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  providesOutputFields?: string[];

  @ApiPropertyOptional({
    type: [String],
    example: ['units'],
    description:
      "The contract's optional input fields this binding passes to its endpoint. A call " +
      'that uses one is routed only to bindings that support it.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  supportsInputFields?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120_000)
  timeoutMs?: number;

  /** See {@link SaveToolBindingBodyDto.maxRps}. `null` clears the ceiling. */
  @ApiPropertyOptional({ nullable: true, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxRps?: number | null;

  /** See {@link SaveToolBindingBodyDto.maxDailyCalls}. `null` clears the ceiling. */
  @ApiPropertyOptional({ nullable: true, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxDailyCalls?: number | null;
}

/**
 * A saved binding.
 *
 * Structurally identical to `ToolBindingDetailDto` now that `publishedVersion`
 * and `hasUnpublishedChanges` have moved up onto it: the editor's two fields
 * were never editor-only, they were simply missing from the read. Redeclaring
 * them here as well would leave two declarations of one field free to drift, so
 * the subclass declares nothing and exists to name the save response in Swagger
 * and to carry the `PublishedToolBindingDto` / `PausedToolBindingDto` subtypes.
 */
export class SavedToolBindingDto extends ToolBindingDetailDto {}
