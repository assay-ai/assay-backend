import { Injectable } from '@nestjs/common';

import { ProviderEntity } from '@database/postgres/entities/provider.entity';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';

import { GetProviderVerificationResponseDto } from '@modules/provider/dto/get-provider-verification.dto';
import { ProviderErrors } from '@modules/provider/errors/provider.errors';
import { toResponseDto } from '@modules/provider/services/provider-verification.service';

import { VerifyProviderBodyDto } from '../dto/operator-console.dto';
import { OperatorSession } from '../ports/operator-session.port';
import { OverrideLogService } from './override-log.service';

/**
 * `V-7` — the first writer `providers.verified` has ever had.
 *
 * Provider registration created the column, its attributor (`verified_by`, `verified_at`), its
 * method and its check list, and the providers explorer has been rendering a
 * badge off it ever since. Nothing wrote it: registration sets `verified:
 * false` and no other code path touched the seven columns, so the badge was a
 * label no provider could earn. This service is that path, and it is the only
 * one — see `ProviderVerificationService`'s trailing comment for why the label
 * still gates nothing.
 *
 * ## Why the whole write is one statement inside one override
 *
 * `chk_providers_verified_attributed` refuses `verified = true` with a null
 * `verified_by` or `verified_at`. A service that set the label and then its
 * author would be asking the database for a state it rejects, so all seven
 * columns move in a single `UPDATE` and the constraint never sees a half-state.
 * And the `UPDATE` runs on the `QueryRunner` `OverrideLogService.perform` hands
 * over, so the row and its register entry commit or roll back together — there
 * is no ordering in which the label changes without a record of who changed it.
 *
 * ## Why this throws a `provider` error from the `operator` module
 *
 * The workspace convention is one error catalog per domain, and reaching across
 * for one is deliberate here — as it already is in `OperatorCaseService`, which
 * raises `SlashErrors` for the same reason. The caller names a provider id, and
 * the honest answer to "there is no such provider" is `PROVIDER_NOT_FOUND`, the
 * same code the provider surface returns for the same fact. Minting an
 * `OPERATOR_*` twin would give one condition two codes and make a console that
 * handles both the only correct client.
 */
@Injectable()
export class OperatorProviderVerificationService {
  constructor(
    private readonly overrides: OverrideLogService,
    private readonly providers: ProviderRepository,
  ) {}

  async setVerification(
    operator: OperatorSession,
    providerId: string,
    body: VerifyProviderBodyDto,
    requestId: string | null,
  ): Promise<GetProviderVerificationResponseDto> {
    const existing = await this.providers.findOneBy({ organizationId: providerId });
    if (!existing) throw ProviderErrors.providerNotFound({ providerId });

    return this.overrides.perform<GetProviderVerificationResponseDto>(
      {
        code: 'V-7',
        actor: operator,
        targetType: 'provider',
        targetId: existing.id,
        organizationId: providerId,
        reasonCode: body.reasonCode,
        reason: body.note,
        ticketRef: body.ticketRef ?? null,
        requestId,
      },
      async (queryRunner) => {
        // Clearing the label clears its attributor too. A `verified: false` row
        // still naming an author reads as "somebody checked and it failed",
        // which is a different fact from "nobody has checked" — and the second
        // is what a withdrawn label means.
        const patch = {
          verified: body.verified,
          verifiedBy: body.verified ? operator.subject : null,
          verifiedAt: body.verified ? new Date() : null,
          verificationMethod: body.verified ? body.method : null,
          verificationChecks: body.checks.map((c) => ({
            check: c.check,
            result: c.result,
            note: c.note ?? null,
          })),
          verificationExpiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
          verificationEvidenceUrl: body.evidenceUrl ?? null,
        };

        const result = await queryRunner.manager
          .createQueryBuilder()
          .update(ProviderEntity)
          .set(patch)
          .where('organization_id = :organizationId', { organizationId: providerId })
          .andWhere('id = :id', { id: existing.id })
          .execute();
        if ((result.affected ?? 0) !== 1) {
          throw ProviderErrors.providerNotFound({ providerId });
        }

        const row = await queryRunner.manager.findOneOrFail(ProviderEntity, {
          where: { organizationId: providerId, id: existing.id },
        });
        // `before` carries the findings, not just the flag.
        //
        // The house convention is a minimal diff — `ArbitrationService` records
        // `{ status }` alone — and for a status column that is right. This is
        // the one column family where the evidence *is* the value: a clear
        // overwrites `verification_checks` and `verification_method` with
        // whatever the clearing request supplied, and nothing else in the
        // system retains what they were. Without them here, `reversible: true`
        // on `V-7` would mean only that the flag can be set back, not that the
        // withdrawn verification can be reconstructed — and the second is what
        // an appeal against a withdrawn label actually needs.
        return {
          value: toResponseDto(row),
          before: {
            verified: existing.verified,
            verifiedBy: existing.verifiedBy,
            verificationMethod: existing.verificationMethod,
            verificationChecks: existing.verificationChecks,
          },
          after: {
            verified: patch.verified,
            verifiedBy: patch.verifiedBy,
            verificationMethod: patch.verificationMethod,
            verificationChecks: patch.verificationChecks,
          },
        };
      },
    );
  }
}
