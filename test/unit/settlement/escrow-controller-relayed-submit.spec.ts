import { AuditLogWriter } from '@shared/audit';
import { AccountId, AssetId, CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { EscrowController } from '@modules/settlement/controllers/escrow.controller';
import { EscrowIntentKind } from '@modules/settlement/ports/escrow-intent-builder.port';
import {
  EscrowAccountService,
  EscrowState,
} from '@modules/settlement/services/escrow-account.service';
import {
  RelayedEscrowIntentResult,
  WithdrawalService,
} from '@modules/settlement/services/withdrawal.service';
import { MoneyUtil } from '@shared/utils/money.util';

/**
 * `POST /escrow/limits` and `POST /escrow/withdrawals/request` — the HTTP face
 * of the relayed submit path.
 *
 * Three things are only provable at this layer, and each of them is a defect
 * that would be invisible everywhere else.
 *
 * **The account comes from the session.** Every route on this controller takes
 * it from `@CurrentSession()`; the `buyer` in the body is passed along
 * *separately*, to be compared and refused — never used as the account. A
 * controller that passed `body.buyer` as the account would make the binding
 * check compare a value against itself and pass for every request, including a
 * forged one.
 *
 * **The decimal strings become the right bigints.** Two fields of the same type
 * next to each other — `maxVoucherAmount` and `maxPerWindow` — is exactly the
 * shape a transposition hides in, and a transposed pair produces a call that
 * lands, so nothing downstream notices.
 *
 * **A reverted transaction is never a 201.** The service throws; this asserts
 * the controller does not turn that into a response with a hash in it.
 */

const CHAIN = CHAIN_IDS.ROBINHOOD_TESTNET;
const BUYER_ADDRESS = '0x1b89caB90cbc71bBFad47E45707D17787cf91dD1';
const BUYER: AccountId = toAccountId(CHAIN, BUYER_ADDRESS);
const SOMEONE_ELSE = '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955';
const ASSET = `${CHAIN}/erc20:0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac` as AssetId;
const SIGNATURE = `0x${'3c'.repeat(64)}1c`;

const SESSION: McpSession = {
  credentialId: 'cred-zero-eth-buyer',
  organizationId: 'org-7e3a94c1-5b62-4d08-9f37-2c81e6a0b5d4',
  agentId: 'agent-1',
  agentAccount: BUYER,
  chainId: CHAIN,
  label: null,
  callerKind: McpCallerKind.CONFIG,
};

function escrowState(): EscrowState {
  const zero = MoneyUtil.of(0n, ASSET, 6);
  return {
    exists: true,
    chainReadable: true,
    lifetime: null,
    account: BUYER,
    escrowPda: null,
    escrowTokenAccount: null,
    balance: zero,
    openHolds: zero,
    spendable: zero,
    withdrawRequested: zero,
    withdrawAvailableAt: null,
    serverTime: new Date().toISOString(),
    withdrawDelaySeconds: 3_600,
    maxVoucherAmount: MoneyUtil.of(2_500_000n, ASSET, 6),
    maxPerWindow: MoneyUtil.of(9_000_000n, ASSET, 6),
    spentInWindow: zero,
    windowStartedAt: null,
    windowSeconds: 86_400,
    seqHigh: '0',
    nextSeq: '1',
    observedAt: new Date().toISOString(),
  };
}

function build(result?: Partial<RelayedEscrowIntentResult>, reject?: Error) {
  const submitRelayedIntent = jest.fn(
    async (
      // Typed from the method itself, so `mock.calls[0]` is a tuple this file
      // can index by position rather than an untyped `[]`.
      ..._args: Parameters<WithdrawalService['submitRelayedIntent']>
    ): Promise<RelayedEscrowIntentResult> => {
      if (reject) throw reject;
      return {
        submission: {
          transactionHash: '0x1e23e27f81ba84a1a27b0b58b3f4dc5049dd54016c734e94549f4951ecc3f6c9',
          blockNumber: '101847',
          gasUsed: '65536',
        },
        escrow: escrowState(),
        ...result,
      };
    },
  );
  const assetFor = jest.fn(async () => ASSET);

  const recordAfterCommit = jest.fn(async () => undefined);
  const controller = new EscrowController(
    { assetFor } as unknown as EscrowAccountService,
    { submitRelayedIntent } as unknown as WithdrawalService,
    { recordAfterCommit } as unknown as AuditLogWriter,
  );
  return { controller, submitRelayedIntent, assetFor, recordAfterCommit };
}

const LIMITS_BODY = {
  buyer: BUYER_ADDRESS,
  maxVoucherAmount: '2500000',
  maxPerWindow: '9000000',
  nonce: '0',
  deadline: '1789139970',
  signature: SIGNATURE,
};

const REQUEST_BODY = {
  buyer: BUYER_ADDRESS,
  amount: '400000000',
  nonce: '1',
  deadline: '1789139974',
  signature: SIGNATURE,
};

describe('POST /escrow/limits', () => {
  it('hands the service the session account and the CLAIMED buyer, separately', async () => {
    const { controller, submitRelayedIntent } = build();

    await controller.submitLimits(SESSION, { ...LIMITS_BODY, buyer: SOMEONE_ELSE });

    const [organizationId, account, asset, claimedBuyer] = submitRelayedIntent.mock.calls[0];
    expect(organizationId).toBe(SESSION.organizationId);
    // The ACCOUNT is the session's, even though the body named somebody else.
    // The body's value travels as the claim to be refused, in its own argument.
    expect(account).toBe(BUYER);
    expect(claimedBuyer).toBe(SOMEONE_ELSE);
    expect(asset).toBe(ASSET);
  });

  it('parses each decimal string into its own field, in the right order', async () => {
    const { controller, submitRelayedIntent } = build();

    await controller.submitLimits(SESSION, LIMITS_BODY);

    expect(submitRelayedIntent.mock.calls[0][4]).toEqual({
      kind: EscrowIntentKind.SET_LIMITS,
      // Asymmetric on purpose: a transposition of the pair would still be two
      // valid uint64s and would still produce a transaction that lands.
      maxVoucherAmount: 2_500_000n,
      maxPerWindow: 9_000_000n,
      nonce: 0n,
      deadline: 1_789_139_970n,
      signature: SIGNATURE,
    });
  });

  it('answers with the hash, the block, the gas and the state read back', async () => {
    const { controller } = build();

    const response = await controller.submitLimits(SESSION, LIMITS_BODY);

    expect(response.kind).toBe(EscrowIntentKind.SET_LIMITS);
    expect(response.account).toBe(BUYER);
    expect(response.transactionHash).toBe(
      '0x1e23e27f81ba84a1a27b0b58b3f4dc5049dd54016c734e94549f4951ecc3f6c9',
    );
    expect(response.blockNumber).toBe('101847');
    expect(response.gasUsed).toBe('65536');
    expect(response.escrow.maxVoucherAmount?.amount).toBe('2500000');
    // No `transaction` member: there is nothing left to sign.
    expect(response).not.toHaveProperty('transaction');
  });

  it('does not answer at all when the chain refused', async () => {
    const refused = Object.assign(new Error('refused: BadNonce'), {
      errorCode: 'SETTLEMENT_RELAYED_INTENT_REFUSED',
    });
    const { controller } = build(undefined, refused);

    await expect(controller.submitLimits(SESSION, LIMITS_BODY)).rejects.toBe(refused);
  });
});

describe('POST /escrow/withdrawals/request', () => {
  it('parses the amount and reports the kind it relayed', async () => {
    const { controller, submitRelayedIntent } = build();

    const response = await controller.submitRequestWithdraw(SESSION, REQUEST_BODY);

    expect(submitRelayedIntent.mock.calls[0][4]).toEqual({
      kind: EscrowIntentKind.REQUEST_WITHDRAW,
      amount: 400_000_000n,
      nonce: 1n,
      deadline: 1_789_139_974n,
      signature: SIGNATURE,
    });
    expect(response.kind).toBe(EscrowIntentKind.REQUEST_WITHDRAW);
  });

  it('passes `0` through — the chain’s own way to retract a standing request', async () => {
    const { controller, submitRelayedIntent } = build();

    await controller.submitRequestWithdraw(SESSION, { ...REQUEST_BODY, amount: '0' });

    expect(submitRelayedIntent.mock.calls[0][4]).toMatchObject({ amount: 0n });
  });
});

describe('POST /escrow/limits — audit log (BUG-R2-B4-01)', () => {
  it('records limit.updated once the relayed transaction has landed', async () => {
    const { controller, recordAfterCommit } = build();

    await controller.submitLimits(SESSION, LIMITS_BODY);

    expect(recordAfterCommit).toHaveBeenCalledTimes(1);
    expect(recordAfterCommit).toHaveBeenCalledWith({
      organizationId: SESSION.organizationId,
      actor: { type: 'user', id: SESSION.credentialId },
      action: 'limit.updated',
      resourceType: 'escrow',
      resourceId: BUYER,
      before: null,
      after: {
        maxVoucherAmount: '2500000',
        maxPerWindow: '9000000',
        transactionHash: '0x1e23e27f81ba84a1a27b0b58b3f4dc5049dd54016c734e94549f4951ecc3f6c9',
      },
    });
    expect(JSON.stringify(recordAfterCommit.mock.calls)).not.toContain(SIGNATURE);
  });

  it('records nothing when the relay refused', async () => {
    const { controller, submitRelayedIntent, recordAfterCommit } = build();
    submitRelayedIntent.mockRejectedValueOnce(new Error('refused'));

    await expect(controller.submitLimits(SESSION, LIMITS_BODY)).rejects.toThrow('refused');
    expect(recordAfterCommit).not.toHaveBeenCalled();
  });
});

describe('POST /escrow/withdrawals/request — audit log (B7)', () => {
  it('records withdrawal.requested once the relayed request has landed', async () => {
    const { controller, recordAfterCommit } = build();

    await controller.submitRequestWithdraw(SESSION, REQUEST_BODY);

    expect(recordAfterCommit).toHaveBeenCalledTimes(1);
    expect(recordAfterCommit).toHaveBeenCalledWith({
      organizationId: SESSION.organizationId,
      actor: { type: 'user', id: SESSION.credentialId },
      action: 'withdrawal.requested',
      resourceType: 'escrow',
      resourceId: BUYER,
      before: null,
      after: expect.objectContaining({
        amount: '400.000000',
        amountAtomic: '400000000',
        asset: ASSET,
      }),
    });
    expect(JSON.stringify(recordAfterCommit.mock.calls)).not.toContain(SIGNATURE);
  });

  it('records a zero request as withdrawal.cancelled', async () => {
    const { controller, recordAfterCommit } = build();

    await controller.submitRequestWithdraw(SESSION, { ...REQUEST_BODY, amount: '0' });

    expect(recordAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'withdrawal.cancelled' }),
    );
  });

  it('records nothing when the relay refused', async () => {
    const { controller, submitRelayedIntent, recordAfterCommit } = build();
    submitRelayedIntent.mockRejectedValueOnce(new Error('refused'));

    await expect(controller.submitRequestWithdraw(SESSION, REQUEST_BODY)).rejects.toThrow(
      'refused',
    );
    expect(recordAfterCommit).not.toHaveBeenCalled();
  });
});
