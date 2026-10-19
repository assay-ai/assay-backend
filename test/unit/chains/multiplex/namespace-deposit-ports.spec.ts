import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import { NamespaceDepositRequirementsBuilder } from '@modules/chains/multiplex/namespace-deposit-requirements-builder';
import { NamespaceEscrowOpener } from '@modules/chains/multiplex/namespace-escrow-opener';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import {
  AccountId,
  CHAIN_IDS,
  ChainNamespace,
  toAccountId,
} from '@modules/chains/ports/caip.types';
import { PaymentRequirements } from '@modules/chains/ports/x402.types';
import {
  DepositRequirements,
  DepositRequirementsBuilderPort,
} from '@modules/payment/ports/deposit-requirements.port';
import { EscrowOpenerPort } from '@modules/payment/ports/escrow-opener.port';

import { expectErrorCodeAsync } from '../../helpers/expect-error-code';

/**
 * The two ports on the deposit path that were bound `useExisting:
 * Solana…` for every chain, and what dispatching them has to get right.
 *
 * ## The members answer different things on purpose
 *
 * Both fakes below return a value that **names the namespace they came from**.
 * A multiplexer that always picked the first entry, or that dispatched on
 * something other than the argument's chain, returns the wrong one and every
 * assertion here says so by name. Two fakes returning the same shape would make
 * "dispatched correctly" and "dispatched at all" the same test.
 */

const SOLANA = CHAIN_IDS.SOLANA_DEVNET;
const EVM = CHAIN_IDS.ROBINHOOD_TESTNET;

const SOLANA_BUYER: AccountId = toAccountId(SOLANA, 'AgentAccount1111111111111111111111111111111');
const EVM_BUYER: AccountId = toAccountId(EVM, '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc');

const SOLANA_ESCROW: AccountId = toAccountId(SOLANA, 'EscrowTokenAccount1111111111111111111111111');
const EVM_ESCROW: AccountId = toAccountId(EVM, '0x2ed26485593B512d87616a2625d2C0f7721cfF10');

function fakeOpener(escrow: AccountId, signature: string | null): EscrowOpenerPort {
  return {
    open: jest.fn().mockResolvedValue({
      escrowPda: escrow,
      escrowTokenAccount: escrow,
      signature,
    }),
  };
}

describe('NamespaceEscrowOpener', () => {
  const solana = fakeOpener(SOLANA_ESCROW, 'OpenEscrowSignature111');
  const evm = fakeOpener(EVM_ESCROW, null);

  const opener = new NamespaceEscrowOpener(
    new Map<string, EscrowOpenerPort>([
      [ChainNamespace.SOLANA, solana],
      [ChainNamespace.EIP155, evm],
    ]),
  );

  it.each([
    {
      label: 'solana',
      buyer: SOLANA_BUYER,
      asset: ASSET_IDS.USDC_SOLANA_DEVNET,
      escrow: SOLANA_ESCROW,
      signature: 'OpenEscrowSignature111',
    },
    {
      label: 'eip155',
      buyer: EVM_BUYER,
      asset: ASSET_IDS.USDG_ROBINHOOD_TESTNET,
      escrow: EVM_ESCROW,
      // `null` — the EVM member opens nothing, and a dispatcher that reached
      // the Solana member would hand back a signature for a transaction that
      // was never sent.
      signature: null,
    },
  ])('sends a $label buyer to the $label member', async (row) => {
    const opened = await opener.open(row.buyer, row.asset);

    expect(opened.escrowTokenAccount).toBe(row.escrow);
    expect(opened.signature).toBe(row.signature);
  });

  it('dispatches on the BUYER, and calls exactly one member', async () => {
    (solana.open as jest.Mock).mockClear();
    (evm.open as jest.Mock).mockClear();

    await opener.open(EVM_BUYER, ASSET_IDS.USDG_ROBINHOOD_TESTNET);

    expect(evm.open).toHaveBeenCalledWith(EVM_BUYER, ASSET_IDS.USDG_ROBINHOOD_TESTNET);
    expect(solana.open).not.toHaveBeenCalled();
  });

  it('refuses a namespace nothing is wired for, rather than guessing', async () => {
    const solanaOnly = new NamespaceEscrowOpener(
      new Map<string, EscrowOpenerPort>([[ChainNamespace.SOLANA, solana]]),
    );

    await expectErrorCodeAsync(
      () => solanaOnly.open(EVM_BUYER, ASSET_IDS.USDG_ROBINHOOD_TESTNET),
      ChainErrorCode.CHAIN_UNSUPPORTED,
    );
  });
});

function fakeBuilder(answer: DepositRequirements): DepositRequirementsBuilderPort {
  return { build: jest.fn().mockResolvedValue(answer) };
}

const SOLANA_ANSWER: DepositRequirements = {
  namespace: 'solana',
  chainId: SOLANA,
  payTo: 'EscrowTokenAccount1111111111111111111111111',
  asset: 'FG5sGnv611t2nWGK5hVw5WE5hv1HLfx7SwLCtjbuj9xR',
  amount: '5000000',
  decimals: 6,
  feePayer: 'FacilitatorFeePayer1111111111111111111111111',
  memo: '11111111-1111-1111-1111-111111111111',
  blockhash: 'Blockhash111111111111111111111111111111111',
  lastValidBlockHeight: '312445678',
};

const EVM_ANSWER: DepositRequirements = {
  namespace: 'eip155',
  chainId: EVM,
  contract: '0x2ed26485593B512d87616a2625d2C0f7721cfF10',
  method: 'depositFor(address,uint64)',
  spender: '0x2ed26485593B512d87616a2625d2C0f7721cfF10',
  buyer: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  asset: '0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac',
  amount: '5000000',
  decimals: 6,
  plainTransferCreditsNobody: true,
};

/** A `402` that carries nothing either member reads, so only the dispatch is under test. */
const IRRELEVANT_402: PaymentRequirements = {
  scheme: 'exact',
  network: SOLANA,
  amount: '5000000',
  asset: 'irrelevant',
  payTo: 'irrelevant',
  resource: 'assay:deposit:11111111-1111-1111-1111-111111111111',
  maxTimeoutSeconds: 60,
};

describe('NamespaceDepositRequirementsBuilder', () => {
  const solana = fakeBuilder(SOLANA_ANSWER);
  const evm = fakeBuilder(EVM_ANSWER);

  const builder = new NamespaceDepositRequirementsBuilder(
    new Map<string, DepositRequirementsBuilderPort>([
      [ChainNamespace.SOLANA, solana],
      [ChainNamespace.EIP155, evm],
    ]),
  );

  it.each([
    { chainId: SOLANA, expected: SOLANA_ANSWER },
    { chainId: EVM, expected: EVM_ANSWER },
  ])('returns the $chainId member’s own answer', async ({ chainId, expected }) => {
    const built = await builder.build({
      chainId,
      requirements: { ...IRRELEVANT_402, network: chainId },
      decimals: 6,
    });

    expect(built).toBe(expected);
    // The discriminant is the whole point of the union: a client narrows on it
    // before reading a field, and the two members share almost none.
    expect(built.namespace).toBe(chainId === SOLANA ? 'solana' : 'eip155');
  });

  it('dispatches on input.chainId and calls exactly one member', async () => {
    (solana.build as jest.Mock).mockClear();
    (evm.build as jest.Mock).mockClear();

    await builder.build({ chainId: EVM, requirements: IRRELEVANT_402, decimals: 6 });

    // Note `requirements.network` is `solana:…` here and the chain is `eip155`.
    // The dispatch must follow the RESOLVED chain the intent was written with,
    // not a field of the `402` — which on the settle path is rebuilt.
    expect(evm.build).toHaveBeenCalledTimes(1);
    expect(solana.build).not.toHaveBeenCalled();
  });

  it('refuses a namespace nothing is wired for', async () => {
    const solanaOnly = new NamespaceDepositRequirementsBuilder(
      new Map<string, DepositRequirementsBuilderPort>([[ChainNamespace.SOLANA, solana]]),
    );

    await expectErrorCodeAsync(
      () => solanaOnly.build({ chainId: EVM, requirements: IRRELEVANT_402, decimals: 6 }),
      ChainErrorCode.CHAIN_UNSUPPORTED,
    );
  });
});
