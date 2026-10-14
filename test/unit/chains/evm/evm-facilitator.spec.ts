import { encodeFunctionData, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { X402_ESCROW_ABI } from '@modules/chains/evm/abi/x402.abi';
import { EvmFacilitator, EvmFacilitatorClient } from '@modules/chains/evm/evm-facilitator.service';
import { X402_INVALID_REASON } from '@modules/chains/facilitator/facilitator.wire';
import { CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { PaymentPayload, PaymentRequirements } from '@modules/chains/ports/x402.types';

import { deployment, generateSigner } from './evm-fixtures';

/**
 * `EvmFacilitator` — the eip155 member behind `FACILITATOR_PORT`.
 *
 * Every transaction here is **genuinely signed** by a generated key, because
 * the one thing this class adds over `assertPayloadBoundToIntent` is recovering
 * who signed it. The binding spec uses constant `(r, s, v)` on purpose; a
 * facilitator spec that did the same could not tell "recovers the sender" from
 * "reads a field".
 */

const TESTNET = CHAIN_IDS.ROBINHOOD_TESTNET;
const DEPLOYMENT = deployment(TESTNET);
const buyer = generateSigner(TESTNET);
const stranger = generateSigner(TESTNET);

const PRICE = 25_000_000n;
const GAS = 120_000n;
const MAX_FEE = 1_000_000_000n;

async function signedDeposit(
  overrides: {
    signer?: typeof buyer;
    to?: `0x${string}`;
    credit?: `0x${string}`;
    amount?: bigint;
    chainId?: number;
    functionName?: 'depositFor' | 'requestWithdraw';
  } = {},
): Promise<`0x${string}`> {
  const account = privateKeyToAccount((overrides.signer ?? buyer).privateKey);
  const data =
    overrides.functionName === 'requestWithdraw'
      ? encodeFunctionData({ abi: X402_ESCROW_ABI, functionName: 'requestWithdraw', args: [1n] })
      : encodeFunctionData({
          abi: X402_ESCROW_ABI,
          functionName: 'depositFor',
          args: [overrides.credit ?? buyer.address, overrides.amount ?? PRICE],
        });
  return account.signTransaction({
    type: 'eip1559',
    chainId: overrides.chainId ?? 46_630,
    to: overrides.to ?? (DEPLOYMENT.escrow as `0x${string}`),
    value: 0n,
    nonce: 7,
    gas: GAS,
    maxFeePerGas: MAX_FEE,
    maxPriorityFeePerGas: 1n,
    data,
  });
}

const requirements: PaymentRequirements = {
  scheme: 'exact',
  network: TESTNET,
  amount: PRICE.toString(),
  asset: DEPLOYMENT.asset,
  // On EVM `payTo` is the buyer — `EvmChainAdapter.buildPaymentRequirements`.
  payTo: buyer.address,
  resource: 'deposit:d-1',
  maxTimeoutSeconds: 60,
  extra: { contract: DEPLOYMENT.escrow, buyer: buyer.address },
};

const payloadOf = (transaction: string, network: ChainId = TESTNET): PaymentPayload => ({
  x402Version: 2,
  scheme: 'exact',
  network,
  payload: { transaction },
});

function stubClient(overrides: Partial<EvmFacilitatorClient> = {}) {
  const client = {
    call: jest.fn().mockResolvedValue({ data: '0x' }),
    getBalance: jest.fn().mockResolvedValue(10n ** 18n),
    sendRawTransaction: jest
      .fn()
      .mockImplementation(async ({ serializedTransaction }) => keccak256(serializedTransaction)),
    getTransactionReceipt: jest.fn().mockRejectedValue(new Error('not found')),
    ...overrides,
  };
  return client as typeof client & EvmFacilitatorClient;
}

function build(client = stubClient()) {
  return {
    facilitator: new EvmFacilitator(new Map([[TESTNET, client]]), new Map([[TESTNET, DEPLOYMENT]])),
    client,
  };
}

describe('EvmFacilitator.verify', () => {
  it('accepts the buyer’s own signed depositFor, and names the recovered sender as payer', async () => {
    const { facilitator, client } = build();
    await expect(
      facilitator.verify(payloadOf(await signedDeposit()), requirements),
    ).resolves.toEqual({ isValid: true, payer: buyer.account });
    // Simulated AS the sender, against the escrow — an allowance that was never
    // approved is refused here, not after the buyer's gas is spent.
    expect(client.call).toHaveBeenCalledWith(
      expect.objectContaining({ account: buyer.address, to: DEPLOYMENT.escrow }),
    );
  });

  it('refuses a transaction signed by someone other than the buyer it credits', async () => {
    // `depositFor` pulls from msg.sender. A stranger crediting our buyer is not
    // an attack on the buyer, but it is not the buyer paying either — and the
    // ledger entry is written against the buyer as the one who paid.
    const { facilitator } = build();
    await expect(
      facilitator.verify(payloadOf(await signedDeposit({ signer: stranger })), requirements),
    ).resolves.toEqual({
      isValid: false,
      invalidReason: X402_INVALID_REASON.INVALID_EXACT_EVM_PAYLOAD_SIGNATURE,
    });
  });

  it('refuses unsigned or unparseable bytes', async () => {
    const { facilitator } = build();
    for (const transaction of ['0xdeadbeef', 'not hex']) {
      await expect(facilitator.verify(payloadOf(transaction), requirements)).resolves.toEqual({
        isValid: false,
        invalidReason: X402_INVALID_REASON.INVALID_EXACT_EVM_PAYLOAD_TRANSACTION,
      });
    }
  });

  it.each([
    ['a contract that is not this chain’s escrow', { to: DEPLOYMENT.stake as `0x${string}` }],
    ['a different chain id', { chainId: 8453 }],
    ['a call that is not depositFor', { functionName: 'requestWithdraw' as const }],
  ])('refuses %s as a transaction problem', async (_label, overrides) => {
    const { facilitator } = build();
    await expect(
      facilitator.verify(payloadOf(await signedDeposit(overrides)), requirements),
    ).resolves.toEqual({
      isValid: false,
      invalidReason: X402_INVALID_REASON.INVALID_EXACT_EVM_PAYLOAD_TRANSACTION,
    });
  });

  it('refuses a depositFor crediting anyone but the requirements’ payTo', async () => {
    const { facilitator } = build();
    await expect(
      facilitator.verify(
        payloadOf(await signedDeposit({ credit: DEPLOYMENT.escrow as `0x${string}` })),
        requirements,
      ),
    ).resolves.toEqual({
      isValid: false,
      invalidReason: X402_INVALID_REASON.INVALID_EXACT_EVM_PAYLOAD_RECIPIENT,
    });
  });

  it('refuses an underpayment, and accepts an overpayment', async () => {
    const { facilitator } = build();
    await expect(
      facilitator.verify(payloadOf(await signedDeposit({ amount: PRICE - 1n })), requirements),
    ).resolves.toEqual({
      isValid: false,
      invalidReason: X402_INVALID_REASON.INVALID_EXACT_EVM_PAYLOAD_AMOUNT,
    });
    await expect(
      facilitator.verify(payloadOf(await signedDeposit({ amount: PRICE + 1n })), requirements),
    ).resolves.toMatchObject({ isValid: true });
  });

  it('refuses a network it does not serve, and a payload/requirements network split', async () => {
    const { facilitator } = build();
    const tx = await signedDeposit();
    await expect(
      facilitator.verify(payloadOf(tx, CHAIN_IDS.BASE_SEPOLIA), requirements),
    ).resolves.toEqual({ isValid: false, invalidReason: X402_INVALID_REASON.INVALID_NETWORK });
    await expect(
      facilitator.verify(payloadOf(tx, CHAIN_IDS.BASE_SEPOLIA), {
        ...requirements,
        network: CHAIN_IDS.BASE_SEPOLIA,
      }),
    ).resolves.toEqual({ isValid: false, invalidReason: X402_INVALID_REASON.INVALID_NETWORK });
  });

  it('answers insufficient_funds when the sender cannot pay the gas it signed for', async () => {
    const { facilitator } = build(
      stubClient({ getBalance: jest.fn().mockResolvedValue(GAS * MAX_FEE - 1n) }),
    );
    await expect(
      facilitator.verify(payloadOf(await signedDeposit()), requirements),
    ).resolves.toEqual({ isValid: false, invalidReason: X402_INVALID_REASON.INSUFFICIENT_FUNDS });
  });

  it('refuses a transaction whose simulation reverts — e.g. no allowance was approved', async () => {
    const { facilitator } = build(
      stubClient({ call: jest.fn().mockRejectedValue(new Error('execution reverted')) }),
    );
    await expect(
      facilitator.verify(payloadOf(await signedDeposit()), requirements),
    ).resolves.toEqual({
      isValid: false,
      invalidReason: X402_INVALID_REASON.INVALID_EXACT_EVM_PAYLOAD_SIMULATION,
    });
  });
});

describe('EvmFacilitator.settle', () => {
  it('broadcasts the buyer’s own bytes, unchanged, and returns their hash', async () => {
    const { facilitator, client } = build();
    const tx = await signedDeposit();
    await expect(facilitator.settle(payloadOf(tx), requirements)).resolves.toEqual({
      success: true,
      network: TESTNET,
      transaction: keccak256(tx),
      payer: buyer.account,
    });
    expect(client.sendRawTransaction).toHaveBeenCalledWith({ serializedTransaction: tx });
  });

  it('re-verifies before sending, so an invalid payload is never broadcast', async () => {
    const { facilitator, client } = build();
    await expect(
      facilitator.settle(payloadOf(await signedDeposit({ signer: stranger })), requirements),
    ).resolves.toEqual({
      success: false,
      network: TESTNET,
      errorReason: X402_INVALID_REASON.INVALID_EXACT_EVM_PAYLOAD_SIGNATURE,
    });
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('treats a send the node refuses as success when the same bytes already landed', async () => {
    // A retried settle: the node answers "already known" / "nonce too low" for
    // bytes it has mined. The hash is a function of the bytes, so the receipt
    // under it is the answer — not a second transaction, and not a failure.
    const tx = await signedDeposit();
    const { facilitator } = build(
      stubClient({
        // Already mined, so the simulation now reverts — it must not decide this.
        sendRawTransaction: jest.fn().mockRejectedValue(new Error('nonce too low')),
        getTransactionReceipt: jest.fn().mockResolvedValue({ status: 'success' }),
      }),
    );
    await expect(facilitator.settle(payloadOf(tx), requirements)).resolves.toMatchObject({
      success: true,
      transaction: keccak256(tx),
    });
  });

  it('settles a retry whose deposit already landed, even though simulation now reverts', async () => {
    // After the first settle mined, the allowance is spent, so `eth_call` of
    // the same bytes reverts. The mined receipt under their hash decides.
    const tx = await signedDeposit();
    const { facilitator, client } = build(
      stubClient({
        call: jest.fn().mockRejectedValue(new Error('execution reverted')),
        getTransactionReceipt: jest.fn().mockResolvedValue({ status: 'success' }),
      }),
    );
    await expect(facilitator.settle(payloadOf(tx), requirements)).resolves.toMatchObject({
      success: true,
      transaction: keccak256(tx),
      payer: buyer.account,
    });
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('never claims a mined transaction that fails the structural checks', async () => {
    const { facilitator } = build(
      stubClient({ getTransactionReceipt: jest.fn().mockResolvedValue({ status: 'success' }) }),
    );
    await expect(
      facilitator.settle(payloadOf(await signedDeposit({ signer: stranger })), requirements),
    ).resolves.toMatchObject({
      success: false,
      errorReason: X402_INVALID_REASON.INVALID_EXACT_EVM_PAYLOAD_SIGNATURE,
    });
  });

  /** REGRESSION (review 2026-10-15 P-10): a REVERTED receipt is not a landed settlement. */
  it('does not treat a reverted receipt under the same bytes as landed', async () => {
    const tx = await signedDeposit();
    const { facilitator } = build(
      stubClient({
        sendRawTransaction: jest.fn().mockRejectedValue(new Error('nonce too low')),
        getTransactionReceipt: jest.fn().mockResolvedValue({ status: 'reverted' }),
      }),
    );
    await expect(facilitator.settle(payloadOf(tx), requirements)).resolves.toMatchObject({
      success: false,
      errorReason: X402_INVALID_REASON.UNEXPECTED_SETTLE_ERROR,
    });
  });

  it('reports a send failure with no receipt as unexpected_settle_error', async () => {
    const { facilitator } = build(
      stubClient({ sendRawTransaction: jest.fn().mockRejectedValue(new Error('boom')) }),
    );
    await expect(
      facilitator.settle(payloadOf(await signedDeposit()), requirements),
    ).resolves.toEqual({
      success: false,
      network: TESTNET,
      errorReason: X402_INVALID_REASON.UNEXPECTED_SETTLE_ERROR,
    });
  });
});

describe('EvmFacilitator identity', () => {
  it('supports `exact` on the chains it has a deployment for, and nothing else', async () => {
    const { facilitator } = build();
    await expect(facilitator.supports(TESTNET, 'exact')).resolves.toBe(true);
    await expect(facilitator.supports(TESTNET, 'upto')).resolves.toBe(false);
    await expect(facilitator.supports(CHAIN_IDS.BASE_SEPOLIA, 'exact')).resolves.toBe(false);
  });

  it('has no fee payer to name — gas comes from whoever signed', async () => {
    const { facilitator } = build();
    await expect(facilitator.getFeePayer(TESTNET)).rejects.toMatchObject({
      errorCode: 'CHAIN_FACILITATOR_UNAVAILABLE',
    });
  });
});
