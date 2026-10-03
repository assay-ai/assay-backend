import { Injectable, Logger } from '@nestjs/common';

import { EvidencePackEntity } from '@database/postgres/entities/evidence-pack.entity';
import { EvidenceBodyRepository } from '@database/postgres/repositories/evidence-body.repository';
import { EvidencePackRepository } from '@database/postgres/repositories/evidence-pack.repository';

import { verifyPackIntegrity } from '../domain/evidence/pack';
import { EvidenceCore } from '../domain/evidence/pack.types';
import {
  EvidenceBodyDigestsDto,
  EvidenceIntegrityDto,
  ProviderVerdictEvidenceDto,
} from '../dto/get-verdict-evidence.dto';
import { PinnedPolicyDto, SamplingProofDto } from '../dto/get-verdict-evidence.dto';
import { StageResultDto } from '../dto/get-verdict.dto';
import { VerificationErrors } from '../errors/verification.errors';

/** Everything the buyer's endpoint needs from a sealed pack. */
export interface SealedEvidenceView {
  readonly request: unknown;
  readonly response: unknown;
  readonly stageResults: StageResultDto[];
  readonly sampling: SamplingProofDto;
  readonly pinnedPolicy: PinnedPolicyDto | null;
  readonly evaluatedAt: Date | null;
  readonly integrity: EvidenceIntegrityDto;
  readonly bodyDigests: EvidenceBodyDigestsDto;
}

/**
 * Reads a sealed evidence pack, and checks it on the way out.
 *
 * ## Every read recomputes the hash
 *
 * Not only on request, and not only for failures. A pack that no longer hashes
 * to its stored digest is **not served** — the read raises
 * `VERIFICATION_EVIDENCE_PACK_TAMPERED` and logs at error, because returning it
 * with a warning flag would put the burden of noticing on whoever is reading a
 * dispute at the time. The database refuses `UPDATE` on these rows
 * (`trg_evidence_packs_append_only`), so reaching this branch means something
 * bypassed the trigger — a restore, a superuser, a migration — and that is an
 * incident, not a display state.
 *
 * The cost is one sha256 over the core per read. Evidence is read by humans
 * arguing about money, not in a hot path.
 *
 * ## Two callers, one boundary
 *
 * `forBuyer` is scoped by `organization_id` the ordinary way. `forProvider` is
 * scoped by `provider_id`, which is a deliberate cross-tenant read (the pack's
 * tenant is the buyer), and it returns a payload with `seq` and `prevHash`
 * removed — a buyer's chain position counts their verdicts, and a provider has
 * no business learning that number.
 */
@Injectable()
export class EvidencePackService {
  private readonly logger = new Logger(EvidencePackService.name);

  constructor(
    private readonly packs: EvidencePackRepository,
    private readonly bodies: EvidenceBodyRepository,
  ) {}

  /**
   * The sealed pack for a verdict, or `null` when there is none.
   *
   * `null` rather than a 404 because the buyer's endpoint has a fallback: a
   * verdict judged before evidence packs existed still renders, from the record, labelled
   * `integrity: null`. Only the provider's route treats absence as not-found.
   */
  async forBuyer(organizationId: string, verdictId: string): Promise<SealedEvidenceView | null> {
    const pack = await this.packs.findByVerdictId(organizationId, verdictId);
    if (!pack) return null;

    return this.render(pack);
  }

  async forProvider(providerId: string, verdictId: string): Promise<ProviderVerdictEvidenceDto> {
    const pack = await this.packs.findByVerdictIdForProvider(providerId, verdictId);
    if (!pack) {
      throw VerificationErrors.evidencePackNotFound({ verdictId });
    }

    const view = await this.render(pack);

    return {
      id: pack.verdictId,
      intentId: pack.intentId,
      toolId: (pack.core as unknown as EvidenceCore).toolId,
      request: view.request,
      response: view.response,
      stageResults: view.stageResults,
      sampling: view.sampling,
      pinnedPolicy: view.pinnedPolicy,
      evaluatedAt: view.evaluatedAt,
      // No `seq`, no `prevHash` — see `ProviderEvidenceIntegrityDto`.
      integrity: {
        sealed: true,
        contentHash: view.integrity.contentHash,
        sealedAt: view.integrity.sealedAt,
        bodyState: view.integrity.bodyState,
      },
      bodyDigests: view.bodyDigests,
    };
  }

  private async render(pack: EvidencePackEntity): Promise<SealedEvidenceView> {
    const core = pack.core as unknown as EvidenceCore;
    const contentHash = pack.contentHash.trim();

    if (
      !verifyPackIntegrity({ core, seq: pack.seq, prevHash: normalise(pack.prevHash), contentHash })
    ) {
      this.logger.error(
        `Evidence pack ${pack.id} (verdict ${pack.verdictId}) does not match its content hash. ` +
          `The table refuses UPDATE, so this row was changed outside the application.`,
      );
      throw VerificationErrors.evidencePackTampered({ packId: pack.id });
    }

    const body = await this.bodies.findByPackId(pack.organizationId, pack.id);

    return {
      request: body?.request ?? null,
      response: body?.response ?? null,
      stageResults: (core.stages ?? []) as StageResultDto[],
      sampling: core.sampling,
      pinnedPolicy: core.policy
        ? {
            policyId: core.policy.decisionPolicyId,
            policyVersion: core.policy.decisionPolicyVersion,
            lifecycle: core.policy.lifecycle,
            decisionDocument: core.policy.decisionDocument ?? {},
            verificationDocument: core.policy.verificationDocument,
          }
        : null,
      evaluatedAt: core.timestamps.evaluatedAt ? new Date(core.timestamps.evaluatedAt) : null,
      integrity: {
        sealed: true,
        seq: Number(pack.seq),
        contentHash,
        prevHash: normalise(pack.prevHash),
        sealedAt: pack.sealedAt,
        // The body row's absence IS the retention state. A second column saying
        // so would be a value that has to be kept in step with a deletion, and
        // the two would eventually disagree.
        bodyState: body ? 'RAW' : 'DIGESTED',
      },
      bodyDigests: {
        request: core.bodyDigests.request,
        response: core.bodyDigests.response,
      },
    };
  }
}

/**
 * `char(64)` pads with spaces, and the padding is invisible in every log line
 * it ever appears in. Comparing an unpadded digest against a padded column
 * would fail every verification for a reason nobody could see.
 */
function normalise(hash: string | null): string | null {
  return hash === null ? null : hash.trim();
}
