import { decodeFunctionData, encodeFunctionData, toFunctionSelector } from 'viem';

import { ASSAY_ESCROW_ABI } from '@modules/chains/evm/abi/assay.abi';
import {
  EVM_RELAYED_INTENT_MAX_COST_WEI,
  EVM_RELAYED_INTENT_MAX_GAS,
  EvmRelayedEscrowIntentSubmitter,
  EvmRelayedIntentClient,
} from '@modules/chains/evm/evm-relayed-escrow-intent.service';
import { EvmRelayerPort, EvmRelayResult } from '@modules/chains/evm/ports/evm-relayer.port';
import { EvmRpcError } from '@modules/chains/evm/sanctioned-evm-rpc';
import { EvmSendRejectedError } from '@modules/chains/evm/evm-send-rejected.error';
import { CHAIN_IDS, ChainId, toAccountId } from '@modules/chains/ports/caip.types';
import { EscrowIntentKind } from '@modules/settlement/ports/escrow-intent-builder.port';
import { RelayedEscrowIntent } from '@modules/settlement/ports/relayed-escrow-intent.port';

import { deployment } from './evm-fixtures';
import { L2_BASE_FEE, fakeNodeInterface } from './helpers/fake-node-interface';

/**
 * `EvmRelayedEscrowIntentSubmitter` — the verb that makes the relayed doors
 * reachable, and the three things it must never become.
 *
 * The door itself was proved on a fork before this class existed:
 * `setLimitsBySig` and
 * `requestWithdrawBySig` both execute, a replay is `BadNonce`, an `s`-flipped
 * signature is `MalleableSignature`, an expired one is `SignatureExpired` and a
 * forged one is `SignerIsNotBuyer`. **None of that is re-asserted here** — it is
 * the contract's behaviour, it was measured against the real deployment, and a
 * mock that agreed with it would be this file agreeing with itself.
 *
 * What is asserted is what this class contributes:
 *
 *  1. the calldata is **built from fields**, against the vendored ABI, naming
 *     the SESSION's buyer — never forwarded, and never `withdraw`;
 *  2. a refusal the pre-flight catches costs **no transaction at all**, and
 *     comes back under the contract's own name rather than as a decode error;
 *  3. a refusal that happens after the send carries the hash that paid for it,
 *     so the two cases are distinguishable.
 */
const TESTNET = CHAIN_IDS.ROBINHOOD_TESTNET;
const OTHER = CHAIN_IDS.BASE_SEPOLIA;
const DEPLOYMENT = deployment(TESTNET);

const BUYER = '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4';
const BUYER_ACCOUNT = toAccountId(TESTNET, BUYER);
const RELAYER = '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720';

/** 65 bytes. Its contents are never inspected by this class — only its shape. */
const SIGNATURE = `0x${'ab'.repeat(64)}1b`;

/** `assay-evm/src/Errors.sol`, by selector — computed the way the chain computes them. */
const SELECTORS = {
  BadNonce: toFunctionSelector('BadNonce()'),
  SignatureExpired: toFunctionSelector('SignatureExpired()'),
  MalleableSignature: toFunctionSelector('MalleableSignature()'),
  SignerIsNotBuyer: toFunctionSelector('SignerIsNotBuyer()'),
  EscrowLimitsUnchanged: toFunctionSelector('EscrowLimitsUnchanged()'),
};

interface Harness {
  readonly submitter: EvmRelayedEscrowIntentSubmitter;
  readonly estimateGas: jest.Mock;
  readonly sendCall: jest.Mock;
  readonly sendValue: jest.Mock;
}

function build(
  options: {
    estimateGas?: jest.Mock;
    send?: Partial<EvmRelayResult>;
    call?: jest.Mock;
    sendError?: unknown;
    relayerCritical?: boolean;
    hourly?: { take: jest.Mock; settle?: jest.Mock };
    escrow?: { read: jest.Mock };
  } = {},
): Harness {
  const estimateGas = options.estimateGas ?? jest.fn().mockResolvedValue(65_638n);
  const sendCall = jest.fn(async (): Promise<EvmRelayResult> => {
    if (options.sendError) throw options.sendError;
    return {
      hash: '0x1e23e27f81ba84a1a27b0b58b3f4dc5049dd54016c734e94549f4951ecc3f6c9',
      status: 'SUCCESS',
      revertReason: null,
      gasUsed: 65_536n,
      blockNumber: 101_847n,
      ...options.send,
    };
  });
  const sendValue = jest.fn();

  const client: EvmRelayedIntentClient = {
    estimateGas: (args) => estimateGas(args) as Promise<bigint>,
    ...(options.call ? { call: options.call } : {}),
  };
  const relayer: EvmRelayerPort = {
    name: 'test-relayer',
    address: async (chainId: ChainId) => toAccountId(chainId, RELAYER),
    balanceWei: async () => 10n ** 18n,
    sendCall: sendCall as unknown as EvmRelayerPort['sendCall'],
    sendValue: sendValue as unknown as EvmRelayerPort['sendValue'],
  };

  const submitter = new EvmRelayedEscrowIntentSubmitter(
    new Map<ChainId, EvmRelayedIntentClient>([[TESTNET, client]]),
    new Map([[TESTNET, DEPLOYMENT]]),
    relayer,
    options.relayerCritical === undefined
      ? null
      : { isRelayerCritical: jest.fn().mockResolvedValue(options.relayerCritical) },
    options.hourly ? { settle: jest.fn().mockResolvedValue(undefined), ...options.hourly } : null,
    options.escrow ?? null,
  );
  return { submitter, estimateGas, sendCall, sendValue };
}

function setLimits(overrides: Partial<RelayedEscrowIntent> = {}): RelayedEscrowIntent {
  return {
    kind: EscrowIntentKind.SET_LIMITS,
    account: BUYER_ACCOUNT,
    maxVoucherAmount: 2_500_000n,
    maxPerWindow: 9_000_000n,
    nonce: 0n,
    deadline: 1_789_139_970n,
    signature: SIGNATURE,
    ...overrides,
  } as RelayedEscrowIntent;
}

function requestWithdraw(overrides: Partial<RelayedEscrowIntent> = {}): RelayedEscrowIntent {
  return {
    kind: EscrowIntentKind.REQUEST_WITHDRAW,
    account: BUYER_ACCOUNT,
    amount: 400_000_000n,
    nonce: 1n,
    deadline: 1_789_139_974n,
    signature: SIGNATURE,
    ...overrides,
  } as RelayedEscrowIntent;
}

/** A revert, shaped the way the sanctioned transport actually delivers one. */
function reverting(selector: string): jest.Mock {
  return jest
    .fn()
    .mockRejectedValue(
      new EvmRpcError('execution reverted', { code: 3, data: selector as `0x${string}` }),
    );
}

/** What `all-exceptions.filter.ts` reads off a thrown domain error. */
function caught(error: unknown): { code?: string; status?: number; message: string } {
  const candidate = error as { errorCode?: string; statusCode?: number; message: string };
  return { code: candidate.errorCode, status: candidate.statusCode, message: candidate.message };
}

describe('the calldata, built from fields', () => {
  it('encodes setLimitsBySig with the signed values and sends it to the escrow', async () => {
    const { submitter, sendCall } = build();

    const result = await submitter.submit(setLimits());

    expect(sendCall).toHaveBeenCalledTimes(1);
    const call = sendCall.mock.calls[0][0];
    expect(call.to).toBe(toAccountId(TESTNET, DEPLOYMENT.escrow));
    expect(call.chainId).toBe(TESTNET);

    // Decoded back through the ABI rather than compared to a hex string this
    // file computed the same way: a wrong ARGUMENT ORDER is the defect worth
    // catching, and a byte-for-byte comparison against `encodeFunctionData`
    // would agree with any order both sides used.
    const decoded = decodeFunctionData({ abi: ASSAY_ESCROW_ABI, data: call.data });
    expect(decoded.functionName).toBe('setLimitsBySig');
    expect(decoded.args).toEqual([
      BUYER,
      2_500_000n,
      9_000_000n,
      0n,
      1_789_139_970n,
      SIGNATURE.toLowerCase(),
    ]);

    expect(result).toEqual({
      transactionHash: '0x1e23e27f81ba84a1a27b0b58b3f4dc5049dd54016c734e94549f4951ecc3f6c9',
      blockNumber: '101847',
      gasUsed: '65536',
    });
  });

  it('encodes requestWithdrawBySig with the signed values', async () => {
    const { submitter, sendCall } = build();

    await submitter.submit(requestWithdraw());

    const decoded = decodeFunctionData({
      abi: ASSAY_ESCROW_ABI,
      data: sendCall.mock.calls[0][0].data,
    });
    expect(decoded.functionName).toBe('requestWithdrawBySig');
    expect(decoded.args).toEqual([
      BUYER,
      400_000_000n,
      1n,
      1_789_139_974n,
      SIGNATURE.toLowerCase(),
    ]);
  });

  /**
   * The one that makes this class safe to expose.
   *
   * `account` is the session's, and it is the ONLY source of the address the
   * call names. Nothing in the request can aim the relayer somewhere else — not
   * at another buyer, and not at another contract: `to` comes from the
   * deployment record and the selector from a `switch` over a kind that cannot
   * be `WITHDRAW`.
   */
  it('names the account it was given and never a buyer from anywhere else', async () => {
    const { submitter, sendCall } = build();
    const someoneElse = '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955';

    await submitter.submit(setLimits({ account: toAccountId(TESTNET, someoneElse) }));

    const decoded = decodeFunctionData({
      abi: ASSAY_ESCROW_ABI,
      data: sendCall.mock.calls[0][0].data,
    });
    expect(decoded.args?.[0]).toBe(someoneElse);
  });

  it('sends only the two *BySig selectors — never withdraw, and never redeem', async () => {
    const { submitter, sendCall } = build();

    await submitter.submit(setLimits());
    await submitter.submit(requestWithdraw());

    const selectors = sendCall.mock.calls.map(([call]) => (call.data as string).slice(0, 10));
    expect(selectors).toEqual([
      toFunctionSelector('setLimitsBySig(address,uint64,uint64,uint64,uint64,bytes)'),
      toFunctionSelector('requestWithdrawBySig(address,uint64,uint64,uint64,bytes)'),
    ]);
    // The two calldata forms `withdraw` and a redemption would take, neither of
    // which any input to this class can produce.
    expect(selectors).not.toContain(
      encodeFunctionData({ abi: ASSAY_ESCROW_ABI, functionName: 'withdraw' }),
    );
  });

  it('never uses the value path — a gas grant is not a relayed call', async () => {
    const { submitter, sendValue } = build();
    await submitter.submit(setLimits());
    expect(sendValue).not.toHaveBeenCalled();
  });
});

describe('the pre-flight: a refusal the chain would make costs no gas', () => {
  /**
   * Five refusals, each with the SAME everything except the selector the node
   * returns. That is the control the standard asks for: if one of these passed
   * because the class reports a fixed name, or because it reports whatever the
   * last branch set, the table would not be five different answers.
   */
  it.each(Object.entries(SELECTORS))(
    'reports %s under its own name, and sends nothing',
    async (name, selector) => {
      const { submitter, sendCall } = build({ estimateGas: reverting(selector) });

      const error = await submitter.submit(setLimits()).catch((e: unknown) => e);

      expect(caught(error).code).toBe('SETTLEMENT_RELAYED_INTENT_REFUSED');
      expect(caught(error).status).toBe(409);
      expect(caught(error).message).toContain(name);
      // The whole point: nothing was submitted, so nothing was paid for.
      expect(caught(error).message).toContain('nothing was submitted');
      expect(sendCall).not.toHaveBeenCalled();
    },
  );

  it('reports a selector it does not know as UNKNOWN_REVERT rather than as a success', async () => {
    const { submitter, sendCall } = build({
      // `ERC20InsufficientAllowance(address,uint256,uint256)` — the token's, not
      // this repository's. The live proof met exactly this and it must not
      // become a 500.
      estimateGas: reverting('0xfb8f41b2'),
    });

    const error = await submitter.submit(setLimits()).catch((e: unknown) => e);

    expect(caught(error).code).toBe('SETTLEMENT_RELAYED_INTENT_REFUSED');
    expect(caught(error).message).toContain('UNKNOWN_REVERT:0xfb8f41b2');
    expect(sendCall).not.toHaveBeenCalled();
  });

  /**
   * A node that is down is not a buyer who did something wrong.
   *
   * Mapping every pre-flight failure to `SETTLEMENT_RELAYED_INTENT_REFUSED`
   * would answer "the chain refused your signature" to an outage — a wrong
   * answer that reads like an actionable one, and one the buyer would act on by
   * re-signing.
   */
  it('lets a transport failure through untouched', async () => {
    const { submitter, sendCall } = build({
      estimateGas: jest.fn().mockRejectedValue(new Error('socket hang up')),
    });

    const error = await submitter.submit(setLimits()).catch((e: unknown) => e);

    expect(caught(error).code).toBeUndefined();
    expect(caught(error).message).toBe('socket hang up');
    expect(sendCall).not.toHaveBeenCalled();
  });

  it('refuses a call that estimates above the relayed-request gas ceiling', async () => {
    // Just over: `(estimate * 12) / 10 > EVM_RELAYED_INTENT_MAX_GAS`.
    const overCeiling = (EVM_RELAYED_INTENT_MAX_GAS * 10n) / 12n + 1n;
    const { submitter, sendCall } = build({
      estimateGas: jest.fn().mockResolvedValue(overCeiling),
    });

    const error = await submitter.submit(setLimits()).catch((e: unknown) => e);

    expect(caught(error).code).toBe('SETTLEMENT_RELAYED_INTENT_REFUSED');
    expect(caught(error).message).toContain(String(EVM_RELAYED_INTENT_MAX_GAS));
    expect(sendCall).not.toHaveBeenCalled();
  });

  it('passes the margined estimate as the budget, and estimates as the relayer', async () => {
    const { submitter, estimateGas, sendCall } = build({
      estimateGas: jest.fn().mockResolvedValue(65_638n),
    });

    await submitter.submit(setLimits());

    // From the RELAYER's address, because that is who will send it.
    expect(estimateGas).toHaveBeenCalledWith(
      expect.objectContaining({ account: RELAYER, to: DEPLOYMENT.escrow, value: 0n }),
    );
    expect(sendCall.mock.calls[0][0].gasLimit).toBe((65_638n * 12n) / 10n);
  });
});

describe('a revert after the send', () => {
  it('carries the transaction hash that paid for it, so the two cases differ', async () => {
    const { submitter } = build({
      send: { status: 'REVERTED', revertReason: 'BadNonce', hash: '0xdead' },
    });

    const error = await submitter.submit(setLimits()).catch((e: unknown) => e);

    expect(caught(error).code).toBe('SETTLEMENT_RELAYED_INTENT_REFUSED');
    expect(caught(error).message).toContain('BadNonce');
    expect(caught(error).message).toContain('0xdead');
    expect(caught(error).message).toContain('reverted');
    expect(caught(error).message).not.toContain('nothing was submitted');
  });

  it('never reports a reverted transaction as a submission', async () => {
    const { submitter } = build({ send: { status: 'REVERTED', revertReason: 'SignatureExpired' } });
    await expect(submitter.submit(requestWithdraw())).rejects.toBeDefined();
  });
});

describe('what is refused before any RPC call at all', () => {
  it.each([
    ['too short', `0x${'ab'.repeat(64)}`],
    ['not hex', `0x${'zz'.repeat(65)}`],
    ['unprefixed', 'ab'.repeat(65)],
    ['empty', ''],
  ])('refuses a signature that is %s', async (_case, signature) => {
    const { submitter, estimateGas, sendCall } = build();

    const error = await submitter.submit(setLimits({ signature })).catch((e: unknown) => e);

    expect(caught(error).code).toBe('SETTLEMENT_RELAYED_INTENT_MALFORMED');
    expect(caught(error).status).toBe(400);
    expect(estimateGas).not.toHaveBeenCalled();
    expect(sendCall).not.toHaveBeenCalled();
  });

  it.each([
    ['maxVoucherAmount', setLimits({ maxVoucherAmount: 2n ** 64n })],
    ['amount', requestWithdraw({ amount: 2n ** 64n })],
    ['nonce', setLimits({ nonce: 2n ** 64n })],
    ['deadline', requestWithdraw({ deadline: 2n ** 64n })],
  ])('refuses %s that does not fit a uint64, naming the field', async (field, intent) => {
    const { submitter, estimateGas } = build();

    const error = await submitter.submit(intent).catch((e: unknown) => e);

    expect(caught(error).code).toBe('SETTLEMENT_RELAYED_INTENT_MALFORMED');
    expect(caught(error).message).toContain(field);
    expect(estimateGas).not.toHaveBeenCalled();
  });

  it('refuses a chain this deployment does not serve', async () => {
    const { submitter, sendCall } = build();

    const error = await submitter
      .submit(setLimits({ account: toAccountId(OTHER, BUYER) }))
      .catch((e: unknown) => e);

    expect(caught(error).code).toBe('CHAIN_UNSUPPORTED');
    expect(sendCall).not.toHaveBeenCalled();
  });

  /**
   * CAIP-10's grammar is chain-agnostic, so a mixed-case address with a broken
   * checksum parses — and viem's non-strict `getAddress` downstream would
   * *repair* it. Here that would mean the platform paying for a call encoded for
   * an address nobody verified.
   */
  it('refuses an address whose EIP-55 checksum does not hold', async () => {
    const { submitter, sendCall } = build();
    const broken = `0x5b38Da6a701c568545dCfcB03FcB875f56beddC4`;

    const error = await submitter
      .submit(setLimits({ account: toAccountId(TESTNET, broken) }))
      .catch((e: unknown) => e);

    expect(caught(error).code).toBe('CHAIN_INVALID_ADDRESS');
    expect(sendCall).not.toHaveBeenCalled();
  });
});

describe('the L1 half of the estimate (Nitro)', () => {
  // The 2026-10-29 spike: about 952k estimated, about 845k of it L1.
  const SPIKE_TOTAL = 952_000n;
  const SPIKE_L1 = 845_000n;

  it('with an L1 part of 0, budgets exactly as before', async () => {
    const call = fakeNodeInterface({ l1Gas: 0n });
    const { submitter, sendCall } = build({ call });

    await submitter.submit(setLimits());

    expect(sendCall.mock.calls[0][0].gasLimit).toBe((65_638n * 12n) / 10n);
    expect(call.asked).toEqual([{ to: DEPLOYMENT.escrow, data: sendCall.mock.calls[0][0].data }]);
  });

  it('keeps the ceiling on execution only, and sends a limit that covers L1', async () => {
    // A total above the 300k execution ceiling, mostly L1, still under the
    // 1e-5 ETH cost cap: 400k x 1.2 at 0.02 gwei is 9.6e-6 ETH.
    const { submitter, sendCall } = build({
      estimateGas: jest.fn().mockResolvedValue(400_000n),
      call: fakeNodeInterface({ l1Gas: 300_000n }),
    });

    await submitter.submit(setLimits());

    expect(sendCall.mock.calls[0][0].gasLimit).toBe((400_000n * 12n) / 10n);
  });

  it('defers the measured 952k spike (845k of it L1) now that the cap is 1e-5 ETH', async () => {
    const { submitter, sendCall } = build({
      estimateGas: jest.fn().mockResolvedValue(SPIKE_TOTAL),
      call: fakeNodeInterface({ l1Gas: SPIKE_L1 }),
    });

    const error = await submitter.submit(setLimits()).catch((e: unknown) => e);

    expect(caught(error).status).toBe(503);
    expect(sendCall).not.toHaveBeenCalled();
  });

  it('never sends without execution gas when the L1 part reads above the whole estimate', async () => {
    // The two reads are a moment apart; an L1 part at or above the total leaves
    // the split unknown, so the whole estimate is budgeted for execution.
    const { submitter, sendCall } = build({
      estimateGas: jest.fn().mockResolvedValue(100_000n),
      call: fakeNodeInterface({ l1Gas: 120_000n }),
    });

    await submitter.submit(setLimits());

    expect(sendCall.mock.calls[0][0].gasLimit).toBe(((100_000n + 120_000n) * 12n) / 10n);
  });

  it('still refuses execution above the ceiling, whatever the L1 part', async () => {
    const execution = (EVM_RELAYED_INTENT_MAX_GAS * 10n) / 12n + 1n;
    const { submitter, sendCall } = build({
      estimateGas: jest.fn().mockResolvedValue(execution + 10_000n),
      call: fakeNodeInterface({ l1Gas: 10_000n }),
    });

    const error = await submitter.submit(setLimits()).catch((e: unknown) => e);

    expect(caught(error).code).toBe('SETTLEMENT_RELAYED_INTENT_REFUSED');
    expect(sendCall).not.toHaveBeenCalled();
  });

  it('answers a cost above the cap with a 503 to retry shortly, sending nothing', async () => {
    // 11.8M of L1 at 0.02 gwei is far above 0.00005 ETH.
    const { submitter, sendCall } = build({
      estimateGas: jest.fn().mockResolvedValue(11_900_000n),
      call: fakeNodeInterface({ l1Gas: 11_800_000n }),
    });

    const error = await submitter.submit(requestWithdraw()).catch((e: unknown) => e);

    expect(caught(error).code).toBe('SETTLEMENT_RELAYED_INTENT_UNAVAILABLE');
    expect(caught(error).status).toBe(503);
    expect(caught(error).message).toMatch(/fees are temporarily high/);
    expect(sendCall).not.toHaveBeenCalled();
  });

  it('sends right up to the cost cap', async () => {
    const atCap = EVM_RELAYED_INTENT_MAX_COST_WEI / L2_BASE_FEE; // the largest limit allowed
    const total = (atCap * 10n) / 12n;
    const { submitter, sendCall } = build({
      estimateGas: jest.fn().mockResolvedValue(total),
      call: fakeNodeInterface({ l1Gas: total - 100_000n }),
    });

    await submitter.submit(setLimits());

    expect(sendCall.mock.calls[0][0].gasLimit).toBeLessThanOrEqual(atCap);
  });

  it('falls back to L1 = 0 when NodeInterface fails: no cost cap, ceiling on the total', async () => {
    const { submitter, sendCall } = build({
      estimateGas: jest.fn().mockResolvedValue(SPIKE_TOTAL),
      call: fakeNodeInterface(new Error('method not found')),
    });

    const error = await submitter.submit(setLimits()).catch((e: unknown) => e);

    expect(caught(error).code).toBe('SETTLEMENT_RELAYED_INTENT_REFUSED');
    expect(sendCall).not.toHaveBeenCalled();
  });
});

describe('EvmRelayedEscrowIntentSubmitter, protecting the relayer float', () => {
  it('answers a 503 "try again shortly" while the relayer float is critical, before any RPC', async () => {
    const { submitter, estimateGas, sendCall } = build({ relayerCritical: true });

    const error = await submitter.submit(setLimits()).catch((e: unknown) => e);

    expect(caught(error).code).toBe('SETTLEMENT_RELAYED_INTENT_UNAVAILABLE');
    expect(caught(error).status).toBe(503);
    expect(caught(error).message).toMatch(/cannot relay requests right now.*try again shortly/);
    expect(estimateGas).not.toHaveBeenCalled();
    expect(sendCall).not.toHaveBeenCalled();
  });

  it('relays as usual when the float is not critical', async () => {
    const { submitter, sendCall } = build({ relayerCritical: false });

    await submitter.submit(setLimits());

    expect(sendCall).toHaveBeenCalledTimes(1);
  });

  it('takes the global hourly budget only after the pre-flight passed, and 503s when it is spent', async () => {
    const take = jest.fn().mockResolvedValue(null);
    const { submitter, estimateGas, sendCall } = build({ hourly: { take } });

    const error = await submitter.submit(setLimits()).catch((e: unknown) => e);

    expect(estimateGas).toHaveBeenCalled();
    expect(take).toHaveBeenCalledWith(
      TESTNET,
      expect.objectContaining({ purpose: expect.stringContaining('SET_LIMITS') }),
    );
    expect(caught(error).code).toBe('SETTLEMENT_RELAYED_INTENT_UNAVAILABLE');
    expect(sendCall).not.toHaveBeenCalled();
  });

  it('charges the budget gasLimit x basefee and settles it to gasUsed x basefee', async () => {
    const ticket = { parts: [], score: 1 };
    const take = jest.fn().mockResolvedValue(ticket);
    const settle = jest.fn().mockResolvedValue(undefined);
    const { submitter, sendCall } = build({
      hourly: { take, settle },
      call: fakeNodeInterface({ l1Gas: 0n }),
    });

    await submitter.submit(setLimits());

    const gasLimit = sendCall.mock.calls[0][0].gasLimit as bigint;
    expect(take.mock.calls[0][1].wei).toBe(gasLimit * L2_BASE_FEE);
    expect(settle).toHaveBeenCalledWith(ticket, 65_536n * L2_BASE_FEE);
  });

  it('charges the per-request cap when the basefee is unknown', async () => {
    const take = jest.fn().mockResolvedValue({ parts: [], score: 1 });
    const { submitter } = build({ hourly: { take } });

    await submitter.submit(setLimits());

    expect(take.mock.calls[0][1].wei).toBe(EVM_RELAYED_INTENT_MAX_COST_WEI);
  });

  it('hands the budget the account and its escrow on chain, read lazily (review 2026-10-30 I-3)', async () => {
    const cases: Array<[unknown, unknown]> = [
      [null, null],
      [
        { balance: { amount: '1' }, withdrawRequested: 0n },
        { balance: 1n, withdrawRequested: 0n },
      ],
      [
        { balance: { amount: '2000000' }, withdrawRequested: 5n },
        { balance: 2_000_000n, withdrawRequested: 5n },
      ],
    ];
    for (const [reading, holding] of cases) {
      const take = jest.fn().mockResolvedValue({ parts: [], score: 1 });
      const read = jest.fn().mockResolvedValue(reading);
      const { submitter } = build({ hourly: { take }, escrow: { read } });

      await submitter.submit(setLimits());

      expect(take.mock.calls[0][1].account).toBe(BUYER_ACCOUNT);
      const lazy = take.mock.calls[0][1].escrow as () => Promise<unknown>;
      // Lazy: nothing read until the budget asks.
      expect(read).not.toHaveBeenCalled();
      await expect(lazy()).resolves.toEqual(holding);
      expect(read.mock.calls[0][0]).toBe(BUYER_ACCOUNT);
    }
  });

  it('settles at the receipt gasUsed x effectiveGasPrice when the receipt carries one (M-2)', async () => {
    const ticket = { parts: [], score: 1 };
    const take = jest.fn().mockResolvedValue(ticket);
    const settle = jest.fn().mockResolvedValue(undefined);
    const { submitter, sendCall } = build({
      hourly: { take, settle },
      call: fakeNodeInterface({ l1Gas: 0n }),
    });
    sendCall.mockResolvedValueOnce({
      hash: '0x' + 'ab'.repeat(32),
      status: 'SUCCESS',
      revertReason: null,
      gasUsed: 50_000n,
      effectiveGasPrice: 7n,
      blockNumber: 1n,
    });

    await submitter.submit(setLimits());

    expect(settle).toHaveBeenCalledWith(ticket, 350_000n);
  });

  it('caps one relayed request at 1e-5 ETH', () => {
    expect(EVM_RELAYED_INTENT_MAX_COST_WEI).toBe(10_000_000_000_000n);
  });

  it('costs the hourly budget nothing when the chain refuses at the pre-flight', async () => {
    const take = jest.fn().mockResolvedValue(true);
    const { submitter } = build({
      hourly: { take },
      estimateGas: reverting('0x' + 'deadbeef'),
    });

    await submitter.submit(setLimits()).catch(() => null);

    expect(take).not.toHaveBeenCalled();
  });

  it('answers a send the node refused (not broadcast) with the same 503', async () => {
    const { submitter } = build({
      sendError: new EvmSendRejectedError('INSUFFICIENT_FUNDS', null),
    });

    const error = await submitter.submit(setLimits()).catch((e: unknown) => e);

    expect(caught(error).code).toBe('SETTLEMENT_RELAYED_INTENT_UNAVAILABLE');
  });

  it('lets any other send failure through untouched: its outcome is unknown', async () => {
    const timeout = new Error('receipt timed out');
    const { submitter } = build({ sendError: timeout });

    await expect(submitter.submit(setLimits())).rejects.toBe(timeout);
  });
});
