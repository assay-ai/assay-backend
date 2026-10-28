import {
  EscrowWithdrawalEventRepository,
  UnbookedClaim,
  withdrawalRef,
} from '@database/postgres/repositories/escrow-withdrawal-event.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AssetId } from '@modules/chains/ports/caip.types';
import { AppendEntryInput, LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { foldLiabilities, vaultLiabilities } from '@modules/settlement/domain/ledger-book';
import {
  CLAIMED_WITHDRAWAL_BOOKING_BATCH,
  ClaimedWithdrawalBooker,
} from '@modules/settlement/services/claimed-withdrawal-booker.service';
import { MoneyUtil } from '@shared/utils/money.util';

const USDG = ASSET_IDS.USDG_ROBINHOOD_TESTNET as AssetId;
const ORG = 'org-11111111-1111-4111-8111-111111111111';
const ACCOUNT = 'eip155:46630:0x1111111111111111111111111111111111111111';
const TX = '0xabababababababababababababababababababababababababababababababab';

function claim(overrides: Partial<UnbookedClaim> = {}): UnbookedClaim {
  return {
    organizationId: ORG,
    accountId: ACCOUNT,
    assetId: USDG,
    amount: 1_000_000n,
    ref: withdrawalRef(TX, 0),
    ...overrides,
  };
}

function booker(claims: UnbookedClaim[], available: bigint, append?: jest.Mock) {
  const listUnbookedClaims = jest.fn().mockResolvedValue(claims);
  const appendNow = append ?? jest.fn().mockResolvedValue({});
  const getBalance = jest.fn().mockResolvedValue({
    available: MoneyUtil.of(available, USDG, 6),
  });
  const service = new ClaimedWithdrawalBooker(
    { listUnbookedClaims } as unknown as EscrowWithdrawalEventRepository,
    { appendNow, getBalance } as unknown as LedgerService,
  );
  return { service, listUnbookedClaims, appendNow, getBalance };
}

describe('ClaimedWithdrawalBooker', () => {
  it('books a claim as a WITHDRAWAL debit keyed by its log', async () => {
    const { service, listUnbookedClaims, appendNow } = booker([claim()], 24_930_000n);

    await expect(service.book()).resolves.toBe(1);

    expect(listUnbookedClaims).toHaveBeenCalledWith(CLAIMED_WITHDRAWAL_BOOKING_BATCH);
    const input = appendNow.mock.calls[0][0] as AppendEntryInput;
    expect(input).toEqual({
      organizationId: ORG,
      accountId: ACCOUNT,
      entryType: LedgerEntryType.WITHDRAWAL,
      money: MoneyUtil.of(1_000_000n, USDG, 6),
      chainTxRef: `${TX}:0`,
    });
  });

  it('never debits more than available, and still books the claim at zero', async () => {
    const { service, appendNow } = booker(
      [claim({ amount: 5_000_000n }), claim({ ref: withdrawalRef(TX, 1) })],
      2_000_000n,
    );

    await service.book();

    const amounts = appendNow.mock.calls.map(([input]: [AppendEntryInput]) => input.money.amount);
    // The mock balance does not move between the two claims; the clamp is per read.
    expect(amounts).toEqual(['2000000', '1000000']);

    const empty = booker([claim({ amount: 5_000_000n })], 0n);
    await empty.service.book();
    expect((empty.appendNow.mock.calls[0][0] as AppendEntryInput).money.amount).toBe('0');
  });

  it('loses a duplicate quietly and leaves a failed claim for the next pass', async () => {
    const append = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }))
      .mockRejectedValueOnce(new Error('LEDGER_INSUFFICIENT_AVAILABLE_BALANCE'))
      .mockResolvedValueOnce({});
    const { service } = booker(
      [claim(), claim({ ref: withdrawalRef(TX, 1) }), claim({ ref: withdrawalRef(TX, 2) })],
      24_930_000n,
      append,
    );

    await expect(service.book()).resolves.toBe(1);
    expect(append).toHaveBeenCalledTimes(3);
  });

  it('never throws out of the cron handler', async () => {
    const { service, listUnbookedClaims } = booker([], 0n);
    listUnbookedClaims.mockRejectedValueOnce(new Error('database down'));

    await expect(service.handleTick()).resolves.toBeUndefined();
  });

  it('closes the dev breach: the books match a vault the claim left', () => {
    // 25 deposited, 7 calls of 0.01 redeemed, 1 claimed.
    const journal = {
      [LedgerEntryType.DEPOSIT_PENDING]: 25_000_000n,
      [LedgerEntryType.DEPOSIT_CONFIRM]: 25_000_000n,
      [LedgerEntryType.HOLD_CREATE]: 70_000n,
      [LedgerEntryType.HOLD_COMMIT]: 70_000n,
      [LedgerEntryType.PROVIDER_CREDIT]: 63_000n,
      [LedgerEntryType.PLATFORM_FEE]: 7_000n,
    };
    const paid = { providerCredits: 63_000n, platformFees: 7_000n };
    const vault = 23_930_000n;
    const owed = (entries: Record<string, bigint>) =>
      vaultLiabilities(foldLiabilities(new Map(Object.entries(entries))), paid).total;

    expect(vault - owed(journal)).toBe(-1_000_000n);
    expect(vault - owed({ ...journal, [LedgerEntryType.WITHDRAWAL]: 1_000_000n })).toBe(0n);
  });
});

describe('withdrawalRef', () => {
  it('is the lower-case transaction hash and the log index', () => {
    expect(withdrawalRef(TX.toUpperCase().replace('0X', '0x'), 3)).toBe(`${TX}:3`);
  });
});
