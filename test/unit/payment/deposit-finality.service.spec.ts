import { DepositIntentRepository } from '@database/postgres/repositories/deposit-intent.repository';
import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { EscrowBalanceReaderPort } from '@modules/ledger/ports/escrow-balance-reader.port';
import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { DepositFinalityService } from '@modules/payment/services/deposit-finality.service';
import { MoneyUtil } from '@shared/utils/money.util';

/**
 * The finality sweep's three answers.
 *
 * The one that was wrong: on `eip155:46630` the `finalized` head trails
 * `latest` by ~17 minutes, the sweep runs every 5, and `observeTransfer` at
 * `finalized` answers `null` for a transfer that is merely NOT FINAL YET — the
 * same `null` it gives for one a reorg dropped. The sweep read every `null` as
 * a drop and wrote DEPOSIT_REJECT. Measured 2026-09-22 on the real testnet: a
 * 25 USDG deposit sat in the escrow on chain while the ledger rejected it, 3
 * minutes after settle. Solana (finality ~13 s) and anvil (blocks mined by
 * hand) never produce the gap, which is why nothing caught it.
 */
const CHAIN = CHAIN_IDS.ROBINHOOD_TESTNET;
const ACCOUNT = `${CHAIN}:0x66d7CA4cD09C65197B2f3239c1fe79631747dd00`;
const TX = `0x${'ab'.repeat(32)}`;
const money = MoneyUtil.of('25000000', ASSET_IDS.USDG_ROBINHOOD_TESTNET, 6);

function build(observe: (commitment: string | undefined) => unknown) {
  const deposits = {
    findSettledAwaitingFinality: jest
      .fn()
      .mockResolvedValue([
        { id: 'dep-1', organizationId: 'org-1', chainId: CHAIN, chainTxRef: TX },
      ]),
    markFinalityResolved: jest.fn().mockResolvedValue(undefined),
  };
  const ledger = {
    readJournal: jest
      .fn()
      .mockResolvedValue([
        { entryType: LedgerEntryType.DEPOSIT_PENDING, accountId: ACCOUNT, money },
      ]),
    appendNow: jest.fn().mockResolvedValue(undefined),
  };
  const adapter = {
    observeTransfer: jest.fn(async (_intent, _tx, options?: { commitment?: string }) =>
      observe(options?.commitment),
    ),
  };
  const service = new DepositFinalityService(
    deposits as unknown as DepositIntentRepository,
    { resolve: () => adapter } as unknown as ChainAdapterRegistry,
    {
      escrowAddresses: async () => ({
        escrowPda: `${CHAIN}:0x60aBdb81796322b1bA6674068a3861309a9f8D37`,
      }),
    } as unknown as EscrowBalanceReaderPort,
    ledger as unknown as LedgerService,
  );
  return { service, deposits, ledger, adapter };
}

const LANDED = { amount: '25000000', asset: ASSET_IDS.USDG_ROBINHOOD_TESTNET, decimals: 6 };

describe('DepositFinalityService sweep', () => {
  it('waits — writes nothing, leaves the deposit queued — when the transfer is confirmed but not final yet', async () => {
    const { service, ledger, deposits } = build((c) => (c === 'finalized' ? null : LANDED));

    await expect(service.promotePendingDeposits(10)).resolves.toMatchObject({
      confirmed: 0,
      rejected: 0,
      skipped: 1,
    });
    expect(ledger.appendNow).not.toHaveBeenCalled();
    // Still in the queue: the next sweep must look again.
    expect(deposits.markFinalityResolved).not.toHaveBeenCalled();
  });

  it('rejects only a transfer the chain no longer shows at any commitment', async () => {
    const { service, ledger } = build(() => null);

    await expect(service.promotePendingDeposits(10)).resolves.toMatchObject({ rejected: 1 });
    expect(ledger.appendNow).toHaveBeenCalledWith(
      expect.objectContaining({ entryType: LedgerEntryType.DEPOSIT_REJECT, chainTxRef: TX }),
    );
  });

  it('confirms a finalized transfer', async () => {
    const { service, ledger } = build(() => LANDED);

    await expect(service.promotePendingDeposits(10)).resolves.toMatchObject({ confirmed: 1 });
    expect(ledger.appendNow).toHaveBeenCalledWith(
      expect.objectContaining({ entryType: LedgerEntryType.DEPOSIT_CONFIRM, chainTxRef: TX }),
    );
  });
});
