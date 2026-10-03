import { ApiProperty } from '@nestjs/swagger';

import { ToolTier } from '../ports/tool.types';

/**
 * `GET /tools` — the tool contracts, named.
 *
 * ## Why a second catalogue read exists
 *
 * `GET /providers/me/tool-bindings/catalogue` already serves this data, and it
 * is already platform-wide: it reads no session and its own controller says so.
 * A buyer screen could call it, and for one afternoon that is what the Explore
 * tabs were going to do. It is the wrong read for three reasons, and none of
 * them is style:
 *
 * - **It is on the seller surface.** `providers/me/*` is, everywhere else in
 *   this API, "the caller's own provider record". A buyer session calling it
 *   works only because this one route forgot to scope — which is a thing that
 *   gets fixed, and the day it is fixed every buyer screen goes blank.
 * - **It carries the contract, not the label.** `inputSchema` and
 *   `outputSchema` are there so a provider can author a mapping against them.
 *   A buyer rendering a table needs a name; shipping two JSON Schema documents
 *   per row to get one is payload nobody reads.
 * - **It carries `settlementAsset`,** which answers a question only the create-
 *   a-binding screen asks.
 *
 * So this is the same catalogue, cut to what a buyer is entitled to know: which
 * tools exist, what each one is called, what it does, and how hard the platform
 * checks it.
 *
 * ## What it is for
 *
 * Every buyer screen that names a tool had only `payment_intents.tool_id` to
 * print — a uuid. `06399979-f8b8-4c9e-a9b1-bd2a5924d442` is not a thing a
 * person recognises, and `/tool-calls` does not join anything that would fix
 * it. This is the join, done once by the client and cached, rather than
 * denormalised onto every call row.
 *
 * ## Not org-scoped, and that is the point
 *
 * A tool contract is authored by the platform (the seeded launch catalogue) and
 * is identical for every caller. The session is required — the guard is on the
 * controller, and an unauthenticated catalogue is a different decision that
 * nobody has taken — but it is not read.
 */
export class ToolSummaryDto {
  @ApiProperty({
    description: 'The id `payment_intents.tool_id` and every call row carries.',
    example: '06399979-f8b8-4c9e-a9b1-bd2a5924d442',
  })
  id: string;

  @ApiProperty({
    description: 'The name to print instead of the id.',
    example: 'get_weather',
  })
  name: string;

  @ApiProperty({
    description:
      'Shown to the calling agent’s model, so it drives tool selection — product copy, ' +
      'not a comment.',
  })
  description: string;

  @ApiProperty({
    enum: ToolTier,
    description: 'How hard the platform checks an answer to this tool.',
  })
  tier: ToolTier;
}

/**
 * The whole catalogue, unpaged.
 *
 * **Unpaged, deliberately** — `ToolCataloguePort.listTools()` is unpaged and
 * its own doc comment records why (the launch catalogue is 24 tools, and a
 * cursor with nothing behind it is an API that changes twice). This endpoint
 * inherits that decision rather than inventing a second answer to it; when the
 * port gains paging, so does this.
 *
 * Wrapped in an object rather than served as a bare array so that a later
 * `nextCursor` — or a `count`, or an `updatedAt` — is an added member instead
 * of a breaking change to the response's top-level type.
 */
export class ToolListDto {
  @ApiProperty({
    type: [ToolSummaryDto],
    description: 'Every tool, unpaged. Empty is normal — the catalogue is seeded.',
  })
  tools: ToolSummaryDto[];
}
