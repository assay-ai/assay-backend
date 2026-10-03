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
}

export class PublishCheckDto {
  @ApiProperty()
  publishable: boolean;

  @ApiProperty({ description: 'The revision that would go live.' })
  mappingVersion: number;

  @ApiProperty({ type: [PublishRequirementDto], description: 'One entry per requirement, always.' })
  requirements: PublishRequirementDto[];
}

export class PublishedToolBindingDto extends SavedToolBindingDto {
  @ApiProperty({ description: 'When this revision went live.' })
  publishedAt: Date;
}
