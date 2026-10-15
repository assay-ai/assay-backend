import { SlashDisputeIntentService } from '@modules/slash/services/slash-dispute-intent.service';

const CHAIN = 'eip155:46630';
const STAKE_AUTHORITY = '0xA271A3407D3302f4b4Fbe469b9188487cedd7d45';
const ID = 'a'.repeat(64);
const CALL = {
  chainId: CHAIN,
  to: '0x0aF4D08f97B4FA8Ba3E47Cb025aE8CaD509bc73c',
  data: '0x',
  value: '0' as const,
  signer: STAKE_AUTHORITY,
  signerRole: 'PROVIDER' as const,
  functionName: 'disputeSlashBatch',
  requestIds: [ID],
};
const OPERATOR = {
  operatorId: 'op_1',
  subject: 'lee@',
  roles: ['ADJL'],
  authorityLimitMinor: null,
};

function build(port: Record<string, unknown>, enrolled = true) {
  const logged: { context: Record<string, unknown>; after: unknown }[] = [];
  const service = new SlashDisputeIntentService(
    {
      findOneBy: async () =>
        enrolled ? { stakeAuthorityAccountId: `${CHAIN}:${STAKE_AUTHORITY}` } : null,
    } as never,
    {
      perform: async (
        context: Record<string, unknown>,
        mutation: () => Promise<{ value: unknown; after: unknown }>,
      ) => {
        const result = await mutation();
        logged.push({ context, after: result.after });
        return result.value;
      },
    } as never,
    { findChainDisputed: async () => [] } as never,
    port as never,
  );
  return { service, logged };
}

describe('SlashDisputeIntentService', () => {
  it('builds the provider’s batch for its own stake wallet, ids 0x-prefixed', async () => {
    const seen: unknown[] = [];
    const { service } = build({
      buildDisputeBatch: async (request: unknown) => (
        seen.push(request),
        { call: CALL, refusals: [] }
      ),
    });
    const call = await service.providerDispute('org-1', CHAIN, [`0x${ID}`]);
    expect(seen).toEqual([{ chainId: CHAIN, provider: STAKE_AUTHORITY, requestIds: [`0x${ID}`] }]);
    expect(call.requestIds).toEqual([`0x${ID}`]);
  });

  it('refuses the whole request with every refused id named (422)', async () => {
    const { service } = build({
      buildDisputeBatch: async () => ({
        call: null,
        refusals: [{ requestId: ID, reason: 'DisputeWindowClosed', detail: 'closed' }],
      }),
    });
    await expect(service.providerDispute('org-1', CHAIN, [`0x${ID}`])).rejects.toMatchObject({
      errorCode: 'SLASH_CHAIN_BATCH_REFUSED',
      statusCode: 422,
      context: { refusals: [expect.objectContaining({ reason: 'DisputeWindowClosed' })] },
    });
  });

  it('refuses a provider with no proven stake authority on the chain, and a non-EVM chain', async () => {
    const { service } = build({}, false);
    await expect(service.providerDispute('org-1', CHAIN, [`0x${ID}`])).rejects.toMatchObject({
      errorCode: expect.stringMatching(/STAKE_AUTHORITY/),
    });
    await expect(
      service.providerDispute('org-1', 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', [`0x${ID}`]),
    ).rejects.toMatchObject({ errorCode: 'CHAIN_UNSUPPORTED' });
  });

  it('logs an arbiter ruling to the register as S-13, unsigned', async () => {
    const { service, logged } = build({
      buildRulingBatch: async () => ({
        call: { ...CALL, functionName: 'upholdSlashBatch', signerRole: 'ARBITER' },
        refusals: [],
      }),
    });
    await service.arbiterRuling(
      {
        operator: OPERATOR as never,
        reasonCode: 'DISPUTE_RULED',
        note: 'the evidence supports the judgement',
        requestId: null,
      },
      CHAIN,
      'UPHOLD',
      [`0x${ID}`],
    );
    expect(logged).toEqual([
      {
        context: expect.objectContaining({ code: 'S-13', targetType: 'slash_record_batch' }),
        after: expect.objectContaining({
          ruling: 'UPHOLD',
          signed: false,
          functionName: 'upholdSlashBatch',
        }),
      },
    ]);
  });

  it('logs an arbiter block as A-11', async () => {
    const { service, logged } = build({
      buildBlock: async () => ({ ...CALL, functionName: 'setBlocked', requestIds: [] }),
    });
    await service.arbiterBlock(
      {
        operator: OPERATOR as never,
        reasonCode: 'LEAKED_KEY',
        note: 'the key was posted publicly',
        requestId: null,
      },
      CHAIN,
      STAKE_AUTHORITY,
    );
    expect(logged[0].context).toMatchObject({ code: 'A-11', targetType: 'chain_blocklist' });
  });
});

describe('SlashDisputeIntentService — superseded earlier-epoch records (review R2-6)', () => {
  const SUPERSEDED = {
    requestId: ID,
    proposalId: 'case-1',
    organizationId: 'org-1',
    providerId: 'org-1',
    assetId: `${CHAIN}/erc20:0xdbbc156dd414f43f2c952c1be0f16a0b9a826cd3`,
    chainStatus: 'PENDING',
    chainEpoch: 0,
    caseChainEpoch: 1,
    penaltyAmount: '500',
    chainReserved: '500',
    chainExecutableAt: new Date('2026-10-20T00:00:00Z'),
  };

  function buildSuperseded(port: Record<string, unknown>) {
    const logged: { context: Record<string, unknown>; after: unknown }[] = [];
    const service = new SlashDisputeIntentService(
      { findOneBy: async () => null } as never,
      {
        perform: async (
          context: Record<string, unknown>,
          mutation: () => Promise<{ value: unknown; after: unknown }>,
        ) => {
          const result = await mutation();
          logged.push({ context, after: result.after });
          return result.value;
        },
      } as never,
      {
        findChainDisputed: async () => [],
        findSupersededStanding: async () => [SUPERSEDED],
      } as never,
      port as never,
    );
    return { service, logged };
  }

  it('lists them for the arbiter with their chain and door', async () => {
    const { service } = buildSuperseded({});
    await expect(service.supersededOnChain()).resolves.toEqual([
      expect.objectContaining({
        requestId: `0x${ID}`,
        proposalId: 'case-1',
        chainId: CHAIN,
        chainStatus: 'PENDING',
        recordEpoch: 0,
        caseEpoch: 1,
        executableAt: '2026-10-20T00:00:00.000Z',
      }),
    ]);
  });

  it('builds the arbiter’s cancelSlash for a superseded record only, logged as S-13', async () => {
    const seen: unknown[] = [];
    const { service, logged } = buildSuperseded({
      buildRulingBatch: async (request: unknown) => (
        seen.push(request),
        { call: { ...CALL, functionName: 'cancelSlashBatch', signerRole: 'ARBITER' }, refusals: [] }
      ),
    });
    const context = {
      operator: OPERATOR as never,
      reasonCode: 'SUPERSEDED_EPOCH',
      note: 'an earlier proposal landed late',
      requestId: null,
    };
    const call = await service.supersededCancel(context, CHAIN, `0x${ID}`);
    expect(call.functionName).toBe('cancelSlashBatch');
    expect(seen).toEqual([{ chainId: CHAIN, ruling: 'CANCEL', requestIds: [`0x${ID}`] }]);
    expect(logged[0].context).toMatchObject({ code: 'S-13' });
    expect(logged[0].after).toMatchObject({ ruling: 'CANCEL', superseded: true });

    await expect(service.supersededCancel(context, CHAIN, `0x${'b'.repeat(64)}`)).rejects.toMatchObject(
      { statusCode: 409 },
    );
  });
});
