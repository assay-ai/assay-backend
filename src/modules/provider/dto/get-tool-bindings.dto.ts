import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

import { ListQueryDto } from '@shared/api';
import { BindingStatus, PricingMode } from '@modules/tool/ports/tool.types';
import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';

/**
 * No resource-specific filters. `sort` accepts `createdAt`, the platform
 * default — the `tool_bindings` table is what finally gives this list a
 * `NOT NULL` timestamp to key on. It originally sorted by `id` for want of
 * one.
 */
export class ListToolBindingsQueryDto extends ListQueryDto {}

export class GetToolBindingParamsDto {
  @ApiProperty({ description: 'A binding id, as issued by `tool_bindings`.' })
  @IsUUID()
  id: string;
}

export class ToolBindingSummaryDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  toolId: string;

  @ApiProperty()
  endpoint: string;

  @ApiProperty({ enum: PricingMode })
  pricingMode: PricingMode;

  @ApiProperty({ type: MoneyDto })
  price: MoneyDto;

  @ApiProperty({ enum: BindingStatus })
  status: BindingStatus;

  /**
   * The chains this binding is offered on. CAIP-2, never empty.
   *
   * On the **summary** and not only the detail, unlike the two ceilings. A
   * console listing bindings has to be able to show which of them are offered
   * where — "why is this tool not routing on the chain I enrolled on" is a list
   * question, and answering it would otherwise cost one detail read per row.
   *
   * A declaration, not evidence: a chain named here is a chain the provider
   * *offers*, not one they are proven staked on. The stake is on chain and this
   * column is platform config, so nothing makes them agree by construction.
   */
  @ApiProperty({
    isArray: true,
    type: String,
    description:
      'CAIP-2 chain ids this binding is offered on. At least one. What the ' +
      'provider declared — not evidence of stake on those chains.',
    example: ['solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'],
  })
  settlementChains: string[];

  @ApiProperty({ description: 'Which stored revision of the request/response mapping this is' })
  version: number;
}

export class ToolBindingDetailDto extends ToolBindingSummaryDto {
  @ApiProperty({ description: "How the tool input maps to this provider's request shape" })
  requestMapping: unknown;

  @ApiProperty({ description: "How this provider's response maps to the tool's outputSchema" })
  responseMapping: unknown;

  @ApiPropertyOptional({ nullable: true })
  freeQuotaPerAgent: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description:
      'The most free calls this binding serves per day, across all agents (a call count, ' +
      'not money). `null` means the platform default.',
  })
  freeDailyBudget: number | null;

  @ApiProperty({ description: 'The declared SLA failure rate, e.g. 0.05 for 5%' })
  slaFailureRate: number;

  @ApiProperty()
  timeoutMs: number;

  /**
   * The two self-declared ceilings. `null` where none was declared.
   *
   * Read back as well as written, because a ceiling a provider can set and
   * never see again is a dial with no gauge — and the first question after
   * "why did my traffic drop" is what the row actually says.
   */
  @ApiPropertyOptional({ nullable: true, description: 'Declared requests-per-second ceiling.' })
  maxRps: number | null;

  @ApiPropertyOptional({ nullable: true, description: 'Declared calls-per-UTC-day ceiling.' })
  maxDailyCalls: number | null;

  /**
   * The revision serving live traffic, and whether the stored one has moved past
   * it.
   *
   * On the **detail** read, not only on the save response. The editor
   * screen is usually reached by loading a binding, not by having just saved
   * one, and without these two a freshly loaded editor cannot tell a clean draft
   * from one holding edits nobody has put live — which also means it cannot say
   * why the publish button is refusing it. The publish gate wants a
   * green tester run **at the current revision**, so a save silently invalidates
   * the tick that was there a moment ago; `version` vs `publishedVersion` is the
   * only thing that explains it.
   *
   * Deliberately not on {@link ToolBindingSummaryDto}. The list shows `status`,
   * which is the question a list answers.
   */
  @ApiProperty({ description: 'Which revision is live, or null if it has never been published.' })
  publishedVersion: number | null;

  /**
   * True when the current revision differs from the published one — the edits a
   * provider has made and not put live.
   *
   * **A never-published binding is `true`,** not `false`: everything about it is
   * unpublished. There is no published revision to differ from, and answering
   * `false` on that basis would tell a provider their draft was already serving.
   */
  @ApiProperty({
    description:
      'True when the current revision differs from the published one — ' +
      'the edits a provider has made and not put live. A binding that has ' +
      'never been published is wholly unpublished, so this is true.',
  })
  hasUnpublishedChanges: boolean;
}
