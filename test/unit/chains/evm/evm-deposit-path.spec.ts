import { EvmDepositRequirementsBuilder } from '@modules/chains/evm/evm-deposit-requirements-builder.service';
import {
  EvmEscrowBalanceReader,
  EvmReaderClient,
} from '@modules/chains/evm/evm-escrow-balance-reader.service';
import { EvmEscrowOpener } from '@modules/chains/evm/evm-escrow-opener.service';
import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import {
  AccountId,
  AssetId,
  CHAIN_IDS,
  ChainId,
  toAssetId,
} from '@modules/chains/ports/caip.types';
import { PaymentRequirements } from '@modules/chains/ports/x402.types';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';

import { expectErrorCodeAsync } from '../../helpers/expect-error-code';
import { deployment } from './evm-fixtures';

/**
 * The two `eip155` halves of the deposit path, each of which had no member at
 * all until a buyer on `eip155:46630` turned out to be unable to deposit.
 *
 * ## Two chains in every fixture, with different values
 *
 * `ROBINHOOD_TESTNET` and `BASE_SEPOLIA` carry **different escrow addresses**
 * and **different token addresses** in `evm-fixtures.ts`. Nothing below asserts
 * a single chain's answer: an implementation that returned the first
 * deployment, or a constant, answers one row and fails the other. That is the
 * shape of the defect this file ships with — a table keyed by chain that nobody
 * extended, invisible because every fixture used the first chain.
 */

const TESTNET = CHAIN_IDS.ROBINHOOD_TESTNET;
const BASE = CHAIN_IDS.BASE_SEPOLIA;

const TESTNET_DEPLOYMENT = deployment(TESTNET);
const BASE_DEPLOYMENT = deployment(BASE);

const BUYER = '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4';
const OTHER_BUYER = '0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2';

/** Exactly the asset each deployment declares, in CAIP-19. */
const TESTNET_ASSET = ASSET_IDS.USDG_ROBINHOOD_TESTNET;
const BASE_ASSET = toAssetId(BASE, 'erc20', BASE_DEPLOYMENT.asset);

const CHAINS: readonly {
  chainId: ChainId;
  escrow: string;
  asset: AssetId;
  buyer: string;
}[] = [
  { chainId: TESTNET, escrow: TESTNET_DEPLOYMENT.escrow, asset: TESTNET_ASSET, buyer: BUYER },
  { chainId: BASE, escrow: BASE_DEPLOYMENT.escrow, asset: BASE_ASSET, buyer: OTHER_BUYER },
];

function account(chainId: ChainId, address: string): AccountId {
  return `${chainId}:${address}` as AccountId;
}

/**
 * The opener under test, over BOTH chains at once.
 *
 * One instance serving two deployments, deliberately: an opener that closed
 * over a single escrow address would be indistinguishable from a correct one if
 * the harness built a new instance per chain.
 */
function opener(): EvmEscrowOpener {
  const reader = new EvmEscrowBalanceReader(
    // `escrowAddresses` performs no read at all — it is a lookup and a
    // normalisation. A client that throws on any call is the assertion that it
    // stays that way: an opener doing an RPC round trip on every deposit would
    // turn a lookup into a dependency on a node being up.
    new Map<ChainId, EvmReaderClient>([
      [TESTNET, throwingClient()],
      [BASE, throwingClient()],
    ]),
    new Map([
      [TESTNET, TESTNET_DEPLOYMENT],
      [BASE, BASE_DEPLOYMENT],
    ]),
  );
  return new EvmEscrowOpener(reader);
}

function throwingClient(): EvmReaderClient {
  return {
    readContract: async () => {
      throw new Error('the deposit path must not read the chain to answer this');
    },
    multicall: async () => {
      throw new Error('the deposit path must not read the chain to answer this');
    },
  };
}

describe('EvmEscrowOpener', () => {
  it.each(CHAINS)(
    'answers $chainId with that chain’s own escrow, and sends nothing',
    async ({ chainId, escrow, asset, buyer }) => {
      const opened = await opener().open(account(chainId, buyer), asset);

      expect(opened.escrowPda).toBe(account(chainId, escrow));
      expect(opened.escrowTokenAccount).toBe(account(chainId, escrow));
      // `null`, not a fabricated hash: nothing was opened, because there is
      // nothing to open. `buyer_escrows.opened_tx_ref` is nullable for exactly
      // this, and a made-up signature would be a claim a reconciler could chase.
      expect(opened.signature).toBeNull();
    },
  );

  it('gives the two chains DIFFERENT escrows', async () => {
    const [first, second] = await Promise.all(
      CHAINS.map((row) => opener().open(account(row.chainId, row.buyer), row.asset)),
    );

    expect(first.escrowPda).not.toBe(second.escrowPda);
    expect(TESTNET_DEPLOYMENT.escrow).not.toBe(BASE_DEPLOYMENT.escrow);
  });

  it('never hands a buyer the OTHER chain’s escrow, even for the same address', async () => {
    // Same buyer address, two chains. An opener keyed on the address rather
    // than the chain — or one that ignored the chain entirely — passes every
    // test above and fails this one.
    const onTestnet = await opener().open(account(TESTNET, BUYER), TESTNET_ASSET);
    const onBase = await opener().open(account(BASE, BUYER), BASE_ASSET);

    expect(onTestnet.escrowPda).toBe(account(TESTNET, TESTNET_DEPLOYMENT.escrow));
    expect(onBase.escrowPda).toBe(account(BASE, BASE_DEPLOYMENT.escrow));
  });

  it.each(CHAINS)('refuses an asset that is not $chainId’s own', async ({ chainId, buyer }) => {
    // Cross-chain, both directions: the testnet row is offered Base's token and
    // the Base row is offered testnet's USDG.
    const foreign = chainId === TESTNET ? BASE_ASSET : TESTNET_ASSET;

    await expectErrorCodeAsync(
      () => opener().open(account(chainId, buyer), foreign),
      ChainErrorCode.CHAIN_ASSET_NOT_ON_CHAIN,
    );
  });

  it('refuses a chain it has no deployment for', async () => {
    await expectErrorCodeAsync(
      () => opener().open(account(CHAIN_IDS.BASE_MAINNET, BUYER), TESTNET_ASSET),
      ChainErrorCode.CHAIN_UNSUPPORTED,
    );
  });

  it('refuses a buyer address that is not an address', async () => {
    await expectErrorCodeAsync(
      () => opener().open(account(TESTNET, '0xnot-an-address'), TESTNET_ASSET),
      ChainErrorCode.CHAIN_INVALID_ADDRESS,
    );
  });
});

/** The `402` the EVM adapter builds, as this builder receives it. */
function requirements(row: (typeof CHAINS)[number], amount = '5000000'): PaymentRequirements {
  return {
    scheme: 'exact-evm',
    network: row.chainId,
    amount,
    asset: row.asset.split('erc20:')[1],
    payTo: row.buyer,
    resource: 'assay:deposit:11111111-1111-1111-1111-111111111111',
    maxTimeoutSeconds: 120,
    extra: {
      paymentFlow: 'contract-call',
      method: 'depositFor(address,uint64)',
      contract: row.escrow,
      spender: row.escrow,
      buyer: row.buyer,
      plainTransferCreditsNobody: true,
    },
  };
}

describe('EvmDepositRequirementsBuilder', () => {
  const builder = new EvmDepositRequirementsBuilder();

  it.each(CHAINS)('describes a CONTRACT CALL on $chainId, with no destination', async (row) => {
    const built = await builder.build({
      chainId: row.chainId,
      requirements: requirements(row),
      decimals: 6,
    });

    expect(built).toEqual({
      namespace: 'eip155',
      chainId: row.chainId,
      contract: row.escrow,
      method: 'depositFor(address,uint64)',
      spender: row.escrow,
      buyer: row.buyer,
      asset: row.asset.split('erc20:')[1],
      amount: '5000000',
      decimals: 6,
      plainTransferCreditsNobody: true,
    });

    // `toEqual` above already forbids extra keys, and this says why.
    // A `payTo` on an EVM deposit is an address a UI renders as "send here",
    // and tokens sent to the escrow contract that way credit nobody.
    expect(built).not.toHaveProperty('payTo');
    expect(built).not.toHaveProperty('feePayer');
    expect(built).not.toHaveProperty('memo');
    expect(built).not.toHaveProperty('blockhash');
  });

  it('gives the two chains different contracts, tokens and amounts', async () => {
    const [first, second] = await Promise.all([
      builder.build({
        chainId: CHAINS[0].chainId,
        requirements: requirements(CHAINS[0], '1000000'),
        decimals: 6,
      }),
      builder.build({
        chainId: CHAINS[1].chainId,
        requirements: requirements(CHAINS[1], '2500000'),
        decimals: 2,
      }),
    ]);

    expect(first.chainId).not.toBe(second.chainId);
    expect(first.contract).not.toBe(second.contract);
    expect(first.asset).not.toBe(second.asset);
    expect(first.buyer).not.toBe(second.buyer);
    expect([first.amount, second.amount]).toEqual(['1000000', '2500000']);
    // Different scales, so "always 6" — the value every chain happens to use
    // today — is not what is being read.
    expect([first.decimals, second.decimals]).toEqual([6, 2]);
  });

  it.each(['contract', 'spender', 'buyer'])(
    'refuses a `402` whose extra.%s is missing, rather than shipping "undefined"',
    async (field) => {
      const row = CHAINS[0];
      const broken = requirements(row);
      const extra = { ...(broken.extra as Record<string, unknown>) };
      delete extra[field];

      await expectErrorCodeAsync(
        () =>
          builder.build({ chainId: row.chainId, requirements: { ...broken, extra }, decimals: 6 }),
        PaymentErrorCode.PAYMENT_DEPOSIT_REQUIREMENTS_INCOMPLETE,
      );
    },
  );

  it('refuses a non-string extra rather than casting it', async () => {
    const row = CHAINS[0];
    const broken = requirements(row);

    await expectErrorCodeAsync(
      () =>
        builder.build({
          chainId: row.chainId,
          requirements: {
            ...broken,
            extra: { ...(broken.extra as Record<string, unknown>), contract: 42 },
          },
          decimals: 6,
        }),
      PaymentErrorCode.PAYMENT_DEPOSIT_REQUIREMENTS_INCOMPLETE,
    );
  });
});
