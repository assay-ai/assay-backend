import { OperatorReferenceService } from '@modules/operator/services/operator-reference.service';
import { AssetId, ChainId } from '@modules/chains/ports/caip.types';
import { MoneyUtil } from '@shared/utils/money.util';
import { OVERRIDE_CODES } from '@modules/operator/domain/override-register';
import { SigningKeyState } from '@modules/verification/signing/domain/key-lifecycle';
import { RegisteredVerifierStatus } from '@modules/verification/signing/ports/verifier-registry.port';

import {
  fakeConfigService,
  fakePolicyRepository,
  fakeProviderRegistry,
  fakeProviderRepositoryFor,
  fakeVerifierKeyRepository,
  fakeVerifierRegistry,
  policyRow,
  verifierKeyRow,
} from './helpers/fake-reference';

function build(
  options: {
    policies?: ReturnType<typeof policyRow>[];
    verifierKeys?: ReturnType<typeof verifierKeyRow>[];
    verifierRegistry?: ReturnType<typeof fakeVerifierRegistry>;
    providerIds?: readonly string[];
    providerRegistry?: ReturnType<typeof fakeProviderRegistry>;
    config?: Readonly<Record<string, string>>;
    /** A chain read (`minimumStake` set) or never read (`null`). */
    readings?: readonly {
      chainId: ChainId;
      minimumStake: bigint | null;
      takeRateBps?: number;
      slashAgentBps?: number;
      slashPlatformBps?: number;
    }[];
  } = {},
): OperatorReferenceService {
  const chainParams = options.readings
    ? {
        all: jest.fn(() =>
          options.readings!.map((reading) => ({
            chainId: reading.chainId,
            source: reading.minimumStake === null ? 'config' : 'chain',
            minimumStake: MoneyUtil.of(reading.minimumStake ?? 50_000_000n, EVM_ASSET, 6),
            penaltyAmount:
              reading.minimumStake === null ? null : MoneyUtil.of(1_000_000n, EVM_ASSET, 6),
            takeRateBps: reading.takeRateBps ?? 1000,
            slashAgentBps: reading.slashAgentBps ?? 6000,
            slashPlatformBps: reading.slashPlatformBps ?? 3000,
            slashCapBps: 1000,
          })),
        ),
      }
    : null;
  return new OperatorReferenceService(
    fakePolicyRepository(options.policies ?? []),
    fakeVerifierKeyRepository(options.verifierKeys ?? []),
    options.verifierRegistry ?? fakeVerifierRegistry(),
    fakeProviderRepositoryFor(options.providerIds ?? []),
    options.providerRegistry ?? fakeProviderRegistry(),
    fakeConfigService(options.config ?? {}),
    chainParams as never,
  );
}

const EVM_CHAIN = 'eip155:46630' as ChainId;
const EVM_ASSET = `${EVM_CHAIN}/erc20:0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac` as AssetId;

describe('OperatorReferenceService — policy lifecycle', () => {
  it('returns an empty list against an empty database', async () => {
    const service = build();

    await expect(service.listPolicies()).resolves.toEqual([]);
  });

  it('prefers the ACTIVE version over SHADOW versions of the same policy', async () => {
    const service = build({
      policies: [
        policyRow({
          policyId: 'p',
          policyVersion: 1,
          lifecycle: 'ACTIVE',
          promotionEvidence: { falsePositiveRate: 0.01 },
        }),
        policyRow({ policyId: 'p', policyVersion: 2, lifecycle: 'SHADOW' }),
      ],
    });

    const [row] = await service.listPolicies();

    expect(row.policyVersion).toBe(1);
    expect(row.state).toBe('ACTIVE');
  });

  it('always qualifies ACTIVE as "slashing live" — enforces() has no other outcome for it', async () => {
    const service = build({
      policies: [policyRow({ policyId: 'p', lifecycle: 'ACTIVE' })],
    });

    const [row] = await service.listPolicies();

    expect(row.qualifier).toBe('slashing live');
    expect(row.actionWord).toBe('kill');
  });

  it('never qualifies SHADOW — promotionEvidence is only ever written on a successful promotion', async () => {
    const service = build({
      policies: [policyRow({ policyId: 'p', lifecycle: 'SHADOW', promotionEvidence: null })],
    });

    const [row] = await service.listPolicies();

    expect(row.qualifier).toBeNull();
    expect(row.actionWord).toBe('promote');
    expect(row.falsePositiveRate).toBeNull();
  });

  it('reads the false-positive rate exactly as promote() stored it, for an ACTIVE row', async () => {
    const service = build({
      policies: [
        policyRow({
          policyId: 'p',
          lifecycle: 'ACTIVE',
          promotionEvidence: { falsePositiveRate: 0.004 },
        }),
      ],
    });

    const [row] = await service.listPolicies();

    expect(row.falsePositiveRate).toBe(0.004);
  });

  it('extracts the voting verifier ids from the decision document', async () => {
    const service = build({
      policies: [
        policyRow({
          policyId: 'p',
          decisionDocument: { verifiers: [{ verifierId: 'schema' }, { verifierId: 'rules' }] },
        }),
      ],
    });

    const [row] = await service.listPolicies();

    expect(row.votingVerifierIds).toEqual(['schema', 'rules']);
  });

  it('returns null actionWord and qualifier for a lifecycle outside SHADOW/ACTIVE', async () => {
    const service = build({ policies: [policyRow({ policyId: 'p', lifecycle: 'ARCHIVED' })] });

    const [row] = await service.listPolicies();

    expect(row.actionWord).toBeNull();
    expect(row.qualifier).toBeNull();
  });
});

describe('OperatorReferenceService — verifier registry', () => {
  const KEY_HEX = 'b'.repeat(64);

  it('returns an empty list when this deployment has never had a signing key', async () => {
    const service = build();

    await expect(service.listVerifiers()).resolves.toEqual([]);
  });

  it('reports approved / revoked from the on-chain lookup, not the local lifecycle column', async () => {
    const service = build({
      verifierKeys: [
        verifierKeyRow({ keyId: 'v1', publicKey: KEY_HEX, state: SigningKeyState.RETIRED }),
      ],
      verifierRegistry: fakeVerifierRegistry({
        entries: {
          [KEY_HEX]: {
            address: KEY_HEX,
            status: RegisteredVerifierStatus.ACTIVE,
            label: 'v1',
            registeredAt: new Date('2026-01-01T00:00:00.000Z'),
            expiresAt: new Date('2027-01-01T00:00:00.000Z'),
            revokedAt: null,
          },
        },
      }),
    });

    const [row] = await service.listVerifiers();

    expect(row.state).toBe('approved');
    expect(row.unreadableReason).toBeNull();
  });

  it('degrades a row to state null instead of throwing when the chain is unreadable', async () => {
    const service = build({
      verifierKeys: [verifierKeyRow({ keyId: 'v1', publicKey: KEY_HEX })],
      verifierRegistry: fakeVerifierRegistry({ throwsFor: new Set([KEY_HEX]) }),
    });

    await expect(service.listVerifiers()).resolves.toBeDefined();
    const [row] = await service.listVerifiers();

    expect(row.state).toBeNull();
    // A fixed sentence: the error text can carry an internal RPC address.
    expect(row.unreadableReason).toBe('chain unreadable');
  });

  it('reports null, not a fabricated state, for a key never registered on chain', async () => {
    const service = build({ verifierKeys: [verifierKeyRow({ keyId: 'v1', publicKey: KEY_HEX })] });

    const [row] = await service.listVerifiers();

    expect(row.state).toBeNull();
    expect(row.unreadableReason).toContain('never registered');
  });

  it('truncates the chain address for display', async () => {
    const service = build({
      verifierKeys: [
        verifierKeyRow({
          keyId: 'v1',
          publicKey: KEY_HEX,
          chainAddress: 'ChainAddress1111111111111111111111111111',
        }),
      ],
    });

    const [row] = await service.listVerifiers();

    expect(row.truncatedKey).toBe('ChainA…1111');
  });
});

describe('OperatorReferenceService — economic parameters', () => {
  it('reports the six named parameters against config defaults, none crashing on an empty database', async () => {
    const service = build();

    const rows = await service.listEconomicParameters();

    const byKey = new Map(rows.map((row) => [row.key, row]));
    expect(byKey.get('takeRate')?.value).toBe('10%');
    expect(byKey.get('minimumStake')?.value).toBe('$50.00');
    expect(byKey.get('minimumStake')?.overrideCount).toBe(0);
    expect(byKey.get('splitAgent')?.value).toBe('60%');
    expect(byKey.get('splitPlatform')?.value).toBe('30%');
    expect(byKey.get('splitProvider')?.value).toBe('10%');
  });

  it('reports penaltySize as not known yet, rather than fabricating a value, before a chain read', async () => {
    const service = build();

    const rows = await service.listEconomicParameters();
    const penaltySize = rows.find((row) => row.key === 'penaltySize');

    expect(penaltySize?.value).toBeNull();
    expect(penaltySize?.note).toContain('params().penaltyAmount');
  });

  it('reports the per-record penalty ceiling and the slash cap from the chain (M6)', async () => {
    const service = build({ readings: [{ chainId: EVM_CHAIN, minimumStake: 50_000_000n }] });

    const row = (await service.listEconomicParameters()).find((r) => r.key === 'penaltySize');

    expect(row?.value).toBe('$1.00 per record');
    expect(row?.source).toBe('chain');
    expect(row?.note).toContain('10% of the provider');
    expect(row?.note).not.toContain('no per-call or per-strike ceiling');
  });

  it('counts providers with a negotiated minimum-stake override', async () => {
    const service = build({
      providerIds: ['p1', 'p2', 'p3'],
      providerRegistry: fakeProviderRegistry(
        new Map([
          ['p1', { minimumStakeOverride: { amount: '1', asset: 'x', decimals: 6 } as never }],
          ['p2', {}],
          ['p3', {}],
        ]),
      ),
    });

    const rows = await service.listEconomicParameters();
    const minimumStake = rows.find((row) => row.key === 'minimumStake');

    expect(minimumStake?.overrideCount).toBe(1);
  });

  it('reads the minimum stake from the settlement contract, as the Contracts page does (BUG-OPS-CORE-02)', async () => {
    const service = build({ readings: [{ chainId: EVM_CHAIN, minimumStake: 100_000_000n }] });

    const row = (await service.listEconomicParameters()).find((r) => r.key === 'minimumStake');

    expect(row?.value).toBe('$100.00');
    expect(row?.source).toBe('chain');
    expect(row?.note).toContain('$50.00');
  });

  it('leaves the note empty when the chain agrees with the configured floor', async () => {
    const service = build({ readings: [{ chainId: EVM_CHAIN, minimumStake: 50_000_000n }] });

    const row = (await service.listEconomicParameters()).find((r) => r.key === 'minimumStake');

    expect(row?.value).toBe('$50.00');
    expect(row?.source).toBe('chain');
    expect(row?.note).toBeNull();
  });

  it('shows the configured floor while no chain was read', async () => {
    const service = build({ readings: [{ chainId: EVM_CHAIN, minimumStake: null }] });

    const row = (await service.listEconomicParameters()).find((r) => r.key === 'minimumStake');

    expect(row?.value).toBe('$50.00');
    expect(row?.source).toBe('config');
  });

  it('lists one value per chain when the chains disagree, skipping a chain never read', async () => {
    const other = 'eip155:1' as ChainId;
    const service = build({
      readings: [
        { chainId: EVM_CHAIN, minimumStake: 100_000_000n },
        { chainId: other, minimumStake: 20_000_000n },
        { chainId: 'eip155:2' as ChainId, minimumStake: null },
      ],
    });

    const row = (await service.listEconomicParameters()).find((r) => r.key === 'minimumStake');

    expect(row?.source).toBe('chain');
    expect(row?.value).toBe('eip155:46630 $100.00 · eip155:1 $20.00');
  });

  it('reads the take rate and the split from the chain over config', async () => {
    const service = build({
      config: { PLATFORM_FEE_BPS: '1200', PROVIDER_TERMS_PENALTY_SPLIT: '50 / 40 / 10' },
      readings: [
        {
          chainId: EVM_CHAIN,
          minimumStake: 50_000_000n,
          takeRateBps: 800,
          slashAgentBps: 7000,
          slashPlatformBps: 2500,
        },
      ],
    });

    const byKey = new Map((await service.listEconomicParameters()).map((row) => [row.key, row]));

    expect(byKey.get('takeRate')).toMatchObject({ value: '8%', source: 'chain' });
    expect(byKey.get('splitAgent')).toMatchObject({ value: '70%', source: 'chain' });
    expect(byKey.get('splitPlatform')).toMatchObject({ value: '25%', source: 'chain' });
    expect(byKey.get('splitProvider')).toMatchObject({ value: '5%', source: 'chain' });
  });

  it('respects a custom take rate and penalty split from config', async () => {
    const service = build({
      config: {
        PLATFORM_FEE_BPS: '1200',
        PROVIDER_TERMS_PENALTY_SPLIT: '50 / 40 / 10',
      },
    });

    const rows = await service.listEconomicParameters();
    const byKey = new Map(rows.map((row) => [row.key, row]));

    expect(byKey.get('takeRate')?.value).toBe('12%');
    expect(byKey.get('splitAgent')?.value).toBe('50%');
    expect(byKey.get('splitPlatform')?.value).toBe('40%');
    expect(byKey.get('splitProvider')?.value).toBe('10%');
  });

  it('reports the split rows as unparseable rather than a guessed number on a malformed override', async () => {
    const service = build({ config: { PROVIDER_TERMS_PENALTY_SPLIT: 'garbage' } });

    const rows = await service.listEconomicParameters();
    const splitAgent = rows.find((row) => row.key === 'splitAgent');

    expect(splitAgent?.value).toBeNull();
    expect(splitAgent?.note).toBeTruthy();
  });
});

describe('OperatorReferenceService — override register', () => {
  it('lists every code, including implemented: false rows, in the register order', () => {
    const service = build();

    const rows = service.listOverrideRegister();

    expect(rows.map((row) => row.code)).toEqual([...OVERRIDE_CODES]);
    expect(rows.some((row) => row.implemented === false)).toBe(true);
  });
});
