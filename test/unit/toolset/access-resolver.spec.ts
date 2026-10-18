import { AccessEpochService } from '@modules/toolset/services/access-epoch.service';
import { ACCESS_CACHE_TTL_MS, AccessResolver } from '@modules/toolset/services/access.resolver';
import { AccessMode, accessAllows } from '@modules/toolset/domain/access';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';

const ORG = '4a0e8f5c-0b6b-4f5e-9d8f-1d2c3b4a5e6f';
const AGENT = '7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const CREDENTIAL = '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b';
const TOOLSET = '9e8d7c6b-5a49-4382-9172-6a5b4c3d2e1f';

const session: McpSession = {
  credentialId: CREDENTIAL,
  storedCredential: true,
  organizationId: ORG,
  agentId: AGENT,
  agentAccount: 'solana:x:agent' as never,
  chainId: 'solana:x' as never,
  label: null,
  callerKind: McpCallerKind.AGENT,
  paymentsAllowed: true,
};

function build(
  policy: Record<string, unknown> | null,
  credential: Record<string, unknown> | null = null,
) {
  let epoch = '1';
  let now = 1_000_000;
  const reads = { policies: 0 };
  const policies = {
    findLive: jest.fn(async () => {
      reads.policies += 1;
      return policy;
    }),
  };
  const credentials = { findOneBy: jest.fn(async () => credential) };
  const toolsets = {
    findAnyByIds: jest.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, ownerOrgId: ORG, deletedAt: null, removedAt: null })),
    ),
  };
  const entries = {
    findByToolsets: jest.fn(async (ids: string[]) =>
      ids.includes(TOOLSET) ? [{ toolsetId: TOOLSET, toolId: 'tool-in-kit' }] : [],
    ),
  };
  const epochs = {
    currentWithSharing: jest.fn(async () => epoch),
  } as unknown as AccessEpochService;
  const resolver = new AccessResolver(
    policies as never,
    credentials as never,
    toolsets as never,
    entries as never,
    epochs,
    { findPairs: async () => [] } as never,
    () => now,
  );
  return {
    resolver,
    reads,
    bump: () => (epoch = String(Number(epoch) + 1)),
    advance: (ms: number) => (now += ms),
    breakRedis: () => (epochs.currentWithSharing as jest.Mock).mockResolvedValue(null),
  };
}

const restrictedPolicy = {
  accessMode: AccessMode.RESTRICTED,
  allowedToolsets: [{ toolsetId: TOOLSET, version: null, viaUrlOnly: true }],
  allowedToolIds: ['tool-direct'],
  ruleExcludeProviderIds: ['p9'],
  ruleMaxPrice: '10000',
  ruleMinTier: 'ESTABLISHED',
  ruleMinQuality: '0.900',
  pinnedTools: ['get_weather'],
  assetId: 'solana:x/token:y',
  decimals: 6,
  policyVersion: 4,
};

/**
 * The access a call is checked against, resolved from the policy and the
 * key, cached per credential and invalidated by the organization's epoch
 * (NFR-1): a write is seen on the next call, the TTL is only a backstop.
 */
describe('AccessResolver', () => {
  it('reads the access policy, expands toolsets from the Draft and reads the agent rules', async () => {
    const { resolver } = build(restrictedPolicy);
    const access = await resolver.resolve(session);

    expect(accessAllows(access, 'tool-direct', null)).toBe(true);
    expect(accessAllows(access, 'tool-in-kit', TOOLSET)).toBe(true);
    expect(accessAllows(access, 'tool-in-kit', null)).toBe(false);
    expect(access.rules).toEqual({
      excludeProviderIds: ['p9'],
      maxPrice: { amount: '10000', asset: 'solana:x/token:y', decimals: 6 },
      minTier: 'ESTABLISHED',
      minQuality: 0.9,
    });
    expect(access.pinnedTools).toEqual(['get_weather']);
    expect(access.policyVersion).toBe(4);
  });

  it('no policy at all: everything, no rules', async () => {
    const { resolver } = build(null);
    const access = await resolver.resolve(session);
    expect(accessAllows(access, 'anything', null)).toBe(true);
    expect(access.rules).toBeNull();
  });

  it("applies the key's narrowing on top of the agent's access", async () => {
    const { resolver } = build(null, {
      accessMode: AccessMode.RESTRICTED,
      allowedToolsets: [],
      allowedToolIds: ['only-this'],
    });
    const access = await resolver.resolve(session);
    expect(accessAllows(access, 'only-this', null)).toBe(true);
    expect(accessAllows(access, 'anything-else', null)).toBe(false);
  });

  it('a toolset pinned to a version that does not exist allows nothing', async () => {
    const { resolver } = build({
      ...restrictedPolicy,
      allowedToolIds: [],
      allowedToolsets: [{ toolsetId: TOOLSET, version: 2, viaUrlOnly: false }],
    });
    const access = await resolver.resolve(session);
    expect(accessAllows(access, 'tool-in-kit', TOOLSET)).toBe(false);
  });

  it('caches per credential, and a bumped epoch invalidates at once', async () => {
    const { resolver, reads, bump } = build(restrictedPolicy);
    await resolver.resolve(session);
    await resolver.resolve(session);
    expect(reads.policies).toBe(1);

    bump();
    await resolver.resolve(session);
    expect(reads.policies).toBe(2);
  });

  it('the TTL is a backstop', async () => {
    const { resolver, reads, advance } = build(restrictedPolicy);
    await resolver.resolve(session);
    advance(ACCESS_CACHE_TTL_MS + 1);
    await resolver.resolve(session);
    expect(reads.policies).toBe(2);
  });

  it('an unreadable epoch is never served from cache', async () => {
    const { resolver, reads, breakRedis } = build(restrictedPolicy);
    breakRedis();
    await resolver.resolve(session);
    await resolver.resolve(session);
    expect(reads.policies).toBe(2);
  });
});
