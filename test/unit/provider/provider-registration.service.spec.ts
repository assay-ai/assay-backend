import { UNIQUE_VIOLATION_CODE } from '@database/postgres/repositories/abstract.repository';
import { ProviderConnectivityCheckRepository } from '@database/postgres/repositories/provider-connectivity-check.repository';
import { ProviderChainEnrolmentRepository } from '@database/postgres/repositories/provider-chain-enrolment.repository';
import { ProviderPayoutChallengeRepository } from '@database/postgres/repositories/provider-payout-challenge.repository';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import {
  ConnectivityOutcome,
  OnboardingStepStatus,
} from '@modules/provider/ports/provider-registration.types';
import { ProviderStatus, ProviderTier } from '@modules/provider/ports/provider.types';
import { ProviderRegistrationService } from '@modules/provider/services/provider-registration.service';
import { ProviderTerms } from '@modules/provider/services/provider-terms';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

const ORG = 'org-77777777-7777-4777-8777-777777777777';
const ENDPOINT = 'https://api.vesseldata.example';
const MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

const TERMS: ProviderTerms = {
  providerAgreementVersion: 'v1.0',
  payoutTermsVersion: 'v1.0',
  slashPolicyVersion: 'v1.0',
  acceptanceLine:
    'I accept the provider agreement v1.0, the payout terms v1.0 and the slash policy v1.0',
  commercialTerms: [
    { key: 'takeRate', label: 'Take rate', value: '10%', caption: 'flat, no per-call fee floor' },
  ],
};

const SESSION: McpSession = {
  credentialId: 'cred-1',
  organizationId: ORG,
  agentId: 'agent-1',
  agentAccount: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:acct' as any,
  chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' as any,
  label: null,
  callerKind: McpCallerKind.CONFIG,
  paymentsAllowed: true,
};

function acceptedTermsInput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    providerAgreementVersion: 'v1.0',
    payoutTermsVersion: 'v1.0',
    slashPolicyVersion: 'v1.0',
    ...overrides,
  };
}

function contact(overrides: Partial<Record<string, unknown>> = {}) {
  return { name: 'Alex Example', email: 'alex@vesseldata.example', phone: null, ...overrides };
}

function registerBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    legalName: 'Example Vessel Data Ltd',
    technicalContact: contact(),
    ownerContact: contact({ email: 'founder@vesseldata.example' }),
    timezone: 'Europe/Oslo',
    acceptedTerms: acceptedTermsInput(),
    ...overrides,
  } as any;
}

function providerEntity(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'provider-1',
    organizationId: ORG,
    legalName: 'Example Vessel Data Ltd',
    technicalContact: contact(),
    ownerContact: contact({ email: 'founder@vesseldata.example' }),
    timezone: 'Europe/Oslo',
    acceptedTerms: {
      providerAgreementVersion: 'v1.0',
      payoutTermsVersion: 'v1.0',
      slashPolicyVersion: 'v1.0',
      acceptedAt: '2026-08-10T00:00:00.000Z',
      acceptedBy: 'cred-1',
    },
    status: ProviderStatus.ACTIVE,
    tier: ProviderTier.NEW,
    endpoint: null,
    verified: false,
    verifiedBy: null,
    verifiedAt: null,
    verificationMethod: null,
    verificationChecks: [],
    verificationExpiresAt: null,
    verificationEvidenceUrl: null,
    createdAt: new Date('2026-08-10T00:00:00.000Z'),
    ...overrides,
  } as any;
}

function connectivityCheck(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    outcome: ConnectivityOutcome.REACHABLE,
    endpoint: ENDPOINT,
    statusCode: 200,
    latencyMs: 40,
    failureKind: null,
    failureCode: null,
    detail: null,
    createdAt: new Date('2026-08-11T00:00:00.000Z'),
    ...overrides,
  } as any;
}

/** One `provider_chain_enrolments` row, as much of it as this service reads. */
interface EnrolmentRow {
  chainId: string;
  payoutAccountId: string;
  payoutProvedAt: Date;
  /** `ACTIVE` unless a test says otherwise — the only status that is payable. */
  status?: string;
}

function enrolment(overrides: Partial<EnrolmentRow> = {}): EnrolmentRow {
  return {
    chainId: MAINNET,
    payoutAccountId: `${MAINNET}:acct`,
    payoutProvedAt: new Date('2026-08-11T00:00:00.000Z'),
    status: 'ACTIVE',
    ...overrides,
  };
}

function build(
  options: {
    save?: jest.Mock;
    findOneBy?: jest.Mock;
    update?: jest.Mock;
    payoutChallengeFindOneBy?: jest.Mock;
    connectivityFindOne?: jest.Mock;
    /** The per-chain enrolments `providers.payout_account_id` became. */
    enrolments?: EnrolmentRow[];
  } = {},
) {
  const providers = {
    save: options.save ?? jest.fn(),
    findOneBy: options.findOneBy ?? jest.fn(),
    update: options.update ?? jest.fn().mockResolvedValue({ affected: 1 }),
  } as unknown as ProviderRepository;

  const payoutChallenges = {
    findOneBy: options.payoutChallengeFindOneBy ?? jest.fn().mockResolvedValue(null),
  } as unknown as ProviderPayoutChallengeRepository;

  const connectivityChecks = {
    findOne: options.connectivityFindOne ?? jest.fn().mockResolvedValue(null),
  } as unknown as ProviderConnectivityCheckRepository;

  const chainEnrolments = {
    findByProviders: jest.fn().mockResolvedValue(options.enrolments ?? []),
  } as unknown as ProviderChainEnrolmentRepository;

  const service = new ProviderRegistrationService(
    providers,
    payoutChallenges,
    chainEnrolments,
    connectivityChecks,
    TERMS,
  );

  return { service, providers, payoutChallenges, chainEnrolments, connectivityChecks };
}

describe('ProviderRegistrationService — register (open, no approval)', () => {
  it('lands ACTIVE / NEW / unverified — there is no pending state to pass through', async () => {
    const save = jest.fn().mockImplementation(async (draft) => providerEntity(draft));
    const { service } = build({ save });

    const result = await service.register(SESSION, registerBody());

    const [draft] = save.mock.calls[0];
    expect(draft.status).toBe(ProviderStatus.ACTIVE);
    expect(draft.tier).toBe(ProviderTier.NEW);
    expect(draft.verified).toBe(false);
    expect(draft.organizationId).toBe(ORG);
    expect(draft.legalName).toBe('Example Vessel Data Ltd');

    expect(result.status).toBe(ProviderStatus.ACTIVE);
    expect(result.tier).toBe(ProviderTier.NEW);
    expect(result.verification.verified).toBe(false);
    // Empty, not null: a brand-new provider has enrolled on no chain, and the
    // wire carries a list because the answer is per chain.
    expect(result.payoutAccounts).toEqual([]);
    expect(result.endpoint).toBeNull();
  });

  it('stamps acceptedTerms.acceptedBy from session.credentialId, acceptedAt as now', async () => {
    const save = jest.fn().mockImplementation(async (draft) => providerEntity(draft));
    const { service } = build({ save });

    await service.register(SESSION, registerBody());

    const [draft] = save.mock.calls[0];
    expect(draft.acceptedTerms.acceptedBy).toBe('cred-1');
    expect(new Date(draft.acceptedTerms.acceptedAt).toString()).not.toBe('Invalid Date');
  });

  it('duplicate registration -> 409 PROVIDER_ALREADY_REGISTERED, translated from the unique violation', async () => {
    const save = jest.fn().mockRejectedValue({ code: UNIQUE_VIOLATION_CODE });
    const { service } = build({ save });

    await expectErrorCodeAsync(
      () => service.register(SESSION, registerBody()),
      ProviderErrorCode.PROVIDER_ALREADY_REGISTERED,
    );
  });

  it('an unrelated database error is rethrown unchanged, not swallowed as a duplicate', async () => {
    const save = jest.fn().mockRejectedValue(new Error('connection reset'));
    const { service } = build({ save });

    await expect(service.register(SESSION, registerBody())).rejects.toThrow('connection reset');
  });

  it('identical technical and owner email -> PROVIDER_CONTACTS_NOT_DISTINCT', async () => {
    const { service } = build();

    await expectErrorCodeAsync(
      () =>
        service.register(
          SESSION,
          registerBody({
            technicalContact: contact({ email: 'same@example.com' }),
            ownerContact: contact({ email: 'same@example.com' }),
          }),
        ),
      ProviderErrorCode.PROVIDER_CONTACTS_NOT_DISTINCT,
    );
  });

  it('unknown timezone -> PROVIDER_TIMEZONE_UNKNOWN', async () => {
    const { service } = build();

    await expectErrorCodeAsync(
      () => service.register(SESSION, registerBody({ timezone: 'Mars/Olympus_Mons' })),
      ProviderErrorCode.PROVIDER_TIMEZONE_UNKNOWN,
    );
  });

  it('wrong terms version -> PROVIDER_TERMS_VERSION_MISMATCH', async () => {
    const { service } = build();

    await expectErrorCodeAsync(
      () =>
        service.register(
          SESSION,
          registerBody({ acceptedTerms: acceptedTermsInput({ slashPolicyVersion: 'v0.9' }) }),
        ),
      ProviderErrorCode.PROVIDER_TERMS_VERSION_MISMATCH,
    );
  });
});

describe('ProviderRegistrationService — getRegistration, the onboarding state', () => {
  it('404s when the organization never registered', async () => {
    const { service } = build({ findOneBy: jest.fn().mockResolvedValue(null) });

    await expectErrorCodeAsync(
      () => service.getRegistration(ORG),
      ProviderErrorCode.PROVIDER_NOT_FOUND,
    );
  });

  it('account and terms are DONE from the moment the row exists', async () => {
    const { service } = build({ findOneBy: jest.fn().mockResolvedValue(providerEntity()) });

    const state = await service.getRegistration(ORG);

    expect(state.steps.find((s) => s.key === 'account')?.status).toBe(OnboardingStepStatus.DONE);
    expect(state.steps.find((s) => s.key === 'terms')?.status).toBe(OnboardingStepStatus.DONE);
  });

  it('serves the published terms table from injected configuration', async () => {
    const { service } = build({ findOneBy: jest.fn().mockResolvedValue(providerEntity()) });

    const state = await service.getRegistration(ORG);

    expect(state.terms.providerAgreementVersion).toBe('v1.0');
    expect(state.terms.commercialTerms).toEqual(TERMS.commercialTerms);
  });

  describe('payout wallet step', () => {
    it('DONE once an address is proved on ANY chain', async () => {
      const { service } = build({
        findOneBy: jest.fn().mockResolvedValue(providerEntity()),
        enrolments: [enrolment()],
      });

      const state = await service.getRegistration(ORG);

      expect(state.steps.find((s) => s.key === 'payoutWallet')?.status).toBe(
        OnboardingStepStatus.DONE,
      );
    });

    it('is NOT DONE when the only enrolment is SUSPENDED — the tick would be a lie', async () => {
      // The console's half of `PAYOUT_ENROLMENT_NOT_ACTIVE`. This provider has
      // signed, so `NOT_STARTED` would be wrong; nothing they own can take a
      // paid call, so `DONE` would be worse — it actively reassures next to an
      // address that cannot be paid. `IN_PROGRESS` is the least wrong of the
      // three words the vocabulary has.
      const { service } = build({
        findOneBy: jest.fn().mockResolvedValue(providerEntity()),
        enrolments: [enrolment({ status: 'SUSPENDED' })],
      });

      const state = await service.getRegistration(ORG);

      expect(state.steps.find((s) => s.key === 'payoutWallet')?.status).toBe(
        OnboardingStepStatus.IN_PROGRESS,
      );
    });

    it('is DONE when ONE of several enrolments is ACTIVE', async () => {
      // The step asks whether the signing flow is finished anywhere, not
      // whether a particular chain is payable — that question is
      // `evaluatePayoutGate`'s and is asked per call.
      const { service } = build({
        findOneBy: jest.fn().mockResolvedValue(providerEntity()),
        enrolments: [
          enrolment({ status: 'SUSPENDED' }),
          enrolment({ chainId: DEVNET, payoutAccountId: `${DEVNET}:acct`, status: 'ACTIVE' }),
        ],
      });

      const state = await service.getRegistration(ORG);

      expect(state.steps.find((s) => s.key === 'payoutWallet')?.status).toBe(
        OnboardingStepStatus.DONE,
      );
    });

    it('renders every chain WITH its status, so a closed one is visible as closed', async () => {
      const { service } = build({
        findOneBy: jest.fn().mockResolvedValue(providerEntity()),
        enrolments: [
          enrolment({ chainId: DEVNET, payoutAccountId: `${DEVNET}:acct`, status: 'SUSPENDED' }),
          enrolment(),
        ],
      });

      const state = await service.getRegistration(ORG);

      // Sorted by chain id, both present, each carrying its own status. A list
      // that dropped the closed one would answer "you have no address there" to
      // somebody who does; a list without `status` renders a dead chain
      // identically to a live one.
      //
      // The order is `localeCompare` on the raw CAIP-2 string and nothing
      // cleverer, so mainnet (`solana:5eykt4…`) sorts before devnet
      // (`solana:EtWT…`) on the digit — asserted rather than assumed, and
      // asserted here rather than in a separate "it sorts" case, because the
      // point of sorting is that two identical responses diff cleanly and that
      // is only visible on a multi-entry list.
      expect(state.registration.payoutAccounts).toEqual([
        {
          chainId: MAINNET,
          accountId: `${MAINNET}:acct`,
          provedAt: '2026-08-11T00:00:00.000Z',
          status: 'ACTIVE',
        },
        {
          chainId: DEVNET,
          accountId: `${DEVNET}:acct`,
          provedAt: '2026-08-11T00:00:00.000Z',
          status: 'SUSPENDED',
        },
      ]);
      expect(MAINNET < DEVNET).toBe(true);
    });

    it('IN_PROGRESS while an unconsumed, unexpired challenge is outstanding', async () => {
      const { service } = build({
        findOneBy: jest.fn().mockResolvedValue(providerEntity()),
        payoutChallengeFindOneBy: jest.fn().mockResolvedValue({ id: 'challenge-1' }),
      });

      const state = await service.getRegistration(ORG);

      expect(state.steps.find((s) => s.key === 'payoutWallet')?.status).toBe(
        OnboardingStepStatus.IN_PROGRESS,
      );
    });

    it('NOT_STARTED with no address and no open challenge', async () => {
      const { service } = build({ findOneBy: jest.fn().mockResolvedValue(providerEntity()) });

      const state = await service.getRegistration(ORG);

      expect(state.steps.find((s) => s.key === 'payoutWallet')?.status).toBe(
        OnboardingStepStatus.NOT_STARTED,
      );
    });
  });

  describe('endpoint step', () => {
    it('NOT_STARTED when no endpoint has been declared', async () => {
      const { service } = build({ findOneBy: jest.fn().mockResolvedValue(providerEntity()) });

      const state = await service.getRegistration(ORG);

      expect(state.steps.find((s) => s.key === 'endpoint')?.status).toBe(
        OnboardingStepStatus.NOT_STARTED,
      );
    });

    it('IN_PROGRESS when declared but never probed', async () => {
      const { service } = build({
        findOneBy: jest.fn().mockResolvedValue(providerEntity({ endpoint: ENDPOINT })),
        connectivityFindOne: jest.fn().mockResolvedValue(null),
      });

      const state = await service.getRegistration(ORG);

      expect(state.steps.find((s) => s.key === 'endpoint')?.status).toBe(
        OnboardingStepStatus.IN_PROGRESS,
      );
    });

    it('IN_PROGRESS when the latest probe of that endpoint was not reachable', async () => {
      const { service } = build({
        findOneBy: jest.fn().mockResolvedValue(providerEntity({ endpoint: ENDPOINT })),
        connectivityFindOne: jest
          .fn()
          .mockResolvedValue(connectivityCheck({ outcome: ConnectivityOutcome.UNREACHABLE })),
      });

      const state = await service.getRegistration(ORG);

      expect(state.steps.find((s) => s.key === 'endpoint')?.status).toBe(
        OnboardingStepStatus.IN_PROGRESS,
      );
    });

    it('DONE only when declared and the latest probe of that same endpoint is REACHABLE', async () => {
      const { service } = build({
        findOneBy: jest.fn().mockResolvedValue(providerEntity({ endpoint: ENDPOINT })),
        connectivityFindOne: jest.fn().mockResolvedValue(connectivityCheck()),
      });

      const state = await service.getRegistration(ORG);

      expect(state.steps.find((s) => s.key === 'endpoint')?.status).toBe(OnboardingStepStatus.DONE);
    });
  });

  it('currentStep is the ordinal of the first non-DONE step (1-indexed)', async () => {
    const { service } = build({ findOneBy: jest.fn().mockResolvedValue(providerEntity()) });

    const state = await service.getRegistration(ORG);

    // account=DONE(1), payoutWallet=NOT_STARTED(2) -> stop at 2
    expect(state.currentStep).toBe(2);
    expect(state.totalSteps).toBe(4);
  });

  it('currentStep is totalSteps once every step is DONE', async () => {
    const { service } = build({
      findOneBy: jest.fn().mockResolvedValue(providerEntity({ endpoint: ENDPOINT })),
      enrolments: [enrolment()],
      connectivityFindOne: jest.fn().mockResolvedValue(connectivityCheck()),
    });

    const state = await service.getRegistration(ORG);

    expect(state.currentStep).toBe(4);
  });

  it('lastConnectivityCheck is null before any probe has ever run', async () => {
    const { service } = build({ findOneBy: jest.fn().mockResolvedValue(providerEntity()) });

    const state = await service.getRegistration(ORG);

    expect(state.lastConnectivityCheck).toBeNull();
  });

  it('lastConnectivityCheck reflects the latest probe row, mapped to the wire shape', async () => {
    const { service } = build({
      findOneBy: jest.fn().mockResolvedValue(providerEntity({ endpoint: ENDPOINT })),
      connectivityFindOne: jest.fn().mockResolvedValue(connectivityCheck()),
    });

    const state = await service.getRegistration(ORG);

    expect(state.lastConnectivityCheck).toEqual({
      outcome: ConnectivityOutcome.REACHABLE,
      endpoint: ENDPOINT,
      statusCode: 200,
      latencyMs: 40,
      failureKind: null,
      failureCode: null,
      detail: null,
      checkedAt: '2026-08-11T00:00:00.000Z',
    });
  });
});

describe('ProviderRegistrationService — updateAccount', () => {
  it('patches legal name / contacts / timezone, scoped by organizationId and this row', async () => {
    const update = jest.fn().mockResolvedValue({ affected: 1 });
    const { service } = build({ findOneBy: jest.fn().mockResolvedValue(providerEntity()), update });

    await service.updateAccount(SESSION, { legalName: 'New Name AS' });

    expect(update).toHaveBeenCalledWith(
      { organizationId: ORG, id: 'provider-1' },
      expect.objectContaining({ legalName: 'New Name AS' }),
    );
  });

  it('refuses to change endpoint or the payout address even when present on the payload', async () => {
    const update = jest.fn().mockResolvedValue({ affected: 1 });
    const { service } = build({
      findOneBy: jest.fn().mockResolvedValue(providerEntity({ endpoint: 'https://old.example' })),
      enrolments: [enrolment({ payoutAccountId: `${MAINNET}:old` })],
      update,
    });

    const maliciousBody = {
      legalName: 'New Name AS',
      endpoint: 'https://evil.example',
      payoutAccountId: `${MAINNET}:stolen`,
    } as any;

    const result = await service.updateAccount(SESSION, maliciousBody);

    const [, patch] = update.mock.calls[0];
    expect(patch.endpoint).toBeUndefined();
    expect(patch.payoutAccountId).toBeUndefined();
    expect(result.registration.endpoint).toBe('https://old.example');
    // Read back off the ENROLMENT, which `updateAccount` cannot write at all —
    // since per-chain enrolment the address is not even a column on the row this patch
    // touches, so the claim is now structural rather than a filtered field.
    expect(result.registration.payoutAccounts).toEqual([
      {
        chainId: MAINNET,
        accountId: `${MAINNET}:old`,
        provedAt: '2026-08-11T00:00:00.000Z',
        status: 'ACTIVE',
      },
    ]);
  });

  it('leaves acceptedTerms untouched when the patch omits it', async () => {
    const original = providerEntity();
    const { service } = build({ findOneBy: jest.fn().mockResolvedValue(original) });

    const result = await service.updateAccount(SESSION, { legalName: 'New Name AS' });

    expect(result.registration.acceptedTerms).toEqual(original.acceptedTerms);
  });

  it('re-accepts and re-stamps terms when the patch includes the currently published versions', async () => {
    const { service } = build({ findOneBy: jest.fn().mockResolvedValue(providerEntity()) });

    const result = await service.updateAccount(SESSION, {
      acceptedTerms: acceptedTermsInput(),
    } as any);

    expect(result.registration.acceptedTerms.acceptedBy).toBe('cred-1');
  });

  it('wrong terms version on update -> PROVIDER_TERMS_VERSION_MISMATCH', async () => {
    const { service } = build({ findOneBy: jest.fn().mockResolvedValue(providerEntity()) });

    await expectErrorCodeAsync(
      () =>
        service.updateAccount(SESSION, {
          acceptedTerms: acceptedTermsInput({ providerAgreementVersion: 'v2.0' }),
        } as any),
      ProviderErrorCode.PROVIDER_TERMS_VERSION_MISMATCH,
    );
  });

  it('identical technical and owner email -> PROVIDER_CONTACTS_NOT_DISTINCT', async () => {
    const { service } = build({ findOneBy: jest.fn().mockResolvedValue(providerEntity()) });

    await expectErrorCodeAsync(
      () =>
        service.updateAccount(SESSION, {
          technicalContact: contact({ email: 'same@example.com' }),
          ownerContact: contact({ email: 'same@example.com' }),
        } as any),
      ProviderErrorCode.PROVIDER_CONTACTS_NOT_DISTINCT,
    );
  });

  it('unknown timezone -> PROVIDER_TIMEZONE_UNKNOWN', async () => {
    const { service } = build({ findOneBy: jest.fn().mockResolvedValue(providerEntity()) });

    await expectErrorCodeAsync(
      () => service.updateAccount(SESSION, { timezone: 'Nowhere/Fake' } as any),
      ProviderErrorCode.PROVIDER_TIMEZONE_UNKNOWN,
    );
  });

  it('404s when the organization has no provider row', async () => {
    const { service } = build({ findOneBy: jest.fn().mockResolvedValue(null) });

    await expectErrorCodeAsync(
      () => service.updateAccount(SESSION, { legalName: 'X' }),
      ProviderErrorCode.PROVIDER_NOT_FOUND,
    );
  });
});

/**
 * `isKnownIanaTimeZone` (private to provider-registration.service.ts) has no
 * exported seam of its own, so this drives it through `register()`, which
 * validates the timezone synchronously before any repository call — see
 * `assertValidTimezone` at line ~307. That makes `build()` with a
 * pass-through `save` mock enough to exercise every case without touching
 * unrelated collaborators.
 *
 * Regression coverage for the 2026-08-25 defect: `Intl.supportedValuesOf
 * ('timeZone')` lists CLDR's canonical spellings, which for several zones
 * are the *deprecated* IANA alias rather than the current primary name (tzdata
 * 2022b renamed these). Checking membership in that list alone rejected a
 * provider's own correct, current timezone — found live when a provider was
 * refused `Asia/Kolkata` with a message claiming it "is not an IANA time
 * zone", which is false.
 */
describe('ProviderRegistrationService — timezone validation', () => {
  const modernPrimaries = ['Asia/Kolkata', 'Europe/Kyiv', 'America/Nuuk'];
  const deprecatedAliases = ['Asia/Calcutta', 'Europe/Kiev', 'America/Godthab'];
  const ordinaryZones = ['Europe/Oslo', 'America/New_York'];

  it.each([...modernPrimaries, ...deprecatedAliases, ...ordinaryZones])(
    'accepts %s',
    async (timezone) => {
      const save = jest.fn().mockImplementation(async (draft) => providerEntity(draft));
      const { service } = build({ save });

      const result = await service.register(SESSION, registerBody({ timezone }));

      expect(result.timezone).toBe(timezone);
    },
  );

  it.each([
    ['empty string', ''],
    ['not a zone at all', 'Not/AZone'],
    ['a raw UTC offset, not an IANA identifier', 'UTC+5'],
    ['a space instead of the required underscore', 'America/Los Angeles'],
    ['a non-string', 42 as unknown as string],
  ])('rejects %s (%p) -> PROVIDER_TIMEZONE_UNKNOWN', async (_label, timezone) => {
    const { service } = build();

    await expectErrorCodeAsync(
      () => service.register(SESSION, registerBody({ timezone })),
      ProviderErrorCode.PROVIDER_TIMEZONE_UNKNOWN,
    );
  });
});
