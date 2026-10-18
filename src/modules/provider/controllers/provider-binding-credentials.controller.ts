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
import { AuditLogWriter, auditActorOf } from '@shared/audit';
import { BindingStatus } from '@modules/tool/ports/tool.types';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';

import { assertCredentialPut, originOf } from '../credentials/credential-rules';
import { CredentialVaultService } from '../credentials/credential-vault.service';
import {
  CredentialSetSummaryDto,
  DeleteBindingCredentialsQueryDto,
  PutBindingCredentialsBodyDto,
} from '../dto/binding-credentials.dto';
import { ProviderErrors } from '../errors/provider.errors';
import { GetToolBindingParamsDto } from '../dto/get-tool-bindings.dto';
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
    private readonly audit: AuditLogWriter,
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
      'PROVIDER_CREDENTIAL_ORIGIN_MISMATCH, or PROVIDER_INVALID_CREDENTIAL_HEADERS (names only; ' +
      'includes the 8 KiB cap on mapping constant headers + credentials + Assay headers)',
  })
  async put(
    @CurrentSession() session: McpSession,
    @Param() params: GetToolBindingParamsDto,
    @Body() body: PutBindingCredentialsBodyDto,
  ): Promise<CredentialSetSummaryDto> {
    const row = await this.editor.loadEditable(session.organizationId, params.id);

    assertCredentialPut(
      row.endpoint,
      await this.editor.publishedEndpoint(row),
      body.origin,
      body.headers,
      row.requestMapping,
    );

    const summary = await this.vault.put(
      session.organizationId,
      params.id,
      body.origin,
      body.headers,
      session.credentialId,
    );
    // Names only: the audit writer refuses secret-named keys, and values never reach it.
    await this.audit.recordAfterCommit({
      organizationId: session.organizationId,
      actor: auditActorOf(session),
      action: 'binding_credentials.set',
      resourceType: 'tool_binding',
      resourceId: params.id,
      after: { origin: body.origin, header_names: body.headers.map((h) => h.name) },
    });
    return summary;
  }

  @Delete()
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove the credential set for one origin' })
  @ApiResponse({ status: 204 })
  @ApiResponse({
    status: 409,
    description:
      'PROVIDER_CREDENTIAL_ORIGIN_LIVE: the origin of the published endpoint of an ACTIVE binding',
  })
  async remove(
    @CurrentSession() session: McpSession,
    @Param() params: GetToolBindingParamsDto,
    @Query() query: DeleteBindingCredentialsQueryDto,
  ): Promise<void> {
    const row = await this.editor.loadEditable(session.organizationId, params.id);
    // The published revision's origin is the one live calls use. Deleting its
    // set while the binding is ACTIVE would turn every call into a platform
    // fault; pause first, or publish an endpoint elsewhere (which prunes it).
    if (row.status === BindingStatus.ACTIVE) {
      const published = await this.editor.publishedEndpoint(row);
      if (published && originOf(published) === query.origin) {
        throw ProviderErrors.credentialOriginLive();
      }
    }
    const before = (await this.vault.list(session.organizationId, params.id)).find(
      (set) => set.origin === query.origin,
    );
    await this.vault.remove(session.organizationId, params.id, query.origin);
    await this.audit.recordAfterCommit({
      organizationId: session.organizationId,
      actor: auditActorOf(session),
      action: 'binding_credentials.removed',
      resourceType: 'tool_binding',
      resourceId: params.id,
      before: { origin: query.origin, header_names: before?.headers.map((h) => h.name) ?? [] },
    });
  }
}
