import { IsNull, MoreThan } from 'typeorm';

import { Inject, Injectable } from '@nestjs/common';

import { ProviderChainEnrolmentEntity } from '@database/postgres/entities/provider-chain-enrolment.entity';
import { ProviderEntity } from '@database/postgres/entities/provider.entity';
import { UNIQUE_VIOLATION_CODE } from '@database/postgres/repositories/abstract.repository';
import { ProviderConnectivityCheckRepository } from '@database/postgres/repositories/provider-connectivity-check.repository';
import { ProviderChainEnrolmentRepository } from '@database/postgres/repositories/provider-chain-enrolment.repository';
import { ProviderPayoutChallengeRepository } from '@database/postgres/repositories/provider-payout-challenge.repository';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';

import {
  AcceptedTermsInputDto,
  ProviderContactInputDto,
  ProviderPayoutAccountDto,
  ProviderRegistrationRecordDto,
  RegisterProviderBodyDto,
  RegisterProviderResponseDto,
} from '../dto/register-provider.dto';
import {
  GetProviderRegistrationResponseDto,
  ProviderOnboardingStepDto,
  ProviderOnboardingStepKey,
  ProviderTermsSummaryDto,
  UpdateProviderAccountBodyDto,
} from '../dto/get-provider-registration.dto';
import { toConnectivityDto, toContactDto, toVerificationDto } from '../dto/provider-shared.dto';
import { ProviderErrors } from '../errors/provider.errors';
import {
  AcceptedTerms,
  ConnectivityOutcome,
  OnboardingStepStatus,
  ProviderContact,
} from '../ports/provider-registration.types';
import { ChainEnrolmentStatus } from '../ports/chain-enrolment.port';
import { ProviderStatus, ProviderTier } from '../ports/provider.types';
import { PROVIDER_TERMS, ProviderTermsSource } from './provider-terms';

/**
 * Open registration and the console's onboarding screen.
 *
 * ## Open means open
 *
 * `register` writes a row and returns it. There is no queue, no reviewer, no
 * status the row passes through before it is real — see `provider.entity.ts`'s
 * class comment for why that absence is the feature rather than a gap. What
 * *does* gate paid traffic is the publish check (a green mapping tester
 * plus stake at or above the minimum), which this service does not touch.
 *
 * ## Terms are required at `POST`, not at step 4
 *
 * The console draws terms as step 4 — something accepted after the row
 * already exists. This API requires `acceptedTerms` on `POST /providers`
 * instead, because a `providers` row is a counterparty record: it is what the
 * platform pays out to and what a slash is asserted against, and a row that
 * exists with no agreement behind it is a counterparty the platform has no
 * contract with. So step 4 is `DONE` from the moment the row
 * exists — there is no path to a registered provider who has not accepted —
 * and the console's four-step *walkthrough* stays true even
 * though the *API* enforces the order differently underneath it.
 *
 * ## Duplicate registration is a database answer, not a service one
 *
 * `register` does not check-then-insert. It inserts and reads what Postgres
 * says: `uq_providers_organization_id` is the single source of truth for "has
 * this organization already registered", and translating its unique-violation
 * into `PROVIDER_ALREADY_REGISTERED` is what keeps two concurrent `POST`s from
 * both succeeding — the race a read-then-write cannot close.
 */
@Injectable()
export class ProviderRegistrationService {
  constructor(
    private readonly providers: ProviderRepository,
    private readonly payoutChallenges: ProviderPayoutChallengeRepository,
    private readonly chainEnrolments: ProviderChainEnrolmentRepository,
    private readonly connectivityChecks: ProviderConnectivityCheckRepository,
    @Inject(PROVIDER_TERMS) private readonly termsSource: ProviderTermsSource,
  ) {}

  async register(
    session: McpSession,
    body: RegisterProviderBodyDto,
  ): Promise<RegisterProviderResponseDto> {
    const technicalContact = toContact(body.technicalContact);
    const ownerContact = toContact(body.ownerContact);
    this.assertDistinctContacts(technicalContact, ownerContact);
    this.assertValidTimezone(body.timezone);
    const acceptedTerms = this.buildAcceptedTerms(body.acceptedTerms, session.credentialId);

    let saved: ProviderEntity;
    try {
      saved = await this.providers.save({
        organizationId: session.organizationId,
        legalName: body.legalName,
        technicalContact,
        ownerContact,
        timezone: body.timezone,
        acceptedTerms,
        status: ProviderStatus.ACTIVE,
        tier: ProviderTier.NEW,
        verified: false,
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw ProviderErrors.alreadyRegistered({ legalName: body.legalName });
      }
      throw error;
    }

    // No enrolments: the row is brand new. A second `POST` for an organization
    // that already has one is `alreadyRegistered` above, and an enrolment
    // cannot exist without a provider row — `issueChallenge` refuses to mint a
    // nonce for an organization that has not registered — so there is nothing
    // to read and no query worth issuing.
    return this.toRecordDto(saved, []);
  }

  async getRegistration(organizationId: string): Promise<GetProviderRegistrationResponseDto> {
    const provider = await this.providers.findOneBy({ organizationId });
    if (!provider) {
      throw ProviderErrors.providerNotFound({ providerId: organizationId });
    }
    return this.buildRegistrationState(provider);
  }

  /**
   * `endpoint` and the payout address are absent from {@link
   * UpdateProviderAccountBodyDto} at the type level, and the global
   * `ValidationPipe` (`whitelist: true, forbidNonWhitelisted: true` —
   * `bootstrap/api/main.ts`) rejects a request that sends them before this
   * method ever runs. Nothing here reads either field off `body`, on purpose:
   * the payout proof writes the payout address only from a verified signature
   * and the connectivity check writes `endpoint` only through its own
   * declare-and-probe flow, and letting either arrive through this generic
   * PATCH would be a second, unproven path onto both columns.
   */
  async updateAccount(
    session: McpSession,
    body: UpdateProviderAccountBodyDto,
  ): Promise<GetProviderRegistrationResponseDto> {
    const organizationId = session.organizationId;
    const provider = await this.providers.findOneBy({ organizationId });
    if (!provider) {
      throw ProviderErrors.providerNotFound({ providerId: organizationId });
    }

    const technicalContact = body.technicalContact
      ? toContact(body.technicalContact)
      : provider.technicalContact;
    const ownerContact = body.ownerContact ? toContact(body.ownerContact) : provider.ownerContact;
    this.assertDistinctContacts(technicalContact, ownerContact);

    const timezone = body.timezone ?? provider.timezone;
    if (body.timezone) {
      this.assertValidTimezone(timezone);
    }

    // `acceptedTerms` is optional here: omitting it leaves the row's existing
    // acceptance untouched. Sending it is how a provider re-accepts once the
    // published versions move — same validation and stamping as `register`.
    const acceptedTerms = body.acceptedTerms
      ? this.buildAcceptedTerms(body.acceptedTerms, session.credentialId)
      : provider.acceptedTerms;

    const legalName = body.legalName ?? provider.legalName;

    await this.providers.update(
      { organizationId, id: provider.id },
      { legalName, technicalContact, ownerContact, timezone, acceptedTerms },
    );

    // `{ ...provider }` copies the row's data fields, not `ProviderEntity`'s
    // TypeORM prototype methods (`save`, `hasId`, …) — none of which
    // `buildRegistrationState` calls, so the cast is safe. Re-reading the row
    // after `update()` would also work but costs a round trip this method has
    // no reason to pay for.
    const updated = {
      ...provider,
      legalName,
      technicalContact,
      ownerContact,
      timezone,
      acceptedTerms,
    } as ProviderEntity;
    return this.buildRegistrationState(updated);
  }

  // ── Onboarding state ────────────────────────────────────────────────────

  private async buildRegistrationState(
    provider: ProviderEntity,
  ): Promise<GetProviderRegistrationResponseDto> {
    const organizationId = provider.organizationId;
    const [enrolments, endpointStatus, lastCheck] = await Promise.all([
      this.chainEnrolments.findByProviders([organizationId]),
      this.deriveEndpointStatus(organizationId, provider),
      this.connectivityChecks.findOne({
        where: { organizationId },
        order: { createdAt: 'DESC' },
      }),
    ]);
    const payoutStatus = await this.derivePayoutWalletStatus(organizationId, enrolments);

    const steps = this.buildSteps(payoutStatus, endpointStatus);

    return {
      registration: this.toRecordDto(provider, enrolments),
      steps,
      currentStep: deriveCurrentStep(steps),
      totalSteps: steps.length,
      terms: this.toTermsSummaryDto(),
      lastConnectivityCheck: lastCheck ? toConnectivityDto(lastCheck) : null,
    };
  }

  private buildSteps(
    payoutStatus: OnboardingStepStatus,
    endpointStatus: OnboardingStepStatus,
  ): ProviderOnboardingStepDto[] {
    return [
      {
        key: ProviderOnboardingStepKey.ACCOUNT,
        title: 'Account',
        caption: 'who we contact, and in which timezone',
        // The row exists by the time this method runs — `getRegistration` and
        // `updateAccount` both 404 before reaching here otherwise — so this
        // step is always DONE. See the class comment on why `register` also
        // requires terms be accepted, which is what makes this true for every
        // row rather than most of them.
        status: OnboardingStepStatus.DONE,
      },
      {
        key: ProviderOnboardingStepKey.PAYOUT_WALLET,
        title: 'Payout wallet',
        caption:
          'the address your earnings settle to — proved by a wallet signature, never declared',
        status: payoutStatus,
      },
      {
        key: ProviderOnboardingStepKey.ENDPOINT,
        title: 'Endpoint',
        caption: 'where we send calls, checked before you go live',
        status: endpointStatus,
      },
      {
        key: ProviderOnboardingStepKey.TERMS,
        title: 'Terms',
        caption: 'two documents, no second page of conditions',
        // See the class comment: acceptance is required at `POST`, so this is
        // DONE from the same moment `ACCOUNT` is.
        status: OnboardingStepStatus.DONE,
      },
    ];
  }

  /**
   * `DONE` once an **ACTIVE** enrolment exists on any chain; `IN_PROGRESS`
   * while a nonce is outstanding (issued, not consumed, not expired) **or**
   * while every enrolment the provider has is closed; `NOT_STARTED` otherwise.
   * Reads `provider_payout_challenges` directly rather than a summary column —
   * the open-challenge query is the only place that state lives, and it is
   * cheap because `idx_provider_payout_challenges_open` exists for exactly
   * this read.
   *
   * ## "Any chain", but only an ACTIVE one
   *
   * The step asks whether the provider has finished the signing flow, not
   * whether they are payable on some particular chain — the per-chain question
   * is `evaluatePayoutGate`'s and is asked per call. So one ACTIVE enrolment
   * anywhere is `DONE`, and answering per chain here would tell a provider they
   * had not done something they had.
   *
   * But `DONE` on **any status** was a lie in the other direction, and a worse
   * one, because it reassures: a provider whose only enrolment is `SUSPENDED`
   * would read "Payout wallet ✓" while every paid binding they own is refused
   * with `PAYOUT_ENROLMENT_NOT_ACTIVE`. `IN_PROGRESS` is the least wrong of the
   * three words available — it is true that they are not finished, and it is
   * not the tick. The vocabulary has no fourth value for "closed by the
   * platform", which is why `ProviderPayoutAccountDto.status` carries the real
   * answer alongside the address: the step says *not yet*, the list says *why*.
   */
  private async derivePayoutWalletStatus(
    organizationId: string,
    enrolments: readonly ProviderChainEnrolmentEntity[],
  ): Promise<OnboardingStepStatus> {
    if (enrolments.some((enrolment) => enrolment.status === ChainEnrolmentStatus.ACTIVE)) {
      return OnboardingStepStatus.DONE;
    }
    if (enrolments.length > 0) {
      // Proved, and closed. Not `NOT_STARTED` — they signed — and not `DONE`.
      return OnboardingStepStatus.IN_PROGRESS;
    }
    const openChallenge = await this.payoutChallenges.findOneBy({
      organizationId,
      consumedAt: IsNull(),
      expiresAt: MoreThan(new Date()),
    });
    return openChallenge ? OnboardingStepStatus.IN_PROGRESS : OnboardingStepStatus.NOT_STARTED;
  }

  /**
   * `DONE` requires both an endpoint on the row *and* the latest probe of
   * that exact endpoint answering `REACHABLE` — a stale check against an
   * endpoint the provider has since changed must not read as done. `IN_
   * PROGRESS` covers "declared but never checked" and "declared but the last
   * check failed" identically: both mean the provider has more to do, and the
   * distinction between them belongs to the connectivity check's own history, not to this
   * step's status.
   */
  private async deriveEndpointStatus(
    organizationId: string,
    provider: ProviderEntity,
  ): Promise<OnboardingStepStatus> {
    if (!provider.endpoint) {
      return OnboardingStepStatus.NOT_STARTED;
    }
    const latest = await this.connectivityChecks.findOne({
      where: { organizationId, endpoint: provider.endpoint },
      order: { createdAt: 'DESC' },
    });
    return latest?.outcome === ConnectivityOutcome.REACHABLE
      ? OnboardingStepStatus.DONE
      : OnboardingStepStatus.IN_PROGRESS;
  }

  // ── Validation ──────────────────────────────────────────────────────────

  private assertDistinctContacts(technical: ProviderContact, owner: ProviderContact): void {
    if (technical.email.trim().toLowerCase() === owner.email.trim().toLowerCase()) {
      throw ProviderErrors.contactsNotDistinct({ email: technical.email });
    }
  }

  private assertValidTimezone(timezone: string): void {
    if (!isKnownIanaTimeZone(timezone)) {
      throw ProviderErrors.timezoneUnknown({ timezone });
    }
  }

  /**
   * Validates the three claimed versions against what is currently
   * published and, if they match, stamps a fresh acceptance. There is no
   * partial acceptance: all three must equal the published set, because the
   * three documents are accepted as one act (see `AcceptedTerms` in
   * `ports/provider-registration.types.ts`).
   */
  private buildAcceptedTerms(input: AcceptedTermsInputDto, acceptedBy: string): AcceptedTerms {
    const { providerAgreementVersion, payoutTermsVersion, slashPolicyVersion } =
      this.termsSource.current();
    const matches =
      input.providerAgreementVersion === providerAgreementVersion &&
      input.payoutTermsVersion === payoutTermsVersion &&
      input.slashPolicyVersion === slashPolicyVersion;

    if (!matches) {
      throw ProviderErrors.termsVersionMismatch({
        expected: `${providerAgreementVersion} / ${payoutTermsVersion} / ${slashPolicyVersion}`,
        got:
          `${input.providerAgreementVersion} / ${input.payoutTermsVersion} / ` +
          `${input.slashPolicyVersion}`,
      });
    }

    return {
      providerAgreementVersion,
      payoutTermsVersion,
      slashPolicyVersion,
      acceptedAt: new Date().toISOString(),
      acceptedBy,
    };
  }

  // ── Mapping ─────────────────────────────────────────────────────────────

  private toRecordDto(
    provider: ProviderEntity,
    enrolments: readonly ProviderChainEnrolmentEntity[],
  ): ProviderRegistrationRecordDto {
    return {
      id: provider.id,
      // The signature audience: bindings carry `providerId === organizationId`.
      providerId: provider.organizationId,
      legalName: provider.legalName,
      technicalContact: toContactDto(provider.technicalContact),
      ownerContact: toContactDto(provider.ownerContact),
      timezone: provider.timezone,
      acceptedTerms: provider.acceptedTerms,
      status: provider.status as ProviderStatus,
      tier: provider.tier as ProviderTier,
      payoutAccounts: toPayoutAccountDtos(enrolments),
      endpoint: provider.endpoint,
      verification: toVerificationDto(provider),
      registeredAt: provider.createdAt.toISOString(),
    };
  }

  private toTermsSummaryDto(): ProviderTermsSummaryDto {
    // Built per request: the stake floor, fee, split and hold follow the chain.
    const terms = this.termsSource.current();
    return {
      providerAgreementVersion: terms.providerAgreementVersion,
      payoutTermsVersion: terms.payoutTermsVersion,
      slashPolicyVersion: terms.slashPolicyVersion,
      acceptanceLine: terms.acceptanceLine,
      commercialTerms: terms.commercialTerms.map((term) => ({ ...term })),
    };
  }
}

function toContact(input: ProviderContactInputDto): ProviderContact {
  return { name: input.name, email: input.email, phone: input.phone ?? null };
}

function deriveCurrentStep(steps: ProviderOnboardingStepDto[]): number {
  const firstUnfinished = steps.findIndex((step) => step.status !== OnboardingStepStatus.DONE);
  return firstUnfinished === -1 ? steps.length : firstUnfinished + 1;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null | undefined)?.code === UNIQUE_VIOLATION_CODE;
}

/**
 * `Intl.supportedValuesOf('timeZone')` returns CLDR's canonical spellings,
 * and CLDR canonicalises several zones to their *deprecated* IANA alias
 * rather than the current primary name. `Asia/Kolkata`
 * is the primary IANA identifier and `Asia/Calcutta` is the backward-compat
 * alias — but this ICU build's canonical list has it backwards, so checking
 * membership in that list alone rejected a provider's own correct, current
 * timezone. Found during provider onboarding: a
 * provider was refused with "Not an IANA time zone: Asia/Kolkata", a message
 * that is factually wrong — it *is* the IANA name, just not this list's
 * canonical spelling of it. The same mismatch hits `Europe/Kyiv` and
 * `America/Nuuk`, among others.
 *
 * `Intl.DateTimeFormat` construction is the runtime's own answer to "can I
 * compute in this zone", which is the only property this check needs, and it
 * accepts both the canonical spelling and every alias — a strict superset of
 * `supportedValuesOf`. `supportedValuesOf` is kept only as a fast path (a Set
 * lookup beats throwing and catching for the common canonical case); it can
 * only ever say "valid" to something the fallback already accepts, so
 * dropping it would change performance, not correctness.
 *
 * One thing `DateTimeFormat` accepts that must still be refused: a raw
 * fixed-offset string like `'+05:30'`. That is not an IANA zone identifier —
 * timezone here is used to count business days, and a fixed offset cannot
 * express DST, so it is rejected explicitly before the zone check runs.
 */
const FIXED_OFFSET_TIMEZONE_PATTERN = /^[+-]\d{1,2}(:?\d{2})?$/;

function isKnownIanaTimeZone(timezone: string): boolean {
  if (typeof timezone !== 'string' || timezone.length === 0) {
    return false;
  }
  if (FIXED_OFFSET_TIMEZONE_PATTERN.test(timezone)) {
    return false;
  }
  const supportedValuesOf = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf;
  if (typeof supportedValuesOf === 'function' && supportedValuesOf('timeZone').includes(timezone)) {
    return true;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Every chain this provider is enrolled on, in a stable order.
 *
 * Sorted by chain id rather than left in whatever order the read returned, so
 * the console renders the same list twice running and a diff of two responses
 * is a real change. Not filtered by status: a `SUSPENDED` enrolment is still a
 * chain the provider proved an address on, and hiding it from the setup screen
 * would answer "you have no payout address there" to somebody who does — it is
 * carried WITH its status instead, because unfiltered and unlabelled is the
 * worst of the three options.
 */
function toPayoutAccountDtos(
  enrolments: readonly ProviderChainEnrolmentEntity[],
): ProviderPayoutAccountDto[] {
  return [...enrolments]
    .sort((a, b) => a.chainId.localeCompare(b.chainId))
    .map((enrolment) => ({
      chainId: enrolment.chainId,
      accountId: enrolment.payoutAccountId,
      provedAt: enrolment.payoutProvedAt.toISOString(),
      // The half that decides whether money arrives. Rendered next to the
      // address rather than filtered out of the list, so a withdrawn chain is
      // visible as withdrawn instead of simply absent.
      status: enrolment.status as ChainEnrolmentStatus,
    }));
}
