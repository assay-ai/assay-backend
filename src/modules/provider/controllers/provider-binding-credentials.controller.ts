import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentSession, HumanSessionGuard, SessionAuthGuard } from '@shared/auth';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';

import { credentialHeaderProblems, originOf } from '../credentials/credential-rules';
import { CredentialVaultService } from '../credentials/credential-vault.service';
import {
  CredentialSetSummaryDto,
  DeleteBindingCredentialsQueryDto,
  PutBindingCredentialsBodyDto,
} from '../dto/binding-credentials.dto';
import { GetToolBindingParamsDto } from '../dto/get-tool-bindings.dto';
import { ProviderErrors } from '../errors/provider.errors';
import { BindingEditorService } from '../services/binding-editor.service';

/**
 * The credential headers Assay sends to a provider's endpoint. Write-only:
 * no route returns a value, only names and hints.
 *
 * Every route loads the binding through `loadEditable` first — the vault does
 * not check that a binding belongs to the organization, so this is the guard
 * and the 404.
 */
@ApiTags('Provider')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard, HumanSessionGuard)
@Controller('providers/me/tool-bindings/:id/credentials')
export class ProviderBindingCredentialsController {
  constructor(
    private readonly editor: BindingEditorService,
    private readonly vault: CredentialVaultService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Credential sets stored for this binding: header names and hints only' })
  @ApiResponse({ status: 200, type: [CredentialSetSummaryDto] })
  async list(
    @CurrentSession() session: McpSession,
    @Param() params: GetToolBindingParamsDto,
  ): Promise<CredentialSetSummaryDto[]> {
    await this.editor.loadEditable(session.organizationId, params.id);
    return this.vault.list(session.organizationId, params.id);
  }

  @Put()
  @ApiOperation({ summary: 'Replace the credential set for one origin of this binding' })
  @ApiResponse({ status: 200, type: CredentialSetSummaryDto })
  @ApiResponse({
    status: 400,
    description:
      'PROVIDER_CREDENTIAL_ORIGIN_MISMATCH, or PROVIDER_INVALID_CREDENTIAL_HEADERS (names only)',
  })
  async put(
    @CurrentSession() session: McpSession,
    @Param() params: GetToolBindingParamsDto,
    @Body() body: PutBindingCredentialsBodyDto,
  ): Promise<CredentialSetSummaryDto> {
    const row = await this.editor.loadEditable(session.organizationId, params.id);

    const allowed = [originOf(row.endpoint)];
    const published = await this.editor.publishedEndpoint(row);
    if (published) allowed.push(originOf(published));
    if (!allowed.includes(body.origin)) {
      throw ProviderErrors.credentialOriginMismatch();
    }

    const problems = credentialHeaderProblems(body.headers);
    if (problems.length > 0) {
      throw ProviderErrors.invalidCredentialHeaders({ problems });
    }

    return this.vault.put(
      session.organizationId,
      params.id,
      body.origin,
      body.headers,
      session.credentialId,
    );
  }

  @Delete()
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove the credential set for one origin' })
  @ApiResponse({ status: 204 })
  async remove(
    @CurrentSession() session: McpSession,
    @Param() params: GetToolBindingParamsDto,
    @Query() query: DeleteBindingCredentialsQueryDto,
  ): Promise<void> {
    await this.editor.loadEditable(session.organizationId, params.id);
    await this.vault.remove(session.organizationId, params.id, query.origin);
  }
}
