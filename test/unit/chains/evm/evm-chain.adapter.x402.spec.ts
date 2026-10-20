import { encodeAbiParameters, encodeEventTopics, encodeFunctionData } from 'viem';

import { ASSAY_ESCROW_ABI } from '@modules/chains/evm/abi/assay.abi';
import {
  decodeEscrowView,
  EvmChainAdapter,
  EvmReadClient,
  EvmTransactionReceipt,
} from '@modules/chains/evm/evm-chain.adapter';
import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import {
  PaymentIntent,
  PaymentPayload,
  SettlementReceipt,
  TxRef,
} from '@modules/chains/ports/x402.types';
import { MoneyUtil } from '@shared/utils/money.util';

import { depositTransaction, deployment } from './evm-fixtures';

/**
 * The x402 half of `EvmChainAdapter` — what the shared conformance suite is
 * forbidden from naming.
 *
 * Everything here is `0x`-shaped: a `Deposited` event, a `depositFor` calldata,
 * an EIP-1559 serialization, a twelve-field `Escrow` struct. The suite in
 * `eip155-adapter.contract.spec.ts` pins the port's chain-agnostic properties
 * and cannot see any of it.
 */

const TESTNET = CHAIN_IDS.ROBINHOOD_TESTNET;
const USDG = ASSET_IDS.USDG_ROBINHOOD_TESTNET;
const DEPLOYMENT = deployment(TESTNET);

const BUYER = '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4';
const SOMEBODY_ELSE = '0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2';
const BUYER_ACCOUNT = `${TESTNET}:${BUYER}` as AccountId;
/**
 * The pooled escrow, as a CAIP-10 — what `DepositService` passes as `payTo`,
 * because it genuinely is where the tokens land on this chain.
 *
 * Used as the `payTo` of every requirements fixture below **so that `payTo` and
 * `payer` are different accounts**. They were the same value before, and while
 * they were, `expect(requirements.payTo).toBe(BUYER)` could not tell "reads
 * `payer`" from "reads `payTo`" — which is exactly the confusion that put the
 * escrow contract into `depositFor`'s buyer slot on the live deposit path.
 */
const ESCROW_ACCOUNT = `${TESTNET}:${DEPLOYMENT.escrow}` as AccountId;

const SETTLED_HASH = `0x${'ab'.repeat(32)}` as TxRef;
const UNKNOWN_HASH = `0x${'cd'.repeat(32)}` as TxRef;

/**
 * The credit and the resulting total. Deliberately different numbers: an
 * adapter reporting `balance` instead of `amount` would be indistinguishable
 * from a correct one if the buyer had started empty.
 */
const DEPOSITED_AMOUNT = 3_200n;
const RESULTING_BALANCE = 4_200n;

const usdg = (amount: string) => MoneyUtil.of(amount, USDG, 6);

/** `Deposited(buyer, funder, amount, balance)`, encoded the way a node emits it. */
function depositedLog(args: {
  buyer: string;
  funder: string;
  amount: bigint;
  balance: bigint;
  address?: string;
}) {
  return {
    address: args.address ?? DEPLOYMENT.escrow,
    topics: encodeEventTopics({
      abi: ASSAY_ESCROW_ABI,
      eventName: 'Deposited',
      args: { buyer: args.buyer as `0x${string}`, funder: args.funder as `0x${string}` },
    }) as `0x${string}`[],
    data: encodeAbiParameters(
      [
        { name: 'amount', type: 'uint64' },
        { name: 'balance', type: 'uint128' },
      ],
      [args.amount, args.balance],
    ),
  };
}

const SETTLED_RECEIPT: EvmTransactionReceipt = {
  status: 'success',
  blockNumber: 100n,
  logs: [
    // A log from a contract that is not the escrow, first, so a reader that
    // takes the first Deposited-shaped log it sees fails here.
    depositedLog({
      buyer: BUYER,
      funder: BUYER,
      amount: 999_999n,
      balance: 999_999n,
      address: '0x9999999999999999999999999999999999999999',
    }),
    depositedLog({
      buyer: BUYER,
      funder: BUYER,
      amount: DEPOSITED_AMOUNT,
      balance: RESULTING_BALANCE,
    }),
  ],
};

/** All twelve fields distinct, so reading the wrong NAME returns a wrong number. */
const ESCROW_REPLY = {
  balance: 1_234n,
  seqHigh: 7n,
  authNonce: 8n,
  maxVoucherAmount: 20n,
  maxPerWindow: 21n,
  spentInWindow: 22n,
  windowStartedAt: 23n,
  withdrawRequested: 24n,
  withdrawAvailableAt: 25n,
  totalRedeemed: 26n,
  totalWithdrawn: 27n,
  totalFunded: 9_999n,
};

interface Stub {
  readonly client: EvmReadClient;
  readonly finalizedBlock: { number: bigint | null };
  readonly latestBlock: { number: bigint };
}

function stubClient(
  overrides: { receipt?: EvmTransactionReceipt | null; escrow?: unknown } = {},
): Stub {
  const finalizedBlock = { number: 100n as bigint | null };
  const latestBlock = { number: 100n };
  const client: EvmReadClient = {
    getTransactionReceipt: async ({ hash }) =>
      hash === (SETTLED_HASH as string)
        ? (overrides.receipt ?? SETTLED_RECEIPT)
        : Promise.reject(new Error('TransactionReceiptNotFoundError')),
    getBlock: async () => finalizedBlock,
    getBlockNumber: async () => latestBlock.number,
    readContract: async () => overrides.escrow ?? ESCROW_REPLY,
  };
  return { client, finalizedBlock, latestBlock };
}

function buildAdapter(overrides?: Parameters<typeof stubClient>[0]): {
  adapter: EvmChainAdapter;
  stub: Stub;
} {
  const stub = stubClient(overrides);
  return {
    adapter: new EvmChainAdapter(
      new Map([[TESTNET, stub.client]]),
      new Map([[TESTNET, DEPLOYMENT]]),
      [TESTNET],
    ),
    stub,
  };
}

/**
 * Shaped exactly as `DepositService.toChainIntent` shapes it: `payTo` is the
 * mirror row's `escrowAccountId`, which on this chain is the pooled contract,
 * and `payer` is the buyer. This fixture used to set `payTo: BUYER_ACCOUNT` —
 * a value production never passes — and while it did, every binding and
 * observation test below passed against an adapter that refused every real
 * deposit with "transaction credits a different buyer".
 */
const intent: PaymentIntent = {
  id: 'pi_01J8XZQ4M0000000000000',
  resource: 'https://api.platform.io/tools/search_web',
  amount: usdg('10000'),
  payTo: ESCROW_ACCOUNT,
  payer: BUYER_ACCOUNT,
  chainId: TESTNET,
  expiresAt: new Date('2026-09-09T00:01:00.000Z'),
};

const payloadOf = (transaction: `0x${string}`): PaymentPayload => ({
  x402Version: 2,
  scheme: 'exact',
  network: TESTNET,
  payload: { transaction },
});

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { errorCode?: string }).errorCode;
  }
  return undefined;
};

describe('EvmChainAdapter payment requirements', () => {
  it('never advertises the pooled escrow contract as the address to pay', async () => {
    // Measured on chain as `test_donationsDoNotBecomeAnybodysBalance`:
    // one contract holds every buyer, so a bare transfer to it has no sender
    // attribution the contract can see and the money is gone. A frontend that
    // renders `payTo` as a send-to target must therefore never receive it.
    const { adapter } = buildAdapter();

    const requirements = await adapter.buildPaymentRequirements({
      chainId: TESTNET,
      intentId: intent.id,
      resource: intent.resource,
      amount: intent.amount,
      payTo: ESCROW_ACCOUNT,
      payer: BUYER_ACCOUNT,
      feePayer: `${TESTNET}:${SOMEBODY_ELSE}` as AccountId,
    });

    expect(requirements.payTo).toBe(BUYER);
    expect(requirements.payTo).not.toBe(DEPLOYMENT.escrow);
    expect(requirements.network).toBe(TESTNET);
    expect(requirements.asset).toBe('0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac');
    expect(requirements.amount).toBe('10000');
    expect(requirements.maxTimeoutSeconds).toBeGreaterThan(0);
  });

  it('names the call that does credit the buyer, and says the plain transfer does not', async () => {
    const { adapter } = buildAdapter();

    const requirements = await adapter.buildPaymentRequirements({
      chainId: TESTNET,
      intentId: intent.id,
      resource: intent.resource,
      amount: intent.amount,
      payTo: ESCROW_ACCOUNT,
      payer: BUYER_ACCOUNT,
      feePayer: `${TESTNET}:${SOMEBODY_ELSE}` as AccountId,
    });

    expect(requirements.extra).toEqual({
      paymentFlow: 'contract-call',
      method: 'depositFor(address,uint64)',
      contract: DEPLOYMENT.escrow,
      spender: DEPLOYMENT.escrow,
      buyer: BUYER,
      plainTransferCreditsNobody: true,
    });
  });

  it('refuses an asset that is not on the requested chain', async () => {
    const { adapter } = buildAdapter();
    await expect(
      adapter.buildPaymentRequirements({
        chainId: TESTNET,
        intentId: intent.id,
        resource: intent.resource,
        amount: MoneyUtil.of('10000', ASSET_IDS.USDC_SOLANA_MAINNET, 6),
        payTo: ESCROW_ACCOUNT,
        payer: BUYER_ACCOUNT,
        feePayer: `${TESTNET}:${SOMEBODY_ELSE}` as AccountId,
      }),
    ).rejects.toMatchObject({ errorCode: ChainErrorCode.CHAIN_ASSET_NOT_ON_CHAIN });
  });

  it('refuses to credit the escrow contract itself', async () => {
    // The donation loss, reached through the front door: a
    // `depositFor` naming the escrow as the buyer credits an address no key
    // controls, and unlike a stray `transfer` it would look like a correct
    // deposit all the way to the chain.
    const { adapter } = buildAdapter();
    await expect(
      adapter.buildPaymentRequirements({
        chainId: TESTNET,
        intentId: intent.id,
        resource: intent.resource,
        amount: intent.amount,
        payTo: ESCROW_ACCOUNT,
        payer: ESCROW_ACCOUNT,
        feePayer: `${TESTNET}:${SOMEBODY_ELSE}` as AccountId,
      }),
    ).rejects.toMatchObject({ errorCode: ChainErrorCode.CHAIN_INVALID_ADDRESS });
  });

  it('follows `payer` and not `payTo` — they are different accounts on this chain', async () => {
    // The two fields disagree here on purpose, and the disagreement IS the
    // deposit path: `DepositService` passes the pooled escrow as the
    // destination and the buyer as the account to credit. An adapter reading
    // `payTo` — which is what it did — answers with the escrow in both slots.
    const { adapter } = buildAdapter();

    const requirements = await adapter.buildPaymentRequirements({
      chainId: TESTNET,
      intentId: intent.id,
      resource: intent.resource,
      amount: intent.amount,
      payTo: ESCROW_ACCOUNT,
      payer: `${TESTNET}:${SOMEBODY_ELSE}` as AccountId,
      feePayer: `${TESTNET}:${BUYER}` as AccountId,
    });

    expect(requirements.payTo).toBe(SOMEBODY_ELSE);
    expect((requirements.extra as { buyer: string }).buyer).toBe(SOMEBODY_ELSE);
    expect(requirements.payTo).not.toBe(DEPLOYMENT.escrow);
    expect(requirements.payTo).not.toBe(BUYER);
  });
});

describe('EvmChainAdapter payload binding', () => {
  it('accepts a transaction that calls depositFor for this buyer, for at least the price', () => {
    const { adapter } = buildAdapter();
    expect(
      adapter.assertPayloadBoundToIntent(payloadOf(depositTransaction()), intent),
    ).toBeUndefined();
  });

  it('accepts an overpayment, because `exact` tolerates one on both chains', () => {
    const { adapter } = buildAdapter();
    expect(
      adapter.assertPayloadBoundToIntent(
        payloadOf(depositTransaction({ amount: 10_007n })),
        intent,
      ),
    ).toBeUndefined();
  });

  it('refuses a transaction that credits a different buyer', () => {
    // The binding, stated as the attack: the buyer whose escrow is credited is
    // inside the bytes the payer signed, so a payload for somebody else's
    // deposit cannot be presented as payment for this intent.
    const { adapter } = buildAdapter();
    expect(
      codeOf(() =>
        adapter.assertPayloadBoundToIntent(
          payloadOf(depositTransaction({ buyer: SOMEBODY_ELSE })),
          intent,
        ),
      ),
    ).toBe(ChainErrorCode.CHAIN_PAYLOAD_NOT_BOUND_TO_INTENT);
  });

  it('binds to `payer`, never to `payTo` — a depositFor crediting the escrow itself is refused', () => {
    // The direction that loses money. An adapter reading `payTo` would ACCEPT
    // this payload, because `payTo` is the escrow here — and `depositFor(<the
    // escrow contract>, amount)` credits an address no key controls.
    const { adapter } = buildAdapter();
    expect(
      codeOf(() =>
        adapter.assertPayloadBoundToIntent(
          payloadOf(depositTransaction({ buyer: DEPLOYMENT.escrow })),
          intent,
        ),
      ),
    ).toBe(ChainErrorCode.CHAIN_PAYLOAD_NOT_BOUND_TO_INTENT);
  });

  it('refuses a transaction that deposits less than the intent requires', () => {
    const { adapter } = buildAdapter();
    expect(
      codeOf(() =>
        adapter.assertPayloadBoundToIntent(
          payloadOf(depositTransaction({ amount: 9_999n })),
          intent,
        ),
      ),
    ).toBe(ChainErrorCode.CHAIN_PAYLOAD_NOT_BOUND_TO_INTENT);
  });

  it('refuses a transaction aimed at a contract that is not this chain’s escrow', () => {
    const { adapter } = buildAdapter();
    expect(
      codeOf(() =>
        adapter.assertPayloadBoundToIntent(
          payloadOf(depositTransaction({ to: '0xdEAD000000000000000042069420694206942069' })),
          intent,
        ),
      ),
    ).toBe(ChainErrorCode.CHAIN_PAYLOAD_NOT_BOUND_TO_INTENT);
  });

  it('refuses a transaction that calls the escrow but not depositFor', () => {
    // `withdraw()` is on the same contract and is signed by the same buyer, so
    // "calls our escrow" is not the binding — which function it calls is.
    const { adapter } = buildAdapter();
    const data = encodeFunctionData({ abi: ASSAY_ESCROW_ABI, functionName: 'withdraw' });
    expect(
      codeOf(() =>
        adapter.assertPayloadBoundToIntent(payloadOf(depositTransaction({ data })), intent),
      ),
    ).toBe(ChainErrorCode.CHAIN_PAYLOAD_NOT_BOUND_TO_INTENT);
  });

  it('refuses a transaction built for a different EVM chain', () => {
    // The same key controls the same address on every EVM chain, so without the
    // chain id inside the signed bytes a deposit on Base is a deposit here.
    const { adapter } = buildAdapter();
    expect(
      codeOf(() =>
        adapter.assertPayloadBoundToIntent(
          payloadOf(depositTransaction({ chainId: 8_453 })),
          intent,
        ),
      ),
    ).toBe(ChainErrorCode.CHAIN_PAYLOAD_NOT_BOUND_TO_INTENT);
  });

  it('refuses a payload whose network is not the intent’s chain', () => {
    const { adapter } = buildAdapter();
    expect(
      codeOf(() =>
        adapter.assertPayloadBoundToIntent(payloadOf(depositTransaction()), {
          ...intent,
          chainId: CHAIN_IDS.BASE_SEPOLIA,
        }),
      ),
    ).toBe(ChainErrorCode.CHAIN_PAYLOAD_NOT_BOUND_TO_INTENT);
  });

  it.each([
    ['not hex at all', 'deadbeef'],
    ['hex that is not a transaction', '0xdeadbeef'],
    ['nothing at all', undefined],
  ])('answers CHAIN_PAYLOAD_MALFORMED for %s', (_label, transaction) => {
    const { adapter } = buildAdapter();
    const payload: PaymentPayload = {
      x402Version: 2,
      scheme: 'exact',
      network: TESTNET,
      payload: transaction === undefined ? {} : { transaction },
    };
    expect(codeOf(() => adapter.assertPayloadBoundToIntent(payload, intent))).toBe(
      ChainErrorCode.CHAIN_PAYLOAD_MALFORMED,
    );
  });
});

describe('EvmChainAdapter settled amount', () => {
  const receiptOf = (observed: SettlementReceipt['observed']): SettlementReceipt => ({
    transaction: SETTLED_HASH,
    network: TESTNET,
    payer: BUYER_ACCOUNT,
    observed,
  });

  it('credits what landed, not what was asked for', () => {
    const { adapter } = buildAdapter();
    const settled = adapter.extractSettledAmount(
      intent,
      receiptOf({ amount: '10007', asset: USDG, decimals: 6 }),
    );
    expect(settled.amount).toBe('10007');
    expect(settled.amount).not.toBe(intent.amount.amount);
  });

  it('refuses an underpayment', () => {
    const { adapter } = buildAdapter();
    expect(
      codeOf(() =>
        adapter.extractSettledAmount(
          intent,
          receiptOf({ amount: '9999', asset: USDG, decimals: 6 }),
        ),
      ),
    ).toBe(ChainErrorCode.CHAIN_SETTLED_AMOUNT_BELOW_INTENT);
  });

  it('refuses a settlement in another asset', () => {
    const { adapter } = buildAdapter();
    expect(
      codeOf(() =>
        adapter.extractSettledAmount(
          intent,
          receiptOf({ amount: '10000', asset: ASSET_IDS.USDC_SOLANA_MAINNET, decimals: 6 }),
        ),
      ),
    ).toBe(ChainErrorCode.CHAIN_SETTLED_ASSET_MISMATCH);
  });
});

describe('EvmChainAdapter extractSettledAmount refuses a receipt from the wrong chain', () => {
  /**
   * An adapter serving **two** EVM chains, so a cross-chain receipt is a
   * genuine mismatch between chains it serves rather than an unserved chain
   * wearing a second hat — which `assertServes` would refuse first, making the
   * network comparison untestable.
   */
  const OTHER = CHAIN_IDS.BASE_SEPOLIA;
  const twoChainAdapter = new EvmChainAdapter(
    new Map([[TESTNET, stubClient().client]]),
    new Map([
      [TESTNET, DEPLOYMENT],
      [OTHER, deployment(OTHER)],
    ]),
    [TESTNET, OTHER],
  );

  const receipt = (network: (typeof CHAIN_IDS)[keyof typeof CHAIN_IDS]): SettlementReceipt => ({
    transaction: SETTLED_HASH,
    network,
    payer: BUYER_ACCOUNT,
    observed: { amount: '10000', asset: USDG, decimals: 6 },
  });

  it('refuses an intent on a chain this adapter does not serve', () => {
    // Intent AND receipt name the same unserved chain, so the only thing wrong
    // with the pair is that it is unserved.
    expect(
      codeOf(() =>
        twoChainAdapter.extractSettledAmount(
          { ...intent, chainId: CHAIN_IDS.BASE_MAINNET },
          receipt(CHAIN_IDS.BASE_MAINNET),
        ),
      ),
    ).toBe(ChainErrorCode.CHAIN_NAMESPACE_MISMATCH);
  });

  it('refuses a receipt whose network is not the intent chain', () => {
    // Both chains served, and the asset comparison CANNOT stand in for this on
    // EVM: the same ERC-20 address is deployable on every chain, so a receipt
    // from Base carrying the identical asset reference passes it.
    expect(codeOf(() => twoChainAdapter.extractSettledAmount(intent, receipt(OTHER)))).toBe(
      ChainErrorCode.CHAIN_SETTLED_NETWORK_MISMATCH,
    );
  });

  it('still settles a receipt on the intent chain', () => {
    // The control. Both guards above are satisfiable by an unconditional throw
    // without it.
    expect(twoChainAdapter.extractSettledAmount(intent, receipt(TESTNET)).amount).toBe('10000');
  });
});

describe('EvmChainAdapter observeTransfer', () => {
  it('reports the credit the contract wrote, not the balance it left behind', async () => {
    const { adapter } = buildAdapter();
    await expect(adapter.observeTransfer(intent, SETTLED_HASH)).resolves.toEqual({
      amount: DEPOSITED_AMOUNT.toString(),
      asset: USDG,
      decimals: 6,
    });
  });

  it('reads `buyer` by NAME, so a log crediting the funder instead is not this buyer’s', async () => {
    // `buyer` and `funder` are adjacent `address` fields: swapping them changes
    // no selector, no topic count and no encoded width. This is the same blind
    // spot the ABI return-shape pin had before it pinned names as well as
    // types, one struct over.
    const { adapter } = buildAdapter({
      receipt: {
        status: 'success',
        blockNumber: 100n,
        logs: [
          depositedLog({
            buyer: SOMEBODY_ELSE,
            funder: BUYER,
            amount: DEPOSITED_AMOUNT,
            balance: RESULTING_BALANCE,
          }),
        ],
      },
    });

    await expect(adapter.observeTransfer(intent, SETTLED_HASH)).resolves.toBeNull();
  });

  it('matches the event against `payer`, never against `payTo`', async () => {
    // `payTo` is the pooled contract on this chain. Matching it would find no
    // real deposit at all — and the finality sweep reads a `null` here as
    // "dropped by a reorg" and writes DEPOSIT_REJECT.
    const { adapter } = buildAdapter({
      receipt: {
        status: 'success',
        blockNumber: 100n,
        logs: [
          depositedLog({
            buyer: DEPLOYMENT.escrow,
            funder: BUYER,
            amount: DEPOSITED_AMOUNT,
            balance: RESULTING_BALANCE,
          }),
        ],
      },
    });

    await expect(adapter.observeTransfer(intent, SETTLED_HASH)).resolves.toBeNull();
  });

  it('ignores a Deposited event emitted by a contract that is not our escrow', async () => {
    const { adapter } = buildAdapter({
      receipt: {
        status: 'success',
        blockNumber: 100n,
        logs: [
          depositedLog({
            buyer: BUYER,
            funder: BUYER,
            amount: 500n,
            balance: 500n,
            address: '0x9999999999999999999999999999999999999999',
          }),
        ],
      },
    });

    await expect(adapter.observeTransfer(intent, SETTLED_HASH)).resolves.toBeNull();
  });

  it('returns null for a hash the chain cannot find', async () => {
    const { adapter } = buildAdapter();
    await expect(adapter.observeTransfer(intent, UNKNOWN_HASH)).resolves.toBeNull();
  });

  it('returns null for a reference that is not a 32-byte hash', async () => {
    const { adapter } = buildAdapter();
    await expect(adapter.observeTransfer(intent, 'not-a-hash' as TxRef)).resolves.toBeNull();
  });

  it('returns null for a transaction that reverted', async () => {
    const { adapter } = buildAdapter({
      receipt: { ...SETTLED_RECEIPT, status: 'reverted' },
    });
    await expect(adapter.observeTransfer(intent, SETTLED_HASH)).resolves.toBeNull();
  });

  it('withholds a confirmed transfer until the finalized head has reached it', async () => {
    const { adapter, stub } = buildAdapter();

    // The control: at the default commitment the same transaction IS observed,
    // so "returns null" below is about finality and not about the fixture.
    await expect(adapter.observeTransfer(intent, SETTLED_HASH)).resolves.not.toBeNull();

    stub.finalizedBlock.number = 99n;
    await expect(
      adapter.observeTransfer(intent, SETTLED_HASH, { commitment: 'finalized' }),
    ).resolves.toBeNull();

    stub.finalizedBlock.number = 100n;
    await expect(
      adapter.observeTransfer(intent, SETTLED_HASH, { commitment: 'finalized' }),
    ).resolves.not.toBeNull();
  });
});

describe('EvmChainAdapter deposit confirmations (EVM_DEPOSIT_CONFIRMATIONS)', () => {
  const withConfirmations = (count: number) => {
    const stub = stubClient();
    stub.finalizedBlock.number = 0n; // far behind: never what decides here
    const adapter = new EvmChainAdapter(
      new Map([[TESTNET, stub.client]]),
      new Map([[TESTNET, DEPLOYMENT]]),
      [TESTNET],
      count,
    );
    return { adapter, stub };
  };

  it('0: credited at the soft confirmation, without waiting for the finalized head', async () => {
    const { adapter } = withConfirmations(0);
    await expect(
      adapter.observeTransfer(intent, SETTLED_HASH, { commitment: 'finalized' }),
    ).resolves.not.toBeNull();
  });

  it('N: withheld until N blocks sit on top of the transaction', async () => {
    const { adapter, stub } = withConfirmations(3);
    stub.latestBlock.number = SETTLED_RECEIPT.blockNumber + 2n;
    await expect(
      adapter.observeTransfer(intent, SETTLED_HASH, { commitment: 'finalized' }),
    ).resolves.toBeNull();
    stub.latestBlock.number = SETTLED_RECEIPT.blockNumber + 3n;
    await expect(
      adapter.observeTransfer(intent, SETTLED_HASH, { commitment: 'finalized' }),
    ).resolves.not.toBeNull();
  });

  it('a reverted deposit is never credited, however early', async () => {
    const stub = stubClient({ receipt: { ...SETTLED_RECEIPT, status: 'reverted' } });
    const adapter = new EvmChainAdapter(
      new Map([[TESTNET, stub.client]]),
      new Map([[TESTNET, DEPLOYMENT]]),
      [TESTNET],
      0,
    );
    await expect(
      adapter.observeTransfer(intent, SETTLED_HASH, { commitment: 'finalized' }),
    ).resolves.toBeNull();
  });
});

describe('EvmChainAdapter vault balance', () => {
  it('reads the `balance` field by name out of the twelve-field struct', async () => {
    // Every field of `ESCROW_REPLY` is distinct, so an implementation reading
    // any other name — or any position — answers a different number.
    const { adapter } = buildAdapter();
    const balance = await adapter.getVaultBalance(BUYER_ACCOUNT, USDG);

    expect(balance.amount).toBe('1234');
    expect(balance.amount).not.toBe(ESCROW_REPLY.totalFunded.toString());
    expect(balance.asset).toBe(USDG);
    expect(balance.decimals).toBe(6);
  });

  it('refuses an asset that is not this deployment’s settlement token', async () => {
    // `Config` fixes exactly one token, so reading a balance for another asset
    // would answer with the wrong token's number rather than with nothing.
    const other = `${TESTNET}/erc20:0x1111111111111111111111111111111111111111` as never;
    const { adapter } = buildAdapter();
    await expect(adapter.getVaultBalance(BUYER_ACCOUNT, other)).rejects.toMatchObject({
      errorCode: ChainErrorCode.CHAIN_ASSET_NOT_ON_CHAIN,
    });
  });

  it('refuses a struct whose field names are not the deployed layout', async () => {
    const { seqHigh, ...missingOneField } = ESCROW_REPLY;
    void seqHigh;
    const { adapter } = buildAdapter({ escrow: missingOneField });
    await expect(adapter.getVaultBalance(BUYER_ACCOUNT, USDG)).rejects.toMatchObject({
      errorCode: ChainErrorCode.CHAIN_ACCOUNT_LAYOUT_UNEXPECTED,
    });
  });
});

describe('decodeEscrowView', () => {
  it('accepts exactly the twelve names the deployed struct declares', () => {
    expect(decodeEscrowView(ESCROW_REPLY).balance).toBe(1_234n);
  });

  /**
   * Exactly TWELVE keys, one of them spelled differently.
   *
   * The obvious fixture — `{ ...ESCROW_REPLY, seqHigh: undefined, seq_high: 7n }`
   * — is wrong in two ways at once (thirteen keys AND an `undefined` where a
   * `bigint` belongs), so it is refused by the count check and by the type
   * check and says nothing about whether the NAMES are read. Measured: with the
   * name comparison deleted, that fixture still passed. This one violates one
   * thing.
   */
  const RENAMED_ONE_FIELD = (() => {
    const { seqHigh, ...rest } = ESCROW_REPLY;
    return { ...rest, seq_high: seqHigh };
  })();

  it.each([
    ['a positional tuple', Object.values(ESCROW_REPLY)],
    ['an extra field', { ...ESCROW_REPLY, exposed: 1n }],
    ['a renamed field, with the field count unchanged', RENAMED_ONE_FIELD],
    ['a string where a bigint belongs', { ...ESCROW_REPLY, balance: '1234' }],
    ['nothing at all', null],
  ])('refuses %s', (_label, value) => {
    expect(() => decodeEscrowView(value)).toThrow(/layout/i);
  });

  it('the renamed fixture is wrong in exactly one way', () => {
    // Non-vacuity for the case above: same twelve fields, same twelve values,
    // one name different. Anything else and the case passes for the wrong
    // reason and survives deleting the name check.
    expect(Object.keys(RENAMED_ONE_FIELD)).toHaveLength(12);
    expect(Object.values(RENAMED_ONE_FIELD).every((v) => typeof v === 'bigint')).toBe(true);
    expect(Object.values(RENAMED_ONE_FIELD).sort()).toEqual(Object.values(ESCROW_REPLY).sort());
  });
});
