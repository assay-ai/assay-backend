import { ToolContractVersionDto } from '@modules/tool/dto/tool-contract-version.dto';
import { ApiProperty } from '@nestjs/swagger';

import { ToolTier } from '@modules/tool/ports/tool.types';

/**
 * `GET /providers/me/tool-bindings/catalogue` — for the binding editor.
 *
 * ## Why the endpoint exists
 *
 * A provider does not invent the tool they implement — they author a binding
 * **against a contract somebody else wrote**. `outputSchema` *is* that
 * contract: every response mapping has to satisfy it, `contract-check.ts`
 * refuses a Save that cannot, and the router's whole ability to substitute one
 * provider for another mid-flight rests on both of them producing the same
 * shape. `inputSchema` is the other half — the payload the request mapping is
 * handed.
 *
 * Neither reached the console before this. `SaveToolBindingBodyDto.toolId` is a
 * bare string and `ToolBindingSummaryDto.toolId` is a bare uuid, so the create
 * screen had a required field with no picker behind it and a mapping editor
 * with no columns to draw. The catalogue is the missing read.
 *
 * {@link ToolCatalogueDto.settlementAsset} rides along for a smaller but
 * sharper reason: `BindingEditorService.create` runs `assertKnownAsset` over
 * `body.assetId`, and no other endpoint tells the console which asset this
 * deployment settles in. Without it, every create is a guess that 400s with
 * `CHAIN_ASSET_NOT_REGISTERED` — a message about an asset the provider never
 * chose.
 *
 * ## What is deliberately not here
 *
 * `Tool.verificationPolicyId` is platform-internal: it names how the platform
 * judges an answer, not anything a provider authors or can act on, and putting
 * it on a provider-facing payload would invite a mapping written to satisfy the
 * judge rather than the contract.
 */
export class CatalogueToolDto {
  @ApiProperty({ description: 'The id a binding names in `toolId`.', example: 'search_web' })
  id: string;

  @ApiProperty({ description: 'Human label for the picker.', example: 'Search the web' })
  name: string;

  @ApiProperty({
    description:
      'Shown to the calling agent’s model, so it drives tool selection — product copy, ' +
      'not a comment. It is what a provider is agreeing to implement.',
  })
  description: string;

  @ApiProperty({ enum: ToolTier })
  tier: ToolTier;

  /**
   * JSON Schema documents, typed `unknown` with their **shape** left undeclared
   * on purpose.
   *
   * The same reasoning `SaveToolBindingBodyDto` gives for the two mappings, in
   * the other direction: these are JSON Schema, the mapping validator and
   * `contract-check.ts` are what read them, and re-declaring their shape in
   * Swagger decorators would give two answers to one question — with the
   * shallower, hand-maintained one arriving first and drifting quietly.
   *
   * The `@ApiProperty` below is not a contradiction of that and must stay: an
   * `unknown` property emits no `design:type` metadata, so without it Swagger
   * has nothing to read and the field disappears from the published schema
   * altogether. It declares that a document is here — `type: 'object'`,
   * `additionalProperties: true` — and declares nothing about what is in it,
   * which is exactly the line being drawn.
   *
   * They are also served **byte-identical to the catalogue's own copy**. The
   * console draws its editor tables from these and the server re-validates the
   * saved mapping against them; a payload that reordered or pruned a document
   * would let the two disagree about the same contract.
   */
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'JSON Schema for the tool input a mapping is handed.',
  })
  inputSchema: unknown;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'JSON Schema the response mapping must satisfy. The contract itself.',
  })
  outputSchema: unknown;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '1.1.0',
    description: 'The contract version unpinned URLs serve; a new binding defaults to its major.',
  })
  currentVersion: string | null;

  @ApiProperty({
    type: [ToolContractVersionDto],
    description:
      'Every published version, newest first, with its optional fields — what a binding ' +
      'chooses its range (`^1 || ^2`) and its declared fields from.',
  })
  versions: ToolContractVersionDto[];
}

/** The asset this deployment prices and settles in. One, for the MVP. */
export class SettlementAssetDto {
  @ApiProperty({ description: 'CAIP-19 asset id — what `assetId` on a binding must be.' })
  assetId: string;

  @ApiProperty({
    description:
      'CAIP-2 chain this asset settles on. A binding priced in it can only be offered on ' +
      'this chain, so a provider with no active enrolment there is refused with ' +
      '`PROVIDER_BINDING_CHAIN_NOT_ENROLLED` — the console can compare it with the ' +
      'chains in `GET /providers/me/stake` and warn before submit.',
    example: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  })
  chainId: string;

  @ApiProperty({ example: 'USDC' })
  symbol: string;

  @ApiProperty({ description: 'The scale `priceAmount` is quoted in.', example: 6 })
  decimals: number;

  /**
   * The paid-call minimum for the caller's bindings in this asset: a PAID or
   * FREEMIUM binding priced below it is refused by the editor
   * (`PROVIDER_BINDING_PRICE_BELOW_MINIMUM`), and an existing one takes no
   * paid call (`PAYMENT_PRICE_BELOW_MINIMUM`). `'0'` when no minimum applies.
   */
  @ApiProperty({
    description:
      'Minimum `priceAmount` (atomic units of this asset) of a PAID or FREEMIUM binding. ' +
      "'0' when no minimum applies to the caller.",
    example: '100000',
  })
  minPaidPrice: string;
}

/**
 * The whole catalogue, and the asset a binding must be priced in.
 *
 * **Unpaged, deliberately.** `ToolCataloguePort.listTools()` is unpaged and its
 * own doc comment says why — the launch catalogue is 24 tools and a
 * page cursor with nothing behind it is an API that has to change twice. This
 * endpoint inherits that decision rather than inventing a second answer to it;
 * when the port gains paging, so does this.
 */
export class ToolCatalogueDto {
  @ApiProperty({ type: [CatalogueToolDto], description: 'Every tool, unpaged. Empty is normal.' })
  tools: CatalogueToolDto[];

  @ApiProperty({ type: SettlementAssetDto })
  settlementAsset: SettlementAssetDto;
}
