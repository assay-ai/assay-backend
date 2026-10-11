import { AccountId } from '@modules/chains/ports/caip.types';
import { EscrowDelegationKind } from '@modules/settlement/ports/escrow-delegation.port';
import { EscrowDelegationService } from '@modules/settlement/services/escrow-delegation.service';

import { guardOver } from './helpers/unsettled-guard';

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
        guardOver().guard,
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

/**
 * REGRESSION (BUG-D1-06): the relay budget was checked only when the SIGNED
 * request was relayed, so the payer was asked to sign and told afterwards. The
 * intents now refuse first, and nothing is built.
 */
describe('EscrowDelegationService intents — the relay budget comes before the wallet', () => {
  const limited = Object.assign(new Error('limit'), {
    errorCode: 'SETTLEMENT_RELAYED_INTENT_RATE_LIMITED',
  });

  function build(room: () => Promise<void>) {
    const delegation = {
      list: jest.fn(async () => []),
      authorizeIntent: jest.fn(async () => ({ kind: 'typed-data' })),
      revokeIntent: jest.fn(async () => ({ kind: 'typed-data' })),
    };
    const withdrawals = { assertRelayRoom: jest.fn(room) };
    const service = new EscrowDelegationService(
      delegation as never,
      withdrawals as never,
      { assetFor: jest.fn(async () => 'eip155:46630/erc20:0xDbbC') } as never,
      guardOver().guard,
    );
    return { service, delegation, withdrawals };
  }
  const terms = {
    delegate: 'eip155:46630:0x5555555555555555555555555555555555555555' as AccountId,
    maxVoucherAmount: 1n,
    maxPerWindow: 2n,
    validUntil: 3n,
  };

  it('refuses an authorise or revoke intent when the budget is spent, building nothing', async () => {
    const { service, delegation, withdrawals } = build(async () => {
      throw limited;
    });
    await expect(service.authorizeIntent('org', PAYER, terms)).rejects.toBe(limited);
    await expect(
      service.revokeIntent('org', PAYER, '0x5555555555555555555555555555555555555555'),
    ).rejects.toBe(limited);
    expect(withdrawals.assertRelayRoom).toHaveBeenCalledWith('org', PAYER);
    expect(delegation.authorizeIntent).not.toHaveBeenCalled();
    expect(delegation.revokeIntent).not.toHaveBeenCalled();
  });

  it('builds the request when there is room', async () => {
    const { service, delegation } = build(async () => undefined);
    await expect(service.authorizeIntent('org', PAYER, terms)).resolves.toEqual({
      kind: 'typed-data',
    });
    expect(delegation.authorizeIntent).toHaveBeenCalledWith(PAYER, terms);
  });
});

/**
 * REGRESSION (BUG-D1-07): lowering a delegate's window below what its served,
 * unredeemed vouchers need was signed and relayed without a word, and the
 * chain then refused those vouchers at redemption. The D1 retest: W = 5, the
 * counter about 2.27, one 0.10 voucher in flight, W lowered to 2.
 */
describe('EscrowDelegationService — lowering caps with payments in flight (BUG-D1-07)', () => {
  const DELEGATE = 'eip155:46630:0x76B98f0000000000000000000000000000d10C' as AccountId;
  const ASSET = 'eip155:46630/erc20:0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac';
  const validUntil = BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400);
  const standing = {
    delegate: DELEGATE,
    maxVoucherAmount: 500_000n,
    maxPerWindow: 5_000_000n,
    spentInWindow: 2_270_000n,
    validUntil,
    status: 'ACTIVE',
  };
  const inFlight = {
    count: 1,
    total: 100_000n,
    largest: 100_000n,
    redeemableUntil: new Date(Date.now() + 30 * 60_000),
    redeemedSince: 0n,
  };

  function build(totals = inFlight) {
    const delegation = {
      list: jest.fn(async () => [standing]),
      authorizeIntent: jest.fn(async () => ({ kind: 'typed-data' })),
      revokeIntent: jest.fn(async () => ({ kind: 'typed-data' })),
    };
    const withdrawals = {
      assertRelayRoom: jest.fn(async () => undefined),
      submitRelayedIntent: jest.fn(async () => ({ submission: SUBMISSION })),
    };
    const { guard, repository } = guardOver(totals);
    const service = new EscrowDelegationService(
      delegation as never,
      withdrawals as never,
      { assetFor: jest.fn(async () => ASSET) } as never,
      guard,
    );
    return { service, delegation, withdrawals, repository };
  }
  const lowered = {
    delegate: DELEGATE,
    maxVoucherAmount: 500_000n,
    maxPerWindow: 2_000_000n,
    validUntil,
  };

  it('refuses the intent before the wallet is asked, unless acknowledged', async () => {
    const { service, delegation } = build();
    await expect(service.authorizeIntent('org', PAYER, lowered)).rejects.toMatchObject({
      errorCode: 'SETTLEMENT_UNSETTLED_VOUCHERS_AT_RISK',
    });
    expect(delegation.authorizeIntent).not.toHaveBeenCalled();

    await expect(service.authorizeIntent('org', PAYER, lowered, true)).resolves.toEqual({
      kind: 'typed-data',
    });
  });

  it('builds a lowered window that still holds the counter and the payments in flight', async () => {
    const { service } = build();
    await expect(
      service.authorizeIntent('org', PAYER, { ...lowered, maxPerWindow: 2_370_000n }),
    ).resolves.toEqual({ kind: 'typed-data' });
  });

  it('builds any change once nothing is in flight', async () => {
    const { service } = build({
      ...inFlight,
      count: 0,
      total: 0n,
      largest: 0n,
      redeemableUntil: null,
    });
    await expect(service.authorizeIntent('org', PAYER, lowered)).resolves.toEqual({
      kind: 'typed-data',
    });
  });

  it('refuses the signed request too when payments arrived while it was signed, and relays nothing', async () => {
    const { service, withdrawals, repository } = build();
    const signed = {
      kind: EscrowDelegationKind.AUTHORIZE_DELEGATE,
      delegate: DELEGATE.split(':')[2],
      maxVoucherAmount: 500_000n,
      maxPerWindow: 2_000_000n,
      validUntil,
      nonce: 26n,
      deadline: 2n,
      signature: `0x${'ab'.repeat(65)}`,
    } as const;
    await expect(service.submit('org', PAYER, PAYER.split(':')[2], signed)).rejects.toMatchObject({
      errorCode: 'SETTLEMENT_UNSETTLED_VOUCHERS_AT_RISK',
    });
    expect(withdrawals.submitRelayedIntent).not.toHaveBeenCalled();
    expect(repository.holdVoucherAdmission).toHaveBeenCalledTimes(1);

    await expect(
      service.submit('org', PAYER, PAYER.split(':')[2], signed, true),
    ).resolves.toMatchObject({ submission: SUBMISSION });
    expect(withdrawals.submitRelayedIntent).toHaveBeenCalledTimes(1);
  });

  it('never refuses a revocation, but relays it under the admission pause', async () => {
    const { service, withdrawals, repository } = build();
    await expect(
      service.submit('org', PAYER, PAYER.split(':')[2], {
        kind: EscrowDelegationKind.REVOKE_DELEGATE,
        delegate: DELEGATE.split(':')[2],
        nonce: 1n,
        deadline: 2n,
        signature: `0x${'ab'.repeat(65)}`,
      }),
    ).resolves.toMatchObject({ submission: SUBMISSION });
    expect(withdrawals.submitRelayedIntent).toHaveBeenCalledTimes(1);
    expect(repository.holdVoucherAdmission).toHaveBeenCalledTimes(1);
  });

  it('lists each delegate with its payments still being settled', async () => {
    const { service } = build();
    const [listed] = await service.list(PAYER);
    expect(listed.unsettled).toEqual({
      count: 1,
      total: 100_000n,
      largest: 100_000n,
      windowNeeds: 2_370_000n,
      redeemableUntil: inFlight.redeemableUntil,
    });
  });
});
