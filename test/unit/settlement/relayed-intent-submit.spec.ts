import { hexToBytes } from 'viem';

import { hashSetLimits } from '@modules/chains/evm/eip712/escrow-control';
import { evmDomain } from '@modules/chains/evm/eip712/domain';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, AssetId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { SettlementErrors } from '@modules/settlement/errors/settlement.errors';
import { EscrowIntentKind } from '@modules/settlement/ports/escrow-intent-builder.port';
import { RelayedEscrowIntentFields } from '@modules/settlement/ports/relayed-escrow-intent.port';
import {
  EscrowAccountService,
  EscrowState,
} from '@modules/settlement/services/escrow-account.service';
import { ReconciliationService } from '@modules/settlement/services/reconciliation.service';
import { WithdrawalService } from '@modules/settlement/services/withdrawal.service';
import { MoneyUtil } from '@shared/utils/money.util';

import { generateSigner } from '../chains/evm/evm-fixtures';
import { guardOver } from './helpers/unsettled-guard';

/**
 * `WithdrawalService.submitRelayedIntent` — **whose gas is spent**, which is
 * the only question the platform gets to answer on this path.
 *
 * Validity is the contract's: a wrong signer is `SignerIsNotBuyer`, a replay is
 * `BadNonce`, a malleated `s` is `MalleableSignature`, a stale one is
 * `SignatureExpired`, and all four were proved against the real deployment on a
 * fork. Nothing here re-decides any of them.
 *
 * The refusal this file is about is the one the CHAIN CANNOT MAKE. A genuine
 * EIP-712 signature by buyer B, over a message naming B, verifies no matter who
 * sends the transaction — `SignerIsNotBuyer` fires on the *signer*, never on the
 * sender. So a session that scraped somebody else's signature could make the
 * platform pay to submit it, and the chain would be perfectly happy. Only this
 * layer can say no.
 *
 * **The signatures below are real.** `generateSigner` is `@noble/curves`
 * directly — not the adapter, not viem's account — and the digest is the one
 * `hashSetLimits` produces over the real domain. A malformed 65 bytes would
 * make the negative pass for the wrong reason: it would be refused as garbage
 * rather than as somebody else's.
 */
const TESTNET = CHAIN_IDS.ROBINHOOD_TESTNET;
const USDG = ASSET_IDS.USDG_ROBINHOOD_TESTNET;
const ESCROW = '0xf04BD9909697876D8a0E1e110536F80e5Fa1dF97';
const ORG = 'org-7e3a94c1';

const ALICE = generateSigner(TESTNET);
const BOB = generateSigner(TESTNET);

const SET_LIMITS_MESSAGE = {
  maxVoucherAmount: 2_500_000n,
  maxPerWindow: 9_000_000n,
  nonce: 3n,
  deadline: 1_789_139_970n,
};

/**
 * A genuine `SetLimits` signature, by `signer`, over a message naming
 * `signer` — the thing a wallet actually produces, and the thing a scraper
 * would actually have.
 */
function signSetLimits(signer: typeof ALICE): RelayedEscrowIntentFields {
  const digest = hashSetLimits(
    { buyer: signer.address, ...SET_LIMITS_MESSAGE },
    evmDomain(TESTNET, ESCROW),
  );
  return {
    kind: EscrowIntentKind.SET_LIMITS,
    ...SET_LIMITS_MESSAGE,
    signature: signer.sign(hexToBytes(digest)),
  };
}

function escrowState(): EscrowState {
  return {
    exists: true,
    chainReadable: true,
    lifetime: null,
    uncreditedOnChain: null,
    withdrawalsFrozen: null,
    account: ALICE.account,
    escrowPda: null,
    escrowTokenAccount: null,
    balance: MoneyUtil.of(400_000_000n, USDG, 6),
    openHolds: MoneyUtil.of(0n, USDG, 6),
    spendable: MoneyUtil.of(400_000_000n, USDG, 6),
    withdrawRequested: MoneyUtil.of(0n, USDG, 6),
    withdrawAvailableAt: null,
    serverTime: new Date().toISOString(),
    withdrawDelaySeconds: 3_600,
    maxVoucherAmount: MoneyUtil.of(2_500_000n, USDG, 6),
    maxPerWindow: MoneyUtil.of(9_000_000n, USDG, 6),
    spentInWindow: MoneyUtil.of(0n, USDG, 6),
    windowStartedAt: null,
    windowSeconds: 86_400,
    seqHigh: '0',
    nextSeq: '1',
    observedAt: new Date().toISOString(),
  };
}

function build(options: { frozen?: boolean; admit?: jest.Mock; submit?: jest.Mock } = {}) {
  const calls: string[] = [];

  const submit =
    options.submit ??
    jest.fn(async () => {
      calls.push('submit');
      return { transactionHash: '0xabc1', blockNumber: '101847', gasUsed: '65536' };
    });
  const admit =
    options.admit ??
    jest.fn(async () => {
      calls.push('admit');
    });
  const isFrozen = jest.fn(async () => {
    calls.push('isFrozen');
    return options.frozen ?? false;
  });
  const get = jest.fn(async () => {
    calls.push('escrows.get');
    return escrowState();
  });

  const service = new WithdrawalService(
    { buildIntent: jest.fn() } as never,
    { isFrozen } as unknown as ReconciliationService,
    { get } as unknown as EscrowAccountService,
    { grantWithdrawGas: jest.fn() } as never,
    { submit } as never,
    { admit } as never,
    guardOver().guard,
  );

  return { service, submit, admit, isFrozen, get, calls };
}

function caught(error: unknown): { code?: string; status?: number; message: string } {
  const candidate = error as { errorCode?: string; statusCode?: number; message: string };
  return { code: candidate.errorCode, status: candidate.statusCode, message: candidate.message };
}

function submitAs(
  service: WithdrawalService,
  session: AccountId,
  claimedBuyer: string,
  intent: RelayedEscrowIntentFields,
  asset: AssetId = USDG,
) {
  return service.submitRelayedIntent(ORG, session, asset, claimedBuyer, intent);
}

describe("one session must not spend the relayer's gas on another buyer's signature", () => {
  it("refuses Bob's genuine signature posted on Alice's session, by name, and submits nothing", async () => {
    const { service, submit, admit } = build();
    const bobsRequest = signSetLimits(BOB);

    const error = await submitAs(service, ALICE.account, BOB.address, bobsRequest).catch(
      (e: unknown) => e,
    );

    expect(caught(error).code).toBe('SETTLEMENT_RELAYED_INTENT_FOR_ANOTHER_BUYER');
    expect(caught(error).status).toBe(403);
    expect(caught(error).message).toContain(BOB.address);
    // Nothing downstream ran: no gas, and not even a slot of Alice's budget.
    expect(submit).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  /**
   * The control, and the only difference is whose session it arrives on.
   *
   * The same 65 bytes, over the same digest, for the same buyer. If the refusal
   * above fired because the signature was somehow bad, this would fail too.
   */
  it('accepts the IDENTICAL bytes on Bob’s own session', async () => {
    const { service, submit } = build();
    const bobsRequest = signSetLimits(BOB);

    const result = await submitAs(service, BOB.account, BOB.address, bobsRequest);

    expect(result.submission.transactionHash).toBe('0xabc1');
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0].signature).toBe(bobsRequest.signature);
  });

  it('refuses a buyer that differs from the session only in the last character', async () => {
    const { service, submit } = build();
    const nearly = `${ALICE.address.slice(0, -1)}${ALICE.address.endsWith('0') ? '1' : '0'}`;

    const error = await submitAs(service, ALICE.account, nearly, signSetLimits(ALICE)).catch(
      (e: unknown) => e,
    );

    expect(caught(error).code).toBe('SETTLEMENT_RELAYED_INTENT_FOR_ANOTHER_BUYER');
    expect(submit).not.toHaveBeenCalled();
  });

  /**
   * EIP-55 is a checksum carried in the CASE of the hex digits, so a wallet that
   * echoes the address back lower-cased is echoing the same address. Refusing
   * that would break the honest path for a cosmetic difference.
   */
  it('accepts the session’s own address spelled without its EIP-55 checksum', async () => {
    const { service, submit } = build();

    await submitAs(service, ALICE.account, ALICE.address.toLowerCase(), signSetLimits(ALICE));

    expect(submit).toHaveBeenCalledTimes(1);
  });

  /**
   * The address the CALL names comes from the session, never from the body —
   * so even a binding check that let something through could only ever produce
   * a call for the session's own account, which the contract would then refuse
   * `SignerIsNotBuyer` at the pre-flight, before gas.
   */
  it('hands the port the session’s account and nothing the caller supplied', async () => {
    const { service, submit } = build();

    await submitAs(service, ALICE.account, ALICE.address, signSetLimits(ALICE));

    expect(submit.mock.calls[0][0].account).toBe(ALICE.account);
  });
});

describe('the order of the three controls', () => {
  it('counts the attempt before submitting, never after', async () => {
    const { service, calls } = build();

    await submitAs(service, ALICE.account, ALICE.address, signSetLimits(ALICE));

    // The first read is BUG-D1-07's: the escrow's standing limits, to tell
    // whether this change lowers them below what unsettled payments need.
    expect(calls).toEqual(['escrows.get', 'admit', 'submit', 'escrows.get']);
  });

  it('submits nothing when the budget is spent', async () => {
    const rateLimited = Object.assign(new Error('too many'), {
      errorCode: 'SETTLEMENT_RELAYED_INTENT_RATE_LIMITED',
    });
    const { service, submit } = build({
      admit: jest.fn().mockRejectedValue(rateLimited),
    });

    const error = await submitAs(service, ALICE.account, ALICE.address, signSetLimits(ALICE)).catch(
      (e: unknown) => e,
    );

    expect(caught(error).code).toBe('SETTLEMENT_RELAYED_INTENT_RATE_LIMITED');
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([
    ['a fee spike', { feeSpike: true }],
    ['a busy relayer', { relayerBusy: true }],
  ])('gives the attempt back when %s makes the submission a 503', async (_why, context) => {
    const release = jest.fn(async () => undefined);
    const unavailable = SettlementErrors.relayedIntentUnavailable(context);
    const { service } = build({
      admit: jest.fn(async () => ({ release })),
      submit: jest.fn().mockRejectedValue(unavailable),
    });

    const error = await submitAs(service, ALICE.account, ALICE.address, signSetLimits(ALICE)).catch(
      (e: unknown) => e,
    );

    expect(error).toBe(unavailable);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('keeps the attempt counted when the chain refused the request', async () => {
    const release = jest.fn(async () => undefined);
    const { service } = build({
      admit: jest.fn(async () => ({ release })),
      submit: jest
        .fn()
        .mockRejectedValue(SettlementErrors.relayedIntentRefused({ reason: 'BadNonce' })),
    });

    await submitAs(service, ALICE.account, ALICE.address, signSetLimits(ALICE)).catch(() => null);

    expect(release).not.toHaveBeenCalled();
  });

  /**
   * A reserves breach freezes the withdrawal path, and the relayed submit is
   * part of it. Refusing to BUILD a withdrawal request while the vault is known
   * short and then relaying one anyway would make the freeze mean nothing — a
   * buyer could post bytes signed before it.
   */
  it('refuses a relayed REQUEST_WITHDRAW while withdrawals are frozen', async () => {
    const { service, submit } = build({ frozen: true });

    const error = await submitAs(service, ALICE.account, ALICE.address, {
      kind: EscrowIntentKind.REQUEST_WITHDRAW,
      amount: 400_000_000n,
      nonce: 3n,
      deadline: 1_789_139_970n,
      signature: signSetLimits(ALICE).signature,
    }).catch((e: unknown) => e);

    expect(caught(error).code).toBe('SETTLEMENT_WITHDRAWALS_FROZEN');
    expect(submit).not.toHaveBeenCalled();
  });

  /**
   * …and `SET_LIMITS` is not frozen, because it moves no money out of the
   * platform's control and is not what a reserves breach is about. A buyer
   * lowering their ceiling during an incident is doing the thing the incident
   * makes most sensible.
   */
  it('relays a SET_LIMITS while withdrawals are frozen, and does not even ask', async () => {
    const { service, submit, isFrozen } = build({ frozen: true });

    await submitAs(service, ALICE.account, ALICE.address, signSetLimits(ALICE));

    expect(submit).toHaveBeenCalledTimes(1);
    expect(isFrozen).not.toHaveBeenCalled();
  });
});

describe('what comes back', () => {
  /**
   * The escrow is read AFTER the transaction landed, off the chain — never
   * predicted from what was submitted. A console re-renders from the contract's
   * own answer, and a `submit` that reported success without sending anything
   * would still have to explain a state that had not moved.
   */
  it('reads the escrow after the submission, not before', async () => {
    const order: string[] = [];
    const submit = jest.fn(async () => {
      order.push('submit');
      return { transactionHash: '0xabc1', blockNumber: '101847', gasUsed: '65536' };
    });
    const { service, calls } = build({ submit });

    const result = await submitAs(service, ALICE.account, ALICE.address, signSetLimits(ALICE));

    expect(calls.indexOf('escrows.get')).toBeGreaterThan(calls.indexOf('submit'));
    expect(result.escrow.maxVoucherAmount?.amount).toBe('2500000');
    expect(result.submission).toEqual({
      transactionHash: '0xabc1',
      blockNumber: '101847',
      gasUsed: '65536',
    });
  });
});
