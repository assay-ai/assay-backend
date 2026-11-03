import { BadRequestException } from '@nestjs/common';

import { DEPOSIT_PAYMENT_SCHEMES } from '@modules/payment/domain/deposit-wire';
import { EVM_PAYMENT_SCHEME } from '@modules/chains/evm/evm-chain.adapter';
import { SOLANA_PAYMENT_SCHEME } from '@modules/chains/solana/solana.constants';
import { TxRef } from '@modules/chains/ports/x402.types';
import { X402_INVALID_REASON } from '@modules/chains/facilitator/facilitator.wire';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import {
  AccountId,
  ChainId,
  ChainNamespace,
  CHAIN_IDS,
  toAccountId,
} from '@modules/chains/ports/caip.types';
import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { ChainErrorCode, ChainErrors } from '@modules/chains/errors/chains.errors';
import { MoneyUtil } from '@shared/utils/money.util';

import { DepositIntentService } from '@modules/payment/services/deposit-intent.service';
import { DepositService } from '@modules/payment/services/deposit.service';
import { DepositIntentStatus } from '@modules/payment/ports/deposit.types';
import {
  DEPOSIT_COVERAGE_WAIT_MS,
  DEPOSIT_MAX_OPEN_INTENTS_PER_AGENT,
  DEPOSIT_OBSERVE_POLL_MS,
  DEPOSIT_OBSERVE_TIMEOUT_MS,
  DEPOSIT_TX_MAX_AGE_BEFORE_INTENT_MS,
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
  fakeCoverage,
} from './helpers/deposit-harness';

const SOLANA_DEVNET: ChainId = CHAIN_IDS.SOLANA_DEVNET;
const USDC = ASSET_IDS.USDC_SOLANA_DEVNET;
const ORGANIZATION_ID = '11111111-1111-1111-1111-111111111111';
const AGENT_ID = '22222222-2222-2222-2222-222222222222';
/** A person's view: the whole organization. */
const ORG = { organizationId: ORGANIZATION_ID, agentId: null };
/** An agent credential's view: its own agent only. */
const AGENT_SCOPE = { organizationId: ORGANIZATION_ID, agentId: AGENT_ID };
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
  coverage?: { check: jest.Mock };
  audit?: { recordAfterCommit: jest.Mock };
}) {
  const repo = new FakeDepositIntentRepository();
  const depositIntents = new DepositIntentService(repo.asRepository());
  const adapter = overrides?.adapter ?? fakeChainAdapter();
  const facilitator = overrides?.facilitator ?? fakeFacilitator();
  const opener = overrides?.opener ?? fakeEscrowOpener();
  const escrowReader = overrides?.escrowReader ?? fakeEscrowBalanceReader();
  const ledger = overrides?.ledger ?? fakeLedger();
  const coverage = overrides?.coverage ?? fakeCoverage();
  const audit = overrides?.audit ?? { recordAfterCommit: jest.fn().mockResolvedValue(undefined) };
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
    coverage as never,
    (overrides?.chainState ?? null) as never,
    audit as never,
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
    coverage,
    audit,
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

    const settled = await service.settleDeposit(ORG, intent.id, dummyPayload());

    expect(settled.status).toBe(DepositIntentStatus.SETTLED);
    expect(settled.settledAmount?.amount).toBe('5000000');
    expect(settled.chainTxRef).toBe(TX_SIG);
    expect(ledger.appendNow).toHaveBeenCalledTimes(1);
    expect(ledger.appendNow).toHaveBeenCalledWith(
      expect.objectContaining({ entryType: LedgerEntryType.DEPOSIT_PENDING, intentId: intent.id }),
    );

    const reread = await depositIntents.findById(ORG, intent.id);
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
    await service.settleDeposit(ORG, intent.id, dummyPayload());

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
    await service.settleDeposit(ORG, intent.id, dummyPayload());

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

    const settled = await service.settleDeposit(ORG, intent.id, dummyPayload());

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
      () => harness.service.settleDeposit(ORG, intent.id, dummyPayload()),
      PaymentErrorCode.PAYMENT_INVALID_SIGNATURE,
    );
    expect(facilitator.settle).not.toHaveBeenCalled();
    expect(harness.ledger.appendNow).not.toHaveBeenCalled();
    const after = await harness.depositIntents.findById(ORG, intent.id);
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
      () => harness.service.settleDeposit(ORG, intent.id, dummyPayload()),
      ChainErrorCode.CHAIN_SETTLED_AMOUNT_BELOW_INTENT,
    );
    expect(harness.ledger.appendNow).not.toHaveBeenCalled();
    const after = await harness.depositIntents.findById(ORG, intent.id);
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

    const settled = await harness.service.settleDeposit(ORG, intent.id, dummyPayload());
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
      () => harness.service.settleDeposit(ORG, intent.id, dummyPayload()),
      ChainErrorCode.CHAIN_SETTLED_ASSET_MISMATCH,
    );
    expect(harness.ledger.appendNow).not.toHaveBeenCalled();
  });

  it('a scheme other than exact: PAYMENT_UNSUPPORTED_SCHEME before the payload is decoded (BUG-BUY-MONEY-05)', async () => {
    const adapter = fakeChainAdapter();
    const facilitator = fakeFacilitator();
    const harness = buildHarness({ adapter, facilitator });
    const intent = await createdIntent(harness);

    await expectErrorCodeAsync(
      () =>
        harness.service.settleDeposit(ORG, intent.id, {
          ...dummyPayload(),
          scheme: 'upto',
        }),
      PaymentErrorCode.PAYMENT_UNSUPPORTED_SCHEME,
    );
    expect(adapter.assertPayloadBoundToIntent).not.toHaveBeenCalled();
    expect(facilitator.verify).not.toHaveBeenCalled();
    const after = await harness.depositIntents.findById(ORG, intent.id);
    expect(after.status).toBe(DepositIntentStatus.CREATED);
  });

  it('the exact scheme still reaches the network and payload check', async () => {
    const adapter = fakeChainAdapter({
      assertPayloadBoundToIntent: jest.fn().mockImplementation(() => {
        throw ChainErrors.payloadNotBoundToIntent({ intentId: 'x', reason: 'checked' });
      }),
    });
    const harness = buildHarness({ adapter });
    const intent = await createdIntent(harness);

    await expectErrorCodeAsync(
      () => harness.service.settleDeposit(ORG, intent.id, dummyPayload()),
      ChainErrorCode.CHAIN_PAYLOAD_NOT_BOUND_TO_INTENT,
    );
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
      () => harness.service.settleDeposit(ORG, intent.id, dummyPayload()),
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
      () => harness.service.settleDeposit(ORG, intent.id, dummyPayload()),
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
      () => harness.service.settleDeposit(ORG, intent.id, dummyPayload()),
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
      () => harness.service.settleDeposit(ORG, intent.id, dummyPayload()),
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
      () => harness.service.settleDeposit(ORG, intent.id, dummyPayload()),
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

    const first = await harness.service.settleDeposit(ORG, intent.id, dummyPayload());
    const second = await harness.service.settleDeposit(ORG, intent.id, dummyPayload());

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
      () => harness.service.settleDeposit(ORG, intent.id, dummyPayload()),
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
      () => harness.service.settleDeposit(ORG, intent.id, dummyPayload()),
      PaymentErrorCode.PAYMENT_INSUFFICIENT_FUNDS,
    );
    const after = await harness.depositIntents.findById(ORG, intent.id);
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
        () => harness.service.settleDeposit(ORG, intent.id, dummyPayload()),
        PaymentErrorCode.PAYMENT_DEPOSIT_TRANSFER_NOT_OBSERVED,
      );
      await jest.advanceTimersByTimeAsync(DEPOSIT_OBSERVE_TIMEOUT_MS + DEPOSIT_OBSERVE_POLL_MS);
      await settling;

      expect(harness.ledger.appendNow).not.toHaveBeenCalled();
      const after = await harness.depositIntents.findById(ORG, intent.id);
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

      const settling = harness.service.settleDeposit(ORG, intent.id, dummyPayload());
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
  const OTHER_HASH = `0x${'cd'.repeat(32)}` as TxRef;
  const observed = { amount: '5000000', asset: USDC, decimals: 6 };
  const OTHER_AGENT = '44444444-4444-4444-4444-444444444444';
  const OTHER_ORG = '55555555-5555-5555-5555-555555555555';
  const OTHER_ACCOUNT: AccountId = toAccountId(
    SOLANA_DEVNET,
    'OtherAccount1111111111111111111111111111111',
  );
  const CALLER = {
    actor: { type: 'agent' as const, id: AGENT_ID },
    credentialId: '66666666-6666-6666-6666-666666666666',
  };

  /** Mined now, crediting the intent's buyer: the honest answer. */
  const credited = (blockTime: Date = new Date()) => ({
    kind: 'credited' as const,
    transfer: observed,
    blockTime,
  });

  async function createdIntent(
    harness: ReturnType<typeof buildHarness>,
    overrides: Partial<ReturnType<typeof input>> = {},
  ) {
    const { intent } = await harness.service.createDeposit({ ...input(), ...overrides });
    return intent;
  }

  function selfBroadcastAdapter(overrides: Parameters<typeof fakeChainAdapter>[0] = {}) {
    return fakeChainAdapter({
      requiresFeePayer: false,
      observeDeposit: jest.fn().mockImplementation(async () => credited()),
      extractSettledAmount: jest.fn().mockReturnValue(amount()),
      ...overrides,
    });
  }

  /**
   * The chain as it really answers: the transaction credits `buyer` only, and
   * a claim for any other account finds it crediting nobody.
   */
  function chainCrediting(buyer: AccountId, state: { mined: boolean } = { mined: true }) {
    return jest.fn().mockImplementation(async (intent: { payer: AccountId }) => {
      if (!state.mined) return { kind: 'pending' };
      return intent.payer === buyer ? credited() : { kind: 'no_credit' };
    });
  }

  async function errorOf(work: () => Promise<unknown>) {
    return work().then(
      () => {
        throw new Error('expected a refusal');
      },
      (error: unknown) => error as { errorCode: string; statusCode: number; message: string },
    );
  }

  afterEach(() => jest.useRealTimers());

  it('reads the transfer off the chain, credits DEPOSIT_PENDING once, and reaches SETTLED — no facilitator', async () => {
    const adapter = selfBroadcastAdapter();
    const harness = buildHarness({ adapter });
    const intent = await createdIntent(harness);

    const settled = await harness.service.settleDepositByBroadcast(ORG, intent.id, TX_HASH);

    expect(settled.status).toBe(DepositIntentStatus.SETTLED);
    expect(settled.chainTxRef).toBe(TX_HASH);
    expect(harness.facilitator.verify).not.toHaveBeenCalled();
    expect(harness.facilitator.settle).not.toHaveBeenCalled();
    expect(adapter.observeDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ payer: AGENT_ACCOUNT }),
      TX_HASH,
    );
    expect(harness.ledger.appendNow).toHaveBeenCalledTimes(1);
    expect(harness.ledger.appendNow).toHaveBeenCalledWith(
      expect.objectContaining({
        entryType: LedgerEntryType.DEPOSIT_PENDING,
        intentId: intent.id,
        chainTxRef: TX_HASH,
      }),
    );
    // H-1: the escrow must cover the ledger's claim plus THIS credit.
    expect(harness.coverage.check).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      AGENT_ACCOUNT,
      USDC,
      5_000_000n,
    );
  });

  it('allows a scoped caller to report its own deposit and keeps a retry of the same hash idempotent', async () => {
    const harness = buildHarness({ adapter: selfBroadcastAdapter() });
    const intent = await createdIntent(harness);

    const first = await harness.service.settleDepositByBroadcast(AGENT_SCOPE, intent.id, TX_HASH);
    const again = await harness.service.settleDepositByBroadcast(AGENT_SCOPE, intent.id, TX_HASH);

    expect(first.status).toBe(DepositIntentStatus.SETTLED);
    expect(again.id).toBe(first.id);
    expect(harness.ledger.appendNow).toHaveBeenCalledTimes(1);
  });

  // L-2: a second, different deposit reported on a settled intent was told
  // "SETTLED" while its own money stayed uncredited.
  it('answers 409 for a DIFFERENT hash on an already-settled intent, crediting nothing', async () => {
    const adapter = selfBroadcastAdapter();
    const harness = buildHarness({ adapter });
    const intent = await createdIntent(harness);
    await harness.service.settleDepositByBroadcast(ORG, intent.id, TX_HASH);
    jest.clearAllMocks();

    await expectErrorCodeAsync(
      () => harness.service.settleDepositByBroadcast(ORG, intent.id, OTHER_HASH),
      PaymentErrorCode.PAYMENT_DEPOSIT_ALREADY_SETTLED,
    );
    expect(adapter.observeDeposit).not.toHaveBeenCalled();
    expect(harness.ledger.appendNow).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'hides another agent deposit before chain or ledger work, including settled=%s',
    async (settled) => {
      const adapter = selfBroadcastAdapter();
      const harness = buildHarness({ adapter });
      const intent = await createdIntent(harness);
      if (settled) {
        await harness.service.settleDepositByBroadcast(ORG, intent.id, TX_HASH);
      }
      jest.clearAllMocks();

      await expectErrorCodeAsync(
        () =>
          harness.service.settleDepositByBroadcast(
            { organizationId: ORGANIZATION_ID, agentId: OTHER_AGENT },
            intent.id,
            TX_HASH,
          ),
        PaymentErrorCode.PAYMENT_DEPOSIT_NOT_FOUND,
      );
      expect(adapter.observeDeposit).not.toHaveBeenCalled();
      expect(harness.ledger.appendNow).not.toHaveBeenCalled();
    },
  );

  it('does not widen organization scope when the agent id matches', async () => {
    const adapter = selfBroadcastAdapter();
    const harness = buildHarness({ adapter });
    const intent = await createdIntent(harness);

    await expectErrorCodeAsync(
      () =>
        harness.service.settleDepositByBroadcast(
          { organizationId: OTHER_ORG, agentId: AGENT_ID },
          intent.id,
          TX_HASH,
        ),
      PaymentErrorCode.PAYMENT_DEPOSIT_NOT_FOUND,
    );
    expect(adapter.observeDeposit).not.toHaveBeenCalled();
  });

  it('refuses on a chain whose transactions need the platform as fee payer', async () => {
    const adapter = selfBroadcastAdapter({ requiresFeePayer: true });
    const harness = buildHarness({ adapter });
    const intent = await createdIntent(harness);

    await expectErrorCodeAsync(
      () => harness.service.settleDepositByBroadcast(ORG, intent.id, TX_HASH),
      PaymentErrorCode.PAYMENT_DEPOSIT_BROADCAST_UNSUPPORTED,
    );
    expect(adapter.observeDeposit).not.toHaveBeenCalled();
  });

  it('refuses on a chain whose adapter cannot date a transaction (no observeDeposit)', async () => {
    const adapter = selfBroadcastAdapter({ observeDeposit: undefined });
    const harness = buildHarness({ adapter });
    const intent = await createdIntent(harness);

    await expectErrorCodeAsync(
      () => harness.service.settleDepositByBroadcast(ORG, intent.id, TX_HASH),
      PaymentErrorCode.PAYMENT_DEPOSIT_BROADCAST_UNSUPPORTED,
    );
    expect(harness.ledger.appendNow).not.toHaveBeenCalled();
  });

  describe('single use, per (transaction, buyer), platform-wide', () => {
    it('refuses a transaction another deposit already credited to this buyer', async () => {
      const harness = buildHarness({ adapter: selfBroadcastAdapter() });
      const first = await createdIntent(harness);
      await harness.service.settleDepositByBroadcast(ORG, first.id, TX_HASH);
      const second = await createdIntent(harness);

      await expectErrorCodeAsync(
        () => harness.service.settleDepositByBroadcast(ORG, second.id, TX_HASH),
        PaymentErrorCode.PAYMENT_DEPOSIT_TRANSACTION_ALREADY_CLAIMED,
      );
      expect(harness.ledger.appendNow).toHaveBeenCalledTimes(1);
      const after = await harness.depositIntents.findById(ORG, second.id);
      expect(after.status).toBe(DepositIntentStatus.CREATED);
    });

    // M-3: the pre-check was per organization, so another organization's claim
    // was found only by the unique index, after a 20 s observe.
    it('finds a claim held in ANOTHER organization, before reading the chain', async () => {
      const adapter = selfBroadcastAdapter();
      const harness = buildHarness({ adapter });
      const intent = await createdIntent(harness);
      const foreignId = '77777777-7777-7777-7777-777777777777';
      const template = harness.repo.rows.get(intent.id)!;
      harness.repo.rows.set(foreignId, {
        ...template,
        id: foreignId,
        organizationId: OTHER_ORG,
        status: DepositIntentStatus.SETTLED,
        chainTxRef: TX_HASH,
        settledAmount: '5000000',
      } as unknown as typeof template);

      const error = await errorOf(() =>
        harness.service.settleDepositByBroadcast(ORG, intent.id, TX_HASH),
      );

      expect(error.errorCode).toBe(PaymentErrorCode.PAYMENT_DEPOSIT_TRANSACTION_ALREADY_CLAIMED);
      expect(adapter.observeDeposit).not.toHaveBeenCalled();
      // Low-1 / L-1: the answer names no other deposit and no organization.
      expect(error.message).not.toContain(foreignId);
      expect(error.message).not.toContain(OTHER_ORG);
      expect((error as unknown as { publicContext?: unknown }).publicContext).toBeUndefined();
    });

    it('finds a ledger-only credit of the same transaction and buyer', async () => {
      const harness = buildHarness({ adapter: selfBroadcastAdapter() });
      const intent = await createdIntent(harness);
      harness.repo.ledgerClaims.add(`${TX_HASH}|${AGENT_ACCOUNT}`);

      await expectErrorCodeAsync(
        () => harness.service.settleDepositByBroadcast(ORG, intent.id, TX_HASH),
        PaymentErrorCode.PAYMENT_DEPOSIT_TRANSACTION_ALREADY_CLAIMED,
      );
    });

    // A batch transaction funding two buyers: each claims its own share, once.
    it('lets a second buyer claim its own events in a transaction another buyer already claimed', async () => {
      const harness = buildHarness({ adapter: selfBroadcastAdapter() });
      const first = await createdIntent(harness);
      await harness.service.settleDepositByBroadcast(ORG, first.id, TX_HASH);
      const second = await createdIntent(harness, {
        agentId: OTHER_AGENT,
        agentAccount: OTHER_ACCOUNT,
      });

      const settled = await harness.service.settleDepositByBroadcast(ORG, second.id, TX_HASH);

      expect(settled.status).toBe(DepositIntentStatus.SETTLED);
      expect(harness.ledger.appendNow).toHaveBeenCalledTimes(2);
      expect(harness.ledger.appendNow).toHaveBeenLastCalledWith(
        expect.objectContaining({ accountId: OTHER_ACCOUNT, chainTxRef: TX_HASH }),
      );
    });

    // An EVM hash is case-insensitive on the node but compared byte for byte by
    // the claim lookup and both single-use indexes.
    it('refuses a case variant of a transaction already claimed, and stores the hash lowercase', async () => {
      const adapter = selfBroadcastAdapter({ namespace: ChainNamespace.EIP155 });
      const harness = buildHarness({ adapter });
      const first = await createdIntent(harness);
      const mixed = `0x${'aB'.repeat(32)}` as TxRef;

      const settled = await harness.service.settleDepositByBroadcast(ORG, first.id, mixed);
      expect(settled.chainTxRef).toBe(mixed.toLowerCase());
      // The same hash in another spelling is still the idempotent retry.
      const again = await harness.service.settleDepositByBroadcast(
        ORG,
        first.id,
        mixed.toUpperCase().replace('0X', '0x') as TxRef,
      );
      expect(again.id).toBe(first.id);

      const second = await createdIntent(harness);
      await expectErrorCodeAsync(
        () =>
          harness.service.settleDepositByBroadcast(
            ORG,
            second.id,
            mixed.toUpperCase().replace('0X', '0x') as TxRef,
          ),
        PaymentErrorCode.PAYMENT_DEPOSIT_TRANSACTION_ALREADY_CLAIMED,
      );
      expect(harness.ledger.appendNow).toHaveBeenCalledTimes(1);
    });

    // HIGH-1 regression: two concurrent claims both pass the read-then-write
    // check; `uq_ledger_entries_deposit_pending_account` refuses the loser.
    it('fails the loser of a concurrent claim cleanly, with a readable message', async () => {
      const uniqueViolation = Object.assign(new Error('duplicate key value'), { code: '23505' });
      const ledger = fakeLedger({ appendNow: jest.fn().mockRejectedValue(uniqueViolation) });
      const harness = buildHarness({ adapter: selfBroadcastAdapter(), ledger });
      const intent = await createdIntent(harness);

      const error = await errorOf(() =>
        harness.service.settleDepositByBroadcast(ORG, intent.id, TX_HASH),
      );

      expect(error.errorCode).toBe(PaymentErrorCode.PAYMENT_DEPOSIT_TRANSACTION_ALREADY_CLAIMED);
      expect(error.message).not.toContain('deposit a concurrent deposit');
      expect(error.message).toContain('already been credited');
      const after = await harness.depositIntents.findById(ORG, intent.id);
      expect(after.status).toBe(DepositIntentStatus.FAILED);
      expect(after.chainTxRef).toBeNull();
    });

    it('re-raises a ledger failure that is not the pending-credit unique violation', async () => {
      const ledger = fakeLedger({ appendNow: jest.fn().mockRejectedValue(new Error('db down')) });
      const harness = buildHarness({ adapter: selfBroadcastAdapter(), ledger });
      const intent = await createdIntent(harness);

      await expect(
        harness.service.settleDepositByBroadcast(ORG, intent.id, TX_HASH),
      ).rejects.toThrow('db down');
    });
  });

  describe("someone else's hash never reserves or burns it", () => {
    const VICTIM_HASH = TX_HASH;

    async function attackerAndVictim(
      harness: ReturnType<typeof buildHarness>,
      attackerOrg: string,
    ) {
      const victim = await createdIntent(harness);
      if (attackerOrg !== ORGANIZATION_ID) {
        harness.escrows.rows.push({
          id: 'escrow-attacker',
          organizationId: attackerOrg,
          accountId: OTHER_ACCOUNT,
          assetId: USDC,
          escrowAccountId: toAccountId(SOLANA_DEVNET, 'AttackerEscrowPda111111111111111111111111'),
          escrowAssetAccountId: toAccountId(
            SOLANA_DEVNET,
            'AttackerEscrowToken11111111111111111111111',
          ),
          openedTxRef: 'AttackerOpen1111111111111111111111111111111111111111111111111111111111',
        });
      }
      const attacker = await createdIntent(harness, {
        organizationId: attackerOrg,
        agentId: OTHER_AGENT,
        agentAccount: OTHER_ACCOUNT,
      });
      return { victim, attacker };
    }

    it.each([
      ['the same organization (another agent)', ORGANIZATION_ID],
      ['another organization', OTHER_ORG],
    ])(
      'an attacker in %s reporting the victim hash first is refused; the victim is then credited',
      async (_label, attackerOrg) => {
        const observeDeposit = chainCrediting(AGENT_ACCOUNT);
        const harness = buildHarness({ adapter: selfBroadcastAdapter({ observeDeposit }) });
        const { victim, attacker } = await attackerAndVictim(harness, attackerOrg);

        await expectErrorCodeAsync(
          () =>
            harness.service.settleDepositByBroadcast(
              { organizationId: attackerOrg, agentId: OTHER_AGENT },
              attacker.id,
              VICTIM_HASH,
            ),
          PaymentErrorCode.PAYMENT_DEPOSIT_TRANSACTION_CREDITS_NOTHING,
        );
        const attackerAfter = await harness.depositIntents.findById(
          { organizationId: attackerOrg, agentId: null },
          attacker.id,
        );
        expect(attackerAfter.status).toBe(DepositIntentStatus.CREATED);
        expect(attackerAfter.chainTxRef).toBeNull();

        const settled = await harness.service.settleDepositByBroadcast(
          AGENT_SCOPE,
          victim.id,
          VICTIM_HASH,
        );
        expect(settled.status).toBe(DepositIntentStatus.SETTLED);
        expect(harness.ledger.appendNow).toHaveBeenCalledTimes(1);
        expect(harness.ledger.appendNow).toHaveBeenCalledWith(
          expect.objectContaining({ accountId: AGENT_ACCOUNT, chainTxRef: VICTIM_HASH }),
        );
      },
    );

    it('an attacker reporting the hash while the victim claim is SETTLING changes nothing', async () => {
      const observeDeposit = chainCrediting(AGENT_ACCOUNT);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const appendNow = jest.fn().mockImplementation(() => gate.then(() => ({})));
      const harness = buildHarness({
        adapter: selfBroadcastAdapter({ observeDeposit }),
        ledger: fakeLedger({ appendNow }),
      });
      const { victim, attacker } = await attackerAndVictim(harness, ORGANIZATION_ID);

      const victimClaim = harness.service.settleDepositByBroadcast(AGENT_SCOPE, victim.id, TX_HASH);
      // Let the victim reach the ledger write (SETTLING).
      for (let i = 0; i < 20 && appendNow.mock.calls.length === 0; i += 1) {
        await Promise.resolve();
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect((await harness.depositIntents.findById(ORG, victim.id)).status).toBe(
        DepositIntentStatus.SETTLING,
      );

      await expectErrorCodeAsync(
        () =>
          harness.service.settleDepositByBroadcast(
            { organizationId: ORGANIZATION_ID, agentId: OTHER_AGENT },
            attacker.id,
            TX_HASH,
          ),
        PaymentErrorCode.PAYMENT_DEPOSIT_TRANSACTION_CREDITS_NOTHING,
      );

      release();
      const settled = await victimClaim;
      expect(settled.status).toBe(DepositIntentStatus.SETTLED);
      expect(appendNow).toHaveBeenCalledTimes(1);
    });

    it('an attacker front-running a victim tx that is not mined yet is refused; the victim is credited later', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      const chain = { mined: false };
      const observeDeposit = chainCrediting(AGENT_ACCOUNT, chain);
      const harness = buildHarness({ adapter: selfBroadcastAdapter({ observeDeposit }) });
      const { victim, attacker } = await attackerAndVictim(harness, ORGANIZATION_ID);
      const attackerScope = { organizationId: ORGANIZATION_ID, agentId: OTHER_AGENT };

      const early = expectErrorCodeAsync(
        () => harness.service.settleDepositByBroadcast(attackerScope, attacker.id, TX_HASH),
        PaymentErrorCode.PAYMENT_DEPOSIT_TRANSFER_NOT_OBSERVED,
      );
      await jest.advanceTimersByTimeAsync(DEPOSIT_OBSERVE_TIMEOUT_MS + DEPOSIT_OBSERVE_POLL_MS);
      await early;

      chain.mined = true;
      await expectErrorCodeAsync(
        () => harness.service.settleDepositByBroadcast(attackerScope, attacker.id, TX_HASH),
        PaymentErrorCode.PAYMENT_DEPOSIT_TRANSACTION_CREDITS_NOTHING,
      );

      const settled = await harness.service.settleDepositByBroadcast(
        AGENT_SCOPE,
        victim.id,
        TX_HASH,
      );
      expect(settled.status).toBe(DepositIntentStatus.SETTLED);
      expect(harness.ledger.appendNow).toHaveBeenCalledTimes(1);
    });
  });

  describe('what the chain answers', () => {
    // M-1: a mined transaction that credits nobody used to be polled for the
    // whole 20 s window, about 27 RPC reads per bogus report.
    it('answers a mined transaction crediting nobody at once, leaving the intent open', async () => {
      const observeDeposit = jest.fn().mockResolvedValue({ kind: 'no_credit' });
      const harness = buildHarness({ adapter: selfBroadcastAdapter({ observeDeposit }) });
      const intent = await createdIntent(harness);

      const error = await errorOf(() =>
        harness.service.settleDepositByBroadcast(ORG, intent.id, TX_HASH),
      );

      expect(error.statusCode).toBe(422);
      expect(error.errorCode).toBe(PaymentErrorCode.PAYMENT_DEPOSIT_TRANSACTION_CREDITS_NOTHING);
      expect(observeDeposit).toHaveBeenCalledTimes(1);
      expect(harness.ledger.appendNow).not.toHaveBeenCalled();
      const after = await harness.depositIntents.findById(ORG, intent.id);
      expect(after.status).toBe(DepositIntentStatus.CREATED);
      expect(after.chainTxRef).toBeNull();
    });

    // BUG-PROD-BUY-MONEY-02: a readable 422, never a 502. L-3: and the intent
    // stays open, so the same hash can be reported once it is mined.
    it('answers a transaction not mined within the window with a 422, then credits the same hash on the same intent', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick'] });
      const chain = { mined: false };
      const observeDeposit = chainCrediting(AGENT_ACCOUNT, chain);
      const harness = buildHarness({ adapter: selfBroadcastAdapter({ observeDeposit }) });
      const intent = await createdIntent(harness);

      const settling = errorOf(() =>
        harness.service.settleDepositByBroadcast(ORG, intent.id, TX_HASH),
      );
      await jest.advanceTimersByTimeAsync(DEPOSIT_OBSERVE_TIMEOUT_MS + DEPOSIT_OBSERVE_POLL_MS);
      const error = await settling;

      expect(error.statusCode).toBe(422);
      expect(error.errorCode).toBe(PaymentErrorCode.PAYMENT_DEPOSIT_TRANSFER_NOT_OBSERVED);
      expect((await harness.depositIntents.findById(ORG, intent.id)).status).toBe(
        DepositIntentStatus.CREATED,
      );

      chain.mined = true;
      const settled = await harness.service.settleDepositByBroadcast(ORG, intent.id, TX_HASH);
      expect(settled.status).toBe(DepositIntentStatus.SETTLED);
    });

    // M-2: an RPC error is not "the transaction is not there".
    it('answers an unreadable chain with a retryable 503, failing and burning nothing', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick'] });
      const observeDeposit = jest
        .fn()
        .mockRejectedValue(ChainErrors.rpcReadFailed({ method: 'eth_getTransactionReceipt' }));
      const harness = buildHarness({ adapter: selfBroadcastAdapter({ observeDeposit }) });
      const intent = await createdIntent(harness);

      const settling = errorOf(() =>
        harness.service.settleDepositByBroadcast(ORG, intent.id, TX_HASH),
      );
      await jest.advanceTimersByTimeAsync(DEPOSIT_OBSERVE_TIMEOUT_MS + DEPOSIT_OBSERVE_POLL_MS);
      const error = await settling;

      expect(error.statusCode).toBe(503);
      expect(error.errorCode).toBe(ChainErrorCode.CHAIN_RPC_READ_FAILED);
      expect(observeDeposit.mock.calls.length).toBeGreaterThan(1);
      const after = await harness.depositIntents.findById(ORG, intent.id);
      expect(after.status).toBe(DepositIntentStatus.CREATED);
      expect(after.chainTxRef).toBeNull();
      expect(harness.ledger.appendNow).not.toHaveBeenCalled();

      jest.useRealTimers();
      observeDeposit.mockImplementation(async () => credited());
      const settled = await harness.service.settleDepositByBroadcast(ORG, intent.id, TX_HASH);
      expect(settled.status).toBe(DepositIntentStatus.SETTLED);
    });

    it('rides out a transient RPC error inside the window', async () => {
      const observeDeposit = jest
        .fn()
        .mockRejectedValueOnce(ChainErrors.rpcReadFailed({ method: 'eth_getTransactionReceipt' }))
        .mockImplementation(async () => credited());
      jest.useFakeTimers({ doNotFake: ['nextTick'] });
      const harness = buildHarness({ adapter: selfBroadcastAdapter({ observeDeposit }) });
      const intent = await createdIntent(harness);

      const settling = harness.service.settleDepositByBroadcast(ORG, intent.id, TX_HASH);
      await jest.advanceTimersByTimeAsync(DEPOSIT_OBSERVE_POLL_MS * 2);

      expect((await settling).status).toBe(DepositIntentStatus.SETTLED);
    });

    // BUG-PROD-BUY-MONEY-02: one RPC read may take the egress client's whole
    // 30 s budget. The observation window is a hard bound.
    it('stops waiting at the observation deadline even when a chain read hangs', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick'] });
      const adapter = selfBroadcastAdapter({
        observeDeposit: jest.fn().mockReturnValue(new Promise(() => undefined)),
      });
      const harness = buildHarness({ adapter });
      const intent = await createdIntent(harness);

      let done = false;
      const settling = errorOf(() =>
        harness.service.settleDepositByBroadcast(ORG, intent.id, TX_HASH),
      ).finally(() => {
        done = true;
      });
      await jest.advanceTimersByTimeAsync(DEPOSIT_OBSERVE_TIMEOUT_MS + 1);
      expect(done).toBe(true);
      expect((await settling).errorCode).toBe(ChainErrorCode.CHAIN_RPC_READ_FAILED);
      expect((await harness.depositIntents.findById(ORG, intent.id)).status).toBe(
        DepositIntentStatus.CREATED,
      );
    });

    it('keeps the observation window at 20 s, under the 30 s client timeout', () => {
      expect(DEPOSIT_OBSERVE_TIMEOUT_MS).toBe(20_000);
      expect(DEPOSIT_OBSERVE_TIMEOUT_MS + DEPOSIT_COVERAGE_WAIT_MS).toBeLessThan(30_000);
    });

    it('never credits less than was requested, and leaves the intent open', async () => {
      const adapter = selfBroadcastAdapter({
        extractSettledAmount: jest.fn().mockImplementation(() => {
          throw ChainErrors.payloadMalformed({ reason: 'underpaid' });
        }),
      });
      const harness = buildHarness({ adapter });
      const intent = await createdIntent(harness);

      await expect(
        harness.service.settleDepositByBroadcast(ORG, intent.id, TX_HASH),
      ).rejects.toThrow();
      expect(harness.ledger.appendNow).not.toHaveBeenCalled();
      expect((await harness.depositIntents.findById(ORG, intent.id)).status).toBe(
        DepositIntentStatus.CREATED,
      );
    });
  });

  // C-1 / H-1: a deposit is bound to the intent's lifetime and to the money
  // still being in the escrow.
  describe('money that is no longer (or never was for this intent) in the escrow', () => {
    it('refuses a transaction mined before the intent was created (old direct deposit)', async () => {
      const harness = buildHarness({ adapter: selfBroadcastAdapter() });
      const intent = await createdIntent(harness);
      const minedAt = new Date(
        intent.createdAt.getTime() - DEPOSIT_TX_MAX_AGE_BEFORE_INTENT_MS - 1_000,
      );
      (harness.adapter.observeDeposit as jest.Mock).mockResolvedValue(credited(minedAt));

      const error = await errorOf(() =>
        harness.service.settleDepositByBroadcast(ORG, intent.id, TX_HASH),
      );

      expect(error.errorCode).toBe(PaymentErrorCode.PAYMENT_DEPOSIT_TRANSACTION_PREDATES_INTENT);
      expect(error.statusCode).toBe(422);
      expect(harness.ledger.appendNow).not.toHaveBeenCalled();
      expect(harness.coverage.check).not.toHaveBeenCalled();
      expect((await harness.depositIntents.findById(ORG, intent.id)).status).toBe(
        DepositIntentStatus.CREATED,
      );
    });

    it('accepts a transaction mined within the clock skew before the intent', async () => {
      const harness = buildHarness({ adapter: selfBroadcastAdapter() });
      const intent = await createdIntent(harness);
      const minedAt = new Date(
        intent.createdAt.getTime() - DEPOSIT_TX_MAX_AGE_BEFORE_INTENT_MS + 1_000,
      );
      (harness.adapter.observeDeposit as jest.Mock).mockResolvedValue(credited(minedAt));

      const settled = await harness.service.settleDepositByBroadcast(ORG, intent.id, TX_HASH);
      expect(settled.status).toBe(DepositIntentStatus.SETTLED);
    });

    // Scenario B: inside one intent's lifetime — deposit, withdraw on chain,
    // then report. The time bound passes; the escrow balance does not.
    it('deposit -> withdraw -> claim: refuses a credit the escrow no longer covers, crediting nothing', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick'] });
      const coverage = fakeCoverage(false);
      const harness = buildHarness({ adapter: selfBroadcastAdapter(), coverage });
      const intent = await createdIntent(harness);

      const settling = errorOf(() =>
        harness.service.settleDepositByBroadcast(ORG, intent.id, TX_HASH),
      );
      await jest.advanceTimersByTimeAsync(DEPOSIT_COVERAGE_WAIT_MS + DEPOSIT_OBSERVE_POLL_MS);
      const error = await settling;

      expect(error.errorCode).toBe(PaymentErrorCode.PAYMENT_DEPOSIT_NOT_COVERED);
      expect(error.statusCode).toBe(409);
      // Asked again for the node-lag window, not once.
      expect(coverage.check.mock.calls.length).toBeGreaterThan(1);
      expect(harness.ledger.appendNow).not.toHaveBeenCalled();
      const after = await harness.depositIntents.findById(ORG, intent.id);
      expect(after.status).toBe(DepositIntentStatus.CREATED);
      expect(after.chainTxRef).toBeNull();
    });

    it('credits once a lagging balance read catches up inside the coverage window', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick'] });
      const coverage = fakeCoverage();
      coverage.check
        .mockResolvedValueOnce({ chain: 0n, claim: 0n, covered: false })
        .mockResolvedValue({ chain: 5_000_000n, claim: 0n, covered: true });
      const harness = buildHarness({ adapter: selfBroadcastAdapter(), coverage });
      const intent = await createdIntent(harness);

      const settling = harness.service.settleDepositByBroadcast(ORG, intent.id, TX_HASH);
      await jest.advanceTimersByTimeAsync(DEPOSIT_OBSERVE_POLL_MS * 2);

      expect((await settling).status).toBe(DepositIntentStatus.SETTLED);
    });

    it('answers a failed escrow read with the read error, leaving the intent open', async () => {
      const coverage = { check: jest.fn().mockRejectedValue(new Error('escrow unreadable')) };
      const harness = buildHarness({ adapter: selfBroadcastAdapter(), coverage });
      const intent = await createdIntent(harness);

      await expect(
        harness.service.settleDepositByBroadcast(ORG, intent.id, TX_HASH),
      ).rejects.toThrow('escrow unreadable');
      expect(harness.ledger.appendNow).not.toHaveBeenCalled();
      expect((await harness.depositIntents.findById(ORG, intent.id)).status).toBe(
        DepositIntentStatus.CREATED,
      );
    });
  });

  describe('on eip155, where the intent lives 10 minutes', () => {
    async function createdEvmIntent(harness: ReturnType<typeof buildHarness>) {
      return createdIntent(harness, {
        agentAccount: EVM_AGENT_ACCOUNT,
        chainId: CHAIN_IDS.ROBINHOOD_TESTNET,
        amount: MoneyUtil.of(5_000_000n, ASSET_IDS.USDG_ROBINHOOD_TESTNET, 6),
      });
    }

    it('still settles a broadcast that arrives after the old 90 s bound', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick'] });
      const harness = buildHarness({ adapter: selfBroadcastAdapter() });
      const intent = await createdEvmIntent(harness);
      expect(intent.expiresAt.getTime() - Date.now()).toBe(10 * 60 * 1000);

      jest.setSystemTime(Date.now() + 2 * 60 * 1000);
      const settled = await harness.service.settleDepositByBroadcast(ORG, intent.id, TX_HASH);

      expect(settled.status).toBe(DepositIntentStatus.SETTLED);
    });

    it('refuses a broadcast after the 10 minutes, before reading the chain', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick'] });
      const adapter = selfBroadcastAdapter();
      const harness = buildHarness({ adapter });
      const intent = await createdEvmIntent(harness);

      jest.setSystemTime(Date.now() + 10 * 60 * 1000 + 1);
      await expectErrorCodeAsync(
        () => harness.service.settleDepositByBroadcast(ORG, intent.id, TX_HASH),
        PaymentErrorCode.PAYMENT_DEPOSIT_EXPIRED,
      );

      expect(adapter.observeDeposit).not.toHaveBeenCalled();
      expect((await harness.depositIntents.findById(ORG, intent.id)).status).toBe(
        DepositIntentStatus.CREATED,
      );
    });
  });

  // BUG-PROD-BUY-MONEY-02: a hash that cannot exist is a bad request, refused
  // before the intent moves or the chain is read.
  it.each([
    '0xdeadbeef',
    `0x${'ab'.repeat(31)}`,
    `0x${'ab'.repeat(33)}`,
    `0x${'zz'.repeat(32)}`,
    'ab'.repeat(32),
  ])(
    'refuses the malformed EVM hash %p with a 400 VALIDATION_FAILED, leaving the intent CREATED',
    async (hash) => {
      const adapter = selfBroadcastAdapter({ namespace: ChainNamespace.EIP155 });
      const harness = buildHarness({ adapter });
      const intent = await createdIntent(harness);

      const error = await harness.service
        .settleDepositByBroadcast(ORG, intent.id, hash as TxRef)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(BadRequestException);
      const response = (error as BadRequestException).getResponse() as { message: string[] };
      expect(response.message).toEqual([
        'transactionHash must be a 0x-prefixed 32-byte hex transaction hash',
      ]);
      expect(adapter.observeDeposit).not.toHaveBeenCalled();
      expect((await harness.depositIntents.findById(ORG, intent.id)).status).toBe(
        DepositIntentStatus.CREATED,
      );
    },
  );

  it('refuses an expired intent before reading the chain', async () => {
    const adapter = selfBroadcastAdapter();
    const harness = buildHarness({ adapter });
    const intent = await createdIntent(harness);
    const row = harness.repo.rows.get(intent.id);
    if (row) row.expiresAt = new Date(Date.now() - 1_000);

    await expectErrorCodeAsync(
      () => harness.service.settleDepositByBroadcast(ORG, intent.id, TX_HASH),
      PaymentErrorCode.PAYMENT_DEPOSIT_EXPIRED,
    );
    expect(adapter.observeDeposit).not.toHaveBeenCalled();
  });

  // M-2 (business review): which key opened or reported a deposit.
  it('audits a key creating and reporting a deposit, naming the credential', async () => {
    const harness = buildHarness({ adapter: selfBroadcastAdapter() });
    const { intent } = await harness.service.createDeposit({ ...input(), caller: CALLER });
    await harness.service.settleDepositByBroadcast(AGENT_SCOPE, intent.id, TX_HASH, CALLER);

    expect(harness.audit.recordAfterCommit).toHaveBeenCalledTimes(2);
    expect(harness.audit.recordAfterCommit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        action: 'deposit.intent_created',
        actor: CALLER.actor,
        resourceId: intent.id,
        after: expect.objectContaining({ credentialId: CALLER.credentialId }),
      }),
    );
    expect(harness.audit.recordAfterCommit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: 'deposit.reported',
        after: expect.objectContaining({
          credentialId: CALLER.credentialId,
          transactionHash: TX_HASH,
        }),
      }),
    );
  });

  it('writes no caller audit row for a person', async () => {
    const harness = buildHarness({ adapter: selfBroadcastAdapter() });
    const intent = await createdIntent(harness);
    await harness.service.settleDepositByBroadcast(ORG, intent.id, TX_HASH);

    expect(harness.audit.recordAfterCommit).not.toHaveBeenCalled();
  });
});

describe('DepositService.createDeposit — open intents per agent', () => {
  it(`refuses the ${DEPOSIT_MAX_OPEN_INTENTS_PER_AGENT + 1}th open intent of one agent with 409 PAYMENT_DEPOSIT_OPEN_LIMIT`, async () => {
    const harness = buildHarness();
    for (let i = 0; i < DEPOSIT_MAX_OPEN_INTENTS_PER_AGENT; i += 1) {
      await harness.service.createDeposit(input());
    }

    const error = await harness.service.createDeposit(input()).catch((caught: unknown) => caught);

    expect((error as { errorCode: string }).errorCode).toBe(
      PaymentErrorCode.PAYMENT_DEPOSIT_OPEN_LIMIT,
    );
    expect((error as { statusCode: number }).statusCode).toBe(409);
    expect(harness.repo.rows.size).toBe(DEPOSIT_MAX_OPEN_INTENTS_PER_AGENT);
  });

  it('does not count an expired intent, nor another agent’s', async () => {
    const harness = buildHarness();
    for (let i = 0; i < DEPOSIT_MAX_OPEN_INTENTS_PER_AGENT; i += 1) {
      await harness.service.createDeposit(input());
    }
    await harness.service.createDeposit({
      ...input(),
      agentId: '88888888-8888-8888-8888-888888888888',
    });
    const [first] = [...harness.repo.rows.values()];
    first.expiresAt = new Date(Date.now() - 1);

    await expect(harness.service.createDeposit(input())).resolves.toBeDefined();
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

describe('DEPOSIT_PAYMENT_SCHEMES', () => {
  it('is the schemes the deposit adapters quote, and nothing else', () => {
    expect([...DEPOSIT_PAYMENT_SCHEMES].sort()).toEqual(
      [...new Set([SOLANA_PAYMENT_SCHEME, EVM_PAYMENT_SCHEME])].sort(),
    );
    expect(DEPOSIT_PAYMENT_SCHEMES.has('upto')).toBe(false);
  });
});

/**
 * The facilitator path shares the observation and the credit with the
 * buyer-broadcast path, but its intent is already SETTLING (the payload went
 * to the facilitator and may have landed), so its answers differ.
 */
describe('DepositService.settleDeposit — after the facilitator broadcast', () => {
  const observedTransfer = { amount: '5000000', asset: USDC, decimals: 6 };

  async function settling(adapterOverrides: Parameters<typeof fakeChainAdapter>[0], extra = {}) {
    const adapter = fakeChainAdapter({
      extractSettledAmount: jest.fn().mockReturnValue(amount()),
      ...adapterOverrides,
    });
    const facilitator = fakeFacilitator({
      settle: jest
        .fn()
        .mockResolvedValue({ success: true, network: SOLANA_DEVNET, transaction: TX_SIG }),
    });
    const harness = buildHarness({ adapter, facilitator, ...extra });
    const { intent } = await harness.service.createDeposit(input());
    return { harness, intent };
  }

  afterEach(() => jest.useRealTimers());

  it('fails a transaction crediting nobody at once, without polling', async () => {
    const observeDeposit = jest.fn().mockResolvedValue({ kind: 'no_credit' });
    const { harness, intent } = await settling({ observeDeposit });

    await expectErrorCodeAsync(
      () => harness.service.settleDeposit(ORG, intent.id, dummyPayload()),
      PaymentErrorCode.PAYMENT_DEPOSIT_TRANSACTION_CREDITS_NOTHING,
    );
    expect(observeDeposit).toHaveBeenCalledTimes(1);
    expect((await harness.depositIntents.findById(ORG, intent.id)).status).toBe(
      DepositIntentStatus.FAILED,
    );
  });

  // M-2: the transaction may have landed; an RPC blip must not fail it.
  it('leaves the intent SETTLING, uncredited and unburned, when the chain cannot be read', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    const observeTransfer = jest
      .fn()
      .mockRejectedValue(ChainErrors.rpcReadFailed({ method: 'getTransaction' }));
    const { harness, intent } = await settling({ observeTransfer });

    const pending = harness.service
      .settleDeposit(ORG, intent.id, dummyPayload())
      .catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(DEPOSIT_OBSERVE_TIMEOUT_MS + DEPOSIT_OBSERVE_POLL_MS);
    const error = (await pending) as { errorCode: string; statusCode: number };

    expect(error.errorCode).toBe(ChainErrorCode.CHAIN_RPC_READ_FAILED);
    expect(error.statusCode).toBe(503);
    const after = await harness.depositIntents.findById(ORG, intent.id);
    expect(after.status).toBe(DepositIntentStatus.SETTLING);
    expect(after.chainTxRef).toBeNull();
    expect(harness.ledger.appendNow).not.toHaveBeenCalled();
  });

  // H-1 on the shared path: the facilitator minted this deposit a moment ago,
  // so it is held as pending (never spendable) rather than lost, and finality
  // decides.
  it('holds an uncovered credit as pending only, leaving the decision to finality', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    const observeTransfer = jest.fn().mockResolvedValue(observedTransfer);
    const coverage = fakeCoverage(false);
    const { harness, intent } = await settling({ observeTransfer }, { coverage });

    const pending = harness.service.settleDeposit(ORG, intent.id, dummyPayload());
    await jest.advanceTimersByTimeAsync(DEPOSIT_COVERAGE_WAIT_MS + DEPOSIT_OBSERVE_POLL_MS);
    const settled = await pending;

    expect(settled.status).toBe(DepositIntentStatus.SETTLED);
    expect(coverage.check).toHaveBeenCalled();
    expect(harness.ledger.appendNow).toHaveBeenCalledTimes(1);
    expect(harness.ledger.appendNow).toHaveBeenCalledWith(
      expect.objectContaining({ entryType: LedgerEntryType.DEPOSIT_PENDING }),
    );
  });
});
