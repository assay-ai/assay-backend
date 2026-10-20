import { ApiProperty } from '@nestjs/swagger';

import { PublishRequirement } from '../domain/publish-gate';
import { SavedToolBindingDto } from './save-tool-binding.dto';

/**
 * `GET /providers/me/tool-bindings/:id/publish-check` and
 * `POST …/publish`.
 *
 * The checklist is a first-class response rather than the body of a 4xx,
 * because a provider reads it *before* pressing publish — the publish checklist is a screen
 * that shows which condition is still missing, not an error page. Pressing
 * publish anyway raises `PROVIDER_PUBLISH_CHECKS_FAILED` carrying this same
 * list, so the two surfaces cannot disagree.
 */
export class PublishRequirementDto {
  @ApiProperty({ enum: PublishRequirement })
  requirement: PublishRequirement;

  @ApiProperty()
  met: boolean;

  @ApiProperty({ nullable: true, description: 'Stable reason code when unmet.' })
  code: string | null;

  @ApiProperty({
    nullable: true,
    description: 'The specifics — how much stake is missing, which layer the tester failed at.',
  })
  detail: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 2,
    description:
      'TESTER_RUN and TESTER_PASSED: the contract major this row is for — one row per major ' +
      'in the binding’s `toolVersionRange`, each with its own result. `null` on the other ' +
      'requirements.',
  })
  major: number | null;
}

export class PublishCheckDto {
  @ApiProperty()
  publishable: boolean;

  @ApiProperty({ description: 'The revision that would go live.' })
  mappingVersion: number;

  @ApiProperty({
    type: [PublishRequirementDto],
    description:
      'One entry per requirement; the tester requirements one per contract major in the ' +
      'range, the payout and stake ones one per failing chain (one entry when all pass).',
  })
  requirements: PublishRequirementDto[];
}

export class PublishedToolBindingDto extends SavedToolBindingDto {
  @ApiProperty({ description: 'When this revision went live.' })
  publishedAt: Date;
}
