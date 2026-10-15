import { LedgerHoldRepository } from '@database/postgres/repositories/ledger-hold.repository';
import { AccountId } from '@modules/chains/ports/caip.types';
import { LedgerErrorCode } from '@modules/ledger/errors/ledger.errors';
import {
  EscrowBalanceReaderPort,
  EscrowChainBalance,
} from '@modules/ledger/ports/escrow-balance-reader.port';
import {
  EscrowSpendGateService,
  parseEscrowSpendGateEnabled,
} from '@modules/ledger/services/escrow-spend-gate.service';
import { PaymentErrorCode, PaymentErrors } from '@modules/payment/errors/payment.errors';
import { PaymentRail } from '@modules/payment/ports/payment.types';
import { MoneyUtil } from '@shared/utils/money.util';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { ORG, USDC, USDC_DECIMALS, testAccount } from './helpers/entries';

const ACCOUNT: AccountId = testAccount('buyer') as AccountId;

function reading(overrides: Partial<EscrowChainBalance> = {}): EscrowChainBalance {
  return {
    balance: MoneyUtil.of(10_000_000n, USDC, USDC_DECIMALS),
    seqHigh: 0n,
    withdrawRequested: 0n,
    withdrawAvailableAt: 0,
    maxVoucherAmount: 1_000_000_000n,
    maxPerWindow: 1_000_000_000n,
    spentInWindow: 0n,
    windowStartedAt: 0,
    observedAt: new Date(),
    ...overrides,
  };
}

function buildGate(options: {
  reading?: EscrowChainBalance | null;
  readerThrows?: Error;
  openHoldsAtomic?: bigint;
  enabled?: boolean;
}) {
  const readerMock = options.readerThrows
    ? jest.fn().mockRejectedValue(options.readerThrows)
    : jest.fn().mockResolvedValue(options.reading === undefined ? reading() : options.reading);

  const reader: EscrowBalanceReaderPort = {
    read: readerMock,
    readMany: jest.fn(),
    escrowAddresses: jest.fn(),
  };

  const holds = {
    sumOpenByAccount: jest.fn().mockResolvedValue(options.openHoldsAtomic ?? 0n),
  } as unknown as LedgerHoldRepository;

  const gate = new EscrowSpendGateService(reader, holds, options.enabled ?? true);
  return { gate, reader, holds };
}

describe('EscrowSpendGateService.spendable', () => {
  it('is the chain balance minus every open hold', async () => {
    const { gate } = buildGate({
      reading: reading({ balance: MoneyUtil.of(10_000_000n, USDC, USDC_DECIMALS) }),
      openHoldsAtomic: 2_500_000n,
    });

    const result = await gate.spendable(ORG, ACCOUNT, USDC);

    expect(result?.spendable.amount).toBe('7500000');
    expect(result?.chain.amount).toBe('10000000');
    expect(result?.openHolds.amount).toBe('2500000');
  });

  it('never reports a negative spendable, however far the mirror has drifted', async () => {
    const { gate } = buildGate({
      reading: reading({ balance: MoneyUtil.of(1_000_000n, USDC, USDC_DECIMALS) }),
      openHoldsAtomic: 4_000_000n,
    });

    const result = await gate.spendable(ORG, ACCOUNT, USDC);

    expect(result?.spendable.amount).toBe('0');
  });

  it('is null when the account has no escrow', async () => {
    const { gate } = buildGate({ reading: null });

    await expect(gate.spendable(ORG, ACCOUNT, USDC)).resolves.toBeNull();
  });
});

describe('EscrowSpendGateService.assertAffordable', () => {
  it('is inert while ESCROW_SPEND_GATE_ENABLED is not the exact string "true"', () => {
    for (const value of [undefined, '', 'TRUE', '1', 'yes']) {
      expect(parseEscrowSpendGateEnabled(value)).toBe(false);
    }
    expect(parseEscrowSpendGateEnabled('true')).toBe(true);
  });

  it('prices a rail-B call against the chain even while disabled (A6)', async () => {
    // The flag governs only the rail-A refusal. A rail-B voucher is collected
    // from the escrow alone, so admitting one the escrow cannot cover leaves a
    // served call nobody can be charged for.
    const { gate } = buildGate({
      enabled: false,
      reading: reading({ balance: MoneyUtil.of(1n, USDC, USDC_DECIMALS) }),
    });

    await expectErrorCodeAsync(
      () =>
        gate.assertAffordable(ORG, ACCOUNT, MoneyUtil.of(999_000_000n, USDC, USDC_DECIMALS), {
          rail: PaymentRail.RAIL_B_VOUCHER,
        }),
      LedgerErrorCode.LEDGER_INSUFFICIENT_AVAILABLE_BALANCE,
    );
  });

  it('refuses a withdrawn escrow behind a stale ledger mirror while disabled (A6)', async () => {
    // request_withdraw, wait the hour, withdraw: `withdrawRequested` is back
    // to 0 and the chain balance is 0, but nothing writes a WITHDRAWAL entry,
    // so the ledger mirror still shows the old balance. Only the chain read
    // can see that the money is gone.
    const { gate } = buildGate({
      enabled: false,
      reading: reading({
        balance: MoneyUtil.of(0n, USDC, USDC_DECIMALS),
        withdrawRequested: 0n,
      }),
    });

    await expectErrorCodeAsync(
      () =>
        gate.assertAffordable(ORG, ACCOUNT, MoneyUtil.of(1n, USDC, USDC_DECIMALS), {
          rail: PaymentRail.RAIL_B_VOUCHER,
        }),
      LedgerErrorCode.LEDGER_INSUFFICIENT_AVAILABLE_BALANCE,
    );
  });

  it('does not read the chain for a rail-A call while disabled', async () => {
    // Rail A has no escrow, so F5 has nothing to say about it and the read
    // would be wasted on every MCP call on the platform.
    const { gate, reader } = buildGate({ enabled: false });

    await gate.assertAffordable(ORG, ACCOUNT, MoneyUtil.of(1n, USDC, USDC_DECIMALS), {
      rail: PaymentRail.RAIL_A_PER_CALL,
    });

    expect(reader.read).not.toHaveBeenCalled();
  });

  it('refuses a rail-B call with no escrow even while disabled', async () => {
    // No escrow means nothing a voucher could ever be redeemed against.
    const { gate } = buildGate({ enabled: false, reading: null });

    await expectErrorCodeAsync(
      () =>
        gate.assertAffordable(ORG, ACCOUNT, MoneyUtil.of(1n, USDC, USDC_DECIMALS), {
          rail: PaymentRail.RAIL_B_VOUCHER,
        }),
      PaymentErrorCode.PAYMENT_ESCROW_NOT_OPEN,
    );
  });

  it('still lets a rail-A call through while disabled — the flag governs only rail A', async () => {
    const { gate } = buildGate({ enabled: false, reading: null });

    await expect(
      gate.assertAffordable(ORG, ACCOUNT, MoneyUtil.of(1n, USDC, USDC_DECIMALS), {
        rail: PaymentRail.RAIL_A_PER_CALL,
      }),
    ).resolves.toBeUndefined();
  });

  it('passes a rail-B call within the spendable amount', async () => {
    const { gate } = buildGate({
      reading: reading({ balance: MoneyUtil.of(10_000_000n, USDC, USDC_DECIMALS) }),
    });

    await expect(
      gate.assertAffordable(ORG, ACCOUNT, MoneyUtil.of(1_000_000n, USDC, USDC_DECIMALS), {
        rail: PaymentRail.RAIL_B_VOUCHER,
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses a rail-B call over the spendable amount', async () => {
    const { gate } = buildGate({
      reading: reading({ balance: MoneyUtil.of(1_000_000n, USDC, USDC_DECIMALS) }),
      openHoldsAtomic: 900_000n,
    });

    await expectErrorCodeAsync(
      () =>
        gate.assertAffordable(ORG, ACCOUNT, MoneyUtil.of(200_000n, USDC, USDC_DECIMALS), {
          rail: PaymentRail.RAIL_B_VOUCHER,
        }),
      LedgerErrorCode.LEDGER_INSUFFICIENT_AVAILABLE_BALANCE,
    );
  });

  it('refuses a call it cannot price against the chain, and does NOT consult the holds repository', async () => {
    const { gate, holds } = buildGate({
      readerThrows: PaymentErrors.escrowBalanceUnavailable({
        account: ACCOUNT,
      }) as unknown as Error,
    });

    await expectErrorCodeAsync(
      () =>
        gate.assertAffordable(ORG, ACCOUNT, MoneyUtil.of(1n, USDC, USDC_DECIMALS), {
          rail: PaymentRail.RAIL_B_VOUCHER,
        }),
      PaymentErrorCode.PAYMENT_ESCROW_BALANCE_UNAVAILABLE,
    );
    expect(holds.sumOpenByAccount).not.toHaveBeenCalled();
  });

  it('refuses a rail-A intent outright while the gate is on, without reading the chain', async () => {
    // An MCP rail-A call carries no signature, so nothing can ever debit an
    // escrow for it. Spending a mirror balance instead would put back the
    // exact property per-buyer escrows remove.
    const { gate, reader } = buildGate({
      reading: reading({ balance: MoneyUtil.of(10_000_000n, USDC, USDC_DECIMALS) }),
    });

    await expectErrorCodeAsync(
      () =>
        gate.assertAffordable(ORG, ACCOUNT, MoneyUtil.of(1n, USDC, USDC_DECIMALS), {
          rail: PaymentRail.RAIL_A_PER_CALL,
        }),
      PaymentErrorCode.PAYMENT_ESCROW_NOT_OPEN,
    );
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('refuses a new call while a withdrawal is pending on the escrow', async () => {
    // A voucher accepted while a withdrawal stands can be
    // outrun by the withdrawal itself — the buyer withdraws, the escrow drains,
    // and `redeem_voucher` dies with `EscrowInsufficient` after the call has
    // already been served. That loss lands on the platform, so the refusal is
    // on the ACCEPT path and never on the redeem path.
    const { gate } = buildGate({
      reading: reading({
        balance: MoneyUtil.of(10_000_000n, USDC, USDC_DECIMALS),
        withdrawRequested: 1n,
        withdrawAvailableAt: 1_760_000_000,
      }),
    });

    await expectErrorCodeAsync(
      () =>
        gate.assertAffordable(ORG, ACCOUNT, MoneyUtil.of(1n, USDC, USDC_DECIMALS), {
          rail: PaymentRail.RAIL_B_VOUCHER,
        }),
      PaymentErrorCode.PAYMENT_WITHDRAWAL_PENDING,
    );
  });

  it('refuses a standing withdrawal even with ESCROW_SPEND_GATE_ENABLED off (F5)', async () => {
    // THE finding. On chain, `request_withdraw` + WITHDRAW_DELAY_SECONDS +
    // `withdraw` is deliberately NOT blocked by pending redemptions — the
    // program lets a buyer leave without the platform's permission, which is
    // the custody guarantee. So a buyer can request, wait out the hour, buy
    // calls, and withdraw before the redemption cron lands any of the vouchers
    // those calls produced: every one dies `EscrowInsufficient`, the calls are
    // already served, and the platform pays the providers itself.
    //
    // The backend refusing to serve is the whole control, and a control that
    // only runs when a cutover flag is on is not a control — this gate ships
    // OFF, so gating F5 behind it would leave the hole open for exactly as
    // long as the flag stays off, which is today.
    const { gate } = buildGate({
      enabled: false,
      reading: reading({
        balance: MoneyUtil.of(10_000_000n, USDC, USDC_DECIMALS),
        withdrawRequested: 1n,
        withdrawAvailableAt: 1_760_000_000,
      }),
    });

    await expectErrorCodeAsync(
      () =>
        gate.assertAffordable(ORG, ACCOUNT, MoneyUtil.of(1n, USDC, USDC_DECIMALS), {
          rail: PaymentRail.RAIL_B_VOUCHER,
        }),
      PaymentErrorCode.PAYMENT_WITHDRAWAL_PENDING,
    );
  });

  it('passes a rail-B call within the spendable amount while disabled', async () => {
    const { gate, holds } = buildGate({
      enabled: false,
      reading: reading({ balance: MoneyUtil.of(10_000_000n, USDC, USDC_DECIMALS) }),
      openHoldsAtomic: 1_000_000n,
    });

    await expect(
      gate.assertAffordable(ORG, ACCOUNT, MoneyUtil.of(9_000_000n, USDC, USDC_DECIMALS), {
        rail: PaymentRail.RAIL_B_VOUCHER,
      }),
    ).resolves.toBeUndefined();
    expect(holds.sumOpenByAccount).toHaveBeenCalled();
  });

  it('refuses the withdrawal-pending escrow before pricing it, so a rich buyer is refused too', async () => {
    const { gate, holds } = buildGate({
      reading: reading({
        balance: MoneyUtil.of(1_000_000_000n, USDC, USDC_DECIMALS),
        withdrawRequested: 5n,
      }),
    });

    await expectErrorCodeAsync(
      () =>
        gate.assertAffordable(ORG, ACCOUNT, MoneyUtil.of(1n, USDC, USDC_DECIMALS), {
          rail: PaymentRail.RAIL_B_VOUCHER,
        }),
      PaymentErrorCode.PAYMENT_WITHDRAWAL_PENDING,
    );
    expect(holds.sumOpenByAccount).not.toHaveBeenCalled();
  });

  it('still reports spendable for an escrow with a pending withdrawal — reading is not accepting', async () => {
    // `spendable()` answers `GET /balances`. A pending withdrawal stops new
    // calls; it does not make the balance unreportable.
    const { gate } = buildGate({
      reading: reading({
        balance: MoneyUtil.of(10_000_000n, USDC, USDC_DECIMALS),
        withdrawRequested: 4_000_000n,
      }),
    });

    const result = await gate.spendable(ORG, ACCOUNT, USDC);

    expect(result?.spendable.amount).toBe('10000000');
    expect(result?.withdrawRequested).toBe(4_000_000n);
  });

  it('refuses when the account has no escrow at all', async () => {
    const { gate } = buildGate({ reading: null });

    await expectErrorCodeAsync(
      () =>
        gate.assertAffordable(ORG, ACCOUNT, MoneyUtil.of(1n, USDC, USDC_DECIMALS), {
          rail: PaymentRail.RAIL_B_VOUCHER,
        }),
      PaymentErrorCode.PAYMENT_ESCROW_NOT_OPEN,
    );
  });
});
