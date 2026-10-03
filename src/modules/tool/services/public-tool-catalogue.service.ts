import { Inject, Injectable } from '@nestjs/common';

import { TOOL_CATALOGUE, ToolCataloguePort } from '../ports/tool-catalogue.port';
import { Tool } from '../ports/tool.types';
import { ToolListDto, ToolSummaryDto } from '../dto/get-tools.dto';

/**
 * The buyer-facing view of the tool catalogue.
 *
 * It reads the same `TOOL_CATALOGUE` port the router reads, so the names a
 * buyer sees are the names the router routes on. A second source — a table of
 * display labels, a translation file — would be a place for the two to
 * disagree, and the disagreement would surface as a receipt naming a tool the
 * catalogue does not have.
 *
 * There is no organization anywhere in this class's signature. That is not an
 * oversight to be tightened later: a tool contract is platform-authored and
 * identical for every caller, and `test/unit/tool/public-tool-catalogue.spec.ts`
 * keeps a case that goes red the day somebody scopes it.
 */
@Injectable()
export class PublicToolCatalogueService {
  constructor(@Inject(TOOL_CATALOGUE) private readonly catalogue: ToolCataloguePort) {}

  async listTools(): Promise<ToolListDto> {
    const tools = await this.catalogue.listTools();

    return { tools: tools.map(toToolSummaryDto) };
  }
}

/**
 * `Tool` → the buyer payload.
 *
 * Written as an explicit four-field literal rather than a spread-and-delete,
 * because the fields left out are left out for a reason and a spread would
 * carry the next one in silently:
 *
 * - `inputSchema` / `outputSchema` — the contract a *provider* authors a
 *   mapping against. A buyer table needs a label, not two JSON Schema
 *   documents per row.
 * - `verificationPolicyId` — platform-internal. It names how the platform
 *   judges an answer, and publishing it invites a mapping written to satisfy
 *   the judge rather than the contract. `CatalogueToolDto` withholds it from
 *   providers for exactly that reason; withholding it from buyers costs
 *   nothing and keeps one rule instead of two.
 */
function toToolSummaryDto(tool: Tool): ToolSummaryDto {
  return {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    tier: tool.tier,
  };
}
