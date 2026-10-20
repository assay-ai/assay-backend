import { Injectable } from '@nestjs/common';

import { ProviderEntity } from '@database/postgres/entities/provider.entity';
import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { In } from 'typeorm';

import { GetProviderVerificationResponseDto } from '../dto/get-provider-verification.dto';
import { toVerificationDto } from '../dto/provider-shared.dto';
import { ProviderErrors } from '../errors/provider.errors';

/**
 * The `verified` label, read for the catalogue.
 *
 * ## Reading across the organization boundary is deliberate here
 *
 * `providerId === organizationId` platform-wide (see
 * `ProviderProfileService`'s class comment). Every other reader in this module
 * looks up the *calling* organization's own row. This one does not: a buyer
 * browsing the catalogue asks "is *this* provider verified?" about a provider
 * that is, by definition, never the caller. That is not a scope leak — the
 * label's whole point is public information a buyer needs before they
 * spend money, in the same way a legal name or a price is public. And it still
 * goes through `ProviderRepository`, so `assertOrganizationScopedWhere` still
 * runs: the predicate names `organization_id` (as `providerId`), it is just not
 * required to be the caller's own. The scope guard proves a query references
 * the tenant column; it was never a promise that every query is about the
 * caller's tenant, and a catalogue is the legitimate case where it is not.
 *
 * The per-id HTTP route is narrower ({@link getVerificationFor}): a session
 * reads its own provider, or one its organization has paid a call to. The
 * catalogue's batched read ({@link getVerifications}) only ever names listed
 * providers.
 */
@Injectable()
export class ProviderVerificationService {
  constructor(
    private readonly providers: ProviderRepository,
    private readonly intents: PaymentIntentRepository,
  ) {}

  /**
   * The label as `GET /providers/:providerId/verification` serves it: only
   * for the caller's own provider, or for a provider the caller's organization
   * has at least one call with (the receipt page names the provider of the
   * call it shows). Any other id is `providerNotFound`, the same 404 as an
   * absent provider, so the route cannot be used to enumerate providers or
   * read the verification record of one the caller never dealt with. The
   * catalogue reads labels through {@link getVerifications}, not this route.
   */
  async getVerificationFor(
    callerOrganizationId: string,
    providerId: string,
  ): Promise<GetProviderVerificationResponseDto> {
    if (providerId !== callerOrganizationId) {
      const hasCalled = await this.intents.existsBy({
        organizationId: callerOrganizationId,
        providerId,
      });
      if (!hasCalled) {
        throw ProviderErrors.providerNotFound({ providerId });
      }
    }
    return this.getVerification(providerId);
  }

  /**
   * The label for one provider, `UNVERIFIED_PROFILE`-shaped when nobody has
   * checked. `providerNotFound` when there is no row at all — an absent
   * provider and an unverified one are different facts, and the catalogue
   * needs to tell them apart (a delisted id vs. a listed, unverified one).
   */
  async getVerification(providerId: string): Promise<GetProviderVerificationResponseDto> {
    const provider = await this.providers.findOneBy({ organizationId: providerId });

    if (!provider) {
      throw ProviderErrors.providerNotFound({ providerId });
    }

    return toResponseDto(provider);
  }

  /**
   * The same read, batched — a catalogue listing is one query, not N. Silently
   * drops ids with no provider row rather than throwing, because a listing
   * page over many providers must not fail whole because one id is stale; a
   * caller after a single provider's label should use {@link getVerification},
   * which does throw.
   */
  async getVerifications(
    providerIds: readonly string[],
  ): Promise<ReadonlyMap<string, GetProviderVerificationResponseDto>> {
    if (providerIds.length === 0) {
      return new Map();
    }

    const rows = await this.providers.findBy({ organizationId: In([...providerIds]) });

    return new Map(rows.map((row) => [row.organizationId, toResponseDto(row)]));
  }
}

/**
 * `toVerificationDto` reads `verified`/`verifiedBy`/`verificationChecks`/…
 * straight off the row, so an unverified provider — every column at its
 * default (`verified: false`, `verifiedBy: null`, `verificationChecks: []`) —
 * already comes back `UNVERIFIED_PROFILE`-shaped with no branch needed here.
 * `chk_providers_verified_attributed` is what keeps that true: the database
 * refuses `verified = true` with a null author, so this mapper never has to
 * guess one.
 */
export function toResponseDto(provider: ProviderEntity): GetProviderVerificationResponseDto {
  return {
    providerId: provider.organizationId,
    legalName: provider.legalName,
    verification: toVerificationDto(provider),
  };
}

/**
 * Who writes `verified`, and why nothing else *reads* it.
 *
 * **The writer is `V-7`** — `POST /operator/providers/:providerId/verification`
 * (`OperatorProviderVerificationService`), added after open registration had
 * left the column, its attributor and its check list with no write path at all besides
 * registration's `verified: false`. It is a single-approver, reversible
 * override held by `ADJL`/`BD`, it goes through `OverrideLogService.perform`,
 * and it is the only place in this codebase that sets these seven columns.
 *
 * That writer did **not** make the label load-bearing, and this is the comment
 * that has to say so. Registration is open with no approval step, and the
 * publish gate gates *publishing* on a green mapping tester and sufficient stake — a
 * router and a publish check that already exist and already decide "can this
 * provider serve traffic" on their own terms. Wiring `verified` into either
 * would make it a second, silent approval gate wearing the clothes of an
 * informational label: the whole reason the label exists is to give buyers a
 * signal that is *not* load bearing anywhere, so that removing the manual
 * review open registration deleted does not quietly grow back through this column. If a
 * future milestone wants `verified` to gate something, that is a new decision
 * to write down, not a one-line change to a `WHERE` clause here.
 */
