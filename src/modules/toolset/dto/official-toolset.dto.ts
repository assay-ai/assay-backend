import { ApiProperty } from '@nestjs/swagger';

import { TOOLSET_ICONS } from './toolset.dto';

/** One tool of an official set, as the operator console shows it. */
export class OfficialToolsetEntryDto {
  @ApiProperty()
  position: number;

  @ApiProperty({ format: 'uuid' })
  toolId: string;

  @ApiProperty()
  toolName: string;

  @ApiProperty()
  category: string;

  @ApiProperty({
    example: '^1',
    nullable: true,
    description: 'Contract majors this entry routes to',
  })
  toolVersionRange: string | null;

  @ApiProperty({ description: 'The tool row: `ACTIVE`, `DEPRECATED`, `REMOVED`, …' })
  toolStatus: string;

  @ApiProperty({ description: 'LISTED, UNLISTED or PRIVATE' })
  toolVisibility: string;

  @ApiProperty({
    description:
      'ACTIVE provider bindings of the tool. 0: no provider serves it yet, so a call through ' +
      'this set has nobody to route to',
  })
  bindingCount: number;
}

/**
 * An official (platform) tool set, Draft included (design spec §7.10).
 * Published versions serve at `/@assay/{slug}`; the Draft serves nothing.
 */
export class OfficialToolsetDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  slug: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ nullable: true })
  description: string | null;

  @ApiProperty({ nullable: true })
  category: string | null;

  @ApiProperty({ type: [String] })
  tags: string[];

  @ApiProperty({ nullable: true, enum: TOOLSET_ICONS })
  icon: string | null;

  @ApiProperty({ type: [String], description: '"Always loaded" tool names, at most 5' })
  pinnedTools: string[];

  @ApiProperty({ enum: ['PRIVATE', 'PUBLIC'], description: 'PRIVATE until its first publish' })
  visibility: string;

  @ApiProperty({ nullable: true, enum: ['LISTED', 'DELISTED'] })
  listingStatus: string | null;

  @ApiProperty({ description: 'An operator delist stands (A-15); relist with A-20' })
  delisted: boolean;

  @ApiProperty({ description: 'Taken down (A-16): nothing serves it' })
  removed: boolean;

  @ApiProperty({ nullable: true, description: 'The newest published version; null for a Draft' })
  latestVersion: number | null;

  @ApiProperty({ description: 'The Draft differs from the newest published version (or none yet)' })
  draftChanged: boolean;

  @ApiProperty({ description: 'The slug is fixed from the first publish' })
  slugLocked: boolean;

  @ApiProperty({ nullable: true, example: 'https://mcp.example.com/@assay/web-research' })
  publicUrl: string | null;

  @ApiProperty({ type: [OfficialToolsetEntryDto] })
  entries: OfficialToolsetEntryDto[];

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt: string;
}
