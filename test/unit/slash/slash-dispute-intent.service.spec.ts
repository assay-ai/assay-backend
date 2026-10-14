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
