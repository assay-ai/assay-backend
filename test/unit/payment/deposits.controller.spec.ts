import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, ChainId, CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import { PaymentRequirements } from '@modules/chains/ports/x402.types';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { DepositsController } from '@modules/payment/controllers/deposits.controller';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import { DepositRequirementsBuilderPort } from '@modules/payment/ports/deposit-requirements.port';
import { DepositIntent, DepositIntentStatus } from '@modules/payment/ports/deposit.types';
import { DepositService } from '@modules/payment/services/deposit.service';
import { MoneyUtil } from '@shared/utils/money.util';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

const SOLANA_DEVNET: ChainId = CHAIN_IDS.SOLANA_DEVNET;
const USDC = ASSET_IDS.USDC_SOLANA_DEVNET;
const ORGANIZATION_ID = '11111111-1111-1111-1111-111111111111';
const AGENT_ID = '22222222-2222-2222-2222-222222222222';
const DEPOSIT_ID = '33333333-3333-3333-3333-333333333333';
const AGENT_ACCOUNT: AccountId = toAccountId(
  SOLANA_DEVNET,
  'AgentAccount1111111111111111111111111111111',
);

const VAULT_ATA = 'VaultAta11111111111111111111111111111111111';
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const FEE_PAYER = 'FacilitatorFeePayer1111111111111111111111111';
const BLOCKHASH = 'Blockhash111111111111111111111111111111111';
const TX_SIG = 'FakeTransactionSignature11111111111111111111111111111111111111111111111';

const ROBINHOOD_TESTNET: ChainId = CHAIN_IDS.ROBINHOOD_TESTNET;
const USDG = ASSET_IDS.USDG_ROBINHOOD_TESTNET;
const EVM_AGENT_ACCOUNT: AccountId = toAccountId(
  ROBINHOOD_TESTNET,
  '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
);

/**
 * A session for an organization other than the one any request body could
 * name — the point of the identity tests below.
 *
 * Takes the chain and account so the asset-derivation cases can run on BOTH
 * chains. A session fixture pinned to one chain is how the deposit-asset table
 * stayed two rows long while a second chain shipped.
 */
function session(overrides?: Partial<McpSession>): McpSession {
  return {
    credentialId: 'cred-1',
    organizationId: ORGANIZATION_ID,
    agentId: AGENT_ID,
    agentAccount: AGENT_ACCOUNT,
    chainId: SOLANA_DEVNET,
    label: 'buyer',
    callerKind: McpCallerKind.CONFIG,
    ...overrides,
  };
}

function requirements(extra?: Record<string, unknown>): PaymentRequirements {
  return {
    scheme: 'exact',
    network: SOLANA_DEVNET,
    amount: '5000000',
    asset: MINT,
    payTo: VAULT_ATA,
    resource: `x402:deposit:${DEPOSIT_ID}`,
    maxTimeoutSeconds: 60,
    description: 'Deposit to platform balance',
    extra: extra ?? { feePayer: FEE_PAYER, memo: DEPOSIT_ID },
  };
}

function intent(overrides?: Partial<DepositIntent>): DepositIntent {
  return {
    id: DEPOSIT_ID,
    organizationId: ORGANIZATION_ID,
    status: DepositIntentStatus.CREATED,
    statusReason: null,
    agentId: AGENT_ID,
    agentAccount: AGENT_ACCOUNT,
    requestedAmount: MoneyUtil.of(5_000_000n, USDC, 6),
    settledAmount: null,
    chainId: SOLANA_DEVNET,
    chainTxRef: null,
    expiresAt: new Date('2026-08-23T10:00:00.000Z'),
    createdAt: new Date('2026-08-23T09:59:00.000Z'),
    updatedAt: new Date('2026-08-23T09:59:00.000Z'),
    ...overrides,
  };
}

function buildHarness(overrides?: { extra?: Record<string, unknown> }) {
  const deposits = {
    createDeposit: jest
      .fn()
      .mockResolvedValue({ intent: intent(), requirements: requirements(overrides?.extra) }),
    settleDeposit: jest.fn(),
    settleDepositByBroadcast: jest.fn(),
  };

  // The whole `DepositRequirements` value, because that is what the controller
  // now returns unchanged. Its assembly — and the two
  // `PAYMENT_DEPOSIT_REQUIREMENTS_INCOMPLETE` refusals that used to live in
  // this file — moved to `test/unit/chains/solana/deposit-requirements-builder.spec.ts`.
  const requirementsBuilder = {
    build: jest.fn().mockResolvedValue({
      namespace: 'solana',
      chainId: SOLANA_DEVNET,
      payTo: VAULT_ATA,
      asset: MINT,
      amount: '5000000',
      decimals: 6,
      feePayer: FEE_PAYER,
      memo: DEPOSIT_ID,
      blockhash: BLOCKHASH,
      lastValidBlockHeight: '312445678',
    }),
  };

  const controller = new DepositsController(
    deposits as unknown as DepositService,
    requirementsBuilder as unknown as DepositRequirementsBuilderPort,
  );

  return { deposits, requirementsBuilder, controller };
}

describe('DepositsController.create', () => {
  it('takes every identity field from the session and only the amount from the body', async () => {
    const { controller, deposits } = buildHarness();

    await controller.create(session(), { amount: '5000000' });

    // Not `objectContaining`: the assertion is as much about what is *absent*
    // — there is no field on this call the request body could have supplied.
    expect(deposits.createDeposit).toHaveBeenCalledTimes(1);
    expect(deposits.createDeposit).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      agentAccount: AGENT_ACCOUNT,
      chainId: SOLANA_DEVNET,
      amount: MoneyUtil.of(5_000_000n, USDC, 6),
    });
  });

  it('hands the builder the intent’s scale and the session’s chain, and returns its answer', async () => {
    const { controller, requirementsBuilder } = buildHarness();

    const response = await controller.create(session(), { amount: '5000000' });

    expect(response.depositId).toBe(DEPOSIT_ID);
    expect(response.expiresAt).toBe('2026-08-23T10:00:00.000Z');
    expect(requirementsBuilder.build).toHaveBeenCalledTimes(1);
    expect(requirementsBuilder.build).toHaveBeenCalledWith({
      chainId: SOLANA_DEVNET,
      requirements: requirements(),
      decimals: 6,
    });
    expect(response.requirements).toBe(await requirementsBuilder.build.mock.results[0].value);
  });

  it('takes the chain from the session when the body names none', async () => {
    const { controller, deposits } = buildHarness();

    await controller.create(session(), { amount: '5000000' });

    expect(deposits.createDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: SOLANA_DEVNET, agentAccount: AGENT_ACCOUNT }),
    );
  });

  /**
   * The asset is derived from the RESOLVED chain and is never a request field,
   * so this is the only place the controller can get it wrong — and until this
   * case existed it could only ever be asked about Solana.
   *
   * Two rows, two chains, two DIFFERENT assets, in two different namespaces.
   * One row would pass against an implementation that returns a constant; the
   * `eip155` row is the one that was answering `400
   * PAYMENT_DEPOSIT_ASSET_NOT_USDC` in production for a chain that settles in
   * USDG.
   */
  it.each([
    { label: 'Solana devnet', chainId: SOLANA_DEVNET, account: AGENT_ACCOUNT, asset: USDC },
    {
      label: 'Robinhood testnet',
      chainId: ROBINHOOD_TESTNET,
      account: EVM_AGENT_ACCOUNT,
      asset: USDG,
    },
  ])('derives $label’s own settlement asset and never refuses it', async (row) => {
    const { controller, deposits } = buildHarness();

    await controller.create(session({ chainId: row.chainId, agentAccount: row.account }), {
      amount: '5000000',
    });

    expect(deposits.createDeposit).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: row.chainId,
        agentAccount: row.account,
        // `MoneyUtil.of` carries the asset AND the registered scale; both come
        // off the derived asset, so a wrong asset would be a wrong scale too.
        amount: MoneyUtil.of(5_000_000n, row.asset, 6),
      }),
    );
  });

  it('refuses a chainId the session has no account on, and never calls the service', async () => {
    // The loser, asserted twice: the right error AND no write. A resolver that
    // threw after `createDeposit` had already run would leave a CREATED row —
    // and a CREATED row IS the `pendingDeposits` figure on the buyer's screen
    // (memory: `failed-deposit-request-leaves-a-row`).
    const { controller, deposits } = buildHarness();

    await expectErrorCodeAsync(
      () => controller.create(session(), { amount: '5000000', chainId: CHAIN_IDS.SOLANA_MAINNET }),
      PaymentErrorCode.PAYMENT_DEPOSIT_ACCOUNT_NOT_LINKED,
    );
    expect(deposits.createDeposit).not.toHaveBeenCalled();
  });
});

describe('DepositsController.settle', () => {
  it('passes the session organization, the path id and the payload, in that order', async () => {
    const { controller, deposits } = buildHarness();
    deposits.settleDeposit.mockResolvedValue(
      intent({
        status: DepositIntentStatus.SETTLED,
        settledAmount: MoneyUtil.of(5_000_000n, USDC, 6),
        chainTxRef: TX_SIG,
      }),
    );

    const response = await controller.settle(session(), DEPOSIT_ID, {
      x402Version: 2,
      scheme: 'exact',
      network: SOLANA_DEVNET,
      payload: { transaction: 'AQAB' },
    });

    // Three positional arguments — `settleDeposit` has no input object.
    expect(deposits.settleDeposit).toHaveBeenCalledWith(ORGANIZATION_ID, DEPOSIT_ID, {
      x402Version: 2,
      scheme: 'exact',
      network: SOLANA_DEVNET,
      payload: { transaction: 'AQAB' },
    });

    expect(response).toEqual({
      id: DEPOSIT_ID,
      status: DepositIntentStatus.SETTLED,
      settledAmount: MoneyUtil.of(5_000_000n, USDC, 6),
      chainTxRef: TX_SIG,
    });
  });

  it('never reads the organization from anywhere but the session', async () => {
    const { controller, deposits } = buildHarness();
    deposits.settleDeposit.mockResolvedValue(
      intent({ status: DepositIntentStatus.SETTLED, chainTxRef: TX_SIG }),
    );

    await controller.settle(session(), DEPOSIT_ID, {
      x402Version: 2,
      scheme: 'exact',
      network: SOLANA_DEVNET,
      payload: { transaction: 'AQAB' },
    });

    expect(deposits.settleDeposit.mock.calls[0][0]).toBe(ORGANIZATION_ID);
  });

  it('refuses a network that is not a CAIP-2 chain id', async () => {
    const { controller, deposits } = buildHarness();

    await expectErrorCodeAsync(
      () =>
        controller.settle(session(), DEPOSIT_ID, {
          x402Version: 2,
          scheme: 'exact',
          network: 'solana-devnet',
          payload: { transaction: 'AQAB' },
        }),
      PaymentErrorCode.PAYMENT_INVALID_PAYLOAD,
    );

    expect(deposits.settleDeposit).not.toHaveBeenCalled();
  });
});

describe('DepositsController.broadcast', () => {
  it('hands the service the session organization, the path id and the hash — nothing else', async () => {
    const { controller, deposits } = buildHarness();
    const hash = `0x${'ab'.repeat(32)}`;
    deposits.settleDepositByBroadcast.mockResolvedValue(
      intent({
        status: DepositIntentStatus.SETTLED,
        settledAmount: MoneyUtil.of(5_000_000n, USDC, 6),
        chainTxRef: hash,
      }),
    );

    const response = await controller.broadcast(session(), DEPOSIT_ID, { transactionHash: hash });

    expect(deposits.settleDepositByBroadcast).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      DEPOSIT_ID,
      hash,
    );
    expect(response).toEqual({
      id: DEPOSIT_ID,
      status: DepositIntentStatus.SETTLED,
      settledAmount: MoneyUtil.of(5_000_000n, USDC, 6),
      chainTxRef: hash,
    });
  });
});
