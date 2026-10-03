import { ConfigService } from '@nestjs/config';

import { VerificationPolicyEntity } from '@database/postgres/entities/verification-policy.entity';
import { VerificationPolicyRepository } from '@database/postgres/repositories/verification-policy.repository';
import { VerifierSigningKeyEntity } from '@database/postgres/entities/verifier-signing-key.entity';
import { VerifierSigningKeyRepository } from '@database/postgres/repositories/verifier-signing-key.repository';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { ProviderRegistryPort } from '@modules/provider/ports/provider-registry.port';
import {
  ProviderRoutingState,
  ProviderStatus,
  ProviderTier,
} from '@modules/provider/ports/provider.types';
import { SigningKeyState } from '@modules/verification/signing/domain/key-lifecycle';
import {
  VerifierRegistryEntry,
  VerifierRegistryPort,
} from '@modules/verification/signing/ports/verifier-registry.port';

/**
 * Hand-written fakes for {@link OperatorReferenceService}'s dependencies.
 * Named distinctly from `fake-metrics.ts` and from anything another agent's
 * `test/unit/operator/helpers/` might add.
 */

export function fakePolicyRepository(
  rows: VerificationPolicyEntity[] = [],
): VerificationPolicyRepository {
  return {
    find: jest.fn().mockResolvedValue(rows),
  } as unknown as VerificationPolicyRepository;
}

export function policyRow(
  overrides: Partial<VerificationPolicyEntity> = {},
): VerificationPolicyEntity {
  return {
    policyId: 'search_web.default',
    policyVersion: 1,
    toolId: 'tool-1',
    lifecycle: 'SHADOW',
    decisionDocument: { verifiers: [] },
    verificationDocument: null,
    createdBy: 'operator@platform',
    promotedAt: null,
    promotedBy: null,
    promotionEvidence: null,
    withdrawnAt: null,
    withdrawnBy: null,
    withdrawnReason: null,
    ...overrides,
  } as unknown as VerificationPolicyEntity;
}

export function fakeVerifierKeyRepository(
  rows: VerifierSigningKeyEntity[] = [],
): VerifierSigningKeyRepository {
  return {
    findAllOrdered: jest.fn().mockResolvedValue(rows),
  } as unknown as VerifierSigningKeyRepository;
}

export function verifierKeyRow(
  overrides: Partial<VerifierSigningKeyEntity> = {},
): VerifierSigningKeyEntity {
  return {
    keyId: 'verifier-2026-08',
    backend: 'env',
    backendRef: 'VERIFIER_SIGNING_KEY',
    publicKey: 'a'.repeat(64),
    chainId: CHAIN_IDS.SOLANA_DEVNET,
    chainAddress: 'ChainAddress1111111111111111111111111111',
    state: SigningKeyState.ACTIVE,
    registeredExpiresAt: null,
    activatedAt: null,
    retiredAt: null,
    revokedAt: null,
    reason: null,
    ...overrides,
  } as unknown as VerifierSigningKeyEntity;
}

export function fakeVerifierRegistry(
  options: {
    entries?: Readonly<Record<string, VerifierRegistryEntry | null>>;
    throwsFor?: ReadonlySet<string>;
  } = {},
): VerifierRegistryPort {
  const entries = options.entries ?? {};
  const throwsFor = options.throwsFor ?? new Set<string>();

  return {
    // Both methods take the chain first. The fake ignores it for the
    // address rendering (it is a test double, not a chain) but takes it, so
    // that a caller which stopped passing one would fail here rather than
    // silently hashing `undefined`.
    addressOf: jest
      .fn()
      .mockImplementation((_chainId: ChainId, publicKey: Uint8Array) =>
        Buffer.from(publicKey).toString('hex'),
      ),
    lookup: jest.fn().mockImplementation(async (_chainId: ChainId, publicKey: Uint8Array) => {
      const address = Buffer.from(publicKey).toString('hex');
      if (throwsFor.has(address)) {
        throw new Error('rpc unreachable');
      }
      return entries[address] ?? null;
    }),
  };
}

export function fakeProviderRepositoryFor(providerIds: readonly string[] = []): ProviderRepository {
  return {
    findAllProviders: jest
      .fn()
      .mockResolvedValue(providerIds.map((organizationId) => ({ organizationId }))),
  } as unknown as ProviderRepository;
}

export function fakeProviderRegistry(
  states: ReadonlyMap<string, Partial<ProviderRoutingState>> = new Map(),
): ProviderRegistryPort {
  const full = new Map<string, ProviderRoutingState>();
  for (const [providerId, state] of states) {
    full.set(providerId, {
      providerId,
      status: ProviderStatus.ACTIVE,
      tier: ProviderTier.ESTABLISHED,
      stats: {},
      payoutAccountByChain: new Map(),
      payoutEnrolmentChains: new Set(),
      ...state,
    });
  }
  return {
    findRoutingStates: jest.fn().mockResolvedValue(full),
  };
}

export function fakeConfigService(values: Readonly<Record<string, string>> = {}): ConfigService {
  return {
    get: jest.fn().mockImplementation((key: string) => values[key]),
  } as unknown as ConfigService;
}
