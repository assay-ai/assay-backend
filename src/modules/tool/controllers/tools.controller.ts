import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SessionAuthGuard } from '@shared/auth';

import { ToolListDto } from '../dto/get-tools.dto';
import { PublicToolCatalogueService } from '../services/public-tool-catalogue.service';

/**
 * The tool catalogue, as a buyer reads it.
 *
 * One route, and it takes no parameters. See `dto/get-tools.dto.ts` for why it
 * exists next to `GET /providers/me/tool-bindings/catalogue` rather than
 * reusing it.
 *
 * `@CurrentSession()` is deliberately absent from the signature. The guard is
 * on the controller, so a caller still has to be somebody; but the answer does
 * not depend on who they are, and taking a session parameter only to ignore it
 * reads as an oversight rather than as a decision.
 */
@ApiTags('Tools')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('tools')
export class ToolsController {
  constructor(private readonly catalogue: PublicToolCatalogueService) {}

  @Get()
  @ApiOperation({
    summary:
      'Every tool in the catalogue, with the name to print instead of its id. ' +
      'Platform-wide, identical for every caller, unpaged.',
  })
  @ApiResponse({ status: 200, type: ToolListDto })
  async list(): Promise<ToolListDto> {
    return this.catalogue.listTools();
  }
}
