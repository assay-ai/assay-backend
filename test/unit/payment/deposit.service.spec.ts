import { TxRef } from '@modules/chains/ports/x402.types';
import { X402_INVALID_REASON } from '@modules/chains/facilitator/facilitator.wire';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, ChainId, CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { ChainErrorCode, ChainErrors } from '@modules/chains/errors/chains.errors';
import { MoneyUtil } from '@shared/utils/money.util';

import { DepositIntentService } from '@modules/payment/services/deposit-intent.service';
import { DepositService } from '@modules/payment/services/deposit.service';
import { DepositIntentStatus } from '@modules/payment/ports/deposit.types';
import {
  DEPOSIT_OBSERVE_POLL_MS,
  DEPOSIT_OBSERVE_TIMEOUT_MS,
} from '@modules/payment/constants/deposit-intent.constants';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import {
  FakeBuyerEscrowRepository,
  FakeDepositIntentRepository,
  fakeChainAdapter,
  fakeEscrowBalanceReader,
  fakeEscrowOpener,
  fakeFacilitator,
  fakeLedger,
  fakeVaultPort,
} from './helpers/deposit-harness';

const SOLANA_DEVNET: ChainId = CHAIN_IDS.SOLANA_DEVNET;
const USDC = ASSET_IDS.USDC_SOLANA_DEVNET;
const ORGANIZATION_ID = '11111111-1111-1111-1111-111111111111';
const AGENT_ID = '22222222-2222-2222-2222-222222222222';
const AGENT_ACCOUNT: AccountId = toAccountId(
  SOLANA_DEVNET,
  'AgentAccount1111111111111111111111111111111',
);
const ESCROW_PDA: AccountId = toAccountId(
  SOLANA_DEVNET,
  'EscrowPda11111111111111111111111111111111',
);
const ESCROW_TOKEN_ACCOUNT: AccountId = toAccountId(
  SOLANA_DEVNET,
  'EscrowTokenAccount1111111111111111111111111',
);
const TX_SIG = 'FakeTransactionSignature1111111111111111111111111111111111111111111111111';

/** The second chain, with a second asset — see the two-chain cases below. */
const EVM_AGENT_ACCOUNT: AccountId = toAccountId(
  CHAIN_IDS.ROBINHOOD_TESTNET,
  '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
);

function buildHarness(overrides?: {
  adapter?: ReturnType<typeof fakeChainAdapter>;
  facilitator?: ReturnType<typeof fakeFacilitator>;
  opener?: ReturnType<typeof fakeEscrowOpener>;
  escrowReader?: ReturnType<typeof fakeEscrowBalanceReader>;
  ledger?: ReturnType<typeof fakeLedger>;
  /** Seeds the escrow mirror with an already-open row for `AGENT_ACCOUNT` when true (default). */
  escrowExists?: boolean;
  chainState?: { assertActive: jest.Mock } | null;
}) {
  const repo = new FakeDepositIntentRepository();
  const depositIntents = new DepositIntentService(repo.asRepository());
  const adapter = overrides?.adapter ?? fakeChainAdapter();
  const facilitator = overrides?.facilitator ?? fakeFacilitator();
  const opener = overrides?.opener ?? fakeEscrowOpener();
  const escrowReader = overrides?.escrowReader ?? fakeEscrowBalanceReader();
  const ledger = overrides?.ledger ?? fakeLedger();
  const vault = fakeVaultPort();

  const escrows = new FakeBuyerEscrowRepository();
  if (overrides?.escrowExists ?? true) {
    escrows.rows.push({
      id: 'escrow-seed',
      organizationId: ORGANIZATION_ID,
      accountId: AGENT_ACCOUNT,
      assetId: USDC,
      escrowAccountId: ESCROW_PDA,
      escrowAssetAccountId: ESCROW_TOKEN_ACCOUNT,
      openedTxRef: 'SeedOpenEscrowSignature111111111111111111111111111111111111111111111111111',
    });
  }

  const registry = {
    resolve: jest.fn().mockReturnValue(adapter),
  } as unknown as ChainAdapterRegistry;

  const service = new DepositService(
    depositIntents,
    registry,
    facilitator,
    opener,
    escrowReader,
    escrows.asRepository(),
    ledger,
    (overrides?.chainState ?? null) as never,
  );

  return {
    repo,
    depositIntents,
    adapter,
    facilitator,
    opener,
    escrowReader,
    escrows,
    vault,
    ledger,
    registry,
    service,
  };
}

const amount = () => MoneyUtil.of(5_000_000n, USDC, 6);

function input() {
  return {
    organizationId: ORGANIZATION_ID,
    agentId: AGENT_ID,
    agentAccount: AGENT_ACCOUNT,
    chainId: SOLANA_DEVNET,
    amount: amount(),
  };
}

describe('DepositService.createDeposit', () => {
  it('creates a CREATED intent and builds 402 requirements, USDC only', async () => {
    const { service, adapter } = buildHarness();

    const { intent, requirements } = await service.createDeposit(input());

    expect(intent.status).toBe(DepositIntentStatus.CREATED);
    expect(intent.requestedAmount.asset).toBe(USDC);
    expect(adapter.buildPaymentRequirements).toHaveBeenCalledTimes(1);
    expect(requirements.asset).toBeDefined();
  });

  /**
   * Two chains, two different wrong answers. `USDC_SOLANA_MAINNET` is the
   * original case — a registered asset with the right symbol on the wrong
   * Solana chain — and `USDG_ROBINHOOD_TESTNET` is the case the old
   * `USDC_BY_CHAIN` table could not express at all: the settlement asset of
   * the *other namespace*, which a deposit on devnet must still refuse.
   * `test/unit/payment/deposit-asset.spec.ts` runs the opposite direction.
   */
  it.each([
    ['the other Solana chain’s USDC', ASSET_IDS.USDC_SOLANA_MAINNET],
    ['the EVM chain’s USDG', ASSET_IDS.USDG_ROBINHOOD_TESTNET],
  ])('refuses %s before creating anything', async (_label, wrong) => {
    const { service, repo, adapter } = buildHarness();

    await expectErrorCodeAsync(
      () => service.createDeposit({ ...input(), amount: MoneyUtil.of(5_000_000n, wrong, 6) }),
      PaymentErrorCode.PAYMENT_DEPOSIT_ASSET_NOT_SETTLEMENT_ASSET,
    );

    expect(repo.rows.size).toBe(0);
    expect(adapter.buildPaymentRequirements).not.toHaveBeenCalled();
  });

  /**
   * The defect this replaced: `assertDepositIsUsdc` read a two-row table keyed
   * by chain, `eip155:46630` was not in it, and every deposit on that chain was
   * refused `400` before an intent row existed. The service must accept the
   * EVM chain's own settlement asset — a different token (USDG), at a
   * different address, in a different namespace — on exactly the same path.
   */
  it('accepts the EVM chain’s own settlement asset and writes the intent', async () => {
    const { service, repo } = buildHarness();

    const { intent } = await service.createDeposit({
      ...input(),
      agentAccount: EVM_AGENT_ACCOUNT,
      chainId: CHAIN_IDS.ROBINHOOD_TESTNET,
      amount: MoneyUtil.of(5_000_000n, ASSET_IDS.USDG_ROBINHOOD_TESTNET, 6),
    });

    expect(intent.status).toBe(DepositIntentStatus.CREATED);
    expect(intent.chainId).toBe(CHAIN_IDS.ROBINHOOD_TESTNET);
    expect(intent.requestedAmount.asset).toBe(ASSET_IDS.USDG_ROBINHOOD_TESTNET);
    expect(repo.rows.size).toBe(1);
  });

  it('checks the deposit door before writing anything: a paused or blocked buyer leaves no row', async () => {
    const refusal = new Error('CHAIN_ADDRESS_BLOCKED');
    const chainState = { assertActive: jest.fn().mockRejectedValue(refusal) };
    const { service, repo, escrows, opener } = buildHarness({ chainState, escrowExists: false });

    await expect(service.createDeposit(input())).rejects.toBe(refusal);

    expect(chainState.assertActive).toHaveBeenCalledWith('DEPOSIT', [
      { role: 'BUYER', account: AGENT_ACCOUNT },
    ]);
    expect(repo.rows.size).toBe(0);
    expect(escrows.rows).toHaveLength(0);
    expect(opener.open).not.toHaveBeenCalled();
  });

  it('leaves no deposit intent behind when the facilitator cannot be reached', async () => {
    // The row is what `GET /balances` counts as `pendingDeposits` and what the
    // funding screen renders as "Awaiting transfer". A request that answered
    // `502` must not leave money the buyer never sent sitting in either.
    const facilitator = fakeFacilitator({
      getFeePayer: jest
        .fn()
        .mockRejectedValue(
          ChainErrors.facilitatorUnavailable({ chainId: SOLANA_DEVNET, reason: 'no fee payer' }),
        ),
    });
    const { service, repo } = buildHarness({ facilitator });

    await expectErrorCodeAsync(
      () => service.createDeposit(input()),
      ChainErrorCode.CHAIN_FACILITATOR_UNAVAILABLE,
    );

    expect(repo.rows.size).toBe(0);
  });

  it('sends a deposit to the buyer’s own escrow token account, never to the pooled vault', async () => {
    const harness = buildHarness();

    const { requirements } = await harness.service.createDeposit(input());

    // `PaymentRequirements.payTo` is chain-native, not CAIP-10 — the fake
    // adapter's `buildPaymentRequirements` always answers with the escrow ATA
    // address it was handed, which is `ESCROW_TOKEN_ACCOUNT`'s bare address.
    expect(requirements.payTo).toBe('EscrowTokenAccount1111111111111111111111111');
    expect(harness.vault.getVaultOwner).not.toHaveBeenCalled();
  });

  /**
   * The multichain rename of `BuyerEscrowEntity.escrowPda`/`.escrowTokenAccount`
   * to `escrowAccountId`/`escrowAssetAccountId` turned three identity
   * copies in this service into translations between two `AccountId`-typed
   * fields. Nothing pinned them: swapping the pair in `ensureEscrow` left the
   * whole suite green while the deposit destination became the escrow's OWNER
   * instead of its token account — money sent to an address that holds no
   * balance, discovered by the buyer.
   *
   * The two fixtures are deliberately unlike each other. A harness where both
   * carried the same address would pass a swap by construction.
   */
  describe('the escrow account and the escrow ASSET account do not get crossed', () => {
    it('sends the deposit to the asset account when the mirror row already exists', async () => {
      const harness = buildHarness({ escrowExists: true });

      const { requirements } = await harness.service.createDeposit(input());

      // What the service DECIDED, not what the fake answered with.
      expect(harness.adapter.buildPaymentRequirements).toHaveBeenCalledWith(
        expect.objectContaining({ payTo: ESCROW_TOKEN_ACCOUNT, payToIsTokenAccount: true }),
      );
      expect(harness.adapter.buildPaymentRequirements).not.toHaveBeenCalledWith(
        expect.objectContaining({ payTo: ESCROW_PDA }),
      );
      // And what it advertises to the client, which is what the client pays.
      expect(requirements.payTo).toBe('EscrowTokenAccount1111111111111111111111111');
    });

    it('sends it to the asset account on the freshly-opened path too', async () => {
      // A separate case because `ensureEscrow` returns from a DIFFERENT pair of
      // lines here — the row it just wrote, not the row it found.
      const harness = buildHarness({ escrowExists: false });

      const { requirements } = await harness.service.createDeposit(input());

      expect(harness.adapter.buildPaymentRequirements).toHaveBeenCalledWith(
        expect.objectContaining({ payTo: ESCROW_TOKEN_ACCOUNT, payToIsTokenAccount: true }),
      );
      expect(requirements.payTo).toBe('EscrowTokenAccount1111111111111111111111111');
    });

    it('stores the opener’s two addresses in the columns that mean them', async () => {
      const harness = buildHarness({ escrowExists: false });

      await harness.service.createDeposit(input());

      expect(harness.escrows.rows).toEqual([
        expect.objectContaining({
          accountId: AGENT_ACCOUNT,
          escrowAccountId: ESCROW_PDA,
          escrowAssetAccountId: ESCROW_TOKEN_ACCOUNT,
        }),
      ]);
    });
  });

  it('opens the escrow when there is none, and records what it opened', async () => {
    const harness = buildHarness({ escrowExists: false });

    await harness.service.createDeposit(input());

    // No limits are passed, because none may be: `open_escrow` refuses a
    // non-zero limit without the buyer's signature (`EscrowLimitsRequireBuyer`),
    // so the escrow opens disarmed and the buyer arms it themselves.
    expect(harness.opener.open).toHaveBeenCalledWith(AGENT_ACCOUNT, USDC);
    expect(harness.escrows.rows).toContainEqual(
      expect.objectContaining({ accountId: AGENT_ACCOUNT, escrowAccountId: ESCROW_PDA }),
    );
  });

  it('refuses a deposit under the $5 minimum before opening an escrow, and admits exactly $5', async () => {
    const harness = buildHarness({ escrowExists: false });

    await expectErrorCodeAsync(
      () =>
        harness.service.createDeposit({ ...input(), amount: MoneyUtil.of(4_999_999n, USDC, 6) }),
      PaymentErrorCode.PAYMENT_DEPOSIT_BELOW_MINIMUM,
    );
    expect(harness.opener.open).not.toHaveBeenCalled();
    expect(harness.repo.rows.size).toBe(0);

    await expect(
      harness.service.createDeposit({ ...input(), amount: MoneyUtil.of(5_000_000n, USDC, 6) }),
    ).resolves.toBeDefined();
  });

  it('refuses a chain this deployment does not enable before opening an escrow on it', async () => {
    const harness = buildHarness({ escrowExists: false });
    (harness.registry.resolve as jest.Mock).mockImplementation((chainId: ChainId) => {
      throw ChainErrors.unsupportedChain({ chainId });
    });

    await expectErrorCodeAsync(
      () => harness.service.createDeposit(input()),
      ChainErrorCode.CHAIN_UNSUPPORTED,
    );
    expect(harness.opener.open).not.toHaveBeenCalled();
    expect(harness.repo.rows.size).toBe(0);
  });

  it('does not open a second escrow for a buyer who already has one', async () => {
    const harness = buildHarness({ escrowExists: true });
    await harness.service.createDeposit(input());
    expect(harness.opener.open).not.toHaveBeenCalled();
  });

  it('refuses, with a 409 naming the account, when another organization holds its escrow row', async () => {
    // `buyer_escrows` is unique on the account alone (one on-chain escrow per
    // buyer). Measured on the local stack: the second organization's deposit
    // rewrote the first organization's escrow addresses and then 500ed.
    const harness = buildHarness({ escrowExists: false });
    const otherOrganization = '99999999-9999-9999-9999-999999999999';
    harness.escrows.rows.push({
      id: 'escrow-other-org',
      organizationId: otherOrganization,
      accountId: AGENT_ACCOUNT,
      assetId: USDC,
      escrowAccountId: 'escrow-of-the-other-org',
      escrowAssetAccountId: 'escrow-ata-of-the-other-org',
      openedTxRef: null,
    });

    await expectErrorCodeAsync(
      () => harness.service.createDeposit(input()),
      PaymentErrorCode.PAYMENT_ESCROW_ACCOUNT_CLAIMED,
    );
    expect(harness.escrows.rows).toEqual([
      expect.objectContaining({
        organizationId: otherOrganization,
        escrowAccountId: 'escrow-of-the-other-org',
      }),
    ]);
    // Refused before the intent row is written, like the opener failure below.
    expect(harness.repo.rows.size).toBe(0);
  });

  it('refuses the deposit rather than opening an escrow the chain cannot confirm', async () => {
    const opener = fakeEscrowOpener({ open: jest.fn().mockRejectedValue(new Error('rpc down')) });
    const harness = buildHarness({ escrowExists: false, opener });

    await expectErrorCodeAsync(
      () => harness.service.createDeposit(input()),
      PaymentErrorCode.PAYMENT_ESCROW_NOT_OPEN,
    );
    expect(harness.escrows.rows).toHaveLength(0);
    expect(harness.repo.rows.size).toBe(0);
  });
});

describe('DepositService.settleDeposit — happy path', () => {
  it('verifies, settles, observes the transfer, credits the ledger once, and reaches SETTLED', async () => {
    const observed = { amount: '5000000', asset: USDC, decimals: 6 };
    const adapter = fakeChainAdapter({
      observeTransfer: jest.fn().mockResolvedValue(observed),
      extractSettledAmount: jest.fn().mockReturnValue(amount()),
    });
    const facilitator = fakeFacilitator({
      settle: jest
        .fn()
        .mockResolvedValue({ success: true, network: SOLANA_DEVNET, transaction: TX_SIG }),
    });
    const { service, depositIntents, ledger } = buildHarness({ adapter, facilitator });

    const { intent } = await service.createDeposit({
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      agentAccount: AGENT_ACCOUNT,
      chainId: SOLANA_DEVNET,
      amount: amount(),
    });

    const settled = await service.settleDeposit(ORGANIZATION_ID, intent.id, dummyPayload());

    expect(settled.status).toBe(DepositIntentStatus.SETTLED);
    expect(settled.settledAmount?.amount).toBe('5000000');
    expect(settled.chainTxRef).toBe(TX_SIG);
    expect(ledger.appendNow).toHaveBeenCalledTimes(1);
    expect(ledger.appendNow).toHaveBeenCalledWith(
      expect.objectContaining({ entryType: LedgerEntryType.DEPOSIT_PENDING, intentId: intent.id }),
    );

    const reread = await depositIntents.findById(ORGANIZATION_ID, intent.id);
    expect(reread.status).toBe(DepositIntentStatus.SETTLED);
  });

  it('writes DEPOSIT_PENDING durably before answering SETTLED', async () => {
    // The console refetches `GET /balances` the moment the settle response
    // lands. A credit written after SETTLED would leave the buyer reading an
    // empty ledger ("No credited balance") next to a deposit row already
    // reading SETTLED.
    const order: string[] = [];
    const adapter = fakeChainAdapter({
      observeTransfer: jest.fn().mockResolvedValue({ amount: '5000000', asset: USDC, decimals: 6 }),
      extractSettledAmount: jest.fn().mockReturnValue(amount()),
    });
    const facilitator = fakeFacilitator({
      settle: jest
        .fn()
        .mockResolvedValue({ success: true, network: SOLANA_DEVNET, transaction: TX_SIG }),
    });
    const ledger = fakeLedger({
      appendNow: jest.fn().mockImplementation(async () => {
        await Promise.resolve();
        order.push('credit');
      }),
    });
    const { service, depositIntents } = buildHarness({ adapter, facilitator, ledger });
    const transition = depositIntents.transition.bind(depositIntents);
    jest.spyOn(depositIntents, 'transition').mockImplementation(async (...args) => {
      if (args[3] === DepositIntentStatus.SETTLED) order.push('settled');
      return transition(...args);
    });

    const { intent } = await service.createDeposit({
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      agentAccount: AGENT_ACCOUNT,
      chainId: SOLANA_DEVNET,
      amount: amount(),
    });
    await service.settleDeposit(ORGANIZATION_ID, intent.id, dummyPayload());

    expect(ledger.appendNow).toHaveBeenCalledWith(
      expect.objectContaining({ entryType: LedgerEntryType.DEPOSIT_PENDING, intentId: intent.id }),
    );
    expect(order).toEqual(['credit', 'settled']);
  });

  it('hands the adapter the escrow as `payTo` AND the buyer as `payer`, at binding and at observation', async () => {
    // On EVM the mirror's escrow is the pooled contract, so an intent carrying
    // only `payTo` left the adapter comparing `depositFor`'s buyer against the
    // contract — every real deposit refused with "credits a different buyer".
    const adapter = fakeChainAdapter({
      observeTransfer: jest.fn().mockResolvedValue({ amount: '5000000', asset: USDC, decimals: 6 }),
      extractSettledAmount: jest.fn().mockReturnValue(amount()),
    });
    const facilitator = fakeFacilitator({
      settle: jest
        .fn()
        .mockResolvedValue({ success: true, network: SOLANA_DEVNET, transaction: TX_SIG }),
    });
    const { service } = buildHarness({ adapter, facilitator });

    const { intent } = await service.createDeposit({
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      agentAccount: AGENT_ACCOUNT,
      chainId: SOLANA_DEVNET,
      amount: amount(),
    });
    await service.settleDeposit(ORGANIZATION_ID, intent.id, dummyPayload());

    const expected = expect.objectContaining({ payTo: ESCROW_PDA, payer: AGENT_ACCOUNT });
    expect(adapter.assertPayloadBoundToIntent).toHaveBeenCalledWith(expect.anything(), expected);
    expect(adapter.observeTransfer).toHaveBeenCalledWith(expected, TX_SIG, expect.anything());
  });

  it('credits the amount the chain observed, not the amount requested — overpayment is tolerated', async () => {
    // The intent asked for 1.000000 USDC; the chain observed 1.500000.
    const observed = { amount: '1500000', asset: USDC, decimals: 6 };
    const overpaid = MoneyUtil.of(1_500_000n, USDC, 6);
    const adapter = fakeChainAdapter({
      observeTransfer: jest.fn().mockResolvedValue(observed),
      extractSettledAmount: jest.fn().mockReturnValue(overpaid),
    });
    const facilitator = fakeFacilitator({
      settle: jest
        .fn()
        .mockResolvedValue({ success: true, network: SOLANA_DEVNET, transaction: TX_SIG }),
    });
    const { service, ledger } = buildHarness({ adapter, facilitator });

    const { intent } = await service.createDeposit({
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      agentAccount: AGENT_ACCOUNT,
      chainId: SOLANA_DEVNET,
      amount: amount(),
    });

    const settled = await service.settleDeposit(ORGANIZATION_ID, intent.id, dummyPayload());

    expect(settled.settledAmount?.amount).toBe('1500000');
    expect(ledger.appendNow).toHaveBeenCalledWith(
      expect.objectContaining({ money: expect.objectContaining({ amount: '1500000' }) }),
    );
  });
});

describe('DepositService.settleDeposit — required failure paths', () => {
  async function createdIntent(harness: ReturnType<typeof buildHarness>) {
    const { intent } = await harness.service.createDeposit({
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      agentAccount: AGENT_ACCOUNT,
      chainId: SOLANA_DEVNET,
      amount: amount(),
    });
    return intent;
  }

  it('bad signature: facilitator /verify rejects the payload signature', async () => {
    const facilitator = fakeFacilitator({
      verify: jest.fn().mockResolvedValue({
        isValid: false,
        invalidReason: X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_SIGNATURE,
      }),
    });
    const harness = buildHarness({ facilitator });
    const intent = await createdIntent(harness);

    await expectErrorCodeAsync(
      () => harness.service.settleDeposit(ORGANIZATION_ID, intent.id, dummyPayload()),
      PaymentErrorCode.PAYMENT_INVALID_SIGNATURE,
    );
    expect(facilitator.settle).not.toHaveBeenCalled();
    expect(harness.ledger.appendNow).not.toHaveBeenCalled();
    const after = await harness.depositIntents.findById(ORGANIZATION_ID, intent.id);
    expect(after.status).toBe(DepositIntentStatus.CREATED);
  });

  it('amount mismatch: the chain moved less than the intent requires — the ledger is never credited', async () => {
    const adapter = fakeChainAdapter({
      observeTransfer: jest.fn().mockResolvedValue({ amount: '500000', asset: USDC, decimals: 6 }),
      extractSettledAmount: jest.fn().mockImplementation(() => {
        throw ChainErrors.settledAmountBelowIntent({
          intentId: 'x',
          expected: '5000000',
          actual: '500000',
        });
      }),
    });
    const facilitator = fakeFacilitator({
      settle: jest
        .fn()
        .mockResolvedValue({ success: true, network: SOLANA_DEVNET, transaction: TX_SIG }),
    });
    const harness = buildHarness({ adapter, facilitator });
    const intent = await createdIntent(harness);

    await expectErrorCodeAsync(
      () => harness.service.settleDeposit(ORGANIZATION_ID, intent.id, dummyPayload()),
      ChainErrorCode.CHAIN_SETTLED_AMOUNT_BELOW_INTENT,
    );
    expect(harness.ledger.appendNow).not.toHaveBeenCalled();
    const after = await harness.depositIntents.findById(ORGANIZATION_ID, intent.id);
    expect(after.status).toBe(DepositIntentStatus.FAILED);
  });

  it('overpayment is legal on SVM and must be credited, not rejected (contrast with the mismatch case above)', async () => {
    const observed = { amount: '1000001', asset: USDC, decimals: 6 };
    const adapter = fakeChainAdapter({
      observeTransfer: jest.fn().mockResolvedValue(observed),
      extractSettledAmount: jest.fn().mockReturnValue(MoneyUtil.of(1_000_001n, USDC, 6)),
    });
    const facilitator = fakeFacilitator({
      settle: jest
        .fn()
        .mockResolvedValue({ success: true, network: SOLANA_DEVNET, transaction: TX_SIG }),
    });
    const harness = buildHarness({ adapter, facilitator });
    const intent = await createdIntent(harness);

    const settled = await harness.service.settleDeposit(ORGANIZATION_ID, intent.id, dummyPayload());
    expect(settled.status).toBe(DepositIntentStatus.SETTLED);
    expect(settled.settledAmount?.amount).toBe('1000001');
  });

  it('non-USDC mint: the observed transfer is of a different SPL mint', async () => {
    const adapter = fakeChainAdapter({
      observeTransfer: jest.fn().mockResolvedValue({
        amount: '5000000',
        asset: ASSET_IDS.USDC_SOLANA_MAINNET,
        decimals: 6,
      }),
      extractSettledAmount: jest.fn().mockImplementation(() => {
        throw ChainErrors.settledAssetMismatch({
          intentId: 'x',
          expected: USDC,
          actual: ASSET_IDS.USDC_SOLANA_MAINNET,
        });
      }),
    });
    const facilitator = fakeFacilitator({
      settle: jest
        .fn()
        .mockResolvedValue({ success: true, network: SOLANA_DEVNET, transaction: TX_SIG }),
    });
    const harness = buildHarness({ adapter, facilitator });
    const intent = await createdIntent(harness);

    await expectErrorCodeAsync(
      () => harness.service.settleDeposit(ORGANIZATION_ID, intent.id, dummyPayload()),
      ChainErrorCode.CHAIN_SETTLED_ASSET_MISMATCH,
    );
    expect(harness.ledger.appendNow).not.toHaveBeenCalled();
  });

  it('memo missing: the adapter refuses binding before the facilitator is ever called', async () => {
    const adapter = fakeChainAdapter({
      assertPayloadBoundToIntent: jest.fn().mockImplementation(() => {
        throw ChainErrors.payloadNotBoundToIntent({
          intentId: 'x',
          reason: 'transaction carries no memo',
        });
      }),
    });
    const facilitator = fakeFacilitator();
    const harness = buildHarness({ adapter, facilitator });
    const intent = await createdIntent(harness);

    await expectErrorCodeAsync(
      () => harness.service.settleDeposit(ORGANIZATION_ID, intent.id, dummyPayload()),
      ChainErrorCode.CHAIN_PAYLOAD_NOT_BOUND_TO_INTENT,
    );
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it('memo belongs to a different intent: same rejection, same refusal to call the facilitator', async () => {
    const adapter = fakeChainAdapter({
      assertPayloadBoundToIntent: jest.fn().mockImplementation(() => {
        throw ChainErrors.payloadNotBoundToIntent({
          intentId: 'x',
          reason: 'memo is "some-other-intent"',
        });
      }),
    });
    const harness = buildHarness({ adapter });
    const intent = await createdIntent(harness);

    await expectErrorCodeAsync(
      () => harness.service.settleDeposit(ORGANIZATION_ID, intent.id, dummyPayload()),
      ChainErrorCode.CHAIN_PAYLOAD_NOT_BOUND_TO_INTENT,
    );
  });

  it('two memos: ambiguity is a rejection, not a best-effort match', async () => {
    const adapter = fakeChainAdapter({
      assertPayloadBoundToIntent: jest.fn().mockImplementation(() => {
        throw ChainErrors.payloadNotBoundToIntent({
          intentId: 'x',
          reason: 'transaction carries 2 memos',
        });
      }),
    });
    const harness = buildHarness({ adapter });
    const intent = await createdIntent(harness);

    await expectErrorCodeAsync(
      () => harness.service.settleDeposit(ORGANIZATION_ID, intent.id, dummyPayload()),
      ChainErrorCode.CHAIN_PAYLOAD_NOT_BOUND_TO_INTENT,
    );
  });

  it('wrong network: the payload is for a different chain than the intent', async () => {
    const adapter = fakeChainAdapter({
      assertPayloadBoundToIntent: jest.fn().mockImplementation(() => {
        throw ChainErrors.payloadNotBoundToIntent({
          intentId: 'x',
          reason:
            'payload is for solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp, intent is on solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
        });
      }),
    });
    const harness = buildHarness({ adapter });
    const intent = await createdIntent(harness);

    await expectErrorCodeAsync(
      () => harness.service.settleDeposit(ORGANIZATION_ID, intent.id, dummyPayload()),
      ChainErrorCode.CHAIN_PAYLOAD_NOT_BOUND_TO_INTENT,
    );
  });

  it('expired intent: refused before the adapter or facilitator are ever touched', async () => {
    const harness = buildHarness();
    const intent = await createdIntent(harness);
    // `DepositService.createDeposit` no longer accepts a caller-supplied
    // `expiresAt` (removed once `amount` replaced `requestedAmount` in its
    // input type) — back-date the row directly to exercise the check.
    harness.repo.rows.get(intent.id)!.expiresAt = new Date(Date.now() - 1000);

    await expectErrorCodeAsync(
      () => harness.service.settleDeposit(ORGANIZATION_ID, intent.id, dummyPayload()),
      PaymentErrorCode.PAYMENT_DEPOSIT_EXPIRED,
    );
    expect(harness.adapter.assertPayloadBoundToIntent).not.toHaveBeenCalled();
    expect(harness.facilitator.verify).not.toHaveBeenCalled();
  });

  it('replayed settle: settling an already-SETTLED intent is a no-op, and credits once, not twice', async () => {
    const adapter = fakeChainAdapter({
      observeTransfer: jest.fn().mockResolvedValue({ amount: '5000000', asset: USDC, decimals: 6 }),
      extractSettledAmount: jest.fn().mockReturnValue(amount()),
    });
    const facilitator = fakeFacilitator({
      settle: jest
        .fn()
        .mockResolvedValue({ success: true, network: SOLANA_DEVNET, transaction: TX_SIG }),
    });
    const harness = buildHarness({ adapter, facilitator });
    const intent = await createdIntent(harness);

    const first = await harness.service.settleDeposit(ORGANIZATION_ID, intent.id, dummyPayload());
    const second = await harness.service.settleDeposit(ORGANIZATION_ID, intent.id, dummyPayload());

    expect(first.status).toBe(DepositIntentStatus.SETTLED);
    expect(second.status).toBe(DepositIntentStatus.SETTLED);
    expect(second.chainTxRef).toBe(first.chainTxRef);
    expect(facilitator.verify).toHaveBeenCalledTimes(1);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    expect(harness.ledger.appendNow).toHaveBeenCalledTimes(1);
  });

  it('a settle call against an intent already SETTLING (a genuine concurrent race) is refused, not silently retried', async () => {
    const harness = buildHarness();
    const intent = await createdIntent(harness);
    // Force the row into SETTLING to simulate a concurrent winner.
    harness.repo.rows.get(intent.id)!.status = DepositIntentStatus.SETTLING;

    await expectErrorCodeAsync(
      () => harness.service.settleDeposit(ORGANIZATION_ID, intent.id, dummyPayload()),
      PaymentErrorCode.PAYMENT_DEPOSIT_INVALID_STATE_TRANSITION,
    );
  });

  it('settle reports failure: the intent moves to FAILED and the reason is mapped', async () => {
    const facilitator = fakeFacilitator({
      settle: jest.fn().mockResolvedValue({
        success: false,
        network: SOLANA_DEVNET,
        errorReason: X402_INVALID_REASON.INSUFFICIENT_FUNDS,
      }),
    });
    const harness = buildHarness({ facilitator });
    const intent = await createdIntent(harness);

    await expectErrorCodeAsync(
      () => harness.service.settleDeposit(ORGANIZATION_ID, intent.id, dummyPayload()),
      PaymentErrorCode.PAYMENT_INSUFFICIENT_FUNDS,
    );
    const after = await harness.depositIntents.findById(ORGANIZATION_ID, intent.id);
    expect(after.status).toBe(DepositIntentStatus.FAILED);
    expect(harness.ledger.appendNow).not.toHaveBeenCalled();
  });

  /*
    This case now takes `DEPOSIT_OBSERVE_TIMEOUT_MS` of wall time in
    production, because a settlement that is not YET observable is the
    overwhelmingly common case and must not be read as failure — see the next
    test. Fake timers keep the suite fast without weakening the assertion.
  */
  it('settlement reports success but the transfer never lands: never credited, moved to FAILED', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    try {
      const adapter = fakeChainAdapter({ observeTransfer: jest.fn().mockResolvedValue(null) });
      const facilitator = fakeFacilitator({
        settle: jest
          .fn()
          .mockResolvedValue({ success: true, network: SOLANA_DEVNET, transaction: TX_SIG }),
      });
      const harness = buildHarness({ adapter, facilitator });
      const intent = await createdIntent(harness);

      const settling = expectErrorCodeAsync(
        () => harness.service.settleDeposit(ORGANIZATION_ID, intent.id, dummyPayload()),
        PaymentErrorCode.PAYMENT_SETTLEMENT_FAILED,
      );
      await jest.advanceTimersByTimeAsync(DEPOSIT_OBSERVE_TIMEOUT_MS + DEPOSIT_OBSERVE_POLL_MS);
      await settling;

      expect(harness.ledger.appendNow).not.toHaveBeenCalled();
      const after = await harness.depositIntents.findById(ORGANIZATION_ID, intent.id);
      expect(after.status).toBe(DepositIntentStatus.FAILED);
    } finally {
      jest.useRealTimers();
    }
  });

  /*
    The regression this exists for, found on devnet and not by any test: the
    facilitator returns as soon as the RPC ACCEPTS the transaction, so the
    first `getTransaction` at `confirmed` misses. Reading once and calling that
    "not observed" marked a deposit FAILED while 25 USDC had already moved into
    the vault. One unconfirmed read is not an answer.
  */
  it('credits a transfer that only becomes observable on a later read', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    try {
      const observeTransfer = jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ amount: '5000000', asset: USDC, decimals: 6 });
      const adapter = fakeChainAdapter({
        observeTransfer,
        extractSettledAmount: jest.fn().mockReturnValue(amount()),
      });
      const facilitator = fakeFacilitator({
        settle: jest
          .fn()
          .mockResolvedValue({ success: true, network: SOLANA_DEVNET, transaction: TX_SIG }),
      });
      const harness = buildHarness({ adapter, facilitator });
      const intent = await createdIntent(harness);

      const settling = harness.service.settleDeposit(ORGANIZATION_ID, intent.id, dummyPayload());
      await jest.advanceTimersByTimeAsync(DEPOSIT_OBSERVE_POLL_MS * 3);
      const settled = await settling;

      expect(observeTransfer.mock.calls.length).toBeGreaterThan(1);
      expect(settled.status).toBe(DepositIntentStatus.SETTLED);
      expect(harness.ledger.appendNow).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

/*
  "Option B" — the buyer's own wallet broadcast the deposit, and the platform
  is handed its hash. Injected wallets (MetaMask, Rabby, …) implement
  `eth_sendTransaction` and not `eth_signTransaction`, so the signed-UNSENT
  path above can never serve them. Nothing the buyer SAYS is trusted here: the
  chain is read, and only a `Deposited` event crediting THIS intent's buyer,
  for at least the requested amount, credits anything.
*/
describe('DepositService.settleDepositByBroadcast — the buyer sent it themselves', () => {
  const TX_HASH = `0x${'ab'.repeat(32)}` as TxRef;
  const observed = { amount: '5000000', asset: USDC, decimals: 6 };

  async function createdIntent(harness: ReturnType<typeof buildHarness>) {
    const { intent } = await harness.service.createDeposit(input());
    return intent;
  }

  function selfBroadcastAdapter(overrides: Parameters<typeof fakeChainAdapter>[0] = {}) {
    return fakeChainAdapter({
      requiresFeePayer: false,
      observeTransfer: jest.fn().mockResolvedValue(observed),
      extractSettledAmount: jest.fn().mockReturnValue(amount()),
      ...overrides,
    });
  }

  it('reads the transfer off the chain, credits DEPOSIT_PENDING once, and reaches SETTLED — no facilitator', async () => {
    const adapter = selfBroadcastAdapter();
    const harness = buildHarness({ adapter });
    const intent = await createdIntent(harness);

    const settled = await harness.service.settleDepositByBroadcast(
      ORGANIZATION_ID,
      intent.id,
      TX_HASH,
    );

    expect(settled.status).toBe(DepositIntentStatus.SETTLED);
    expect(settled.chainTxRef).toBe(TX_HASH);
    expect(harness.facilitator.verify).not.toHaveBeenCalled();
    expect(harness.facilitator.settle).not.toHaveBeenCalled();
    expect(adapter.observeTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ payer: AGENT_ACCOUNT }),
      TX_HASH,
      { commitment: 'confirmed' },
    );
    expect(harness.ledger.appendNow).toHaveBeenCalledTimes(1);
    expect(harness.ledger.appendNow).toHaveBeenCalledWith(
      expect.objectContaining({
        entryType: LedgerEntryType.DEPOSIT_PENDING,
        intentId: intent.id,
        chainTxRef: TX_HASH,
      }),
    );
  });

  it('refuses on a chain whose transactions need the platform as fee payer', async () => {
    // Solana: the facilitator is the fee payer, so a buyer cannot broadcast
    // alone and a hash-only claim there has no honest producer.
    const adapter = selfBroadcastAdapter({ requiresFeePayer: true });
    const harness = buildHarness({ adapter });
    const intent = await createdIntent(harness);

    await expectErrorCodeAsync(
      () => harness.service.settleDepositByBroadcast(ORGANIZATION_ID, intent.id, TX_HASH),
      PaymentErrorCode.PAYMENT_DEPOSIT_BROADCAST_UNSUPPORTED,
    );
    expect(adapter.observeTransfer).not.toHaveBeenCalled();
    expect(harness.ledger.appendNow).not.toHaveBeenCalled();
  });

  it('refuses a transaction another deposit of this organization already claimed', async () => {
    const adapter = selfBroadcastAdapter();
    const harness = buildHarness({ adapter });
    const first = await createdIntent(harness);
    await harness.service.settleDepositByBroadcast(ORGANIZATION_ID, first.id, TX_HASH);
    const second = await createdIntent(harness);

    await expectErrorCodeAsync(
      () => harness.service.settleDepositByBroadcast(ORGANIZATION_ID, second.id, TX_HASH),
      PaymentErrorCode.PAYMENT_DEPOSIT_TRANSACTION_ALREADY_CLAIMED,
    );
    expect(harness.ledger.appendNow).toHaveBeenCalledTimes(1);
    const after = await harness.depositIntents.findById(ORGANIZATION_ID, second.id);
    expect(after.status).toBe(DepositIntentStatus.CREATED);
  });

  it('never credits a transaction that credits nobody this intent names', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    try {
      const adapter = selfBroadcastAdapter({ observeTransfer: jest.fn().mockResolvedValue(null) });
      const harness = buildHarness({ adapter });
      const intent = await createdIntent(harness);

      const settling = expectErrorCodeAsync(
        () => harness.service.settleDepositByBroadcast(ORGANIZATION_ID, intent.id, TX_HASH),
        PaymentErrorCode.PAYMENT_SETTLEMENT_FAILED,
      );
      await jest.advanceTimersByTimeAsync(DEPOSIT_OBSERVE_TIMEOUT_MS + DEPOSIT_OBSERVE_POLL_MS);
      await settling;

      expect(harness.ledger.appendNow).not.toHaveBeenCalled();
      const after = await harness.depositIntents.findById(ORGANIZATION_ID, intent.id);
      expect(after.status).toBe(DepositIntentStatus.FAILED);
    } finally {
      jest.useRealTimers();
    }
  });

  it('never credits less than was requested', async () => {
    const adapter = selfBroadcastAdapter({
      extractSettledAmount: jest.fn().mockImplementation(() => {
        throw ChainErrors.payloadMalformed({ reason: 'underpaid' });
      }),
    });
    const harness = buildHarness({ adapter });
    const intent = await createdIntent(harness);

    await expect(
      harness.service.settleDepositByBroadcast(ORGANIZATION_ID, intent.id, TX_HASH),
    ).rejects.toThrow();
    expect(harness.ledger.appendNow).not.toHaveBeenCalled();
    const after = await harness.depositIntents.findById(ORGANIZATION_ID, intent.id);
    expect(after.status).toBe(DepositIntentStatus.FAILED);
  });

  it('refuses an expired intent before reading the chain', async () => {
    const adapter = selfBroadcastAdapter();
    const harness = buildHarness({ adapter });
    const intent = await createdIntent(harness);
    const row = harness.repo.rows.get(intent.id);
    if (row) row.expiresAt = new Date(Date.now() - 1_000);

    await expectErrorCodeAsync(
      () => harness.service.settleDepositByBroadcast(ORGANIZATION_ID, intent.id, TX_HASH),
      PaymentErrorCode.PAYMENT_DEPOSIT_EXPIRED,
    );
    expect(adapter.observeTransfer).not.toHaveBeenCalled();
  });

  it('answers an already-SETTLED intent with itself, crediting nothing twice', async () => {
    const adapter = selfBroadcastAdapter();
    const harness = buildHarness({ adapter });
    const intent = await createdIntent(harness);
    await harness.service.settleDepositByBroadcast(ORGANIZATION_ID, intent.id, TX_HASH);

    const again = await harness.service.settleDepositByBroadcast(
      ORGANIZATION_ID,
      intent.id,
      TX_HASH,
    );

    expect(again.status).toBe(DepositIntentStatus.SETTLED);
    expect(harness.ledger.appendNow).toHaveBeenCalledTimes(1);
  });
});

function dummyPayload() {
  return {
    x402Version: 2,
    scheme: 'exact',
    network: SOLANA_DEVNET,
    payload: { transaction: 'ZmFrZQ==' },
  };
}
