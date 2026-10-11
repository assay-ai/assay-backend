import { AccountId } from '@modules/chains/ports/caip.types';
import { EscrowDelegationKind } from '@modules/settlement/ports/escrow-delegation.port';
import { EscrowDelegationService } from '@modules/settlement/services/escrow-delegation.service';

const PAYER = 'eip155:46630:0x18103e1D79257c695B2FBbd4b346CD2Ba7927296' as AccountId;
const SUBMISSION = { transactionHash: '0xabc', blockNumber: '7', gasUsed: '137271' };

/**
 * Review S3-12: once the relayed transaction has landed, a failure to READ the
 * delegates back must not report the authorisation or revocation as failed.
 */
describe('EscrowDelegationService.submit', () => {
  function build(list: () => Promise<unknown>) {
    const delegation = { list: jest.fn(list), authorizeIntent: jest.fn(), revokeIntent: jest.fn() };
    const withdrawals = { submitRelayedIntent: jest.fn(async () => ({ submission: SUBMISSION })) };
    const escrows = { assetFor: jest.fn(async () => 'eip155:46630/erc20:0xDbbC') };
    return {
      service: new EscrowDelegationService(
        delegation as never,
        withdrawals as never,
        escrows as never,
      ),
      withdrawals,
    };
  }
  const intent = {
    kind: EscrowDelegationKind.REVOKE_DELEGATE,
    delegate: '0x5555555555555555555555555555555555555555',
    nonce: 1n,
    deadline: 2n,
    signature: `0x${'ab'.repeat(65)}`,
  } as const;

  it('returns the landed submission with delegates: null when the read-back fails', async () => {
    const { service } = build(async () => {
      throw new Error('rpc down');
    });
    await expect(service.submit('org', PAYER, PAYER.split(':')[2], intent)).resolves.toMatchObject({
      submission: SUBMISSION,
      delegates: null,
    });
  });

  it('returns the delegates read back when it can', async () => {
    const { service } = build(async () => []);
    await expect(service.submit('org', PAYER, PAYER.split(':')[2], intent)).resolves.toMatchObject({
      delegates: [],
    });
  });
});
