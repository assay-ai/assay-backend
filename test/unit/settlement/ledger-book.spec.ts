import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import {
  LEDGER_ENTRY_BOOKS,
  LedgerBook,
  foldLiabilities,
} from '@modules/settlement/domain/ledger-book';

function totals(entries: Partial<Record<LedgerEntryType, bigint>>): Map<string, bigint> {
  return new Map(Object.entries(entries) as [string, bigint][]);
}

describe('foldLiabilities — the three figures', () => {
  it('is all zero for an empty journal', () => {
    const folded = foldLiabilities(totals({}));

    expect(folded).toEqual({
      agentLiabilities: 0n,
      openHolds: 0n,
      providerPayable: 0n,
      platformFees: 0n,
      total: 0n,
    });
  });

  it('counts a deposit as an agent liability', () => {
    const folded = foldLiabilities(totals({ [LedgerEntryType.DEPOSIT]: 10_000_000n }));

    expect(folded.agentLiabilities).toBe(10_000_000n);
    expect(folded.total).toBe(10_000_000n);
  });

  it('counts pending deposits — they are owed before they are spendable', () => {
    const folded = foldLiabilities(
      totals({
        [LedgerEntryType.DEPOSIT_PENDING]: 5_000_000n,
        [LedgerEntryType.DEPOSIT_CONFIRM]: 3_000_000n,
      }),
    );

    // 5 arrived, 3 of it confirmed (pending → available). Still 5 owed.
    expect(folded.agentLiabilities).toBe(5_000_000n);
  });

  it('drops a rejected deposit back out of the total', () => {
    const folded = foldLiabilities(
      totals({
        [LedgerEntryType.DEPOSIT_PENDING]: 5_000_000n,
        [LedgerEntryType.DEPOSIT_REJECT]: 5_000_000n,
      }),
    );

    expect(folded.agentLiabilities).toBe(0n);
    expect(folded.total).toBe(0n);
  });

  it('leaves the total untouched when a hold is opened — the money has not moved', () => {
    const withoutHold = foldLiabilities(totals({ [LedgerEntryType.DEPOSIT]: 10_000_000n }));
    const withHold = foldLiabilities(
      totals({
        [LedgerEntryType.DEPOSIT]: 10_000_000n,
        [LedgerEntryType.HOLD_CREATE]: 10_000n,
      }),
    );

    expect(withHold.total).toBe(withoutHold.total);
    expect(withHold.openHolds).toBe(10_000n);
  });

  it('reports open holds net of releases and commits', () => {
    const folded = foldLiabilities(
      totals({
        [LedgerEntryType.HOLD_CREATE]: 30_000n,
        [LedgerEntryType.HOLD_RELEASE]: 10_000n,
        [LedgerEntryType.HOLD_COMMIT]: 5_000n,
      }),
    );

    expect(folded.openHolds).toBe(15_000n);
  });

  /**
   * The conservation property the whole invariant rests on: a settlement moves
   * value between books without changing what the vault has to cover.
   */
  it('conserves the total across a settlement — agent → provider + platform', () => {
    const beforeSettlement = foldLiabilities(
      totals({
        [LedgerEntryType.DEPOSIT]: 10_000_000n,
        [LedgerEntryType.HOLD_CREATE]: 10_000n,
      }),
    );

    const afterSettlement = foldLiabilities(
      totals({
        [LedgerEntryType.DEPOSIT]: 10_000_000n,
        [LedgerEntryType.HOLD_CREATE]: 10_000n,
        [LedgerEntryType.HOLD_COMMIT]: 10_000n,
        [LedgerEntryType.PROVIDER_CREDIT]: 9_000n,
        [LedgerEntryType.PLATFORM_FEE]: 1_000n,
      }),
    );

    expect(afterSettlement.total).toBe(beforeSettlement.total);
    expect(afterSettlement.agentLiabilities).toBe(9_990_000n);
    expect(afterSettlement.providerPayable).toBe(9_000n);
    expect(afterSettlement.platformFees).toBe(1_000n);
    expect(afterSettlement.openHolds).toBe(0n);
  });

  it('reduces provider payable when a payout leaves', () => {
    const folded = foldLiabilities(
      totals({
        [LedgerEntryType.PROVIDER_CREDIT]: 50_000n,
        [LedgerEntryType.PAYOUT]: 20_000n,
      }),
    );

    expect(folded.providerPayable).toBe(30_000n);
  });

  it('reduces agent liabilities when a withdrawal leaves', () => {
    const folded = foldLiabilities(
      totals({
        [LedgerEntryType.DEPOSIT]: 10_000_000n,
        [LedgerEntryType.WITHDRAWAL]: 4_000_000n,
      }),
    );

    expect(folded.agentLiabilities).toBe(6_000_000n);
    expect(folded.total).toBe(6_000_000n);
  });

  it('goes negative rather than clamping — a negative book is a finding, not a zero', () => {
    const folded = foldLiabilities(totals({ [LedgerEntryType.PAYOUT]: 20_000n }));

    expect(folded.providerPayable).toBe(-20_000n);
  });

  it('refuses an entry type this build has never heard of', () => {
    expect(() => foldLiabilities(new Map([['TELEPORT', 1n]]))).toThrow();
  });
});

describe('LEDGER_ENTRY_BOOKS', () => {
  it('books every entry type — a new way for money to move cannot be omitted', () => {
    for (const entryType of Object.values(LedgerEntryType)) {
      expect(Object.values(LedgerBook)).toContain(LEDGER_ENTRY_BOOKS[entryType]);
    }
  });

  it('books provider earnings and payouts to the provider', () => {
    expect(LEDGER_ENTRY_BOOKS[LedgerEntryType.PROVIDER_CREDIT]).toBe(LedgerBook.PROVIDER);
    expect(LEDGER_ENTRY_BOOKS[LedgerEntryType.PAYOUT]).toBe(LedgerBook.PROVIDER);
  });

  it('books the platform fee to the platform', () => {
    expect(LEDGER_ENTRY_BOOKS[LedgerEntryType.PLATFORM_FEE]).toBe(LedgerBook.PLATFORM);
  });
});
